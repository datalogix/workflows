import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { answeredEnvironments, deploys, projectKind } from '../../kinds/project/index.js';
import { SETUP } from '../../lib/evaluate.js';
import { bold, clack, cyan, dim, orExit, question } from '../../lib/ui.js';
import { deployProviders } from '../../providers/deploy/index.js';
import { deploySites } from '../../providers/deploy/sites.js';
import { MONITORING_SERVICES, monitoringServices } from '../../providers/monitoring/index.js';
import { addDatabaseCheck, inspectHealth, PROVIDER_PATH } from './health.js';
import { inspectTools, NO_TOOLS, toolSteps } from './tools.js';

// What a Laravel app adds to project.yml (cli/kinds/project/index.js): Forge and Laravel Cloud deploys, Nightwatch, Sentry or Inspector, the
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

// The package.json scripts laravel-app-tests and laravel-package-tests run (input js), each the first of its names that
// is defined: types:check and check (Vite+'s vp check) are the Laravel starter kits' names, type-check create-vue's;
// npm init's test script only fails
const NODE_SCRIPTS = [['typecheck', 'types:check', 'type-check'], ['lint', 'check'], ['test']];

/** The scripts of package.json the tests would run. */
export async function nodeScripts(root) {
  try {
    const { scripts = {} } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const defined = (name) => scripts[name] && !String(scripts[name]).includes('no test specified');
    return NODE_SCRIPTS.map((names) => names.find(defined)).filter(Boolean);
  } catch {
    return [];
  }
}

/** Whether the tests run the package.json scripts, asked when it has some. */
export const jsStep = {
  id: 'js',
  flag: 'js',
  when: (a, ctx) => Boolean(ctx.state.nodeScripts?.length),
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          'Run the package.json scripts in the tests?',
          `${ctx.state.nodeScripts.map((name) => `npm run ${name}`).join(', ')} with the PHP checks; a failure fails the tests check`,
        ),
        initialValue: ctx.state.current?.js ?? true,
      }),
    ),
};

// The package each monitoring service needs in the app, without which nothing reaches it
const AGENTS = {
  nightwatch: 'laravel/nightwatch',
  sentry: 'sentry/sentry-laravel',
  inspector: 'inspector-apm/inspector-laravel',
};
const monitoringOf = (a) => a?.monitoring ?? 'nightwatch';

/** Whether composer.json requires the package, e.g. Nightwatch's agent. */
export async function requiresPackage(root, name) {
  try {
    return name in (JSON.parse(await readFile(join(root, 'composer.json'), 'utf8')).require ?? {});
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
          'Make the health check fail when the database is down?',
          `A deploy that breaks the database connection is rolled back; edits ${PROVIDER_PATH}`,
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
      if (updated === null) {
        throw new Error(
          `${PROVIDER_PATH} has no boot() method, or imports setup cannot extend (grouped, or another DB or Event class); ${byHand}`,
        );
      }
      await writeFile(path, updated);
      return `database check added to ${PROVIDER_PATH}`;
    },
  };
}

// The deploy targets of a Laravel app (cli/providers/deploy), with Nightwatch's token in each chosen site
const PROVIDERS = deployProviders(['forge', 'cloud']);

// Problems become issues, or deploys are marked: both need Nightwatch's agent in the app, with its token
const usesNightwatch = (a) => monitoringOf(a) === 'nightwatch' && Boolean(a.incidents || a.monitoringMarkers);

const SITES = deploySites(PROVIDERS, {
  siteTasks: (provider, api, site, environment, answers) =>
    usesNightwatch(answers) && provider.nightwatchTask
      ? [provider.nightwatchTask(api, site, environment, answers[`${environment}MonitoringToken`]?.trim())]
      : [],
});

/** The SDK of Sentry or Inspector, when its problems become issues and the app does not require it yet. */
function sdkNextSteps(answers, { state }) {
  const service = MONITORING_SERVICES[monitoringOf(answers)];
  if (!['sentry', 'inspector'].includes(service?.id) || !answers.incidents || state[service.id]) return [];
  return [
    `Install ${service.name}'s SDK in the app, or nothing reaches ${service.name}: ${cyan(`composer require ${AGENTS[service.id]}`)}`,
  ];
}

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
    ? answeredEnvironments(answers).filter(
        (environment) => !resultOf(environment)?.ok || resultOf(environment).data?.missing,
      )
    : [];
  const problems = left
    .filter((environment) => resultOf(environment) && !resultOf(environment).ok)
    .map((environment) => `${environment}: ${resultOf(environment).detail}`);
  const where = PROVIDERS[answers.deploy]?.where ?? 'the environment of the server';
  if (!deploys(answers) || left.length) {
    steps.push(
      [
        `Set ${bold('NIGHTWATCH_TOKEN')} (the application's token in Nightwatch) in ${where}${left.length ? ` of ${left.map((environment) => bold(environment)).join(' and ')}` : ''}, if it is not there yet.`,
        ...(problems.length ? [dim(`  Setup could not do it through the API (${problems.join('; ')}).`)] : []),
      ].join('\n'),
    );
  }
  return steps;
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

/** Whether the monitoring service's package is in the app, when the service is on. */
function evaluateMonitoring({ ok, warn }, state) {
  // composer.json is read from the folder: without the app, nothing to say
  if (!state.health.laravel) return;
  const service = monitoringOf(state.current);
  const name = AGENTS[service];
  if (!name) return;
  if (state[service]) ok(`${name} in composer.json`);
  else
    warn(
      `composer.json does not require ${name}, so nothing reaches ${MONITORING_SERVICES[service].name}`,
      `composer require ${name}`,
    );
}

export default projectKind({
  deployTargets: Object.values(PROVIDERS).map((provider) => ({ value: provider.id, label: provider.label })),
  deployProviders: PROVIDERS,
  deployHookHint: Object.values(PROVIDERS)
    .map((provider) => provider.hookHint)
    .join(' · '),
  monitoring: monitoringServices(['nightwatch', 'sentry', 'inspector']),
  empty: {
    health: { laravel: false, route: null, databaseCheck: false },
    tools: NO_TOOLS,
    nightwatch: false,
    sentry: false,
    inspector: false,
    nodeScripts: [],
  },
  /** What collectState reads from the folder for a Laravel app: its health check, its locale and its tools. */
  inspect: async (root) => ({
    health: await inspectHealth(root),
    locale: await readLocale(root),
    nightwatch: await requiresPackage(root, AGENTS.nightwatch),
    sentry: await requiresPackage(root, AGENTS.sentry),
    inspector: await requiresPackage(root, AGENTS.inspector),
    nodeScripts: await nodeScripts(root),
    tools: await inspectTools(root),
  }),
  healthPath: (ctx) => ctx.state.health.route ?? '/up',
  deploySteps: SITES.steps,
  steps: () => [databaseCheckStep, ...toolSteps('project'), jsStep],
  tasks: (answers, { root, state }) => [
    ...SITES.tasks(answers, { state }),
    ...(answers.databaseCheck ? [healthCheckTask(root)] : []),
  ],
  files: { healthCheck: PROVIDER_PATH },
  deployNextSteps: SITES.nextSteps,
  nextSteps: (answers, { state, results }) => [
    ...(deploys(answers) && !state.health.laravel
      ? [`Make ${answers.healthPath} answer 200 only when the app works (${BY_HAND}).`]
      : []),
    ...nightwatchNextSteps(answers, { state, results }),
    ...sdkNextSteps(answers, { state }),
  ],
  evaluateDeploy,
  evaluateMonitoring,
});
