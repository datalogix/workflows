import { expect, test } from 'vitest';
import { renderProjectWorkflow } from '../kinds/project/workflow.js';
import { WORKFLOW_PATH } from '../lib/workflow-file.js';
import { detectStack, fromFlags, setupChoices, withModule, workflowKind } from '../stacks/index.js';
import laravel from '../stacks/laravel/index.js';
import { folder } from './helpers.js';

const detect = async (t, files) => {
  const { stack, kind, label } = await detectStack(await folder(t, files, 'stacks-'));
  return [stack, kind, label];
};

const APP = ['laravel', 'project', 'Laravel app'];
const PACKAGE = ['laravel', 'package', 'Laravel package'];

const composer = (json) => JSON.stringify(json);
const LARAVEL_PACKAGE = composer({ require: { 'illuminate/support': '^12.0' } });

test('tells a Laravel app from a Laravel package by the folder', async (t) => {
  expect(await detect(t, { artisan: '', 'composer.json': '{}' })).toStrictEqual(APP);
  expect(await detect(t, { 'composer.json': LARAVEL_PACKAGE })).toStrictEqual(PACKAGE);
  expect(
    await detect(t, { 'composer.json': composer({ 'require-dev': { 'laravel/framework': '^12.0' } }) }),
  ).toStrictEqual(PACKAGE);
  expect(await detect(t, { 'composer.json': composer({ extra: { laravel: { providers: ['A'] } } }) })).toStrictEqual(
    PACKAGE,
  );
  // Not a Laravel folder (or a composer.json it cannot read): read as a Laravel app, not recognized
  expect(await detect(t, { 'composer.json': '{}' })).toStrictEqual(APP);
  expect(await detect(t, { 'composer.json': '{ not json' })).toStrictEqual(APP);
  expect(await detect(t, {})).toStrictEqual(APP);
});

test('tells whether a stack recognized the folder or its workflow file', async (t) => {
  const recognized = async (files) => (await detectStack(await folder(t, files, 'stacks-'))).recognized;
  expect(await recognized({ artisan: '' })).toBe(true);
  expect(await recognized({ 'composer.json': LARAVEL_PACKAGE })).toBe(true);
  expect(await recognized({ [WORKFLOW_PATH]: await renderProjectWorkflow({ deploy: 'none' }) })).toBe(true);
  expect(await recognized({ 'package.json': '{}' })).toBe(true);
  expect(await recognized({ Gemfile: '' })).toBe(false);
  expect(await recognized({})).toBe(false);
});

test('lets the workflow file decide the kind', async (t) => {
  expect(
    await detect(t, {
      artisan: '',
      [WORKFLOW_PATH]: '    uses: datalogix/workflows/.github/workflows/package.yml@v2\n',
    }),
  ).toStrictEqual(PACKAGE);
  expect(
    await detect(t, {
      'composer.json': LARAVEL_PACKAGE,
      [WORKFLOW_PATH]: await renderProjectWorkflow({ deploy: 'none' }),
    }),
  ).toStrictEqual(APP);

  // The kind the file calls goes along, so setup does not work it out again
  const root = await folder(t, { [WORKFLOW_PATH]: await renderProjectWorkflow({ deploy: 'none' }) }, 'stacks-');
  expect((await detectStack(root)).fileKind).toBe('project');
  expect((await detectStack(await folder(t, { artisan: '' }, 'stacks-'))).fileKind).toBe(null);
});

// A package workflow file that names its stack
const naming = (stack, entry = 'package') =>
  `    uses: datalogix/workflows/.github/workflows/${entry}.yml@v2\n    with:\n      stack: ${stack}\n`;

test('reads the stack input in any case, as GitHub compares it', async (t) => {
  expect(await detect(t, { [WORKFLOW_PATH]: naming('laravel') })).toStrictEqual(PACKAGE);
  expect(await detect(t, { [WORKFLOW_PATH]: naming('Laravel') })).toStrictEqual(PACKAGE);
});

test('leaves the kind to the folder when the workflow file names the stack but calls no entry point', async (t) => {
  const file = naming('laravel', 'claude');
  expect(await detect(t, { 'composer.json': LARAVEL_PACKAGE, [WORKFLOW_PATH]: file })).toStrictEqual(PACKAGE);
  expect(await detect(t, { artisan: '', [WORKFLOW_PATH]: file })).toStrictEqual(APP);
  expect(await detect(t, { [WORKFLOW_PATH]: file })).toStrictEqual(APP);
});

test('refuses a stack the workflow file names but the command does not support', async (t) => {
  await expect(detect(t, { [WORKFLOW_PATH]: 'jobs:\n  pipeline:\n    with:\n      stack: nuxt\n' })).rejects.toThrow(
    'uses stack nuxt, which this command does not support yet',
  );
});

test('names the unsupported kind as the commands do: app or package', () => {
  expect(() => withModule({ ...laravel, kinds: { project: laravel.kinds.project } }, 'package')).toThrow(
    'Laravel packages are not supported yet',
  );
  // The kind is named as the commands name it: app, not project
  expect(() => withModule({ ...laravel, kinds: { package: laravel.kinds.package } }, 'project')).toThrow(
    'Laravel apps are not supported yet',
  );
});

test('offers every stack and kind setup supports', () => {
  expect(setupChoices().map((choice) => choice.label)).toStrictEqual([
    'Laravel app',
    'Laravel package',
    'JavaScript app',
    'JavaScript package',
  ]);
});

test('tells a JavaScript library from a Next or Nuxt app, and a PHP project from both', async (t) => {
  const manifest = (json) => JSON.stringify(json);
  expect(await detect(t, { 'package.json': manifest({ devDependencies: { typescript: '^5' } }) })).toStrictEqual([
    'js',
    'package',
    'JavaScript package',
  ]);
  for (const files of [
    { 'package.json': manifest({ dependencies: { next: '^16' } }) },
    { 'package.json': manifest({ devDependencies: { nuxt: '^4' } }) },
    { 'package.json': '{}', 'nuxt.config.ts': '' },
  ]) {
    expect(await detect(t, files)).toStrictEqual(['js', 'project', 'JavaScript app']);
  }
  // composer.json makes it a PHP project, with frontend scripts
  expect(await detect(t, { 'package.json': '{}', 'composer.json': '{}' })).toStrictEqual(APP);
  expect(await detect(t, { 'package.json': '{ not json' })).toStrictEqual(APP);
});

test('takes the stack and kind from the flags, app being the project kind', () => {
  const detected = { stack: 'laravel', kind: 'package' };
  expect(fromFlags({ kind: 'app' }, detected).kind).toBe('project');
  expect(fromFlags({ kind: 'package', stack: 'laravel' }, detected).label).toBe('Laravel package');
  expect(fromFlags({}, detected).kind).toBe('package');
  expect(() => fromFlags({ stack: 'nuxt' }, detected)).toThrow('--stack: use laravel');
});

test('tells a project workflow file from a package one', async () => {
  expect(workflowKind(laravel, await renderProjectWorkflow({ deploy: 'none' }))).toBe('project');
  expect(workflowKind(laravel, '    uses: datalogix/workflows/.github/workflows/package.yml@v2\n')).toBe('package');
  expect(workflowKind(laravel, '    uses: datalogix/workflows/.github/workflows/claude.yml@v2\n')).toBe(null);
});
