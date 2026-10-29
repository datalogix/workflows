import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseStack, setup } from '../commands/setup.js';
import { dropsProductionBranch } from '../kinds/project/index.js';
import { hasSecret } from '../kinds/project/relay.js';
import { LABELS, labelsFor } from '../kinds/project/state.js';
import { projectAnswers, renderProjectWorkflow } from '../kinds/project/workflow.js';
import { EMPTY_STATE } from '../lib/state.js';
import { askSteps } from '../lib/ui.js';
import { parseInputs } from '../lib/workflow-file.js';
import app from '../stacks/laravel/app.js';
import {
  APP_SERVICE_PROVIDER,
  APP_STATE,
  askedSteps,
  byTitle,
  fakeGitHub,
  folder,
  onPlatform,
  RELAY as relay,
  runResults,
  tempRoot,
} from './helpers.js';

// What the prompts showed, and the answer a test gives them
const prompts = vi.hoisted(() => ({ stops: [], asked: [], answer: undefined }));
const reply = vi.hoisted(() => async (options) => (prompts.asked.push(options), prompts.answer));

// Quiet spinners and progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  spinner: () => ({ start() {}, stop: (message) => prompts.stops.push(message), error() {}, message() {} }),
  confirm: reply,
  password: reply,
  select: reply,
  multiselect: reply,
  text: reply,
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
  log: { info() {}, warn() {}, error() {}, success() {}, message() {} },
  note() {},
  outro() {},
  cancel() {},
}));

// The relay is read for real unless a test says what it answers
vi.mock('../kinds/project/relay.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, hasSecret: vi.fn(original.hasSecret) };
});

// Each test starts with no prompt shown and the relay read for real
beforeEach(() => {
  Object.assign(prompts, { stops: [], asked: [], answer: undefined });
  vi.mocked(hasSecret).mockReset();
  // No test reaches the network: the health URLs take a probe, Forge and Cloud a fake fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      throw new Error(`No network in tests: ${url}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const { steps: setupSteps, tasks: setupTasks, nextSteps, warnings: setupWarnings } = app.setup;

const SHA = { commit: { sha: 'a'.repeat(40) } };

// Tasks and their results by id, what nextSteps reads; tasks without an id are found by title
const taskById = (tasks, id) => tasks.find((task) => task.id === id);
const idsOf = (tasks) => tasks.map((task) => task.id);
const done = (id, detail = 'created') => ({ id, ok: true, detail });
const failed = (id, detail) => ({ id, ok: false, detail });

// A project that deploys production from main and staging from develop
const branchAnswers = {
  repository: 'datalogix/app',
  deploy: 'forge',
  domain: 'app.example.com',
  staging: true,
  branches: true,
  developmentBranch: 'develop',
  productionBranch: 'main',
  stagingDomain: 'staging.app.example.com',
  healthPath: '/up',
  incidents: false,
  solo: true,
  codeOwners: '@ana',
};

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n';

test('sets up a new project deployed with Forge', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const answers = {
    repository: 'datalogix/app',
    deploy: 'forge',
    domain: 'app.example.com',
    staging: true,
    stagingDomain: 'staging.app.example.com',
    healthPath: '/up',
    productionHook: 'https://forge.laravel.com/hook/1',
    stagingHook: 'https://forge.laravel.com/hook/2',
    monitoringMarkers: false,
    claudeToken: 'token',
    incidents: true,
    incidentStaging: true,
    incidentPerformance: true,
    solo: true,
    codeOwners: '@ana',
  };

  const tasks = setupTasks(answers, { github, root, state: APP_STATE, relay });
  expect(tasks.map((task) => task.title)).toStrictEqual([
    'Workflow file .github/workflows/datalogix.yml',
    'Code owners .github/CODEOWNERS',
    'Labels',
    'Claude token',
    'Environment production',
    'Environment staging',
    'Health check URLs',
  ]);
  for (const task of tasks) await task.run();

  const workflow = await readFile(join(root, '.github/workflows/datalogix.yml'), 'utf8');
  expect(workflow).toMatch(/deploy: forge\n {6}count-author: true\n$/);
  expect(await readFile(join(root, '.github/CODEOWNERS'), 'utf8')).toMatch(/\n\/\.github\/ @ana\n$/);
  expect(github.calls.filter(([name]) => name !== 'label')).toStrictEqual([
    ['secret', 'CLAUDE_CODE_OAUTH_TOKEN', 'token'],
    ['environment', 'production'],
    ['variable', 'HEALTH_URL', 'https://app.example.com/up', 'production'],
    ['secret', 'DEPLOY_HOOK', 'https://forge.laravel.com/hook/1', 'production'],
    ['environment', 'staging'],
    ['variable', 'HEALTH_URL', 'https://staging.app.example.com/up', 'staging'],
    ['secret', 'DEPLOY_HOOK', 'https://forge.laravel.com/hook/2', 'staging'],
  ]);
  expect(github.calls.filter(([name]) => name === 'label').map(([, name]) => name)).toStrictEqual(
    labelsFor(['production', 'staging']).map((label) => label.name),
  );

  const steps = nextSteps(answers, { relay, results: [], state: APP_STATE });
  const forge = steps.find((step) => step.includes('In Forge'));
  expect(forge).toContain('git checkout --quiet --detach "$FORGE_VAR_COMMIT"');
  expect(forge).toContain('git checkout --quiet --force --detach "${FORGE_VAR_COMMIT:-origin/$FORGE_SITE_BRANCH}"');
  expect(steps).toContainEqual(expect.stringContaining('https://relay.test/nightwatch/datalogix/app'));
  expect(steps.at(-1)).toContain('npx --allow-git=root github:datalogix/workflows#v2 protect');
});

test('changes nothing when everything is already set', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const answers = {
    repository: 'datalogix/app',
    deploy: 'cloud',
    domain: 'app.example.com',
    staging: false,
    healthPath: '/up',
    productionHookKeep: true,
    incidents: false,
    solo: true,
    codeOwners: '@ana',
  };

  const probe = async () => 200;
  const first = setupTasks(answers, { github, root, state: APP_STATE, relay, probe });
  for (const task of first) await task.run();

  const state = {
    ...APP_STATE,
    workflow: await readFile(join(root, '.github/workflows/datalogix.yml'), 'utf8'),
    codeOwnersFile: await readFile(join(root, '.github/CODEOWNERS'), 'utf8'),
    labels: labelsFor(['production']).map((label) => label.name),
    environments: {
      ...APP_STATE.environments,
      production: { exists: true, deployHook: true, healthUrl: 'https://app.example.com/up', monitoringToken: false },
    },
  };
  const quiet = fakeGitHub();
  expect(byTitle(await runResults(setupTasks(answers, { github: quiet, root, state, relay, probe })))).toStrictEqual({
    'Workflow file .github/workflows/datalogix.yml': 'unchanged',
    'Code owners .github/CODEOWNERS': 'unchanged',
    Labels: 'unchanged',
    'Environment production': 'unchanged',
    'Health check URLs': 'production 200',
  });
  expect(quiet.calls).toStrictEqual([]);
});

test('skips the relay secret when the relay is not configured', (t) => {
  onPlatform(t, 'linux');
  const unconfigured = { configured: false, url: '', namespaceId: '', owner: '' };
  const step = setupSteps().find((candidate) => candidate.id === 'webhookSecret');
  expect(step.when({ incidents: true }, { relay: unconfigured })).toBe(false);
  expect(step.when({ incidents: true }, { relay })).toBe(true);

  const answers = { repository: 'datalogix/app', deploy: 'none', incidents: true };
  const steps = nextSteps(answers, { relay: unconfigured, results: [], state: APP_STATE });
  expect(steps).toContainEqual(expect.stringContaining('monitoring relay of datalogix is not set up'));
  expect(steps).toContainEqual(expect.stringContaining('#v2 org'));
  expect(steps).not.toContainEqual(expect.stringContaining('/nightwatch/'));
});

