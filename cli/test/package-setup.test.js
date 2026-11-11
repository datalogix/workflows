import { expect, test, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageAnswers, renderPackageWorkflow } from '../kinds/package/workflow.js';
import { rulesetBody } from '../lib/ruleset.js';
import { NO_TESTS } from '../lib/tools.js';
import { collectState } from '../lib/state.js';
import { parseInputs, WORKFLOW_PATH } from '../lib/workflow-file.js';
import { detectStack } from '../stacks/index.js';
import jsPackage from '../stacks/js/package.js';
import laravelPackage from '../stacks/laravel/package.js';
import phpPackage from '../stacks/php/package.js';
import { byTitle, fakeGitHub, folder, PACKAGE_STATE, runResults, tempRoot } from './helpers.js';

// Quiet progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
  confirm: vi.fn(async () => true),
}));

const { setup } = laravelPackage;

test('writes the package workflow file and the code owners, and stores the Codecov token', async (t) => {
  const root = await tempRoot(t, 'package-');
  const state = { ...PACKAGE_STATE, defaultBranch: 'master' };
  const github = fakeGitHub();
  const answers = { repository: 'datalogix/package', codecovToken: ' token ', solo: true, codeOwners: '@ana' };

  const results = await runResults(setup.tasks(answers, { github, root, state }));
  expect(results.map((result) => [result.title, result.detail])).toStrictEqual([
    ['Workflow file .github/workflows/datalogix.yml', 'created'],
    ['Code owners .github/CODEOWNERS', 'created'],
    ['Codecov token', 'stored as a repository secret'],
  ]);
  const workflow = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  expect(workflow).toContain('uses: datalogix/workflows/.github/workflows/package.yml@v2');
  expect(workflow).toContain('branches: [master]');
  expect(github.calls).toStrictEqual([['secret', 'CODECOV_TOKEN', 'token']]);

  const steps = setup.nextSteps(answers, { results, state });
  // No ruleset: the default branch takes a push
  expect(steps[0]).toMatch(/^Commit and push:/);
  expect(steps[0]).toContain('git add .github/workflows/datalogix.yml .github/CODEOWNERS && git commit');
  expect(steps.at(-1)).toContain('protect --solo');

  // Run again: nothing left to change (a token of spaces is no token)
  const again = {
    ...state,
    workflow,
    codeOwnersFile: await readFile(join(root, '.github/CODEOWNERS'), 'utf8'),
  };
  const quiet = fakeGitHub();
  const rerun = await runResults(
    setup.tasks({ ...answers, codecovToken: '  ' }, { github: quiet, root, state: again }),
  );
  expect(byTitle(rerun)).toStrictEqual({
    'Workflow file .github/workflows/datalogix.yml': 'unchanged',
    'Code owners .github/CODEOWNERS': 'unchanged',
  });
  expect(quiet.calls).toStrictEqual([]);
  expect(await setup.warnings(answers, { state: again })).toStrictEqual([]);
});

test('asks for the code owners only of a team, and writes no CODEOWNERS without them', async (t) => {
  const step = setup.steps().find((candidate) => candidate.id === 'codeOwners');
  expect(step.when({ solo: true }, { flags: {} })).toBe(false);
  expect(step.when({ solo: false }, { flags: {} })).toBe(true);
  // The flag still writes the file of one maintainer
  expect(step.when({ solo: true }, { flags: { 'code-owners': '@ana' } })).toBe(true);

  const root = await tempRoot(t, 'package-');
  const answers = { repository: 'datalogix/package', solo: true };
  const results = await runResults(setup.tasks(answers, { github: fakeGitHub(), root, state: PACKAGE_STATE }));
  expect(results.map((result) => result.title)).toStrictEqual(['Workflow file .github/workflows/datalogix.yml']);
});

test('asks for the Codecov token only when the package uploads coverage and cannot read one', () => {
  const step = setup.steps().find((candidate) => candidate.id === 'codecovToken');
  expect(step.when({}, { state: { codecovToken: true } })).toBe(false);
  expect(step.when({}, { state: { codecovToken: false } })).toBe(true);
  // Nothing to upload without coverage or without tests
  for (const input of ['coverage: false', 'tests: false']) {
    const current = packageAnswers(parseInputs(`jobs:\n  pipeline:\n    with:\n      ${input}\n`));
    expect(step.when({}, { state: { codecovToken: false, current } })).toBe(false);
  }
  // Asked after the test suite question, which may turn it off
  const ids = setup.steps().map((candidate) => candidate.id);
  expect(ids.indexOf('codecovToken')).toBeGreaterThan(ids.indexOf('testRun'));
  expect(step.when({ testRun: NO_TESTS }, { state: { codecovToken: false } })).toBe(false);
  // A test command answered now replaces the file's none
  const none = { codecovToken: false, current: { testCommand: NO_TESTS } };
  expect(step.when({ testRun: 'other' }, { state: none })).toBe(true);
  expect(step.when({}, { state: none })).toBe(false);
});

