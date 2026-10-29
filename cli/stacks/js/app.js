import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deploys, projectKind } from '../../kinds/project/index.js';
import { deployProviders } from '../../providers/deploy/index.js';
import { vercelApi, vercelProjects, vercelStagingTask } from '../../providers/deploy/vercel.js';
import { monitoringServices } from '../../providers/monitoring/index.js';
import { bold, clack, cyan, dim, orExit, question } from '../../lib/ui.js';

// What a JavaScript app (Next, Nuxt) adds to project.yml (cli/kinds/project/index.js): Vercel deploys (its token,
// project and protection bypass, vercel.json and the health route), Sentry, and whether the tests run its end-to-end
// tests

// The deploy targets of a JavaScript app (cli/providers/deploy)
const PROVIDERS = deployProviders(['vercel']);

// Sentry's SDK and wizard of each framework
const SENTRY = {
  next: { name: '@sentry/nextjs', wizard: 'nextjs' },
  nuxt: { name: '@sentry/nuxt', wizard: 'nuxt' },
};

const HEALTH_PATH = '/api/health';
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Where the health route goes for the framework and router of the app, in TypeScript when it has a tsconfig.json. */
async function healthRouteFile(root, framework) {
  const ext = (await exists(join(root, 'tsconfig.json'))) ? 'ts' : 'js';
  if (framework === 'nuxt') return `server/api/health.get.${ext}`;
  if (framework !== 'next') return null;
  for (const base of ['src/app', 'app']) if (await exists(join(root, base))) return `${base}/api/health/route.${ext}`;
  for (const base of ['src/pages', 'pages']) if (await exists(join(root, base))) return `${base}/api/health.${ext}`;
  return `app/api/health/route.${ext}`;
}

// What the health route answers: 200 while the app serves requests, never cached
const HEALTH_ROUTES = {
  'route.ts': `// Health check of the Datalogix deploys: answers 200 while the app serves requests
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
`,
  'health.ts': `import type { NextApiRequest, NextApiResponse } from 'next';

// Health check of the Datalogix deploys: answers 200 while the app serves requests
export default function handler(_request: NextApiRequest, response: NextApiResponse) {
  response.status(200).json({ status: 'ok' });
}
`,
  'health.get.ts': `// Health check of the Datalogix deploys: answers 200 while the app serves requests
export default defineEventHandler(() => ({ status: 'ok' }));
`,
};
HEALTH_ROUTES['route.js'] = HEALTH_ROUTES['route.ts'];
HEALTH_ROUTES['health.js'] = `// Health check of the Datalogix deploys: answers 200 while the app serves requests
export default function handler(_request, response) {
  response.status(200).json({ status: 'ok' });
}
`;
HEALTH_ROUTES['health.get.js'] = HEALTH_ROUTES['health.get.ts'];

/** The framework, its health route, vercel.json, the end-to-end tests script and Sentry's SDK, from the folder. */
async function inspectApp(root) {
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    // An app without a readable package.json: nothing to say
  }
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const framework = ['next', 'nuxt'].find((name) => names.includes(name)) ?? null;
  const healthFile = await healthRouteFile(root, framework);
  // The route at either extension, so a JavaScript one is not created again in TypeScript
  const otherFile = healthFile?.replace(/\.(ts|js)$/, (ext) => (ext === '.ts' ? '.js' : '.ts'));
  const healthRoute =
    Boolean(healthFile) && ((await exists(join(root, healthFile))) || (await exists(join(root, otherFile))));
  return {
    framework,
    healthFile,
    healthRoute: Boolean(healthRoute),
    vercelJson: await readFile(join(root, 'vercel.json'), 'utf8').catch(() => null),
    e2eScript: Boolean(manifest.scripts?.['test:e2e']),
    sentry: names.some((name) => name === SENTRY.next.name || name === SENTRY.nuxt.name),
  };
}

const withToken = (a) => deploys(a) && a.deploy === 'vercel' && Boolean(a.deployToken?.trim());

