import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deploys, projectKind } from '../../kinds/project/index.js';
import { deployProviders } from '../../providers/deploy/index.js';
import { vercelApi, vercelProjects, vercelStagingTask } from '../../providers/deploy/vercel.js';
import { netlifyApi, netlifyLockTask, netlifySites } from '../../providers/deploy/netlify.js';
import { monitoringServices } from '../../providers/monitoring/index.js';
import { bold, clack, cyan, dim, orExit, question } from '../../lib/ui.js';

// What a JavaScript app (Next, Nuxt, or a Vue or React single-page app built with Vite) adds to project.yml
// (cli/kinds/project/index.js): Vercel deploys (its token, project and protection bypass, vercel.json and the health
// route), Netlify deploys (its token, a site per environment, netlify.toml and the health route), Sentry, and whether
// the tests run its end-to-end tests

// The deploy targets of a JavaScript app (cli/providers/deploy)
const PROVIDERS = deployProviders(['vercel', 'netlify']);

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

// Every health route answers 200 while the app serves requests, never cached
const APP_ROUTE = `// Health check of the Datalogix deploys: answers 200 while the app serves requests
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
`;
const NEXT_PAGES_TS = `import type { NextApiRequest, NextApiResponse } from 'next';

// Health check of the Datalogix deploys: answers 200 while the app serves requests
export default function handler(_request: NextApiRequest, response: NextApiResponse) {
  response.status(200).json({ status: 'ok' });
}
`;
const NEXT_PAGES_JS = `// Health check of the Datalogix deploys: answers 200 while the app serves requests
export default function handler(_request, response) {
  response.status(200).json({ status: 'ok' });
}
`;
const NITRO_HANDLER = `// Health check of the Datalogix deploys: answers 200 while the app serves requests
export default defineEventHandler(() => ({ status: 'ok' }));
`;

// The health check of an app with no server: a static file, which the build copies from public/ and the host serves
const STATIC_HEALTH = {
  file: 'public/health.json',
  path: '/health.json',
  content: `${JSON.stringify({ status: 'ok' })}\n`,
};
const HEALTH_PATH = '/api/health';

/** The stems (no extension) of the files, each as .ts and .js. */
const withExtensions = (stems) => stems.flatMap((stem) => [`${stem}.ts`, `${stem}.js`]);

// The Nitro presets each deploy target builds with; static files are served by both
const NITRO_PRESETS = { vercel: /^(vercel|static$)/, netlify: /^(netlify|static$)/ };

/** The Nitro preset nuxt.config sets, if any: the deploy target its build is for. */
async function nitroPresetOf(root) {
  for (const file of ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']) {
    const config = await readFile(join(root, file), 'utf8').catch(() => null);
    if (config !== null) return /\bpreset\s*:\s*['"]([\w-]+)['"]/.exec(config)?.[1] ?? null;
  }
  return null;
}

// The Nuxt commands that build only static files, with no server: nuxt generate, or nuxt build --prerender
const NUXT_STATIC = /\bnux[ti]\s+(generate\b|build\b.*\s--prerender\b)/;
// A command that runs a script of package.json, as npm run generate or yarn generate
const RUN_SCRIPT = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)\s*$/;

/** Whether a build command, or the package.json script it runs, builds a Nuxt app as static files. */
function buildsStatic(command, scripts) {
  if (typeof command !== 'string') return false;
  const script = RUN_SCRIPT.exec(command)?.[1];
  return NUXT_STATIC.test(typeof scripts[script] === 'string' ? scripts[script] : command);
}

/**
 * Whether a Nuxt app is built as static files: the build command of netlify.toml or vercel.json, or else the build
 * script, runs nuxt generate, or nuxt.config sets the static Nitro preset.
 */
function staticNuxt({ manifest, netlifyToml, vercelJson, nitroPreset }) {
  if (nitroPreset === 'static') return true;
  const scripts = manifest.scripts ?? {};
  const commands = [...(netlifyToml ?? '').matchAll(/^\s*command\s*=\s*["']([^"']*)["']/gm)].map((match) => match[1]);
  try {
    commands.push(JSON.parse(vercelJson ?? '{}').buildCommand);
  } catch {
    // vercel.json that is not valid JSON: setup reports it when it writes the file
  }
  commands.push(scripts.build);
  return commands.some((command) => buildsStatic(command, scripts));
}

// The routers whose routes only the app knows, so the host must serve index.html for them
const SPA_ROUTERS = ['vue-router', 'react-router', 'react-router-dom', '@tanstack/react-router'];

