import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deploys, projectKind } from '../../kinds/project/index.js';
import { clack, cyan, orExit, question } from '../../lib/ui.js';
import { deployProviders } from '../../providers/deploy/index.js';
import { deploySites } from '../../providers/deploy/sites.js';
import { MONITORING_SERVICES, monitoringServices } from '../../providers/monitoring/index.js';
import { jsStep, nodeScripts } from '../laravel/app.js';
import { readComposer } from '../laravel/index.js';
import { inspectTools, NO_TOOLS, toolSteps } from '../laravel/tools.js';

// What a PHP app without Laravel (Symfony, or plain PHP) adds to project.yml (cli/kinds/project/index.js): Forge
// deploys, Sentry or Inspector, a health check setup can write and the lint and test tools. project.yml runs
// laravel-app-tests, whose setup and test command follow the files of the app

const BY_HAND = 'see docs/php/app-manual-setup.md in datalogix/workflows';

// Laravel Cloud runs only Laravel, and Vercel and Netlify run no PHP
const PROVIDERS = deployProviders(['forge']);
const SITES = deploySites(PROVIDERS);

// The SDK each monitoring service needs in the app, for Symfony or plain PHP
const SDKS = {
  sentry: { symfony: 'sentry/sentry-symfony', plain: 'sentry/sentry' },
  inspector: { symfony: 'inspector-apm/inspector-symfony', plain: 'inspector-apm/inspector-php' },
};
const sdkOf = (service, framework) => SDKS[service]?.[framework ?? 'plain'];

// Symfony gets a route, picked up by the attribute routing of src/Controller; a plain PHP app a script in its web root
const SYMFONY_HEALTH = { file: 'src/Controller/HealthController.php', path: '/health' };
const DATABASE_PACKAGES = ['doctrine/dbal', 'doctrine/doctrine-bundle', 'doctrine/orm', 'symfony/orm-pack'];

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Whether Symfony imports the routes of the controllers' attributes: Symfony 7.4+'s routing.controllers, or older. */
async function attributeRouting(root) {
  if (await exists(join(root, 'config/routes/attributes.yaml'))) return true;
  try {
    const routes = await readFile(join(root, 'config/routes.yaml'), 'utf8');
    return /\brouting\.controllers\b|\btype:\s*attribute\b/.test(routes);
  } catch {
    return false;
  }
}

/** What collectState reads from the folder for a PHP app: its framework, health check, SDKs and tools. */
async function inspectApp(root) {
  const composer = (await readComposer(root)) ?? {};
  const required = { ...composer.require, ...composer['require-dev'] };
  const requires = (name) => name in (composer.require ?? {});
  const framework =
    (await exists(join(root, 'bin/console'))) && 'symfony/framework-bundle' in required ? 'symfony' : null;
  let health = null;
  if (framework === 'symfony') {
    // Without the attribute routing a controller would not be routed: the health check is left to do by hand
    if (await attributeRouting(root)) health = SYMFONY_HEALTH;
  } else {
    // The web root: public/, or web/ (Craft CMS and others), else the folder itself
    const webRoot = (await exists(join(root, 'public'))) ? 'public/' : (await exists(join(root, 'web'))) ? 'web/' : '';
    const file = `${webRoot}health.php`;
    health = { file, path: '/health.php' };
  }
  return {
    framework,
    healthFile: health?.file ?? null,
    healthRoutePath: health?.path ?? null,
    healthRoute: health ? await exists(join(root, health.file)) : false,
    database: DATABASE_PACKAGES.some((name) => name in required),
    sentry: Object.values(SDKS.sentry).some(requires),
    inspector: Object.values(SDKS.inspector).some(requires),
    nodeScripts: await nodeScripts(root),
    tools: { ...(await inspectTools(root)), binPhpunit: await exists(join(root, 'bin/phpunit')) },
  };
}

/** The test command laravel-app-tests runs without composer test or artisan (see its Tests step). */
const testFallback = (tools) =>
  tools.binPhpunit ? 'php bin/phpunit' : tools.pest ? 'vendor/bin/pest' : 'vendor/bin/phpunit';

/** Whether to create the health check, when the app deploys to its path and has none. */
const healthRouteStep = {
  id: 'healthRoute',
  when: (a, ctx) =>
    deploys(a) && Boolean(ctx.state.healthFile) && a.healthPath === ctx.state.healthRoutePath && !ctx.state.healthRoute,
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          `Create the health check ${ctx.state.healthRoutePath}?`,
          `Writes ${ctx.state.healthFile}, answering 200 while the app serves requests; the deploys check it`,
        ),
        initialValue: true,
      }),
    ),
};

/** Whether the Symfony health check fails when the database is down, when the app uses Doctrine. */
const databaseCheckStep = {
  id: 'databaseCheck',
  when: (a, ctx) => Boolean(a.healthRoute) && ctx.state.framework === 'symfony' && ctx.state.database,
  ask: async ({ header }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          'Make the health check fail when the database is down?',
          'A deploy that breaks the database connection is rolled back',
        ),
        initialValue: true,
      }),
    ),
};

// The database servers laravel-app-tests can start for the tests (its database input)
const DATABASES = [
  { value: 'none', label: 'The database of .env.test', hint: 'SQLite or a server CI can reach; no service started' },
  { value: 'postgres', label: 'PostgreSQL', hint: "Symfony's default" },
  { value: 'mysql', label: 'MySQL' },
  { value: 'mariadb', label: 'MariaDB' },
];
const validDatabase = (value) =>
  DATABASES.some((database) => database.value === value?.trim().toLowerCase())
    ? undefined
    : `use ${DATABASES.map((database) => database.value).join(', ')}`;

