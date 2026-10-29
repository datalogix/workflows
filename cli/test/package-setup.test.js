import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageAnswers, renderPackageWorkflow } from '../kinds/package/workflow.js';
import { rulesetBody } from '../lib/ruleset.js';
import { collectState } from '../lib/state.js';
import { parseInputs, WORKFLOW_PATH } from '../lib/workflow-file.js';
import { detectStack } from '../stacks/index.js';
import jsPackage from '../stacks/js/package.js';
import laravelPackage from '../stacks/laravel/package.js';
import { byTitle, fakeGitHub, folder, PACKAGE_STATE, runResults, tempRoot } from './helpers.js';

// Quiet progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
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
  const state = await read({ hasRepositorySecret: async (name) => name === 'CODECOV_TOKEN' });
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
  expect(ids).toStrictEqual(['repository', 'codecovToken', 'solo', 'codeOwners']);
  const codecov = jsPackage.setup.steps().find((step) => step.id === 'codecovToken');
  expect(codecov.when({}, { state: { codecovToken: false } })).toBe(false);
  const items = await jsPackage.evaluate({
    ...PACKAGE_STATE,
    workflow,
    current: packageAnswers(parseInputs(workflow)),
  });
  expect(items.map((item) => item.title)).not.toContainEqual(expect.stringContaining('CODECOV_TOKEN'));
});

test('writes no stack input for a Laravel package, and keeps the one of the file when not given', async () => {
  expect(parseInputs(await renderPackageWorkflow('', 'main', { stack: 'laravel' })).stack).toBe(undefined);
  const js = await renderPackageWorkflow('', 'main', { stack: 'js' });
  expect(parseInputs(await renderPackageWorkflow(js, 'main', {})).stack).toBe('js');
  // Written once, in front of the other inputs
  expect(parseInputs(await renderPackageWorkflow(js, 'main', { stack: 'js' })).stack).toBe('js');
});