test('stores the Nightwatch tokens and updates a changed health URL, matching label names in any case', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const answers = {
    repository: 'datalogix/app',
    deploy: 'forge',
    domain: ' new.example.com ',
    staging: false,
    healthPath: '/up',
    productionHookKeep: true,
    monitoringMarkers: true,
    productionMonitoringToken: 'nw-token',
    incidents: false,
    solo: true,
    codeOwners: '@ana',
  };
  const state = {
    ...APP_STATE,
    labels: ['Claude', 'CLAUDE-PLAN', 'no-review', 'Rollback', 'ENV:production', 'env:staging'],
    environments: {
      ...APP_STATE.environments,
      production: { exists: true, deployHook: true, healthUrl: 'https://old.example.com/up', monitoringToken: false },
    },
  };

  const results = byTitle(await runResults(setupTasks(answers, { github, root, state, relay })));
  expect(results.Labels).toBe('unchanged');
  expect(results['Environment production']).toBe('HEALTH_URL https://new.example.com/up, NIGHTWATCH_TOKEN');
  expect(github.calls).toStrictEqual([
    ['variable', 'HEALTH_URL', 'https://new.example.com/up', 'production'],
    ['secret', 'NIGHTWATCH_TOKEN', 'nw-token', 'production'],
  ]);
});

test('creates no environment when the workflows do not deploy', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const answers = { repository: 'datalogix/app', deploy: 'none', incidents: false, solo: true, codeOwners: '@ana' };
  const titles = setupTasks(answers, { github: fakeGitHub(), root, state: APP_STATE, relay }).map((task) => task.title);
  expect(titles).not.toContainEqual(expect.stringMatching(/^Environment/));
});

test('asks to keep or replace a secret that is already set', () => {
  const steps = setupSteps();
  const keep = steps.find((step) => step.id === 'productionHookKeep');
  const hook = steps.find((step) => step.id === 'productionHook');
  const ctx = (deployHook) => ({
    state: { ...APP_STATE, environments: { ...APP_STATE.environments, production: { deployHook } } },
  });

  expect(keep.when({ deploy: 'forge' }, ctx(false))).toBe(false);
  expect(hook.when({ deploy: 'forge' }, ctx(false))).toBe(true);
  expect(keep.when({ deploy: 'forge' }, ctx(true))).toBe(true);
  expect(hook.when({ deploy: 'forge', productionHookKeep: true }, ctx(true))).toBe(false);
  expect(hook.when({ deploy: 'forge', productionHookKeep: false }, ctx(true))).toBe(true);
});

test('explains how to add the database check when the provider is missing', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const answers = { repository: 'datalogix/app', deploy: 'none', databaseCheck: true, codeOwners: '@ana' };
  const task = taskById(setupTasks(answers, { github: fakeGitHub(), root, state: APP_STATE, relay }), 'healthCheck');
  await expect(task.run()).rejects.toThrow(/AppServiceProvider\.php does not exist; add the check by hand/);

  await mkdir(join(root, 'app/Providers'), { recursive: true });
  await writeFile(join(root, 'app/Providers/AppServiceProvider.php'), '<?php\n\nclass AppServiceProvider {}\n');
  await expect(task.run()).rejects.toThrow(/has no boot\(\) method/);
});

test('adds the database check to the provider of the project', async (t) => {
  const root = await folder(t, { 'app/Providers/AppServiceProvider.php': APP_SERVICE_PROVIDER }, 'setup-');
  const answers = { repository: 'datalogix/app', deploy: 'none', databaseCheck: true, codeOwners: '@ana' };
  const task = taskById(setupTasks(answers, { github: fakeGitHub(), root, state: APP_STATE, relay }), 'healthCheck');

  expect(await task.run()).toBe('database check added to app/Providers/AppServiceProvider.php');
  expect(await readFile(join(root, 'app/Providers/AppServiceProvider.php'), 'utf8')).toMatch(/DiagnosingHealth/);
});

test('commits only the files the tasks changed', () => {
  const answers = { repository: 'datalogix/app', deploy: 'none', incidents: false, databaseCheck: true };
  const commit = (results) =>
    nextSteps(answers, { relay, results, state: APP_STATE }).find((step) => step.startsWith('Commit'));

  expect(
    commit([done('workflowFile', 'unchanged'), done('codeOwners', 'updated'), failed('healthCheck', 'failed')]),
  ).toContain('git add .github/CODEOWNERS &&');
  expect(commit([done('workflowFile', 'unchanged')])).toBe(undefined);
  // The stack's files go along: the provider the health check task changed
  expect(
    commit([
      done('workflowFile', 'unchanged'),
      done('healthCheck', 'database check added to app/Providers/AppServiceProvider.php'),
    ]),
  ).toContain('git add app/Providers/AppServiceProvider.php &&');
});

// What is left by hand for an app on Linux, where setup can reach the relay
const leftByHand = (answers, extra = {}) =>
  nextSteps(
    { repository: 'datalogix/app', incidents: true, webhookSecret: '', ...answers },
    { relay, results: [], state: APP_STATE, ...extra },
  );

test('tells how to set up Laravel Cloud for each environment', (t) => {
  onPlatform(t, 'linux');
  expect(leftByHand({ deploy: 'cloud', staging: true })).toContainEqual(expect.stringContaining('both environments'));
  // A single branch: staging deploys the default branch
  expect(leftByHand({ deploy: 'cloud', staging: true })).toContainEqual(
    expect.stringContaining('make staging track the default branch'),
  );
  expect(leftByHand({ deploy: 'cloud', staging: false })).toContainEqual(
    expect.stringContaining('for the environment'),
  );
});

test('tells to make the health path answer 200 when it cannot read the health check', (t) => {
  onPlatform(t, 'linux');
  expect(leftByHand({ deploy: 'cloud', healthPath: '/up' })).toContainEqual(expect.stringContaining('/up answer 200'));
});

test('tells to name the environments in Nightwatch with incidents', (t) => {
  onPlatform(t, 'linux');
  expect(leftByHand({ deploy: 'none', staging: false })).toContainEqual(
    expect.stringContaining('name the environments'),
  );
});

test('tells to point the webhook to the relay until its signing secret is stored', (t) => {
  onPlatform(t, 'linux');
  const relayStep = (extra) => leftByHand({ deploy: 'none' }, extra).some((step) => step.includes('/nightwatch/'));
  expect(relayStep({ relayRegistered: true })).toBe(false);
  expect(relayStep({ relayRegistered: false })).toBe(true);
  expect(relayStep({ relayRegistered: true, results: [failed('monitoringRelay', 'not logged in')] })).toBe(true);
});

test('asks for the Nightwatch deploy markers only with Forge', () => {
  const step = setupSteps().find((candidate) => candidate.id === 'monitoringMarkers');
  expect(step.when({ deploy: 'forge' })).toBe(true);
  expect(step.when({ deploy: 'cloud' })).toBe(false);
});

test('suggests the production domain from the health check URL, else from the repository and the locale', async (t) => {
  const step = setupSteps().find((candidate) => candidate.id === 'domain');
  const initialValue = async (healthUrl, locale) => {
    prompts.asked = [];
    const environments = { ...APP_STATE.environments, production: { exists: true, healthUrl } };
    const answers = { repository: 'datalogix/example' };
    await step.ask({ header: '', answers, ctx: { state: { ...APP_STATE, environments, locale } } });
    return prompts.asked[0].initialValue;
  };

  expect(await initialValue('https://app.example.com/up', 'pt_BR')).toBe('app.example.com');
  expect(await initialValue(null, 'pt_BR')).toBe('example.com.br');
  expect(await initialValue(null, null)).toBe('example.com');

  // Staging suggests the dev subdomain of the production domain
  prompts.asked = [];
  const staging = setupSteps().find((candidate) => candidate.id === 'stagingDomain');
  await staging.ask({ header: '', answers: { domain: 'example.com.br' }, ctx: { state: APP_STATE } });
  expect(prompts.asked[0].initialValue).toBe('dev.example.com.br');

  // The locale comes from the app's .env
  const root = await folder(t, { '.env': 'APP_NAME=Example\nAPP_LOCALE="pt_BR"\n' }, 'locale-');
  expect((await app.inspect(root)).locale).toBe('pt_BR');
  expect((await app.inspect(await folder(t, {}, 'locale-'))).locale).toBe(null);
});