/** The database server of the tests, asked of a Symfony app with Doctrine. */
const databaseStep = {
  id: 'database',
  flag: 'database',
  validate: validDatabase,
  parse: (value) => value.trim().toLowerCase(),
  when: (a, ctx) => ctx.state.framework === 'symfony' && ctx.state.database,
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.select({
        message: question(
          header,
          'Database for the tests',
          'The tests create and migrate the test database; a server is started as a service, with DATABASE_URL',
        ),
        initialValue: ctx.state.current?.database ?? 'none',
        options: DATABASES,
      }),
    ),
};

/** The Symfony health controller, with Doctrine's connection when it checks the database. */
export function symfonyHealthController(databaseCheck) {
  const lines = [
    '<?php',
    '',
    'namespace App\\Controller;',
    '',
    ...(databaseCheck ? ['use Doctrine\\DBAL\\Connection;'] : []),
    'use Symfony\\Component\\HttpFoundation\\JsonResponse;',
    'use Symfony\\Component\\Routing\\Attribute\\Route;',
    '',
    '// The health check of the deploys (HEALTH_URL): a deploy whose check stops answering 200 is rolled back',
    'final class HealthController',
    '{',
    ...(databaseCheck
      ? ['    public function __construct(private readonly Connection $connection)', '    {', '    }', '']
      : []),
    "    #[Route('/health', name: 'health', methods: ['GET'])]",
    '    public function __invoke(): JsonResponse',
    '    {',
    ...(databaseCheck
      ? [
          '        // Fails (500) when the database is unreachable',
          "        $this->connection->executeQuery('SELECT 1');",
          '',
        ]
      : []),
    "        return new JsonResponse(['status' => 'ok'], headers: ['Cache-Control' => 'no-store']);",
    '    }',
    '}',
    '',
  ];
  return lines.join('\n');
}

const PLAIN_HEALTH = `<?php

// The health check of the deploys (HEALTH_URL): a deploy whose check stops answering 200 is rolled back
header('Content-Type: application/json');
header('Cache-Control: no-store');
echo json_encode(['status' => 'ok']);
`;

/** Writes the health check of the app. */
function healthRouteTask(root, answers, state) {
  return {
    id: `file:${state.healthFile}`,
    title: `Health check ${state.healthRoutePath}`,
    run: async () => {
      const path = join(root, state.healthFile);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        state.framework === 'symfony' ? symfonyHealthController(Boolean(answers.databaseCheck)) : PLAIN_HEALTH,
      );
      return `created ${state.healthFile}`;
    },
  };
}

const serviceOf = (a) => MONITORING_SERVICES[a?.monitoring];

/** The SDK of Sentry or Inspector, when its problems become issues and the app does not require it yet. */
function sdkNextSteps(answers, { state }) {
  const service = serviceOf(answers);
  const sdk = sdkOf(service?.id, state.framework);
  if (!sdk || !answers.incidents || state[service.id]) return [];
  return [
    `Install ${service.name}'s SDK in the app, or nothing reaches ${service.name}: ${cyan(`composer require ${sdk}`)}`,
  ];
}

/** The health check items of check, for an app that deploys. */
function evaluateDeploy({ ok, warn }, state) {
  if (!state.healthFile) {
    if (state.framework === 'symfony')
      warn(
        'config/routes.yaml does not import the routes of src/Controller',
        `add a health route by hand (${BY_HAND})`,
      );
    return;
  }
  if (state.healthRoute) ok(`Health check ${state.healthRoutePath} (${state.healthFile})`);
  else
    warn(
      `No health check at ${state.healthFile}: every deploy fails its health checks unless HEALTH_URL points to another`,
      'run setup again',
    );
}

/** Whether the monitoring service's SDK is in the app, when the service is on. */
function evaluateMonitoring({ ok, warn }, state) {
  const service = serviceOf(state.current);
  const sdk = sdkOf(service?.id, state.framework);
  if (!sdk) return;
  if (state[service.id]) ok(`${service.name}'s SDK in composer.json`);
  else warn(`composer.json does not require ${sdk}, so nothing reaches ${service.name}`, `composer require ${sdk}`);
}

export default projectKind({
  id: 'php',
  deployTargets: Object.values(PROVIDERS).map((provider) => ({ value: provider.id, label: provider.label })),
  deployProviders: PROVIDERS,
  deployHookHint: Object.values(PROVIDERS)
    .map((provider) => provider.hookHint)
    .join(' · '),
  monitoring: monitoringServices(['sentry', 'inspector']),
  empty: {
    framework: null,
    healthFile: null,
    healthRoutePath: null,
    healthRoute: false,
    database: false,
    sentry: false,
    inspector: false,
    nodeScripts: [],
    tools: NO_TOOLS,
  },
  inspect: inspectApp,
  healthPath: (ctx) => ctx.state.healthRoutePath ?? SYMFONY_HEALTH.path,
  deploySteps: SITES.steps,
  steps: () => [healthRouteStep, databaseCheckStep, databaseStep, ...toolSteps('project', { testFallback }), jsStep],
  tasks: (answers, { root, state }) => [
    ...SITES.tasks(answers, { state }),
    ...(answers.healthRoute && state.healthFile ? [healthRouteTask(root, answers, state)] : []),
  ],
  files: {},
  deployNextSteps: SITES.nextSteps,
  nextSteps: (answers, { state }) => [
    ...(deploys(answers) && !state.healthFile
      ? [`Make ${answers.healthPath} answer 200 only when the app works (${BY_HAND}).`]
      : []),
    ...sdkNextSteps(answers, { state }),
  ],
  evaluateDeploy,
  evaluateMonitoring,
});