/**
 * What setup knows of each framework, in the order they are detected:
 * - detect(names): whether the dependencies of package.json are this framework's;
 * - sentry: Sentry's SDK, and its wizard when Sentry has one;
 * - spa: a single-page app built with Vite, only static files: its health check is STATIC_HEALTH, and with a router
 *   the host rewrites every path to index.html;
 * - health (apps with a server): files(), the files that may answer its health route (whichever router or layout),
 *   create(root, ext), where a new one goes, and content(file, ext), what it holds;
 * - inspect(root, { manifest, vercelJson, netlifyToml }): what else it reads from the folder, as state (staticBuild:
 *   built as static files, which also makes STATIC_HEALTH its health check);
 * - deployWarning(state, target, provider): a reason its build does not suit the deploy target, for check.
 */
const FRAMEWORKS = {
  next: {
    detect: (names) => names.includes('next'),
    sentry: { name: '@sentry/nextjs', wizard: 'nextjs' },
    health: {
      files: () =>
        withExtensions([
          ...['src/app', 'app'].map((base) => `${base}/api/health/route`),
          ...['src/pages', 'pages'].flatMap((base) => [`${base}/api/health`, `${base}/api/health/index`]),
        ]),
      // The App Router when the app has it, else the Pages Router, else a new App Router route
      create: async (root, ext) => {
        for (const base of ['src/app', 'app'])
          if (await exists(join(root, base))) return `${base}/api/health/route.${ext}`;
        for (const base of ['src/pages', 'pages'])
          if (await exists(join(root, base))) return `${base}/api/health.${ext}`;
        return `app/api/health/route.${ext}`;
      },
      content: (file, ext) =>
        file.endsWith(`/route.${ext}`) ? APP_ROUTE : ext === 'ts' ? NEXT_PAGES_TS : NEXT_PAGES_JS,
    },
  },
  nuxt: {
    detect: (names) => names.includes('nuxt'),
    sentry: { name: '@sentry/nuxt', wizard: 'nuxt' },
    health: {
      files: () =>
        withExtensions(
          ['server/api', 'server/routes/api'].flatMap((base) =>
            [`${base}/health`, `${base}/health/index`].flatMap((stem) => [stem, `${stem}.get`]),
          ),
        ),
      create: async (_root, ext) => `server/api/health.get.${ext}`,
      content: () => NITRO_HANDLER,
    },
    inspect: async (root, { manifest, vercelJson, netlifyToml }) => {
      const nitroPreset = await nitroPresetOf(root);
      return { nitroPreset, staticBuild: staticNuxt({ manifest, netlifyToml, vercelJson, nitroPreset }) };
    },
    deployWarning: (state, target, provider) =>
      state.nitroPreset && NITRO_PRESETS[target] && !NITRO_PRESETS[target].test(state.nitroPreset)
        ? [
            `nuxt.config sets the Nitro preset ${state.nitroPreset}, which does not build for ${provider.name}`,
            `remove it (Nitro detects ${provider.name}) or set a ${target} preset`,
          ]
        : null,
  },
  // Vue and React apps built with Vite: single-page apps, with no server to answer a health route
  vue: {
    detect: (names) => names.includes('vite') && names.includes('vue'),
    sentry: { name: '@sentry/vue' },
    spa: true,
  },
  react: {
    detect: (names) => names.includes('vite') && names.includes('react'),
    sentry: { name: '@sentry/react' },
    spa: true,
  },
};

/** The framework of the app, from its dependencies: the first of FRAMEWORKS that detects them, or null. */
function frameworkOf(names) {
  return Object.keys(FRAMEWORKS).find((id) => FRAMEWORKS[id].detect(names)) ?? null;
}

/** Whether the app is only static files, with no server: a single-page app, or a Nuxt app built with nuxt generate. */
const isStatic = ({ framework, staticBuild }) => Boolean(FRAMEWORKS[framework]?.spa) || Boolean(staticBuild);
/** The health check path of the app: a static file when it has no server. */
const healthPathOf = (state) => (isStatic(state) ? STATIC_HEALTH.path : HEALTH_PATH);

/** Where the health route goes for the framework and router of the app, in TypeScript when it has a tsconfig.json. */
async function healthRouteFile(root, app) {
  if (isStatic(app)) return STATIC_HEALTH.file;
  const health = FRAMEWORKS[app.framework]?.health;
  if (!health) return null;
  return health.create(root, (await exists(join(root, 'tsconfig.json'))) ? 'ts' : 'js');
}