test('suggests deploy markers to a project that moves to Forge', async () => {
  const step = setupSteps().find((candidate) => candidate.id === 'monitoringMarkers');
  const initialValue = async (current, monitoringToken) => {
    prompts.asked = [];
    const environments = { ...APP_STATE.environments, production: { exists: true, monitoringToken } };
    await step.ask({ header: '', answers: {}, ctx: { state: { ...APP_STATE, current, environments } } });
    return prompts.asked[0].initialValue;
  };

  expect(await initialValue(null, false)).toBe(true);
  // Set up before with Forge: the token tells the earlier choice
  expect(await initialValue({ deploy: 'forge' }, false)).toBe(false);
  expect(await initialValue({ deploy: 'forge' }, true)).toBe(true);
  // Never asked before: the default of a new project
  expect(await initialValue({ deploy: 'cloud' }, false)).toBe(true);
  expect(await initialValue({ deploy: 'none' }, false)).toBe(true);
});

test('tells when the monitoring relay cannot be read', async () => {
  const step = setupSteps().find((candidate) => candidate.id === 'webhookSecret');
  prompts.answer = '';
  const ask = async (registered) => {
    prompts.stops = [];
    prompts.asked = [];
    vi.mocked(hasSecret).mockResolvedValueOnce(registered);
    const ctx = { relay, state: APP_STATE };
    await step.ask({ header: '', answers: { repository: 'datalogix/app' }, ctx });
    // nextSteps reads it to tell whether the webhook is left to set up
    expect(ctx.relayRegistered).toBe(registered);
    expect(hasSecret).toHaveBeenLastCalledWith(relay, 'nightwatch', 'datalogix/app');
    return [prompts.stops[0], prompts.asked[0].message];
  };

  const [unread, unreadHint] = await ask(null);
  expect(unread).toBe('Could not read the monitoring relay (run npx wrangler login)');
  expect(unreadHint).toContain('empty to keep it as it is');
  const [registered, registeredHint] = await ask(true);
  expect(registered).toBe('Registered in the monitoring relay');
  expect(registeredHint).toContain('empty to keep the current one');
  const [missing, missingHint] = await ask(false);
  expect(missing).toBe('Not registered in the monitoring relay yet');
  expect(missingHint).toContain('empty to set it later');
});

test('removes the Nightwatch token when deploy markers are turned off', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const answers = {
    repository: 'datalogix/app',
    deploy: 'forge',
    domain: 'app.example.com',
    staging: false,
    healthPath: '/up',
    productionHookKeep: true,
    monitoringMarkers: false,
    incidents: false,
    solo: true,
    codeOwners: '@ana',
  };
  const state = {
    ...APP_STATE,
    environments: {
      ...APP_STATE.environments,
      production: { exists: true, deployHook: true, healthUrl: 'https://app.example.com/up', monitoringToken: true },
    },
  };
  const task = setupTasks(answers, { github, root, state, relay }).find(
    (candidate) => candidate.title === 'Environment production',
  );
  expect(await task.run()).toBe('NIGHTWATCH_TOKEN removed');
  expect(github.calls).toStrictEqual([['delete secret', 'NIGHTWATCH_TOKEN', 'production']]);
});

test('does not ask for the signing secret of a repository the relay does not accept', () => {
  const step = setupSteps().find((candidate) => candidate.id === 'webhookSecret');
  expect(step.when({ incidents: true, repository: 'other/app' }, { relay })).toBe(false);

  const steps = nextSteps(
    { repository: 'other/app', deploy: 'none', incidents: true },
    { relay, results: [], state: APP_STATE },
  );
  expect(steps).toContainEqual(expect.stringContaining('only accepts repositories of'));
  expect(steps).not.toContainEqual(expect.stringContaining('/nightwatch/'));
});

test('creates the development branch from production and makes it the default branch', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const branches = { main: SHA };
  const github = fakeGitHub({ branches });
  const answers = branchAnswers;

  const tasks = setupTasks(answers, { github, root, state: APP_STATE, relay });
  const results = await runResults(tasks);
  expect(results.find((result) => result.id === 'branches').detail).toBe(
    'created develop, develop is the default branch',
  );
  expect(github.calls.filter(([name]) => ['branch', 'default'].includes(name))).toStrictEqual([
    ['branch', 'develop', 'a'.repeat(40)],
    ['default', 'develop'],
  ]);
  const workflow = await readFile(join(root, '.github/workflows/datalogix.yml'), 'utf8');
  expect(workflow).toContain('branches: [develop, main]');
  expect(workflow).toContain('production-branch: main');

  const steps = nextSteps(answers, { relay, results, state: APP_STATE });
  // The workflow file reaches develop through a pull request, never by pushing to the branches directly
  expect(steps).toContainEqual(expect.stringContaining('gh pr create --base develop'));
  expect(steps).not.toContainEqual(expect.stringContaining('HEAD:main'));
  expect(steps).toContainEqual(expect.stringContaining('ci: adiciona workflows da Datalogix'));
  expect(nextSteps({ ...answers, language: 'en' }, { relay, results, state: APP_STATE })).toContainEqual(
    expect.stringContaining('ci: add Datalogix workflows'),
  );
  expect(steps).toContainEqual(expect.stringContaining('git switch develop'));
  expect(steps).toContainEqual(expect.stringContaining('release GitHub App'));

  // The file setup wrote has no changes outside its inputs, so running it again warns about nothing
  const written = { ...APP_STATE, workflow, defaultBranch: 'develop', current: projectAnswers(parseInputs(workflow)) };
  expect(await setupWarnings(answers, { state: written })).toStrictEqual([]);
  const edited = { ...written, workflow: workflow.replace('jobs:', 'env:\n  FOO: bar\njobs:') };
  expect(await setupWarnings(answers, { state: edited })).toStrictEqual([
    '.github/workflows/datalogix.yml has changes outside its "with:" inputs: they will be replaced by the template',
  ]);
  const commented = {
    ...written,
    workflow: workflow.replace(
      '      production-branch: main',
      '      # Deploys production\n      production-branch: main',
    ),
  };
  expect(await setupWarnings(answers, { state: commented })).toStrictEqual([
    '.github/workflows/datalogix.yml has comments in its "with:" block: they are removed',
  ]);
  // A comment after a value setup writes is lost; after a value it keeps as it is, it stays
  const trailing = {
    ...written,
    workflow: workflow
      .replace('deploy: forge', 'deploy: forge # Forge sites')
      .replace(/\n$/, '\n      php-version: "8.3" # server\n'),
  };
  expect(await setupWarnings(answers, { state: trailing })).toStrictEqual([
    '.github/workflows/datalogix.yml has comments after the values of deploy: setup rewrites them without',
  ]);

  // Run again on the repository it left: both branches exist and develop is the default
  branches.develop = branches.main;
  const state = { ...APP_STATE, defaultBranch: 'develop', releaseApp: true };
  const again = taskById(setupTasks(answers, { github, root, state, relay }), 'branches');
  expect((await again.run()).detail).toBe('unchanged');
  expect(nextSteps(answers, { relay, results: [], state })).not.toContainEqual(
    expect.stringContaining('release GitHub App'),
  );
});