test('tells to protect the package only without a ruleset, or when it differs from the solo answer', () => {
  const protect = (answers, ruleset) =>
    setup
      .nextSteps(answers, { results: [], state: { ...PACKAGE_STATE, ruleset } })
      .filter((step) => step.includes('workflows#v2 protect'));
  const checks = ['pipeline / tests / all-checks'];

  expect(protect({ solo: true }, null)).toStrictEqual([
    expect.stringMatching(/^After the first pull request shows its checks, protect the default branch:/),
  ]);
  expect(protect({ solo: true }, rulesetBody(checks))).toStrictEqual([]);
  expect(protect({ solo: false }, rulesetBody(checks, { codeOwners: true }))).toStrictEqual([]);
  expect(protect({ solo: false }, rulesetBody(checks))).toStrictEqual([
    expect.stringContaining('Run protect again: the ruleset does not require code owner approval yet'),
  ]);
  expect(protect({ solo: true }, rulesetBody(checks, { codeOwners: true }))).toStrictEqual([
    expect.stringContaining('requires code owner approval, but you work alone'),
  ]);
});

test('tells what check reports about the ruleset: a check of tests turned off, older approvals kept', () => {
  const protect = (ruleset, current = null) =>
    setup
      .nextSteps({ solo: false }, { results: [], state: { ...PACKAGE_STATE, current, ruleset } })
      .find((step) => step.includes('Run protect again'));
  const checks = ['pipeline / tests / all-checks'];
  expect(protect(rulesetBody(checks, { codeOwners: true }), { tests: false })).toContain(
    'still requires pipeline / tests / all-checks, which no longer runs',
  );
  const kept = rulesetBody(checks, { codeOwners: true });
  Object.assign(kept.rules.find((rule) => rule.type === 'pull_request').parameters, {
    dismiss_stale_reviews_on_push: false,
    require_last_push_approval: false,
  });
  expect(protect(kept)).toContain('keeps code owner approvals of older commits');
  expect(protect({ ...rulesetBody(checks, { codeOwners: true }), enforcement: 'evaluate' })).toContain(
    'is evaluate, so nothing is enforced',
  );
});

test('suggests the solo answer the ruleset implies, with what it means for a package', async () => {
  const step = setup.steps().find((candidate) => candidate.id === 'solo');
  const asked = async (ruleset) => {
    clack.confirm.mockClear();
    await step.ask({ header: '', ctx: { state: { ...PACKAGE_STATE, ruleset } } });
    return clack.confirm.mock.calls[0][0];
  };
  const checks = ['pipeline / tests / all-checks'];
  expect((await asked(null)).initialValue).toBe(true);
  expect((await asked(rulesetBody(checks))).initialValue).toBe(true);
  // A team's ruleset: Enter keeps the code owners
  expect((await asked(rulesetBody(checks, { codeOwners: true }))).initialValue).toBe(false);
  expect((await asked(null)).message).toContain('Changes to .github/ need no code owner approval');
  expect((await asked(null)).message).not.toContain('count as your approval');
});

test('tells to open a pull request on a protected branch', () => {
  const state = { ...PACKAGE_STATE, ruleset: rulesetBody(['pipeline / tests / all-checks']) };
  const results = [{ id: 'workflowFile', ok: true, detail: 'created' }];
  const steps = setup.nextSteps({ solo: false }, { results, state });
  expect(steps[0]).toContain('gh pr create --fill');
  expect(steps.at(-1)).toContain('protect --no-solo');
});

const workflowTask = (root, state) =>
  setup.tasks({ codeOwners: '@ana' }, { github: fakeGitHub(), root, state }).find((task) => task.id === 'workflowFile');

test('leaves a CRLF workflow file with the same content unchanged', async (t) => {
  const root = await tempRoot(t, 'package-');
  const workflow = (await renderPackageWorkflow('', 'main')).replace(/\n/g, '\r\n');
  expect(await workflowTask(root, { ...PACKAGE_STATE, workflow }).run()).toBe('unchanged');
});

