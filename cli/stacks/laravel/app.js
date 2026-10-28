import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deploys, projectKind } from '../../kinds/project/index.js';
import { SETUP } from '../../lib/evaluate.js';
import { bold, clack, cyan, dim, orExit, question } from '../../lib/ui.js';
import { cloudApi, cloudEnvironments, cloudEnvironmentTask } from './cloud.js';
import {
  forgeApi,
  forgeDeployHook,
  forgeNightwatchTask,
  forgeSites,
  forgeSiteTask,
  STANDARD_SNIPPET,
  ZERO_DOWNTIME_SNIPPET,
} from './forge.js';
import { addDatabaseCheck, inspectHealth, PROVIDER_PATH } from './health.js';
import { inspectTools, NO_TOOLS, toolSteps } from './tools.js';

// What a Laravel app adds to project.yml (cli/kinds/project/index.js): Forge and Laravel Cloud deploys, Nightwatch, the
// health check of bootstrap/app.php and the lint and test tools

const BY_HAND = 'see docs/laravel/app-manual-setup.md in datalogix/workflows';

/** The app's locale (APP_LOCALE in .env), or null without one. */
async function readLocale(root) {
  let env;
  try {
    env = await readFile(join(root, '.env'), 'utf8');
  } catch {
    return null;
  }
  return /^APP_LOCALE\s*=\s*["']?([^"'\s#]+)/m.exec(env)?.[1] ?? null;
}

// The package.json scripts laravel-app-tests runs (input js); npm init's test script only fails
const NODE_SCRIPTS = ['typecheck', 'lint', 'test'];

/** The scripts of package.json the tests would run. */
async function nodeScripts(root) {
  try {
    const { scripts = {} } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return NODE_SCRIPTS.filter((name) => scripts[name] && !String(scripts[name]).includes('no test specified'));
  } catch {
    return [];
  }
}

/** Whether the tests run the package.json scripts, asked when it has some. */
const jsStep = {
  id: 'js',
  flag: 'js',
  when: (a, ctx) => Boolean(ctx.state.nodeScripts?.length),
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          `Run the package.json scripts in the tests?${dim(`  ${ctx.state.nodeScripts.map((name) => `npm run ${name}`).join(', ')}`)}`,
        ),
        initialValue: ctx.state.current?.js ?? true,
      }),
    ),
};

/** Whether composer.json requires Nightwatch's agent, without which no problem or deploy reaches Nightwatch. */
async function requiresNightwatch(root) {
  try {
    return 'laravel/nightwatch' in (JSON.parse(await readFile(join(root, 'composer.json'), 'utf8')).require ?? {});
  } catch {
    return false;
  }
}

/** Whether to make the health check fail when the database is down, when it does not yet. */
const databaseCheckStep = {
  id: 'databaseCheck',
  when: (a, ctx) => deploys(a) && ctx.state.health.laravel && !ctx.state.health.databaseCheck,
  ask: async ({ header }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          `Make the health check fail when the database is down?${dim(`  edits ${PROVIDER_PATH}`)}`,
        ),
        initialValue: true,
      }),
    ),
};

/** Adds the database check to AppServiceProvider, as the answer asks. */
function healthCheckTask(root) {
  return {
    id: 'healthCheck',
    title: 'Health check',
    run: async () => {
      const path = join(root, PROVIDER_PATH);
      const byHand = `add the check by hand (${BY_HAND})`;
      let content;
      try {
        content = await readFile(path, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`${PROVIDER_PATH} does not exist; ${byHand}`, { cause: error });
        throw error;
      }
      const updated = addDatabaseCheck(content);
      if (updated === null) throw new Error(`${PROVIDER_PATH} has no boot() method to extend; ${byHand}`);
      await writeFile(path, updated);
      return `database check added to ${PROVIDER_PATH}`;
    },
  };
}

