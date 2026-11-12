import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectRelease } from '../kinds/package/release.js';
import { RELEASE_JOB, renderPackageWorkflow, workflowAnswers } from '../kinds/package/workflow.js';
import { packageRoot } from '../lib/project.js';
import { hasJob, jobPermissions, jobText, parseInputs } from '../lib/workflow-file.js';
import jsPackage from '../stacks/js/package.js';
import laravelPackage from '../stacks/laravel/package.js';
import { fakeGitHub, folder, PACKAGE_STATE, runResults, tempRoot } from './helpers.js';

// Quiet progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
}));

const answersOf = (workflow) => workflowAnswers(parseInputs(workflow), workflow);

test('writes the release job only with releases on, as in examples/package-release.yml', async () => {
  const off = await renderPackageWorkflow('', 'main', { release: false });
  expect(hasJob(off, RELEASE_JOB)).toBe(false);
  expect(answersOf(off).release).toBe(false);

  const on = await renderPackageWorkflow('', 'main', { release: true, stack: 'laravel' });
  const example = await readFile(join(packageRoot, 'examples', 'package-release.yml'), 'utf8');
  expect(jobText(on, RELEASE_JOB)).toBe(jobText(example, RELEASE_JOB));
  expect(jobPermissions(on, RELEASE_JOB)).toStrictEqual({
    contents: 'write',
    'pull-requests': 'write',
    'id-token': 'write',
  });
  // The tests keep contents: read
  expect(on).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(answersOf(on).release).toBe(true);

  // Unanswered: kept; turned off: gone
  expect(hasJob(await renderPackageWorkflow(on, 'main', {}), RELEASE_JOB)).toBe(true);
  expect(hasJob(await renderPackageWorkflow(on, 'main', { release: false }), RELEASE_JOB)).toBe(false);
});

test('writes the stack and the language of the release job, and keeps its other inputs', async () => {
  const js = await renderPackageWorkflow('', 'main', { release: true, stack: 'js', language: 'en' });
  expect(parseInputs(js, RELEASE_JOB)).toStrictEqual({ stack: 'js', language: 'en' });
  expect(answersOf(js).language).toBe('en');

  const edited = js.replace('      language: en', '      language: en\n      extra: kept');
  expect(
    parseInputs(await renderPackageWorkflow(edited, 'main', { release: true, stack: 'js' }), RELEASE_JOB),
  ).toStrictEqual({
    stack: 'js',
    language: 'en',
    extra: 'kept',
  });
});

test('writes the release job next to the claude job of the Claude layers', async () => {
  const both = await renderPackageWorkflow('', 'main', { release: true, riskGate: true, stack: 'php' });
  expect(hasJob(both, 'claude')).toBe(true);
  expect(hasJob(both, RELEASE_JOB)).toBe(true);
  expect(answersOf(both)).toMatchObject({ riskGate: true, release: true });
  // Without the layers, only the claude job goes
  const releaseOnly = await renderPackageWorkflow(both, 'main', { release: true, riskGate: false, stack: 'php' });
  expect(hasJob(releaseOnly, 'claude')).toBe(false);
  expect(hasJob(releaseOnly, RELEASE_JOB)).toBe(true);
});

test('asks for the release App without it, and for an npm token only for a js package', () => {
  const steps = (kind) => Object.fromEntries(kind.setup.steps().map((step) => [step.id, step]));
  const state = { ...PACKAGE_STATE };
  const laravel = steps(laravelPackage);
  const js = steps(jsPackage);
  expect(laravel.release.flag).toBe('release');
  expect(laravel.releaseAppClientId.when({ release: true }, { state })).toBe(true);
  expect(laravel.releaseAppClientId.when({ release: true }, { state: { ...state, releaseApp: true } })).toBe(false);
  expect(laravel.releaseAppClientId.when({ release: false }, { state })).toBe(false);
  expect(laravel.npmToken.when({ release: true }, { state })).toBe(false);
  expect(js.npmToken.when({ release: true }, { state })).toBe(true);
  expect(js.npmToken.when({ release: true }, { state: { ...state, npmToken: true } })).toBe(false);
  // The language is asked for the release pull request too
  expect(laravel.language.when({ release: true }, { state })).toBe(true);
});