test('writes the workflow file back with the CRLF line ends it had', async (t) => {
  const root = await tempRoot(t, 'package-');
  // Written on another default branch: setup changes its push branches
  const workflow = (await renderPackageWorkflow('', 'master')).replace(/\n/g, '\r\n');
  expect(await workflowTask(root, { ...PACKAGE_STATE, workflow }).run()).toBe('updated');
  const written = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  expect(written).toContain('branches: [main]\r\n');
  expect(written).not.toMatch(/[^\r]\n/);
});

test('reads only what a package needs from GitHub', async (t) => {
  const root = await folder(t, { 'composer.json': JSON.stringify({ require: { 'illuminate/support': '^12.0' } }) });
  const detected = await detectStack(root);
  const read = async (secrets) =>
    collectState(
      fakeGitHub({
        repo: async () => ({ default_branch: 'main' }),
        rulesets: async () => [],
        login: async () => 'ana',
        ...secrets,
      }),
      root,
      { detected },
    );

  // The fake fails on anything else: the labels, environments and Claude token of an app are not read, nor those of
  // the Claude layers when they are off and setup does not ask (their empty values stay)
  // The organization's secret is read only when the repository has none
  const organizationReads = [];
  const organizationSecret = async (name) => (organizationReads.push(name), false);
  const state = await read({
    hasRepositorySecret: async (name) => name === 'CODECOV_TOKEN',
    hasOrganizationSecret: organizationSecret,
  });
  expect(state.codecovToken).toBe(true);
  expect(state.labels).toStrictEqual([]);
  expect(state.claudeToken).toStrictEqual({ repository: false, organization: false });
  expect(organizationReads).toStrictEqual([]);
  const neither = await read({ hasRepositorySecret: async () => false, hasOrganizationSecret: organizationSecret });
  expect(neither.codecovToken).toBe(false);
  expect(organizationReads).toStrictEqual(['CODECOV_TOKEN']);

  // An organization secret works too; one that cannot be read counts as missing
  const organization = await read({
    hasRepositorySecret: async () => false,
    hasOrganizationSecret: async (name) => name === 'CODECOV_TOKEN',
  });
  expect(organization.codecovToken).toBe(true);
  const unreadable = await read({
    hasRepositorySecret: async () => false,
    hasOrganizationSecret: async () => {
      throw new Error('HTTP 403');
    },
  });
  expect(unreadable.codecovToken).toBe(false);
});

test('writes stack: js for a JavaScript library, and asks for no Codecov token', async (t) => {
  const root = await tempRoot(t, 'package-');
  const answers = { repository: 'datalogix/lib', solo: true, codeOwners: '@ana' };
  const results = await runResults(
    jsPackage.setup.tasks(answers, { github: fakeGitHub(), root, state: PACKAGE_STATE }),
  );
  expect(results.every((result) => result.ok)).toBe(true);
  const workflow = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  expect(parseInputs(workflow)).toMatchObject({ stack: 'js' });
  expect(packageAnswers(parseInputs(workflow)).stack).toBe('js');

  // Its questions: no Codecov token and no Laravel lint or test tools
  const ids = jsPackage.setup.steps().map((step) => step.id);
  expect(ids).toStrictEqual([
    'repository',
    'apiCheck',
    'codecovToken',
    'layers',
    'language',
    'claudeToken',
    'solo',
    'codeOwners',
  ]);
  const codecov = jsPackage.setup.steps().find((step) => step.id === 'codecovToken');
  expect(codecov.when({}, { state: { codecovToken: false } })).toBe(false);
  const items = await jsPackage.evaluate({
    ...PACKAGE_STATE,
    workflow,
    current: packageAnswers(parseInputs(workflow)),
  });
  expect(items.map((item) => item.title)).not.toContainEqual(expect.stringContaining('CODECOV_TOKEN'));
});

test('writes stack: php for a PHP package, with the lint and test tools and the Codecov token of a Laravel one', async (t) => {
  const root = await tempRoot(t, 'package-');
  const answers = { repository: 'datalogix/lib', solo: true, codeOwners: '@ana' };
  const results = await runResults(
    phpPackage.setup.tasks(answers, { github: fakeGitHub(), root, state: PACKAGE_STATE }),
  );
  expect(results.every((result) => result.ok)).toBe(true);
  const workflow = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  expect(parseInputs(workflow)).toMatchObject({ stack: 'php' });
  expect(packageAnswers(parseInputs(workflow)).stack).toBe('php');

  // The same questions as a Laravel package
  const ids = (kind) => kind.setup.steps().map((step) => step.id);
  expect(ids(phpPackage)).toStrictEqual(ids(laravelPackage));
  const codecov = phpPackage.setup.steps().find((step) => step.id === 'codecovToken');
  expect(codecov.when({}, { state: { ...PACKAGE_STATE, codecovToken: false } })).toBe(true);
});