const branchesTask = (answers, context) => taskById(setupTasks(answers, context), 'branches');

test('creates the development branch from the current default branch, where the latest work is', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub({
    branches: {
      master: { commit: { sha: 'b'.repeat(40) } },
      main: SHA,
    },
  });
  const state = { ...APP_STATE, defaultBranch: 'master' };
  await branchesTask(branchAnswers, { github, root, state, relay }).run();
  expect(github.calls).toContainEqual(['branch', 'develop', 'b'.repeat(40)]);
});

test('creates a renamed production branch from the former one, never from the development branch', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub({
    branches: {
      develop: { commit: { sha: 'd'.repeat(40) } },
      main: SHA,
    },
  });
  const state = { ...APP_STATE, defaultBranch: 'develop', productionBranchStatus: { name: 'main', exists: true } };
  const answers = { ...branchAnswers, productionBranch: 'production' };
  expect((await branchesTask(answers, { github, root, state, relay }).run()).detail).toBe('created production');
  expect(github.calls).toContainEqual(['branch', 'production', 'a'.repeat(40)]);
});

test('keeps the production branch protected when the ruleset follows the default branch away from it', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const ruleset = {
    id: 7,
    name: 'datalogix',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    rules: [{ type: 'deletion' }],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  };
  const branches = { main: SHA };

  const github = fakeGitHub({ branches });
  const state = { ...APP_STATE, ruleset, releaseApp: true };
  const results = byTitle(await runResults(setupTasks(branchAnswers, { github, root, state, relay })));
  expect(results.Branches).toBe('created develop, develop is the default branch');
  expect(results.Ruleset).toBe('protects main');
  expect(github.calls).toContainEqual([
    'ruleset',
    7,
    {
      name: 'datalogix',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      rules: [{ type: 'deletion' }],
      conditions: { ref_name: { include: ['refs/heads/main', '~DEFAULT_BRANCH'], exclude: [] } },
    },
  ]);

  // Without the release GitHub App, its release pull requests run no checks: requiring them would block every release
  const noApp = fakeGitHub({ branches });
  const withoutApp = setupTasks(branchAnswers, { github: noApp, root, state: { ...state, releaseApp: false }, relay });
  expect(withoutApp.map((task) => task.title)).not.toContain('Ruleset');
  await runResults(withoutApp);
  expect(noApp.calls.filter(([name]) => name === 'ruleset')).toStrictEqual([]);
});

