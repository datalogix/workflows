import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { suggestedTests } from '../stacks/laravel/tools.js';
import phpApp, { symfonyHealthController } from '../stacks/php/app.js';
import { APP_STATE, fakeGitHub, folder, RELAY as relay } from './helpers.js';

// Quiet progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
}));

const SYMFONY = {
  'composer.json': JSON.stringify({
    type: 'project',
    require: { 'symfony/framework-bundle': '^8.0', 'doctrine/doctrine-bundle': '^3.0' },
  }),
  'bin/console': '',
  'bin/phpunit': '',
  'config/routes.yaml': 'controllers:\n    resource: routing.controllers\n',
};
const PLAIN = { 'composer.json': JSON.stringify({ require: { php: '>=8.3' } }), 'public/index.php': '' };

const answers = {
  repository: 'datalogix/app',
  deploy: 'forge',
  staging: false,
  domain: 'example.com',
  monitoring: 'sentry',
  incidents: true,
  codeOwners: '@ana',
};

const stateOf = async (root) => ({ ...APP_STATE, stack: 'php', ...(await phpApp.inspect(root)) });
const tasksOf = (state, root, extra = {}) =>
  phpApp.setup.tasks({ ...answers, ...extra }, { github: fakeGitHub(), root, state, relay });
const stepOf = (id) => phpApp.setup.steps().find((step) => step.id === id);

test('reads a Symfony app: its health route, Doctrine and the test command of its PHPUnit recipe', async (t) => {
  const state = await stateOf(await folder(t, SYMFONY, 'php-app-'));
  expect(state).toMatchObject({
    framework: 'symfony',
    healthFile: 'src/Controller/HealthController.php',
    healthRoutePath: '/health',
    healthRoute: false,
    database: true,
    sentry: false,
  });
  expect(state.tools.binPhpunit).toBe(true);
});

test('creates the Symfony health route, checking the database when asked', async (t) => {
  const root = await folder(t, SYMFONY, 'php-app-');
  const state = await stateOf(root);
  const ctx = { state };
  expect(stepOf('healthRoute').when({ deploy: 'forge', healthPath: '/health' }, ctx)).toBe(true);
  expect(stepOf('healthRoute').when({ deploy: 'forge', healthPath: '/up' }, ctx)).toBe(false);
  expect(stepOf('healthRoute').when({ deploy: 'none', healthPath: '/health' }, ctx)).toBe(false);
  expect(stepOf('databaseCheck').when({ healthRoute: true }, ctx)).toBe(true);
  expect(stepOf('databaseCheck').when({ healthRoute: true }, { state: { ...state, database: false } })).toBe(false);

  const task = tasksOf(state, root, { healthPath: '/health', healthRoute: true, databaseCheck: true }).find(
    (candidate) => candidate.id === 'file:src/Controller/HealthController.php',
  );
  expect(await task.run()).toBe('created src/Controller/HealthController.php');
  const controller = await readFile(join(root, 'src/Controller/HealthController.php'), 'utf8');
  expect(controller).toBe(symfonyHealthController(true));
  expect(controller).toContain("#[Route('/health', name: 'health', methods: ['GET'])]");
  expect(controller).toContain("$this->connection->executeQuery('SELECT 1');");

  // Without the database check, no Doctrine
  expect(symfonyHealthController(false)).not.toContain('Doctrine');

  // An existing route is not asked for again
  expect(stepOf('healthRoute').when({ deploy: 'forge', healthPath: '/health' }, { state: await stateOf(root) })).toBe(
    false,
  );
});

test('leaves the health route of a Symfony app without attribute routing to do by hand', async (t) => {
  const root = await folder(t, { ...SYMFONY, 'config/routes.yaml': 'index:\n    path: /\n' }, 'php-app-');
  const state = await stateOf(root);
  expect(state).toMatchObject({ framework: 'symfony', healthFile: null, healthRoute: false });
  expect(stepOf('healthRoute').when({ deploy: 'forge', healthPath: '/health' }, { state })).toBe(false);
  const steps = phpApp.setup.nextSteps({ ...answers, healthPath: '/health' }, { relay, results: [], state });
  expect(steps).toContainEqual(expect.stringContaining('Make /health answer 200 only when the app works'));
});

test('creates a health script in the web root of a plain PHP app', async (t) => {
  const root = await folder(t, PLAIN, 'php-app-');
  const state = await stateOf(root);
  expect(state).toMatchObject({ framework: null, healthFile: 'public/health.php', healthRoutePath: '/health.php' });
  expect(stepOf('databaseCheck').when({ healthRoute: true }, { state })).toBe(false);

  const task = tasksOf(state, root, { healthPath: '/health.php', healthRoute: true }).find(
    (candidate) => candidate.id === 'file:public/health.php',
  );
  await task.run();
  const script = await readFile(join(root, 'public/health.php'), 'utf8');
  expect(script).toContain("echo json_encode(['status' => 'ok']);");

  // Without a public folder, the script goes to the root
  const bare = await stateOf(await folder(t, { 'composer.json': '{"type": "project"}' }, 'php-app-'));
  expect(bare).toMatchObject({ healthFile: 'health.php', healthRoutePath: '/health.php' });
});

test("tells to install the monitoring service's SDK of the framework", async (t) => {
  const symfony = await stateOf(await folder(t, SYMFONY, 'php-app-'));
  const plain = await stateOf(await folder(t, PLAIN, 'php-app-'));
  const next = (state, monitoring) =>
    phpApp.setup.nextSteps({ ...answers, deploy: 'none', monitoring }, { relay, results: [], state });
  expect(next(symfony, 'sentry')).toContainEqual(expect.stringContaining('composer require sentry/sentry-symfony'));
  expect(next(plain, 'sentry')).toContainEqual(expect.stringContaining('composer require sentry/sentry'));
  expect(next(symfony, 'inspector')).toContainEqual(
    expect.stringContaining('composer require inspector-apm/inspector-symfony'),
  );
  expect(next(plain, 'inspector')).toContainEqual(
    expect.stringContaining('composer require inspector-apm/inspector-php'),
  );
  // Installed: nothing to say
  expect(next({ ...symfony, sentry: true }, 'sentry')).not.toContainEqual(expect.stringContaining('composer require'));
});

test('asks for the deploy target, the monitoring service and the health check', () => {
  expect(phpApp.setup.steps().map((step) => step.id)).toContain('healthRoute');
  const deploy = phpApp.setup.steps().find((step) => step.id === 'deploy');
  expect(deploy).toBeDefined();
  const monitoring = phpApp.setup.steps().find((step) => step.id === 'monitoring');
  expect(monitoring).toBeDefined();
});

test('suggests the test command laravel-app-tests runs for a PHP app', () => {
  const fallback = (tools) =>
    tools.binPhpunit ? 'php bin/phpunit' : tools.pest ? 'vendor/bin/pest' : 'vendor/bin/phpunit';
  const tools = { pint: false, phpstan: false, pest: false, phpunit: true, scripts: {} };
  expect(suggestedTests({ ...tools, binPhpunit: true }, 'project', fallback).label).toBe('php bin/phpunit');
  expect(suggestedTests({ ...tools, pest: true }, 'project', fallback).label).toBe('vendor/bin/pest');
  expect(suggestedTests(tools, 'project', fallback).label).toBe('vendor/bin/phpunit');
  // A Laravel app keeps php artisan test
  expect(suggestedTests(tools, 'project').label).toBe('php artisan test');
});