test('writes no stack input for a Laravel package, and keeps the one of the file when not given', async () => {
  expect(parseInputs(await renderPackageWorkflow('', 'main', { stack: 'laravel' })).stack).toBe(undefined);
  const js = await renderPackageWorkflow('', 'main', { stack: 'js' });
  expect(parseInputs(await renderPackageWorkflow(js, 'main', {})).stack).toBe('js');
  // Written once, in front of the other inputs
  expect(parseInputs(await renderPackageWorkflow(js, 'main', { stack: 'js' })).stack).toBe('js');
});

test('turns the Claude layers on only when asked, writing true, and reads what they need', async () => {
  // Off by default: nothing is written, and the questions of the layers are not asked
  const off = await renderPackageWorkflow('', 'main', { claude: false, review: false, securityReview: false });
  expect(parseInputs(off)).toStrictEqual({});
  const steps = setup.steps();
  const language = steps.find((step) => step.id === 'language');
  const token = steps.find((step) => step.id === 'claudeToken');
  const state = { ...PACKAGE_STATE };
  expect(language.when({ claude: false, review: false, securityReview: false }, { state })).toBe(false);
  expect(token.when({ review: true }, { state })).toBe(true);
  // The organization's token is enough
  expect(
    token.when({ review: true }, { state: { ...state, claudeToken: { repository: false, organization: true } } }),
  ).toBe(false);

  const on = await renderPackageWorkflow('', 'main', {
    stack: 'php',
    claude: true,
    review: false,
    securityReview: true,
    language: 'en',
  });
  expect(parseInputs(on)).toStrictEqual({ stack: 'php', claude: 'true', 'security-review': 'true', language: 'en' });
  expect(packageAnswers(parseInputs(on))).toMatchObject({
    claude: true,
    review: false,
    securityReview: true,
    language: 'en',
  });
  // Turned off again: the input goes away; not asked (no layer answer): kept
  expect(parseInputs(await renderPackageWorkflow(on, 'main', { claude: false, securityReview: true }))).toStrictEqual({
    stack: 'php',
    'security-review': 'true',
  });
  expect(parseInputs(await renderPackageWorkflow(on, 'main', {}))).toMatchObject({ claude: 'true', language: 'en' });

  // The security review is a required check only when it is on
  expect(laravelPackage.requiredChecks({ current: packageAnswers({}) })).toStrictEqual([
    'pipeline / tests / all-checks',
  ]);
  expect(laravelPackage.requiredChecks({ current: packageAnswers(parseInputs(on)) })).toStrictEqual([
    'pipeline / tests / all-checks',
    'pipeline / security / security',
  ]);

  // Setup reads the labels, the Claude token and the App; so does check when a layer is on
  const github = fakeGitHub({
    hasRepositorySecret: async () => false,
    hasOrganizationSecret: async (name) => name === 'CLAUDE_CODE_OAUTH_TOKEN',
    labels: async () => [{ name: 'claude', description: 'Claude implementa e abre um pull request' }],
    claudeApp: async () => 'selected',
  });
  const read = (github_, options) => laravelPackage.read(github_, (_what, promise) => promise, options);
  expect(await read(github, { claude: true })).toMatchObject({
    labels: ['claude'],
    claudeToken: { repository: false, organization: true },
    claudeApp: 'selected',
  });
  expect(await read(github, { current: packageAnswers({ review: 'true' }) })).toMatchObject({ labels: ['claude'] });
});