test('stores the npm token, and tells what releases need by hand', async (t) => {
  const root = await tempRoot(t, 'release-');
  const stored = [];
  const github = fakeGitHub({ setSecret: async (name) => stored.push(name) });
  const answers = { repository: 'datalogix/lib', solo: true, release: true, npmToken: ' npm_x ' };
  const results = await runResults(jsPackage.setup.tasks(answers, { github, root, state: PACKAGE_STATE }));
  expect(results.every((result) => result.ok)).toBe(true);
  expect(stored).toStrictEqual(['NPM_TOKEN']);

  const steps = jsPackage.setup.nextSteps(
    { ...answers, npmToken: '' },
    { results, state: { ...PACKAGE_STATE, canProtect: true, npmName: '@acme/lib' } },
  );
  expect(steps).toContainEqual(expect.stringContaining('Contents: Read and write'));
  expect(steps).toContainEqual(expect.stringContaining('a protected branch cannot merge it'));
  expect(steps).toContainEqual(expect.stringContaining('add a trusted publisher to'));
  // A Laravel package publishes nothing to npm
  const laravel = laravelPackage.setup.nextSteps(answers, {
    results: [],
    state: { ...PACKAGE_STATE, releaseApp: true },
  });
  expect(laravel.join('\n')).not.toContain('npm');
});

test('reads what releases need from the folder', async (t) => {
  const root = await folder(
    t,
    {
      'composer.json': JSON.stringify({ name: 'acme/lib', version: '1.0.0' }),
      'package.json': JSON.stringify({
        name: '@acme/lib',
        workspaces: ['a'],
        repository: { url: 'git+https://github.com/acme/other.git' },
      }),
      '.github/workflows/publish.yml': 'on:\n  release:\n    types: [published]\n',
      '.github/workflows/datalogix.yml': 'on: push\n',
    },
    'release-',
  );
  expect(await inspectRelease(root)).toStrictEqual({
    composerVersion: '1.0.0',
    workspaces: true,
    npmName: '@acme/lib',
    repositoryUrl: 'git+https://github.com/acme/other.git',
    publishingWorkflows: ['publish.yml'],
  });
});

test('reports what releases lack: the job permissions, the App, and what the folder says', async () => {
  const workflow = (await renderPackageWorkflow('', 'main', { release: true, stack: 'js' })).replace(
    '      id-token: write\n',
    '',
  );
  const items = await jsPackage.evaluate({
    ...PACKAGE_STATE,
    repo: { full_name: 'datalogix/lib', default_branch: 'main' },
    canProtect: true,
    workflow,
    current: answersOf(workflow),
    workspaces: true,
    repositoryUrl: 'git+https://github.com/acme/other.git',
    publishingWorkflows: ['publish.yml'],
  });
  const titles = (level) => items.filter((item) => item.level === level).map((item) => item.title);
  expect(titles('error')).toContainEqual(expect.stringContaining('The release job lacks id-token: write'));
  expect(titles('error')).toContainEqual(expect.stringContaining('No release GitHub App'));
  expect(titles('warn')).toContainEqual(expect.stringContaining('workspaces'));
  expect(titles('warn')).toContainEqual(expect.stringContaining("package.json's repository"));
  expect(titles('warn')).toContainEqual(expect.stringContaining('publish.yml also publishes'));

  // A Laravel package with the App: only composer.json's version
  const laravelWorkflow = await renderPackageWorkflow('', 'main', { release: true, stack: 'laravel' });
  const laravel = await laravelPackage.evaluate({
    ...PACKAGE_STATE,
    repo: { full_name: 'datalogix/lib', default_branch: 'main' },
    canProtect: true,
    releaseApp: true,
    workflow: laravelWorkflow,
    current: answersOf(laravelWorkflow),
    composerVersion: '1.0.0',
  });
  expect(laravel.filter((item) => item.level === 'error').map((item) => item.title)).not.toContainEqual(
    expect.stringContaining('release'),
  );
  expect(laravel.map((item) => item.title)).toContainEqual(expect.stringContaining('composer.json sets version 1.0.0'));

  // Releases off: nothing about them
  const off = await laravelPackage.evaluate({ ...PACKAGE_STATE, canProtect: true, current: answersOf('') });
  expect(off.map((item) => item.title).join('\n')).not.toContain('release GitHub App');
});

test('reads the release App and the npm token in setup or with releases on', async () => {
  const github = fakeGitHub({
    hasRepositorySecret: async (name) => name === 'NPM_TOKEN',
    hasOrganizationSecret: async (name) => name.startsWith('RELEASE_APP_'),
    // What setup also reads for the Claude layers
    labels: async () => [],
    claudeApp: async () => 'all',
  });
  const read = (options) => laravelPackage.read(github, (_what, promise) => promise, options);
  expect(await read({ claude: true })).toMatchObject({ releaseApp: true, npmToken: true });
  expect(await read({ current: { release: true } })).toMatchObject({ releaseApp: true, npmToken: true });
  expect(await read({ current: { release: false } })).not.toHaveProperty('releaseApp');
});