/** The files that answer the health route of the framework, whichever router or layout the app uses. */
function healthRouteFiles(app) {
  if (isStatic(app)) return [STATIC_HEALTH.file];
  return FRAMEWORKS[app.framework]?.health?.files() ?? [];
}

/** What the health route file of the app holds: the framework's handler, or the static file. */
function healthRouteContent(file, state) {
  if (isStatic(state)) return STATIC_HEALTH.content;
  return FRAMEWORKS[state.framework].health.content(file, file.split('.').at(-1));
}

/**
 * The framework, its health route, vercel.json, netlify.toml, the Nitro preset, the end-to-end tests script, Sentry's SDK and, for a single-page app,
 * whether it has a router, from the folder.
 */
async function inspectApp(root) {
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    // An app without a readable package.json: nothing to say
  }
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const framework = frameworkOf(names);
  const vercelJson = await readFile(join(root, 'vercel.json'), 'utf8').catch(() => null);
  const netlifyToml = await readFile(join(root, 'netlify.toml'), 'utf8').catch(() => null);
  const own = (await FRAMEWORKS[framework]?.inspect?.(root, { manifest, vercelJson, netlifyToml })) ?? {};
  const nitroPreset = own.nitroPreset ?? null;
  const app = { framework, staticBuild: Boolean(own.staticBuild) };
  // A route the app already has anywhere is not created again: next to one of another router, it breaks the build
  const present = await Promise.all(healthRouteFiles(app).map((file) => exists(join(root, file))));
  const existing = healthRouteFiles(app).find((_file, index) => present[index]);
  return {
    ...app,
    healthFile: existing ?? (await healthRouteFile(root, app)),
    healthRoute: Boolean(existing),
    vercelJson,
    netlifyToml,
    netlifyRedirects: await exists(join(root, 'public/_redirects')),
    nitroPreset,
    e2eScript: Boolean(manifest.scripts?.['test:e2e']),
    sentry: names.some((name) => Object.values(FRAMEWORKS).some(({ sentry }) => sentry.name === name)),
    spaRouter: Boolean(FRAMEWORKS[framework]?.spa) && names.some((name) => SPA_ROUTERS.includes(name)),
  };
}

const withToken = (a) => deploys(a) && a.deploy === 'vercel' && Boolean(a.deployToken?.trim());
const netlifyWithToken = (a) => deploys(a) && a.deploy === 'netlify' && Boolean(a.deployToken?.trim());

/** The Vercel token, then the projects it finds for the repository. */
const vercelTokenStep = {
  id: 'deployToken',
  when: (a) => deploys(a) && a.deploy === 'vercel',
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.password({
        message: question(
          header,
          `Vercel access token${dim(`  ${PROVIDERS.vercel.tokenHint}`)}`,
          ctx.state.environments?.production?.deployHook
            ? 'Empty: keeps the stored one, without looking for the projects'
            : 'Empty: setup lists what to set by hand at the end, and the deploys fail until then',
        ),
      }),
    ),
  then: async (answers, ctx) => {
    ctx.vercelProjects = [];
    if (!withToken(answers)) return;
    const spinner = clack.spinner();
    spinner.start(`Looking for the Vercel projects of ${answers.repository}`);
    try {
      ctx.vercelProjects = await vercelProjects(vercelApi(answers.deployToken.trim()), answers.repository);
    } catch (error) {
      spinner.error(error.message);
      return;
    }
    if (ctx.vercelProjects.length)
      spinner.stop(`Found ${ctx.vercelProjects.length} Vercel project(s) of ${answers.repository}`);
    else
      spinner.error(`No Vercel project is linked to ${answers.repository}: import it in Vercel, then run setup again`);
  },
};

/** The Vercel project the environments deploy: production and the staging custom environment of the same project. */
const vercelProjectStep = {
  id: 'vercelProject',
  when: (a, ctx) => withToken(a) && Boolean(ctx.vercelProjects?.length),
  ask: async ({ header, ctx }) => {
    const projects = ctx.vercelProjects;
    const index = orExit(
      await clack.select({
        message: question(header, 'Vercel project', 'Production and the staging custom environment of this project'),
        initialValue: 0,
        options: [
          ...projects.map((project, i) => ({
            value: i,
            label: project.team ? `${project.team} · ${project.name}` : project.name,
            hint: project.branch ? `branch ${project.branch}` : undefined,
          })),
          { value: -1, label: 'None of these', hint: 'setup lists what to set by hand at the end' },
        ],
      }),
    );
    return index === -1 ? null : projects[index];
  },
};