test('creates the labels of the layers that are on, stores the token and checks them', async (t) => {
  const root = await tempRoot(t, 'package-');
  const created = [];
  const github = fakeGitHub({
    createLabel: async (name) => created.push(name),
    setSecret: async () => {},
  });
  const answers = { repository: 'datalogix/lib', solo: true, claude: true, review: true, claudeToken: 'token' };
  const results = await runResults(laravelPackage.setup.tasks(answers, { github, root, state: PACKAGE_STATE }));
  expect(results.every((result) => result.ok)).toBe(true);
  expect(created.sort()).toStrictEqual(['claude', 'claude-plan', 'no-review']);
  expect(byTitle(results)['Claude token']).toBe('stored as a repository secret');

  // Off: no labels, no token
  const off = laravelPackage.setup.tasks(
    { repository: 'datalogix/lib', solo: true },
    { github, root, state: PACKAGE_STATE },
  );
  expect(off.map((task) => task.title)).not.toContain('Labels');

  // check: the token and the App are errors only with a layer on
  const workflow = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  const titles = async (current, extra = {}) =>
    (await laravelPackage.evaluate({ ...PACKAGE_STATE, workflow, current, ...extra })).map(
      (item) => `${item.status} ${item.title}`,
    );
  expect(await titles(packageAnswers(parseInputs(workflow)))).toContainEqual(
    expect.stringContaining('Missing labels: claude, claude-plan, no-review'),
  );
  expect(await titles(packageAnswers(parseInputs(workflow)))).toContainEqual(
    expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN is not available'),
  );
  expect(await titles(packageAnswers({}))).not.toContainEqual(expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN'));
});

test('turns the risk gate on as a layer that needs no Claude, counting a solo author as one approval', async () => {
  const gate = await renderPackageWorkflow('', 'main', { riskGate: true, solo: true });
  expect(parseInputs(gate)).toStrictEqual({ 'risk-gate': 'true', 'count-author': 'true' });
  // A team: the author does not count
  expect(parseInputs(await renderPackageWorkflow('', 'main', { riskGate: true, solo: false }))).toStrictEqual({
    'risk-gate': 'true',
  });
  // Turned off: count-author goes with it
  expect(parseInputs(await renderPackageWorkflow(gate, 'main', { riskGate: false, solo: true }))).toStrictEqual({});

  const current = packageAnswers(parseInputs(gate));
  expect(current.riskGate).toBe(true);
  expect(laravelPackage.requiredChecks({ current })).toStrictEqual([
    'pipeline / tests / all-checks',
    'pipeline / gate / gate',
  ]);
  // No Claude token or language for the risk gate alone
  const steps = setup.steps();
  const state = { ...PACKAGE_STATE };
  expect(steps.find((step) => step.id === 'claudeToken').when({ riskGate: true }, { state })).toBe(false);
  expect(steps.find((step) => step.id === 'language').when({ riskGate: true }, { state })).toBe(false);
});

test('writes api-check only when on, and keeps it when the question is not asked', async () => {
  const on = await renderPackageWorkflow('', 'main', { apiCheck: true });
  expect(parseInputs(on)).toStrictEqual({ 'api-check': 'true' });
  expect(packageAnswers(parseInputs(on)).apiCheck).toBe(true);
  expect(parseInputs(await renderPackageWorkflow(on, 'main', {}))).toStrictEqual({ 'api-check': 'true' });
  expect(parseInputs(await renderPackageWorkflow(on, 'main', { apiCheck: false }))).toStrictEqual({});
  // The question says what each stack checks
  const step = (kind) => kind.setup.steps().find((candidate) => candidate.id === 'apiCheck');
  expect(step(laravelPackage).flag).toBe('api-check');
  expect(step(jsPackage).flag).toBe('api-check');
});

test('reports a layer that is on when the workflow file lacks its events or permissions', async () => {
  const errors = async (workflow) =>
    (await laravelPackage.evaluate({ ...PACKAGE_STATE, workflow, current: packageAnswers(parseInputs(workflow)) }))
      .filter((item) => item.level === 'error')
      .map((item) => item.title);
  // The file setup writes has what every layer needs
  const full = await renderPackageWorkflow('', 'main', {
    claude: true,
    review: true,
    securityReview: true,
    riskGate: true,
  });
  expect(await errors(full)).not.toContainEqual(expect.stringContaining('lacks'));

  // An older file: only pushes and pull requests, and contents: read
  const old = [
    'name: datalogix',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  pipeline:',
    '    uses: datalogix/workflows/.github/workflows/package.yml@v2',
    '    secrets: inherit',
    '    with:',
    '      risk-gate: true',
    '      claude: true',
    '',
  ].join('\n');
  const found = await errors(old);
  expect(found).toContainEqual(
    expect.stringContaining(
      'turns on the risk gate but lacks the pull_request_review event, pull-requests: write, issues: write',
    ),
  );
  expect(found).toContainEqual(expect.stringContaining('turns on @claude but lacks the issues event'));
  expect(found).toContainEqual(expect.stringContaining('contents: write'));
});