// What setup can do through each target's API with a token of the user's (used during setup only, never stored)
const PROVIDERS = {
  forge: {
    name: 'Forge',
    kind: 'site',
    tokenHint:
      'with site:manage-deploys and, for Nightwatch, server:view and site:manage-environment; turns off Push to deploy, fixes the deploy script, reads the deploy hooks and sets NIGHTWATCH_TOKEN',
    api: forgeApi,
    find: forgeSites,
    hook: forgeDeployHook,
    label: (site) => site.name,
    task: forgeSiteTask,
    nightwatchTask: forgeNightwatchTask,
  },
  cloud: {
    name: 'Laravel Cloud',
    kind: 'environment',
    tokenHint: 'turns off Push to deploy and sets the branch of each environment',
    api: cloudApi,
    find: cloudEnvironments,
    hook: null,
    label: (environment) => `${environment.application} · ${environment.name}`,
    task: cloudEnvironmentTask,
    nightwatchTask: null,
  },
};

const withToken = (a) => deploys(a) && Boolean(PROVIDERS[a.deploy]) && Boolean(a.deployToken?.trim());
const environmentsOf = (a) => (a.staging ? ['production', 'staging'] : ['production']);

/**
 * The branch an environment deploys: with two branches, the development one to staging and the production one to
 * production; otherwise the default branch (null: whatever the site has).
 */
function branchOf(a, environment, state) {
  if (a.branches && a.productionBranch) return environment === 'staging' ? a.developmentBranch : a.productionBranch;
  return state.defaultBranch ?? null;
}

/** The API token of the deploy target, then the sites (or environments) it finds for the repository. */
const deployTokenStep = {
  id: 'deployToken',
  when: (a) => deploys(a) && Boolean(PROVIDERS[a.deploy]),
  ask: async ({ header, answers }) => {
    const provider = PROVIDERS[answers.deploy];
    return orExit(
      await clack.password({
        message: question(
          header,
          `${provider.name} API token${dim(`  optional: ${provider.tokenHint}; empty to do it by hand`)}`,
        ),
      }),
    );
  },
  then: async (answers, ctx) => {
    ctx.deployTargets = [];
    if (!withToken(answers)) return;
    const provider = PROVIDERS[answers.deploy];
    const spinner = clack.spinner();
    spinner.start(`Looking for the ${provider.name} ${provider.kind}s of ${answers.repository}`);
    try {
      ctx.deployTargets = await provider.find(provider.api(answers.deployToken.trim()), answers.repository);
    } catch (error) {
      // Setup goes on: what the token would do is left to do by hand, with the reason (deployNextSteps)
      spinner.error(error.message);
      answers.deployToken = '';
      answers.deployProblem = error.message;
      return;
    }
    if (ctx.deployTargets.length) {
      spinner.stop(`Found ${ctx.deployTargets.length} ${provider.name} ${provider.kind}(s) of ${answers.repository}`);
    } else {
      answers.deployProblem = `no ${provider.name} ${provider.kind} deploys ${answers.repository}`;
      spinner.error(`${answers.deployProblem}: set it up by hand`);
      answers.deployToken = '';
    }
  },
};

/** Which site (or environment) of the target an environment deploys to; with Forge, its deploy hook comes along. */
function deploySiteStep(environment) {
  return {
    id: `${environment}Site`,
    when: (a, ctx) => withToken(a) && environmentsOf(a).includes(environment) && Boolean(ctx.deployTargets?.length),
    ask: async ({ header, answers, ctx }) => {
      const provider = PROVIDERS[answers.deploy];
      const taken = environment === 'staging' ? answers.productionSite : null;
      const targets = ctx.deployTargets.filter((target) => target !== taken);
      const branch = branchOf(answers, environment, ctx.state);
      const initial =
        targets.find((target) => target.branch === branch && target.name.toLowerCase().includes(environment)) ??
        targets.find((target) => target.branch === branch) ??
        targets.find((target) => target.name.toLowerCase().includes(environment));
      const index = orExit(
        await clack.select({
          message: question(header, `${provider.name} ${provider.kind} of ${environment}`),
          initialValue: initial ? targets.indexOf(initial) : -1,
          options: [
            ...targets.map((target, i) => ({
              value: i,
              label: provider.label(target),
              hint: target.branch ? `branch ${target.branch}` : undefined,
            })),
            { value: -1, label: 'None of these', hint: 'set it up by hand' },
          ],
        }),
      );
      return index === -1 ? null : targets[index];
    },
    then: async (answers) => {
      const provider = PROVIDERS[answers.deploy];
      const site = answers[`${environment}Site`];
      if (!site || !provider.hook) return;
      try {
        answers.deployHooks = {
          ...answers.deployHooks,
          [environment]: await provider.hook(provider.api(answers.deployToken.trim()), site),
        };
      } catch (error) {
        // The hook question asks for it instead
        clack.log.warn(`Could not read the deploy hook of ${site.name}: ${error.message}`);
      }
    },
  };
}