test('takes a former production branch out of the ruleset', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const ruleset = {
    id: 7,
    name: 'datalogix',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    rules: [{ type: 'deletion' }],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH', 'refs/heads/main', 'refs/heads/release/*'], exclude: [] } },
  };
  const github = fakeGitHub({ branches: { main: SHA, develop: SHA, production: SHA } });
  const state = {
    ...APP_STATE,
    defaultBranch: 'develop',
    releaseApp: true,
    current: { ...APP_STATE.current, productionBranch: 'main' },
    productionBranchStatus: { name: 'main', exists: true, sha: SHA },
    ruleset,
  };
  const answers = { ...branchAnswers, productionBranch: 'production' };
  const results = byTitle(await runResults(setupTasks(answers, { github, root, state, relay })));
  expect(results.Ruleset).toBe('protects production, no longer protects main');
  expect(github.calls).toContainEqual([
    'ruleset',
    7,
    expect.objectContaining({
      conditions: {
        ref_name: { include: ['refs/heads/production', '~DEFAULT_BRANCH', 'refs/heads/release/*'], exclude: [] },
      },
    }),
  ]);
});

test('asks to switch to the development branch only when the branches changed', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub({ branches: { main: SHA, develop: SHA } });
  const state = {
    ...APP_STATE,
    defaultBranch: 'develop',
    releaseApp: true,
    ruleset: { id: 7, name: 'datalogix', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } } },
  };

  const tasks = setupTasks(branchAnswers, { github, root, state, relay });
  const results = await runResults(tasks);
  // Only the ruleset changed: the user already works on develop
  expect(results.find((result) => result.id === 'branches').detail).toBe('unchanged');
  expect(results.find((result) => result.title === 'Ruleset').detail).toBe('protects main');
  expect(nextSteps(branchAnswers, { relay, results, state })).not.toContainEqual(
    expect.stringContaining('git switch develop'),
  );
});

test('opens a pull request for the workflow file when only the default branch changed', async (t) => {
  const root = await tempRoot(t, 'setup-');
  // develop already exists; main, the default branch, becomes production
  const github = fakeGitHub({ branches: { main: SHA, develop: SHA } });
  const tasks = setupTasks(branchAnswers, { github, root, state: APP_STATE, relay });
  const results = await runResults(tasks);
  expect(results.find((result) => result.id === 'branches').data).toStrictEqual({
    created: [],
    defaultChanged: true,
  });
  const steps = nextSteps(branchAnswers, { relay, results, state: APP_STATE });
  // The local branch is still main, now production: pushing it would deploy production
  expect(steps).toContainEqual(expect.stringContaining('gh pr create --base develop'));
  expect(steps).not.toContainEqual(expect.stringMatching(/&& git push\n|&& git push$/));
  expect(steps).toContainEqual(expect.stringContaining('git switch develop'));
});

test('creates a branch from the former production branch collectState read, without reading it again', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub({ branches: { develop: { commit: { sha: 'd'.repeat(40) } } } });
  const read = [];
  const branch = github.branch;
  github.branch = async (name) => (read.push(name), branch(name));
  const state = {
    ...APP_STATE,
    defaultBranch: 'develop',
    productionBranchStatus: { name: 'main', exists: true, sha: 'f'.repeat(40) },
  };
  const answers = { ...branchAnswers, productionBranch: 'production' };
  await branchesTask(answers, { github, root, state, relay }).run();
  expect(github.calls).toContainEqual(['branch', 'production', 'f'.repeat(40)]);
  expect(read).not.toContain('main');
});

test('leaves the production branch out of the ruleset when storing the release GitHub App fails', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const key = join(root, 'app.private-key.pem');
  await writeFile(key, PEM);
  const github = fakeGitHub({
    branches: { main: SHA },
    setSecret: async () => {
      throw new Error('gh secret set: HTTP 403');
    },
  });
  const answers = { ...branchAnswers, releaseAppClientId: 'Iv23li123', releaseAppKey: key };
  const state = {
    ...APP_STATE,
    ruleset: { id: 7, name: 'datalogix', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } } },
  };

  const results = byTitle(await runResults(setupTasks(answers, { github, root, state, relay })));
  expect(results['Release GitHub App']).toMatchObject({ ok: false, detail: 'gh secret set: HTTP 403' });
  expect(results.Ruleset).toBe('skipped: the release GitHub App secrets were not stored');
  expect(github.calls.filter(([name]) => name === 'ruleset')).toStrictEqual([]);
});

test('makes the production branch the default branch again when the project leaves it', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const answers = { ...branchAnswers, branches: false, developmentBranch: undefined, productionBranch: undefined };
  const state = {
    ...APP_STATE,
    defaultBranch: 'develop',
    current: { deploy: 'forge', staging: true, productionBranch: 'main' },
    productionBranchStatus: { name: 'main', exists: true },
  };

  const tasks = setupTasks(answers, { github, root, state, relay });
  const results = await runResults(tasks);
  expect(results.find((result) => result.id === 'defaultBranch').detail).toBe('main is the default branch again');
  expect(github.calls).toContainEqual(['default', 'main']);
  const workflow = await readFile(join(root, '.github/workflows/datalogix.yml'), 'utf8');
  expect(workflow).toContain('branches: [main]');
  expect(workflow).not.toContain('production-branch');
  expect(nextSteps(answers, { relay, results, state })).not.toContainEqual(
    expect.stringContaining('the default branch again'),
  );
  // Pushes to develop no longer deploy: what is only there must reach main
  expect(nextSteps(answers, { relay, results, state })).toContainEqual(
    expect.stringContaining('gh pr create --base main --head develop'),
  );

  // When changing the default branch failed, the user does it by hand
  const failedDefault = results.map((result) => (result.id === 'defaultBranch' ? { ...result, ok: false } : result));
  expect(nextSteps(answers, { relay, results: failedDefault, state })).toContainEqual(
    expect.stringContaining('make main the default branch again'),
  );
});

test('tells about the former production branch only when the default branch did not become it', () => {
  const answers = { ...branchAnswers, branches: false, developmentBranch: undefined, productionBranch: undefined };
  const leaving = {
    ...APP_STATE,
    defaultBranch: 'develop',
    current: { deploy: 'forge', staging: true, productionBranch: 'main' },
    productionBranchStatus: { name: 'main', exists: true },
  };
  const steps = (state) => nextSteps(answers, { relay, results: [], state });

  // Already the default branch: the Default branch task does not run and nothing is left to do
  const already = { ...leaving, defaultBranch: 'main' };
  expect(idsOf(setupTasks(answers, { root: '', state: already, relay }))).not.toContain('defaultBranch');
  expect(steps(already)).not.toContainEqual(expect.stringContaining('deploys to production'));
  expect(steps(already)).not.toContainEqual(expect.stringContaining('--head'));

  // Deleted: it cannot become the default branch again
  const gone = { ...leaving, productionBranchStatus: { name: 'main', exists: false } };
  expect(idsOf(setupTasks(answers, { root: '', state: gone, relay }))).not.toContain('defaultBranch');
  expect(steps(gone)).not.toContainEqual(expect.stringContaining('the default branch again'));
  expect(steps(gone)).toContainEqual(
    expect.stringContaining('main, the former production branch, no longer exists: develop, the default branch, now'),
  );
});

test('creates the labels and writes the workflow in the chosen language', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const answers = { repository: 'datalogix/app', deploy: 'none', incidents: false, solo: true, codeOwners: '@ana' };

  for (const task of setupTasks({ ...answers, language: 'en' }, { github, root, state: APP_STATE, relay })) {
    await task.run();
  }
  expect(await readFile(join(root, '.github/workflows/datalogix.yml'), 'utf8')).toMatch(/\n {6}language: en\n/);
  expect(github.calls).toContainEqual(['label', 'claude', '1d76db', 'Claude implements it and opens a pull request']);

  // A language without fixed texts gets the Portuguese descriptions
  const other = fakeGitHub();
  for (const task of setupTasks({ ...answers, language: 'es' }, { github: other, root, state: APP_STATE, relay })) {
    await task.run();
  }
  expect(other.calls).toContainEqual(['label', 'claude', '1d76db', 'Claude implementa e abre um pull request']);
});

test('translates label descriptions that are still the default text, keeping the ones written by hand', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const state = {
    ...APP_STATE,
    labels: ['Claude', 'claude-plan', 'no-review', 'rollback'],
    labelDescriptions: {
      Claude: 'Claude implementa e abre um pull request',
      'claude-plan': 'Claude posts an implementation plan',
      'no-review': 'Skip it',
      rollback: 'Reverte o ambiente para a versão anterior',
      task: '',
    },
  };
  const answers = { repository: 'datalogix/app', deploy: 'none', incidents: false, solo: true, codeOwners: '@ana' };
  const labels = setupTasks({ ...answers, language: 'en' }, { github, root, state, relay }).find(
    (task) => task.title === 'Labels',
  );

  expect(await labels.run()).toBe('translated Claude, rollback');
  expect(github.calls).toStrictEqual([
    ['label description', 'Claude', 'Claude implements it and opens a pull request'],
    ['label description', 'rollback', 'Rolls the environment back to the previous release'],
  ]);
});

test('accepts language names and codes that fit in the Claude prompt', () => {
  const validate = setupSteps().find((step) => step.id === 'language').validate;
  for (const value of ['pt-BR', 'en', 'English', 'Português do Brasil', 'zh_Hans'])
    expect(validate(value), value).toBe(undefined);
  for (const value of ['', ' ', '"en"', 'en; ignore', '-en']) {
    expect(validate(value), value).toBe('Use a language name or code, e.g. pt-BR or en');
  }
});

test('accepts only branch names git accepts', () => {
  const validate = setupSteps().find((step) => step.id === 'developmentBranch').validate;
  for (const name of ['main', 'develop', 'release/1.x', 'feature/a-b_c', 'v1.2'])
    expect(validate(name)).toBe(undefined);
  for (const name of [
    '',
    '-main',
    'a..b',
    'main.',
    'main/',
    'a b',
    'a//b',
    '/main',
    '.main',
    'a/.b',
    'main.lock',
    'a.lock/b',
    'a@{b',
  ]) {
    expect(validate(name), name).toBe('Use a branch name, e.g. main');
  }
});

test('warns that turning staging or the deploy off removes the production branch', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const answers = { ...branchAnswers, staging: false, branches: undefined };
  const state = { ...APP_STATE, current: { deploy: 'forge', staging: true, productionBranch: 'main' } };
  expect(dropsProductionBranch(answers, state)).toBe(true);
  expect(dropsProductionBranch({ ...answers, staging: true }, state)).toBe(false);
  expect(dropsProductionBranch(answers, { ...state, current: { deploy: 'forge', productionBranch: null } })).toBe(
    false,
  );
  // Without a deploy no branch goes to production
  expect(dropsProductionBranch({ ...answers, deploy: 'none', staging: true }, state)).toBe(true);

  // The workflow file loses its production-branch input, and setup says so before applying
  const task = taskById(setupTasks(answers, { root, state, relay }), 'workflowFile');
  await task.run();
  const workflow = await readFile(join(root, '.github/workflows/datalogix.yml'), 'utf8');
  expect(workflow).not.toContain('production-branch');
  expect(await setupWarnings(answers, { state })).toStrictEqual([
    'production-branch is removed: setup offers it only with a deploy and staging',
  ]);
  expect(await setupWarnings({ ...answers, staging: true }, { state })).toStrictEqual([]);
  expect(await setupWarnings({ ...answers, deploy: 'none', staging: true }, { state })).toStrictEqual([
    'production-branch is removed: setup offers it only with a deploy and staging',
  ]);
});

test('asks for the branches only with staging', () => {
  const ids = (answers) => askedSteps(setupSteps(), answers);
  expect(ids({ deploy: 'forge', staging: false })).not.toContain('branches');
  expect(ids({ deploy: 'forge', staging: true, branches: false })).not.toContain('productionBranch');
  expect(ids({ deploy: 'forge', staging: true, branches: true })).toEqual(
    expect.arrayContaining(['branches', 'developmentBranch', 'productionBranch']),
  );
});

test('asks for the release GitHub App only when the repository cannot read it', () => {
  const answers = { ...branchAnswers, releaseAppClientId: ' Iv23li123 ' };
  const state = { ...APP_STATE, defaultBranch: 'develop' };
  expect(askedSteps(setupSteps(), answers, { state })).toEqual(
    expect.arrayContaining(['releaseAppClientId', 'releaseAppKey']),
  );
  expect(askedSteps(setupSteps(), answers, { state: { ...state, releaseApp: true } })).not.toContain(
    'releaseAppClientId',
  );
  // An empty client ID skips the key
  expect(askedSteps(setupSteps(), { ...answers, releaseAppClientId: '' }, { state })).not.toContain('releaseAppKey');
});

test('stores the release GitHub App secrets from the key file', async (t) => {
  const root = await folder(t, { 'app.private-key.pem': PEM }, 'setup-');
  const github = fakeGitHub({ branches: { develop: SHA, main: SHA } });
  const answers = {
    ...branchAnswers,
    releaseAppClientId: ' Iv23li123 ',
    releaseAppKey: join(root, 'app.private-key.pem'),
  };
  const state = { ...APP_STATE, defaultBranch: 'develop' };

  const task = taskById(setupTasks(answers, { github, root, state, relay }), 'releaseApp');
  expect(await task.run()).toBe('stored as repository secrets');
  expect(github.calls).toStrictEqual([
    ['secret', 'RELEASE_APP_CLIENT_ID', 'Iv23li123'],
    ['secret', 'RELEASE_APP_PRIVATE_KEY', PEM],
  ]);

  const results = [done('releaseApp', 'stored as repository secrets')];
  expect(nextSteps(answers, { relay, results, state })).not.toContainEqual(
    expect.stringContaining('release GitHub App'),
  );
});

test('lets GitHub Actions open the release pull requests without the App', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub({ branches: { develop: SHA, main: SHA } });
  const answers = { ...branchAnswers, releaseAppClientId: '' };
  const state = {
    ...APP_STATE,
    defaultBranch: 'develop',
    actionsPullRequests: { allowed: false, defaultPermissions: 'read' },
    canProtect: false,
  };

  const tasks = setupTasks(answers, { github, root, state, relay });
  expect(idsOf(tasks)).not.toContain('releaseApp');
  const task = tasks.find((item) => item.title === 'GitHub Actions pull requests');
  expect(await task.run()).toBe(
    'allowed to open and approve pull requests (bot approvals never count for the risk gate)',
  );
  expect(github.calls).toStrictEqual([['allow', 'read']]);

  const allowed = { ...state, actionsPullRequests: { allowed: true, defaultPermissions: 'read' } };
  expect(setupTasks(answers, { github, root, state: allowed, relay }).map((item) => item.title)).not.toContain(
    'GitHub Actions pull requests',
  );

  // On a plan without rulesets the App would change nothing, and protect cannot run
  const steps = nextSteps(answers, { relay, results: [], state });
  expect(steps).not.toContainEqual(expect.stringContaining('release GitHub App'));
  expect(steps.at(-1)).toContain('Private repository on GitHub Free');
  expect(steps).not.toContainEqual(expect.stringContaining('workflows#v2 protect'));
});

test('opens a pull request for the workflow file when the default branch is protected', () => {
  const answers = { repository: 'datalogix/app', deploy: 'none', incidents: false };
  const results = [done('workflowFile', 'updated')];
  const commit = (state) => nextSteps(answers, { relay, results, state }).find((step) => step.startsWith('Commit'));
  expect(commit({ ...APP_STATE, ruleset: { id: 7 } })).toMatch(/^Commit and open a pull request to main:/);
  expect(commit({ ...APP_STATE, ruleset: { id: 7 } })).toContain('gh pr create --base main --fill');
  expect(commit(APP_STATE)).toMatch(/^Commit and push:/);
  // Running setup again updates the file it created before
  expect(commit(APP_STATE)).toContain('ci: atualiza workflows da Datalogix');
  expect(
    nextSteps({ ...answers, language: 'en' }, { relay, results, state: APP_STATE }).find((step) =>
      step.startsWith('Commit'),
    ),
  ).toContain('ci: update Datalogix workflows');
});

test('checks --deploy against the targets of the stack', async () => {
  const deploy = setupSteps().find((step) => step.id === 'deploy');
  expect(deploy.validate('heroku')).toBe('use forge, cloud, none');
  expect(deploy.validate('cloud')).toBe(undefined);
  await expect(askSteps([deploy], { flags: { deploy: 'heroku' } })).rejects.toThrow('--deploy: use forge, cloud, none');
});

test('stops setup with an error when the repository is missing, before other questions', async () => {
  const repository = setupSteps().find((step) => step.id === 'repository');
  const ctx = (state) => ({
    repository: 'datalogix/app',
    folderRepository: 'datalogix/app',
    flags: { repo: 'datalogix/app' },
    root: '/nowhere',
    relay,
    createGitHub: () => ({
      repository: 'datalogix/app',
      repo: async () => state,
      rulesets: async () => [],
      login: async () => null,
    }),
  });
  await expect(repository.then({ repository: 'datalogix/app' }, ctx(null))).rejects.toThrow(
    'datalogix/app was not found, or your gh login cannot see it',
  );
  // GitHub's spelling of the repository, which the relay keys use
  const answers = { repository: 'datalogix/app' };
  await repository.then(answers, ctx({ full_name: 'Datalogix/App' }));
  expect(answers.repository).toBe('Datalogix/App');
});

test('registers the signing secret in the relay only with incidents and a secret', () => {
  const ids = (answers) =>
    idsOf(
      setupTasks(
        { repository: 'datalogix/app', deploy: 'none', codeOwners: '@ana', ...answers },
        { github: fakeGitHub(), root: '', state: APP_STATE, relay },
      ),
    );
  expect(ids({ incidents: true, webhookSecret: 'whsec' })).toContain('monitoringRelay');
  expect(ids({ incidents: true, webhookSecret: '  ' })).not.toContain('monitoringRelay');
  expect(ids({ incidents: false, webhookSecret: 'whsec' })).not.toContain('monitoringRelay');
});

test('tells to store the signing secret by hand on Windows', (t) => {
  onPlatform(t, 'win32');
  expect(askedSteps(setupSteps(), { incidents: true, repository: 'datalogix/app' })).not.toContain('webhookSecret');
  const steps = nextSteps(
    { repository: 'datalogix/app', deploy: 'none', incidents: true },
    { relay, results: [], state: APP_STATE },
  );
  expect(steps).toContainEqual(expect.stringContaining('setup cannot do it on Windows'));
});

test('fails the Branches task when neither branch exists to start from', async () => {
  const state = { ...APP_STATE, defaultBranch: 'trunk' };
  const task = branchesTask(branchAnswers, { github: fakeGitHub(), root: '', state, relay });
  await expect(task.run()).rejects.toThrow('Neither develop nor main exists');
});

test('creates the production branch from the development branch on a first setup on it', async () => {
  // develop is already the default branch and there is no former production branch
  const github = fakeGitHub({ branches: { develop: { commit: { sha: 'd'.repeat(40) } } } });
  const state = { ...APP_STATE, defaultBranch: 'develop' };
  expect((await branchesTask(branchAnswers, { github, root: '', state, relay }).run()).detail).toBe('created main');
  expect(github.calls).toStrictEqual([['branch', 'main', 'd'.repeat(40)]]);
});

test('explains how to allow GitHub Actions pull requests when the repository setting cannot be changed', async () => {
  const denied = new Error('HTTP 409: blocked by the organization');
  const github = fakeGitHub({
    branches: { develop: SHA, main: SHA },
    allowActionsPullRequests: async () => {
      throw denied;
    },
  });
  const state = {
    ...APP_STATE,
    defaultBranch: 'develop',
    actionsPullRequests: { allowed: false, defaultPermissions: 'read' },
  };
  const task = setupTasks({ ...branchAnswers, releaseAppClientId: '' }, { github, root: '', state, relay }).find(
    (item) => item.title === 'GitHub Actions pull requests',
  );
  const error = await task.run().catch((caught) => caught);
  expect(error.message).toBe(
    'could not allow GitHub Actions to open pull requests; allow it in the organization settings (Actions > General) first',
  );
  expect(error.cause).toBe(denied);
});

test('leaves the ruleset alone when it already protects the production branch', () => {
  const ruleset = {
    id: 7,
    name: 'datalogix',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH', 'refs/heads/main'] } },
  };
  const state = { ...APP_STATE, defaultBranch: 'develop', releaseApp: true, ruleset };
  const titles = setupTasks(branchAnswers, { github: fakeGitHub(), root: '', state, relay }).map((task) => task.title);
  expect(titles).not.toContain('Ruleset');
});

test('asks for the Claude token only when the repository and its organization lack it', () => {
  const asked = (claudeToken) =>
    askedSteps(setupSteps(), { deploy: 'none', incidents: false }, { state: { ...APP_STATE, claudeToken } });
  expect(asked({ repository: false, organization: false })).toContain('claudeToken');
  expect(asked({ repository: false, organization: true })).not.toContain('claudeToken');
  expect(asked({ repository: true, organization: false })).not.toContain('claudeToken');
});

test('does not ask to work on the development branch when the Branches task failed', () => {
  const results = [failed('branches', 'HTTP 403')];
  expect(nextSteps(branchAnswers, { relay, results, state: APP_STATE })).not.toContainEqual(
    expect.stringContaining('git switch develop'),
  );
});

test('checks deploy hooks, the health check path and the release App key file', async (t) => {
  const validate = (id) => setupSteps().find((step) => step.id === id).validate;
  expect(validate('productionHook')('https://forge.laravel.com/hook/1')).toBe(undefined);
  expect(validate('productionHook')('forge.laravel.com/hook/1')).toBe('Paste the full https:// URL');
  // A deploy hook may be left empty, while the site does not exist yet
  expect(validate('productionHook')('')).toBe(undefined);
  expect(validate('stagingHook')('  ')).toBe(undefined);
  expect(validate('healthPath')('/up')).toBe(undefined);
  expect(validate('healthPath')('up')).toBe('Start with /, e.g. /up');

  const root = await folder(t, { 'app.private-key.pem': PEM, 'notes.txt': 'not a key' }, 'setup-');
  expect(validate('releaseAppKey')(join(root, 'app.private-key.pem'))).toBe(undefined);
  expect(validate('releaseAppKey')(join(root, 'notes.txt'))).toBe('Not a private key (.pem) file');
  expect(validate('releaseAppKey')(join(root, 'missing.pem'))).toBe('Cannot read that file');
  // ~ is the home folder
  expect(validate('releaseAppKey')('~/datalogix-no-such-key.pem')).toBe('Cannot read that file');
});

test('creates the environments without the deploy hooks left empty and says deploys fail until they are set', async (t) => {
  const root = await tempRoot(t, 'setup-');
  const github = fakeGitHub();
  const answers = {
    repository: 'datalogix/app',
    deploy: 'forge',
    domain: 'example.com',
    staging: true,
    stagingDomain: 'dev.example.com',
    healthPath: '/up',
    productionHook: '',
    stagingHook: 'https://forge.laravel.com/hook/2',
    monitoringMarkers: false,
    solo: true,
    codeOwners: '@ana',
  };

  for (const task of setupTasks(answers, { github, root, state: APP_STATE, relay })) await task.run();
  expect(github.calls.filter(([name]) => name === 'secret')).toStrictEqual([
    ['secret', 'DEPLOY_HOOK', 'https://forge.laravel.com/hook/2', 'staging'],
  ]);

  const hookStep = (state) =>
    nextSteps(answers, { relay, results: [], state }).find((step) => step.includes('until the deploy hook is set'));
  expect(hookStep(APP_STATE)).toContain('production');
  expect(hookStep(APP_STATE)).not.toContain('staging');
  // A hook already set stays as it is
  const environments = { ...APP_STATE.environments, production: { exists: true, deployHook: true } };
  expect(hookStep({ ...APP_STATE, environments })).toBe(undefined);
});

test('refuses the same branch for development and production', async () => {
  const production = setupSteps().find((step) => step.id === 'productionBranch');
  expect(production.validate('develop', { answers: { developmentBranch: 'develop' } })).toBe(undefined);
  // The question compares with the development branch it got; flags reach then()
  expect(() => production.then({ developmentBranch: 'main', productionBranch: 'main' })).toThrow(
    'The production branch must differ from the development branch',
  );
});

test('tells Forge and Laravel Cloud which branch each environment deploys', () => {
  const steps = (deploy) => nextSteps({ ...branchAnswers, deploy }, { relay, results: [], state: APP_STATE });
  expect(steps('forge')).toContainEqual(expect.stringContaining('staging site on develop, production site on main'));
  expect(steps('cloud')).toContainEqual(
    expect.stringContaining('make staging track develop and production track main'),
  );
});

test('lists the labels it created', async () => {
  const github = fakeGitHub();
  const labels = setupTasks(
    { repository: 'datalogix/app', deploy: 'none', codeOwners: '@ana' },
    {
      github,
      root: '',
      state: APP_STATE,
      relay,
    },
  ).find((task) => task.title === 'Labels');
  expect(await labels.run()).toBe(`created ${LABELS.map((label) => label.name).join(', ')}`);
});

/** A fake GitHub for the whole setup command: what collectState reads, and the tasks' changes. */
function setupGitHub(methods = {}) {
  return fakeGitHub({
    repo: async () => ({ full_name: 'datalogix/app', default_branch: 'main' }),
    rulesets: async () => [],
    login: async () => 'ana',
    labels: async () => [],
    environment: async () => null,
    hasRepositorySecret: async () => true,
    hasOrganizationSecret: async () => false,
    claudeApp: async () => 'all',
    workflowPermissions: async () => null,
    ...methods,
  });
}

const setupFlags = {
  yes: true,
  repo: 'datalogix/app',
  deploy: 'none',
  incidents: false,
  language: 'pt-BR',
  lint: 'none',
  'test-command': 'none',
  layers: 'review,security-review,risk-gate,fix-ci',
  solo: true,
  'code-owners': '@ana',
};

/** The context of the setup command in that folder, with those flags. */
const setupContext = (root, github, flags = setupFlags) => ({
  root,
  repository: 'datalogix/app',
  folderRepository: 'datalogix/app',
  flags,
  relay,
  createGitHub: () => github,
});

test('runs setup without questions and fails when a task fails', async (t) => {
  const root = await folder(t, { artisan: '' }, 'setup-');
  const ctx = (github) => setupContext(root, github);
  // An app reads whether GitHub Actions can open the release pull requests, even before it has two branches
  const read = [];
  const github = setupGitHub({ workflowPermissions: async () => (read.push('workflowPermissions'), null) });
  expect(await setup(ctx(github))).toBe(0);
  expect(read).toStrictEqual(['workflowPermissions']);
  expect(await readFile(join(root, '.github/workflows/datalogix.yml'), 'utf8')).toContain('project.yml@v2');

  const failing = setupGitHub({
    createLabel: async () => {
      throw new Error('HTTP 403');
    },
  });
  expect(await setup(ctx(failing))).toBe(1);
});

test('asks for the repository starting from the empty state main gives it', async (t) => {
  const root = await folder(t, { artisan: '' }, 'setup-');
  const { repo, ...flags } = setupFlags;
  prompts.answer = repo;
  expect(await setup({ ...setupContext(root, setupGitHub(), flags), state: EMPTY_STATE })).toBe(0);
  expect(prompts.asked.map((options) => options.message)).toStrictEqual([expect.stringContaining('GitHub repository')]);
});

test('changes nothing when the changes are not confirmed', async (t) => {
  const root = await folder(t, { artisan: '' }, 'setup-');
  const github = setupGitHub();
  prompts.answer = false;
  expect(await setup(setupContext(root, github, { ...setupFlags, yes: false, kind: 'app' }))).toBe(1);
  expect(prompts.asked.at(-1).message).toBe('Apply these changes?');
  await expect(readFile(join(root, '.github/workflows/datalogix.yml'))).rejects.toThrow(/ENOENT/);
  expect(github.calls).toStrictEqual([]);
});

test('passes the workflow file along with the chosen stack', async (t) => {
  const project = await renderProjectWorkflow({ deploy: 'none' });
  const root = await folder(t, { artisan: '', '.github/workflows/datalogix.yml': project }, 'setup-');
  const chosen = await chooseStack({ root, flags: { kind: 'app' } });
  expect([chosen.label, chosen.workflow]).toStrictEqual(['Laravel app', project]);
  expect((await chooseStack({ root, flags: { yes: true } })).workflow).toBe(project);
});

test('refuses to set a folder up as another kind than its workflow file', async (t) => {
  const project = await renderProjectWorkflow({ deploy: 'none' });
  const root = await folder(t, { artisan: '', '.github/workflows/datalogix.yml': project }, 'setup-');
  await expect(chooseStack({ root, flags: { kind: 'package' } })).rejects.toThrow(
    '.github/workflows/datalogix.yml calls the project workflow: setup cannot set this folder up as a Laravel package',
  );
});

test('does not ask the kind when the workflow file leaves a single choice', async (t) => {
  const project = await renderProjectWorkflow({ deploy: 'none' });
  const root = await folder(t, { artisan: '', '.github/workflows/datalogix.yml': project }, 'setup-');
  // Without --yes or flags: Laravel package is not offered, so no question is left to ask
  expect((await chooseStack({ root, flags: {} })).label).toBe('Laravel app');
  expect(prompts.asked).toStrictEqual([]);
});

test('refuses a folder no stack recognizes, unless --stack or --kind says what it is', async (t) => {
  const root = await folder(t, { 'package.json': '{}', 'nuxt.config.ts': '' }, 'setup-');
  for (const flags of [{}, { yes: true }]) {
    await expect(chooseStack({ root, flags })).rejects.toThrow('This folder is not a Laravel app or package');
  }
  expect(prompts.asked).toStrictEqual([]);
  expect((await chooseStack({ root, flags: { kind: 'package' } })).label).toBe('Laravel package');
  expect((await chooseStack({ root, flags: { stack: 'laravel' } })).label).toBe('Laravel app');
});

test('asks the kind, starting from the detected one, when the folder has no workflow file', async (t) => {
  const root = await folder(t, { artisan: '' }, 'setup-');
  prompts.answer = 'Laravel package';
  expect((await chooseStack({ root, flags: {} })).label).toBe('Laravel package');
  expect(prompts.asked).toMatchObject([{ initialValue: 'Laravel app' }]);
  expect(prompts.asked[0].options.map((option) => option.value)).toStrictEqual(['Laravel app', 'Laravel package']);
});

test('allows merge commits for the release pull requests, or tells to', async () => {
  const github = fakeGitHub();
  const state = { ...APP_STATE, repo: { ...APP_STATE.repo, allow_merge_commit: false } };
  const tasks = setupTasks(branchAnswers, { github, root: '', state, relay, probe: async () => 200 });
  const merge = tasks.find((task) => task.id === 'mergeCommits');
  expect(await merge.run()).toBe('allowed, for the release pull requests');
  expect(github.calls).toContainEqual(['merge commits']);

  const steps = (results) => nextSteps(branchAnswers, { relay, results, state });
  expect(steps([done('mergeCommits', 'allowed')]).join('\n')).not.toContain('Allow merge commits');
  expect(steps([failed('mergeCommits', 'HTTP 403')]).join('\n')).toContain('Allow merge commits');
  // Unknown without admin access, and nothing to do with a single branch
  expect(idsOf(setupTasks(branchAnswers, { github, root: '', state: APP_STATE, relay }))).not.toContain('mergeCommits');
  expect(idsOf(setupTasks({ ...branchAnswers, branches: false }, { github, root: '', state, relay }))).not.toContain(
    'mergeCommits',
  );
});

test('tells what to check when a health URL does not answer 200', async () => {
  const answers = { ...branchAnswers, branches: false };
  const probe = async (url) => (url.includes('staging') ? 401 : 200);
  const health = setupTasks(answers, { github: fakeGitHub(), root: '', state: APP_STATE, relay, probe }).find(
    (task) => task.id === 'healthUrls',
  );
  const [result] = await runResults([health]);
  expect(result.detail).toBe('production 200, staging 401');

  const steps = nextSteps(answers, { relay, results: [result], state: APP_STATE });
  const step = steps.find((text) => text.includes('https://staging.app.example.com/up'));
  expect(step).toContain('answers 401, so every deploy to it is rolled back');
  expect(steps.join('\n')).not.toContain('https://app.example.com/up answers');
});

test('tells when the Claude GitHub App may not reach the repository', () => {
  const step = (claudeApp) =>
    nextSteps(branchAnswers, { relay, results: [], state: { ...APP_STATE, claudeApp } })
      .filter((text) => text.includes('Claude GitHub App'))
      .join('\n');
  expect(step('all')).toBe('');
  expect(step('none')).toContain('Install the Claude GitHub App on datalogix');
  expect(step('selected')).toContain('add datalogix/app in its settings');
  expect(step(null)).toContain('gh auth refresh -s admin:org');
});

test('asks whether to record deploys in GitHub only when the app deploys', () => {
  expect(askedSteps(setupSteps(), { ...branchAnswers })).toContain('githubDeployments');
  expect(askedSteps(setupSteps(), { ...branchAnswers, deploy: 'none' })).not.toContain('githubDeployments');
});

test('asks for the approvals only in team projects with the risk gate, and production only when the app deploys', () => {
  const asked = (answers) => askedSteps(setupSteps(), { ...branchAnswers, ...answers });
  expect(asked({ solo: false })).toEqual(expect.arrayContaining(['approvalsMedium', 'approvalsHigh', 'production']));
  expect(asked({ solo: true })).not.toContain('approvalsMedium');
  expect(asked({ solo: false, riskGate: false })).not.toContain('approvalsHigh');
  expect(asked({ deploy: 'none' })).not.toContain('production');
  expect(asked({})).toContain('layers');
});

test('asks whether to run the package.json scripts only when it has some', () => {
  expect(askedSteps(setupSteps(), branchAnswers, { state: { ...APP_STATE, nodeScripts: ['lint'] } })).toContain('js');
  expect(askedSteps(setupSteps(), branchAnswers)).not.toContain('js');
});

test('tells to run protect again when the layers change what the ruleset should require', async () => {
  const { rulesetBody } = await import('../lib/ruleset.js');
  const state = {
    ...APP_STATE,
    ruleset: rulesetBody(['pipeline / tests / tests', 'pipeline / security / security', 'pipeline / gate / gate']),
  };
  const protect = (answers) =>
    nextSteps({ ...branchAnswers, ...answers }, { relay, results: [], state }).find((step) =>
      step.includes('run protect again'),
    );
  expect(protect({ securityReview: true, riskGate: true })).toBeUndefined();
  expect(protect({ securityReview: false, riskGate: true })).toContain(
    'still requires pipeline / security / security, which no longer runs',
  );
  const fewer = { ...state, ruleset: rulesetBody(['pipeline / tests / tests']) };
  expect(
    nextSteps({ ...branchAnswers, securityReview: true, riskGate: false }, { relay, results: [], state: fewer }).find(
      (step) => step.includes('run protect again'),
    ),
  ).toContain('does not require pipeline / security / security yet');
});

test('says the pull request of the workflow file fails the security review', async () => {
  const { rulesetBody } = await import('../lib/ruleset.js');
  const state = { ...APP_STATE, ruleset: rulesetBody(['pipeline / security / security']) };
  const results = [done('workflowFile', 'updated')];
  const pr = (answers) =>
    nextSteps({ ...branchAnswers, branches: false, ...answers }, { relay, results, state }).find((step) =>
      step.includes('open a pull request'),
    );
  expect(pr({})).toContain(
    'the security review fails: have a person review it, then an admin merges it past the check',
  );
  expect(pr({ securityReview: false })).not.toContain('security review fails');
});