/** The project's Protection Bypass for Automation secret, sent with the health checks of protected environments. */
const vercelBypassStep = {
  id: 'vercelBypass',
  when: (a) => deploys(a) && a.deploy === 'vercel',
  ask: async ({ header }) =>
    orExit(
      await clack.password({
        message: question(
          header,
          `Protection Bypass for Automation secret${dim('  Vercel: Settings > Deployment Protection · empty to keep it or set it later')}`,
          'With Deployment Protection (staging always has it with Standard Protection), health checks without it answer 401 and every deploy is rolled back',
        ),
      }),
    ),
};

/** The Netlify token, then the sites it finds for the repository. */
const netlifyTokenStep = {
  id: 'deployToken',
  when: (a) => deploys(a) && a.deploy === 'netlify',
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.password({
        message: question(
          header,
          `Netlify personal access token${dim(`  ${PROVIDERS.netlify.tokenHint}`)}`,
          ctx.state.environments?.production?.deployHook
            ? 'Empty: keeps the stored one, without looking for the sites'
            : 'Empty: setup lists what to set by hand at the end, and the deploys fail until then',
        ),
      }),
    ),
  then: async (answers, ctx) => {
    ctx.netlifySites = [];
    if (!netlifyWithToken(answers)) return;
    const spinner = clack.spinner();
    spinner.start(`Looking for the Netlify sites of ${answers.repository}`);
    try {
      ctx.netlifySites = await netlifySites(netlifyApi(answers.deployToken.trim()), answers.repository);
    } catch (error) {
      spinner.error(error.message);
      return;
    }
    if (ctx.netlifySites.length)
      spinner.stop(`Found ${ctx.netlifySites.length} Netlify site(s) of ${answers.repository}`);
    else
      spinner.error(`No Netlify site is linked to ${answers.repository}: import it in Netlify, then run setup again`);
  },
};

/** The Netlify site of an environment: each environment deploys its own site. */
const netlifySiteStep = (environment) => ({
  id: environment === 'staging' ? 'netlifyStagingSite' : 'netlifySite',
  when: (a, ctx) =>
    netlifyWithToken(a) && Boolean(ctx.netlifySites?.length) && (environment !== 'staging' || Boolean(a.staging)),
  ask: async ({ header, answers, ctx }) => {
    // Staging is another site: the one production took is offered last
    const sites = ctx.netlifySites.filter((site) => environment !== 'staging' || site.id !== answers.netlifySite?.id);
    const index = orExit(
      await clack.select({
        message: question(header, `Netlify site of ${environment}`, 'Each environment deploys its own site'),
        initialValue: sites.length ? 0 : -1,
        options: [
          ...sites.map((site, i) => ({
            value: i,
            label: site.name,
            hint: [site.url, site.branch && `branch ${site.branch}`].filter(Boolean).join(' · ') || undefined,
          })),
          { value: -1, label: 'None of these', hint: 'setup lists what to set by hand at the end' },
        ],
      }),
    );
    return index === -1 ? null : sites[index];
  },
});

/** Whether to create the health route, when the app deploys to the framework's health path and has none. */
const healthRouteStep = {
  id: 'healthRoute',
  when: (a, ctx) =>
    deploys(a) && a.healthPath === healthPathOf(ctx.state) && !ctx.state.healthRoute && Boolean(ctx.state.healthFile),
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          `Create the health route ${healthPathOf(ctx.state)}?`,
          `Writes ${ctx.state.healthFile}, answering 200 while the app serves requests; the deploys check it`,
        ),
        initialValue: true,
      }),
    ),
};

/** Whether the tests run the test:e2e script, asked when package.json has one. */
const e2eStep = {
  id: 'e2e',
  when: (a, ctx) => ctx.state.e2eScript,
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          'Run the end-to-end tests (test:e2e) in the tests?',
          "After the build, with Playwright's browsers when the project uses Playwright; a failure fails the tests check",
        ),
        initialValue: ctx.state.current?.e2e ?? true,
      }),
    ),
};

/** The branches the workflows deploy: the development and production branches, or the default branch. */
const deployedBranches = (answers, state) =>
  answers.branches && answers.productionBranch
    ? [answers.developmentBranch, answers.productionBranch]
    : [state.defaultBranch].filter(Boolean);

// Every path to the single-page app's index.html; Vercel serves a file that exists (health.json, assets) before it
const SPA_REWRITE = { source: '/(.*)', destination: '/index.html' };