/** The changes in the deploy target the chosen sites (or environments) need. */
function deploySiteTasks(answers, { state }) {
  if (!withToken(answers)) return [];
  const provider = PROVIDERS[answers.deploy];
  const api = provider.api(answers.deployToken.trim());
  return environmentsOf(answers)
    .filter((environment) => answers[`${environment}Site`])
    .flatMap((environment) => {
      const site = answers[`${environment}Site`];
      return [
        provider.task(api, site, environment, cloudBranch(answers, environment, state)),
        ...(usesNightwatch(answers) && provider.nightwatchTask
          ? [provider.nightwatchTask(api, site, environment, answers[`${environment}MonitoringToken`]?.trim())]
          : []),
      ];
    });
}

// Problems become issues, or deploys are marked: both need Nightwatch's agent in the app, with its token
const usesNightwatch = (a) => Boolean(a.incidents || a.monitoringMarkers);

/** What Nightwatch needs in the app and its servers that setup did not do: the agent, and each environment's token. */
function nightwatchNextSteps(answers, { state, results = [] }) {
  if (!usesNightwatch(answers)) return [];
  const steps = [];
  if (!state.nightwatch) {
    steps.push(
      `Install Nightwatch's agent in the app, or nothing reaches Nightwatch: ${cyan('composer require laravel/nightwatch')}`,
    );
  }
  const resultOf = (environment) => results.find((result) => result.id === `nightwatchEnv:${environment}`);
  const left = deploys(answers)
    ? environmentsOf(answers).filter((environment) => !resultOf(environment)?.ok || resultOf(environment).data?.missing)
    : [];
  const problems = left
    .filter((environment) => resultOf(environment) && !resultOf(environment).ok)
    .map((environment) => `${environment}: ${resultOf(environment).detail}`);
  const where =
    answers.deploy === 'forge'
      ? 'the Forge site'
      : answers.deploy === 'cloud'
        ? 'the Laravel Cloud environment'
        : 'the server';
  if (!deploys(answers) || left.length) {
    steps.push(
      [
        `Set ${bold('NIGHTWATCH_TOKEN')} (the application's token in Nightwatch) in the environment of ${where}${left.length ? ` of ${left.map((environment) => bold(environment)).join(' and ')}` : ''}, if it is not there yet.`,
        ...(problems.length ? [dim(`  Setup could not do it through the API (${problems.join('; ')}).`)] : []),
      ].join('\n'),
    );
  }
  return steps;
}

/** The branch a Cloud environment must track: both with two branches, staging otherwise (Forge gets it in the hook). */
function cloudBranch(answers, environment, state) {
  if (answers.branches && answers.productionBranch) return branchOf(answers, environment, state);
  return environment === 'staging' ? branchOf(answers, environment, state) : null;
}

/** What Forge or Laravel Cloud need by hand, so they deploy only what the workflows ask for: what setup did not do. */
function deployNextSteps(answers, { twoBranches, results = [] }) {
  const resultOf = (environment) => results.find((result) => result.id === `deploySite:${environment}`);
  const left = environmentsOf(answers).filter((environment) => !resultOf(environment)?.ok);
  if (!left.length) return [];
  // Why the API did not do it: the token or the search failed, or the task of that environment did
  const problems = [
    answers.deployProblem,
    ...left
      .filter((environment) => resultOf(environment))
      .map((environment) => `${environment}: ${resultOf(environment).detail}`),
  ].filter(Boolean);
  const why = problems.length ? [dim(`  Setup could not do it through the API (${problems.join('; ')}).`)] : [];
  // Staging first, each with the branch it deploys; only read with two branches
  const branchesOf = (phrase) =>
    ['staging', 'production']
      .filter((environment) => left.includes(environment))
      .map((environment) =>
        phrase(environment, bold(environment === 'staging' ? answers.developmentBranch : answers.productionBranch)),
      );
  const which = (kind) =>
    left.length === 2 ? `both ${kind}s` : answers.staging ? `the ${left[0]} ${kind}` : `the ${kind}`;
  if (answers.deploy === 'forge') {
    const branches = () => branchesOf((environment, branch) => `${environment} site on ${branch}`).join(', ');
    return [
      [
        `In Forge, for ${which('site')}: turn off ${bold('Push to deploy')}${twoBranches ? ` (${branches()})` : ''}, and in the deploy script, on zero-downtime sites, add right after ${bold('cd $FORGE_RELEASE_DIRECTORY')}:`,
        dim(ZERO_DOWNTIME_SNIPPET.replace(/^/gm, '  ')),
        `  On standard sites, replace ${bold('git pull origin $FORGE_SITE_BRANCH')} with:`,
        dim(STANDARD_SNIPPET.replace(/^/gm, '  ')),
        ...why,
      ].join('\n'),
    ];
  }
  if (answers.deploy === 'cloud') {
    const branches = () => branchesOf((environment, branch) => `${environment} track ${branch}`).join(' and ');
    return [
      [
        `In Laravel Cloud, for ${which('environment')}: turn off ${bold('Push to deploy')}${twoBranches ? `, make ${branches()}` : left.includes('staging') ? ', and make staging track the default branch' : ''}.`,
        ...why,
      ].join('\n'),
    ];
  }
  return [];
}

