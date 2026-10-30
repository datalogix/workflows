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
import laravelPackage from '../stacks/laravel/package.js';
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

  // The fake fails on anything else: the labels, environments and Claude token of an app are not read
  // Both secrets are read together, like an app's Claude token
  const state = await read({
    hasRepositorySecret: async (name) => name === 'CODECOV_TOKEN',
    hasOrganizationSecret: async () => false,
  });
  expect(state.codecovToken).toBe(true);
  expect(state.labels).toBe(undefined);

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