/** The Vercel token, then the projects it finds for the repository. */
const vercelTokenStep = {
  id: 'deployToken',
  when: (a) => deploys(a) && a.deploy === 'vercel',
  ask: async ({ header }) =>
    orExit(
      await clack.password({
        message: question(
          header,
          `Vercel access token${dim(`  ${PROVIDERS.vercel.tokenHint}`)}`,
          'Empty: setup lists what to set by hand at the end, and the deploys fail until then',
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

/** Whether to create the health route, when the app deploys to /api/health and has none. */
const healthRouteStep = {
  id: 'healthRoute',
  when: (a, ctx) =>
    deploys(a) && a.healthPath === HEALTH_PATH && !ctx.state.healthRoute && Boolean(ctx.state.healthFile),
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          `Create the health route ${HEALTH_PATH}?`,
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

/**
 * vercel.json without Vercel's own deploys of the branches the workflows deploy, so a push is deployed only after the
 * tests; the pull requests keep their preview deployments.
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
      const current = config.git?.deploymentEnabled;
      // Every automatic deploy already off
      if (current === false) return 'unchanged';
      const enabled = typeof current === 'object' && current !== null ? { ...current } : {};
      const branches = deployedBranches(answers, state).filter((branch) => enabled[branch] !== false);
      if (!branches.length) return 'unchanged';
      for (const branch of branches) enabled[branch] = false;
      config.git = { ...config.git, deploymentEnabled: enabled };
      await writeFile(join(root, 'vercel.json'), `${JSON.stringify(config, null, 2)}\n`);
      return `${state.vercelJson === null ? 'created' : 'updated'}: no automatic deploys of ${branches.join(', ')}`;
    },
  };
}

/** The health route of the framework, answering 200. */
function healthRouteTask(root, file) {
  return {
    id: `file:${file}`,
    title: `Health route ${HEALTH_PATH}`,
    run: async () => {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, HEALTH_ROUTES[file.split('/').at(-1)]);
      return `created ${file}`;
    },
  };
}

/** What Vercel still needs: the secrets left empty, and the staging environment's domain. */
function deployNextSteps(answers, { results = [] }) {
  if (!deploys(answers)) return [];
  const steps = PROVIDERS.vercel.manualSteps({ answers });
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
  const sdk = SENTRY[state.framework];
  return [
    sdk
      ? `Install Sentry's SDK in the app, or nothing reaches Sentry: ${cyan(`npx @sentry/wizard@latest -i ${sdk.wizard}`)}`
      : "Install Sentry's SDK in the app, or nothing reaches Sentry.",
  ];
}

/** Whether the health route exists, for an app that deploys to /api/health. */
function evaluateDeploy({ ok, warn }, state) {
  if (!state.healthFile) return;
  if (state.healthRoute) ok(`Health route ${HEALTH_PATH} (${state.healthFile})`);
  else
    warn(
      `No health route at ${state.healthFile}: every deploy fails its health checks unless HEALTH_URL points to another`,
      'run setup again',
    );
}

/** Whether Sentry's SDK is in the app, when Sentry is on. */
function evaluateMonitoring({ ok, warn }, state) {
  if ((state.current?.monitoring ?? 'sentry') !== 'sentry') return;
  const sdk = SENTRY[state.framework]?.name ?? '@sentry/nextjs or @sentry/nuxt';
  if (state.sentry) ok(`${sdk} in package.json`);
  else warn(`package.json does not require ${sdk}, so nothing reaches Sentry`, `npm install ${sdk}`);
}

export default projectKind({
  id: 'js',
  deployTargets: Object.values(PROVIDERS).map((provider) => ({ value: provider.id, label: provider.label })),
  deployProviders: PROVIDERS,
  deployHookHint: '',
  monitoring: monitoringServices(['sentry']),
  empty: { framework: null, healthFile: null, healthRoute: false, vercelJson: null, e2eScript: false, sentry: false },
  inspect: inspectApp,
  healthPath: () => HEALTH_PATH,
  deploySteps: () => [vercelTokenStep, vercelProjectStep, vercelBypassStep],
  steps: () => [healthRouteStep, e2eStep],
  tasks: (answers, { root, state }) => [
    ...(withToken(answers) && answers.vercelProject && answers.staging
      ? [vercelStagingTask(vercelApi(answers.deployToken.trim()), answers.vercelProject)]
      : []),
    ...(deploys(answers) ? [vercelJsonTask(answers, { root, state })] : []),
    ...(answers.healthRoute && state.healthFile ? [healthRouteTask(root, state.healthFile)] : []),
  ],
  files: {},
  deployNextSteps,
  nextSteps: sentryNextSteps,
  evaluateDeploy,
  evaluateMonitoring,
});