/** The health check items of check, for an app that deploys. */
function evaluateDeploy({ ok, warn }, state) {
  if (!state.health.laravel) {
    warn('Could not read bootstrap/app.php from this folder', 'run check from the project folder');
    return;
  }
  if (!state.health.route) warn('bootstrap/app.php has no health route', "add health: '/up' to withRouting()");
  if (!state.health.databaseCheck) warn('The health check does not check the database', SETUP);
  if (state.health.route && state.health.databaseCheck) ok(`Health check ${state.health.route} checks the database`);
}

/** Whether Nightwatch's agent is in the app, when Nightwatch is on. */
function evaluateMonitoring({ ok, warn }, state) {
  // composer.json is read from the folder: without the app, nothing to say
  if (!state.health.laravel) return;
  if (state.nightwatch) ok('laravel/nightwatch in composer.json');
  else
    warn(
      'composer.json does not require laravel/nightwatch, so nothing reaches Nightwatch',
      'composer require laravel/nightwatch',
    );
}

export default projectKind({
  deployTargets: [
    { value: 'forge', label: 'Laravel Forge' },
    { value: 'cloud', label: 'Laravel Cloud' },
  ],
  deployHookHint: 'Forge: site Settings > Deployments · Cloud: environment Settings > Deployments',
  monitoring: {
    id: 'nightwatch',
    name: 'Nightwatch',
    secret: 'NIGHTWATCH_TOKEN',
    tokenHint: "the app's NIGHTWATCH_TOKEN",
    webhookHint: `In Nightwatch, open the application's ${bold('Issues settings > Webhooks')} and set the URL to:`,
    // Deploy markers need the Nightwatch token of a Forge site
    markers: (answers) => answers.deploy === 'forge',
  },
  empty: {
    health: { laravel: false, route: null, databaseCheck: false },
    tools: NO_TOOLS,
    nightwatch: false,
    nodeScripts: [],
  },
  /** What collectState reads from the folder for a Laravel app: its health check, its locale and its tools. */
  inspect: async (root) => ({
    health: await inspectHealth(root),
    locale: await readLocale(root),
    nightwatch: await requiresNightwatch(root),
    nodeScripts: await nodeScripts(root),
    tools: await inspectTools(root),
  }),
  healthPath: (ctx) => ctx.state.health.route ?? '/up',
  deploySteps: () => [deployTokenStep, deploySiteStep('production'), deploySiteStep('staging')],
  steps: () => [databaseCheckStep, ...toolSteps('project'), jsStep],
  tasks: (answers, { root, state }) => [
    ...deploySiteTasks(answers, { state }),
    ...(answers.databaseCheck ? [healthCheckTask(root)] : []),
  ],
  files: { healthCheck: PROVIDER_PATH },
  deployNextSteps,
  nextSteps: (answers, { state, results }) => [
    ...(deploys(answers) && !state.health.laravel
      ? [`Make ${answers.healthPath} answer 200 only when the app works (${BY_HAND}).`]
      : []),
    ...nightwatchNextSteps(answers, { state, results }),
  ],
  evaluateDeploy,
  evaluateMonitoring,
});