// Every path to the single-page app's index.html; Netlify, too, serves a file that exists before it
const NETLIFY_SPA_REDIRECT = `[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
`;

/**
 * netlify.toml with the redirect of every path to the single-page app's index.html, unless netlify.toml or
 * public/_redirects redirects the paths already. Netlify's own builds stay off through the sites' locked publishing.
 */
function netlifyTomlTask({ root, state }) {
  return {
    id: 'file:netlify.toml',
    title: 'netlify.toml',
    run: async () => {
      if (state.netlifyRedirects || /^\s*\[\[redirects\]\]/m.test(state.netlifyToml ?? '')) return 'unchanged';
      const current = state.netlifyToml ?? '';
      const separator = current && !current.endsWith('\n\n') ? (current.endsWith('\n') ? '\n' : '\n\n') : '';
      await writeFile(join(root, 'netlify.toml'), `${current}${separator}${NETLIFY_SPA_REDIRECT}`);
      return `${state.netlifyToml === null ? 'created' : 'updated'}: every path redirected to index.html`;
    },
  };
}

/**
 * vercel.json without Vercel's own deploys of the branches the workflows deploy, so a push is deployed only after the
 * tests; the pull requests keep their preview deployments. A single-page app with a router also gets the rewrite of
 * every path to index.html, so a link to one of its routes does not answer 404, unless vercel.json routes the paths
 * already.
 */
function vercelJsonTask(answers, { root, state }) {
  return {
    id: 'file:vercel.json',
    title: 'vercel.json',
    run: async () => {
      let config = {};
      if (state.vercelJson !== null) {
        try {
          config = JSON.parse(state.vercelJson);
        } catch {
          throw new Error('vercel.json is not valid JSON: fix it, then run setup again');
        }
      }
      const changes = [];
      const current = config.git?.deploymentEnabled;
      // false: every automatic deploy already off
      if (current !== false) {
        const enabled = typeof current === 'object' && current !== null ? { ...current } : {};
        const branches = deployedBranches(answers, state).filter((branch) => enabled[branch] !== false);
        if (branches.length) {
          for (const branch of branches) enabled[branch] = false;
          config.git = { ...config.git, deploymentEnabled: enabled };
          changes.push(`no automatic deploys of ${branches.join(', ')}`);
        }
      }
      if (state.spaRouter && !config.rewrites && !config.routes) {
        config.rewrites = [SPA_REWRITE];
        changes.push('every path rewritten to index.html');
      }
      if (!changes.length) return 'unchanged';
      await writeFile(join(root, 'vercel.json'), `${JSON.stringify(config, null, 2)}\n`);
      return `${state.vercelJson === null ? 'created' : 'updated'}: ${changes.join('; ')}`;
    },
  };
}

/** The health route of the framework, answering 200. */
function healthRouteTask(root, file, state) {
  return {
    id: `file:${file}`,
    title: `Health route ${healthPathOf(state)}`,
    run: async () => {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, healthRouteContent(file, state));
      return `created ${file}`;
    },
  };
}

/** The branch the workflows deploy to the environment. */
const branchOf = (answers, state, environment) =>
  answers.branches && answers.productionBranch
    ? environment === 'staging'
      ? answers.developmentBranch
      : answers.productionBranch
    : state.defaultBranch;

/** What Netlify still needs: the secrets left empty, and a site whose production branch is not the one it deploys. */
function netlifyNextSteps(answers, state) {
  const steps = PROVIDERS.netlify.manualSteps({ answers, state });
  for (const environment of answers.staging ? ['production', 'staging'] : ['production']) {
    const site = environment === 'staging' ? answers.netlifyStagingSite : answers.netlifySite;
    const branch = branchOf(answers, state, environment);
    if (site?.branch && branch && site.branch !== branch) {
      steps.push(
        `In Netlify, set the production branch of ${bold(site.name)} to ${bold(branch)} (${bold('Site configuration > Build & deploy > Branches and deploy contexts')}): ${environment} deploys ${branch}, which otherwise builds as a branch deploy, with that context's variables.`,
      );
    }
  }
  return steps;
}

