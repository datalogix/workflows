import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deploys, projectKind } from '../../kinds/project/index.js';
import { SETUP } from '../../lib/evaluate.js';
import { bold, clack, dim, orExit, question } from '../../lib/ui.js';
import { addDatabaseCheck, inspectHealth, PROVIDER_PATH } from './health.js';
import { inspectTools, NO_TOOLS, toolSteps } from './tools.js';

// What a Laravel app adds to project.yml (cli/kinds/project/index.js): Forge and Laravel Cloud deploys, Nightwatch, the
// health check of bootstrap/app.php and the lint and test tools

const FORGE_SNIPPET = `if [ -n "$FORGE_VAR_COMMIT" ]; then
    git fetch --quiet origin "$FORGE_VAR_COMMIT"
    git checkout --quiet --detach "$FORGE_VAR_COMMIT"
fi`;

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

/** What Forge or Laravel Cloud need by hand, so they deploy only what the workflows ask for. */
function deployNextSteps(answers, { twoBranches }) {
  if (answers.deploy === 'forge') {
    return [
      [
        `In Forge, for ${answers.staging ? 'both sites' : 'the site'}: turn off ${bold('Push to deploy')}${twoBranches ? ` (staging site on ${bold(answers.developmentBranch)}, production site on ${bold(answers.productionBranch)})` : ''}, and in the deploy script add right after ${bold('cd $FORGE_RELEASE_DIRECTORY')}:`,
        dim(FORGE_SNIPPET.replace(/^/gm, '  ')),
        dim('  (standard sites without zero-downtime: see docs/laravel/app.md)'),
      ].join('\n'),
    ];
  }
  if (answers.deploy === 'cloud') {
    return [
      `In Laravel Cloud, for ${answers.staging ? 'both environments' : 'the environment'}: turn off ${bold('Push to deploy')}${twoBranches ? `, make staging track ${bold(answers.developmentBranch)} and production track ${bold(answers.productionBranch)}` : answers.staging ? ', and make staging track the default branch' : ''}.`,
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
  empty: { health: { laravel: false, route: null, databaseCheck: false }, tools: NO_TOOLS },
  /** What collectState reads from the folder for a Laravel app: its health check, its locale and its tools. */
  inspect: async (root) => ({
    health: await inspectHealth(root),
    locale: await readLocale(root),
    tools: await inspectTools(root),
  }),
  healthPath: (ctx) => ctx.state.health.route ?? '/up',
  steps: () => [databaseCheckStep, ...toolSteps('project')],
  tasks: (answers, { root }) => (answers.databaseCheck ? [healthCheckTask(root)] : []),
  files: { healthCheck: PROVIDER_PATH },
  deployNextSteps,
  nextSteps: (answers, { state }) =>
    deploys(answers) && !state.health.laravel
      ? [`Make ${answers.healthPath} answer 200 only when the app works (${BY_HAND}).`]
      : [],
  evaluateDeploy,
});