/** What the deploy target still needs: Vercel's secrets left empty and staging domain, or Netlify's. */
function deployNextSteps(answers, { results = [], state }) {
  if (!PROVIDERS[answers.deploy]) return [];
  if (answers.deploy === 'netlify') return netlifyNextSteps(answers, state);
  const steps = PROVIDERS.vercel.manualSteps({ answers, state });
  const staging = results.find((result) => result.id === 'vercelStaging');
  if (answers.staging && (!staging?.ok || staging.data?.domain === false)) {
    steps.push(
      `In Vercel, open the project's ${bold('Settings > Environments')}: the ${bold('staging')} custom environment (Pro and Enterprise teams) needs the domain ${bold(answers.stagingDomain ?? 'of staging')}${staging && !staging.ok ? `. Setup could not check it (${staging.detail})` : ''}.`,
    );
  }
  return steps;
}

/** Sentry's SDK, when its problems become issues and the app does not have it yet. */
function sentryNextSteps(answers, { state }) {
  if (answers.monitoring !== 'sentry' || !answers.incidents || state.sentry) return [];
  const sdk = FRAMEWORKS[state.framework]?.sentry;
  if (!sdk) return ["Install Sentry's SDK in the app, or nothing reaches Sentry."];
  const command = sdk.wizard ? `npx @sentry/wizard@latest -i ${sdk.wizard}` : `npm install ${sdk.name}`;
  return [`Install Sentry's SDK in the app, or nothing reaches Sentry: ${cyan(command)}`];
}

/**
 * Whether the health route exists, for an app that deploys to the framework's health path, and whether the build of
 * the framework suits the deploy target (a Nuxt app's Nitro preset).
 */
function evaluateDeploy({ ok, warn }, state) {
  const target = state.current?.deploy;
  const warning = PROVIDERS[target] && FRAMEWORKS[state.framework]?.deployWarning?.(state, target, PROVIDERS[target]);
  if (warning) warn(...warning);
  if (!state.healthFile) return;
  if (state.healthRoute) ok(`Health route ${healthPathOf(state)} (${state.healthFile})`);
  else
    warn(
      `No health route at ${state.healthFile}: every deploy fails its health checks unless HEALTH_URL points to another`,
      'run setup again',
    );
}

/** Whether Sentry's SDK is in the app, when Sentry is on. */
function evaluateMonitoring({ ok, warn }, state) {
  if ((state.current?.monitoring ?? 'sentry') !== 'sentry') return;
  const sdk =
    FRAMEWORKS[state.framework]?.sentry.name ??
    Object.values(FRAMEWORKS)
      .map(({ sentry }) => sentry.name)
      .join(' or ');
  if (state.sentry) ok(`${sdk} in package.json`);
  else warn(`package.json does not require ${sdk}, so nothing reaches Sentry`, `npm install ${sdk}`);
}

export default projectKind({
  id: 'js',
  deployTargets: Object.values(PROVIDERS).map((provider) => ({ value: provider.id, label: provider.label })),
  deployProviders: PROVIDERS,
  deployHookHint: '',
  monitoring: monitoringServices(['sentry']),
  empty: {
    framework: null,
    staticBuild: false,
    healthFile: null,
    healthRoute: false,
    vercelJson: null,
    netlifyToml: null,
    netlifyRedirects: false,
    nitroPreset: null,
    e2eScript: false,
    sentry: false,
    spaRouter: false,
  },
  inspect: inspectApp,
  healthPath: (ctx) => healthPathOf(ctx.state),
  deploySteps: () => [
    vercelTokenStep,
    vercelProjectStep,
    vercelBypassStep,
    netlifyTokenStep,
    netlifySiteStep('production'),
    netlifySiteStep('staging'),
  ],
  steps: () => [healthRouteStep, e2eStep],
  tasks: (answers, { root, state }) => [
    ...(withToken(answers) && answers.vercelProject && answers.staging
      ? [vercelStagingTask(vercelApi(answers.deployToken.trim()), answers.vercelProject)]
      : []),
    ...(deploys(answers) && answers.deploy === 'vercel' ? [vercelJsonTask(answers, { root, state })] : []),
    ...(netlifyWithToken(answers)
      ? [
          [answers.netlifySite, 'production'],
          [answers.staging ? answers.netlifyStagingSite : null, 'staging'],
        ]
          .filter(([site]) => site)
          .map(([site, environment]) => netlifyLockTask(netlifyApi(answers.deployToken.trim()), site, environment))
      : []),
    ...(deploys(answers) && answers.deploy === 'netlify' && state.spaRouter ? [netlifyTomlTask({ root, state })] : []),
    ...(answers.healthRoute && state.healthFile ? [healthRouteTask(root, state.healthFile, state)] : []),
  ],
  files: {},
  deployNextSteps,
  nextSteps: sentryNextSteps,
  evaluateDeploy,
  evaluateMonitoring,
});
