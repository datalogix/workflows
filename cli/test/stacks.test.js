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
const PHP_PACKAGE = ['php', 'package', 'PHP package'];

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
  // Testbench alone makes it a Laravel package, not a PHP one
  expect(
    await detect(t, { 'composer.json': composer({ 'require-dev': { 'orchestra/testbench': '^10.0' } }) }),
  ).toStrictEqual(PACKAGE);
  // A composer.json it cannot read: read as a Laravel app, not recognized
  expect(await detect(t, { 'composer.json': '{ not json' })).toStrictEqual(APP);
  expect(await detect(t, {})).toStrictEqual(APP);
});

test('tells whether a stack recognized the folder or its workflow file', async (t) => {
  const recognized = async (files) => (await detectStack(await folder(t, files, 'stacks-'))).recognized;
  expect(await recognized({ artisan: '' })).toBe(true);
  expect(await recognized({ 'composer.json': LARAVEL_PACKAGE })).toBe(true);
  expect(await recognized({ [WORKFLOW_PATH]: await renderProjectWorkflow({ deploy: 'none' }) })).toBe(true);
  expect(await recognized({ 'package.json': '{}' })).toBe(true);
  expect(await recognized({ 'composer.json': '{}' })).toBe(true);
  expect(await recognized({ 'composer.json': composer({ type: 'project' }) })).toBe(true);
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
    'PHP app',
    'PHP package',
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
  // A composer.json with PHP code makes it a PHP project, with frontend scripts; artisan, a Laravel one
  const library = composer({ autoload: { 'psr-4': { 'Acme\\': 'src/' } } });
  expect(await detect(t, { 'package.json': '{}', 'composer.json': library })).toStrictEqual(PHP_PACKAGE);
  expect(await detect(t, { 'package.json': '{}', artisan: '', 'composer.json': '{}' })).toStrictEqual(APP);
  expect(await detect(t, { 'package.json': '{ not json' })).toStrictEqual(APP);
});

test('takes a JavaScript project whose composer.json is only for tooling, or a Next or Nuxt app with PHP inside', async (t) => {
  const JS_APP = ['js', 'project', 'JavaScript app'];
  const JS_PACKAGE = ['js', 'package', 'JavaScript package'];
  const nuxt = JSON.stringify({ devDependencies: { nuxt: '^4' } });
  const spa = JSON.stringify({ dependencies: { vue: '^3' }, devDependencies: { vite: '^8' } });
  const tooling = composer({
    require: { php: '>=8.3', 'ext-json': '*' },
    'require-dev': { 'squizlabs/php_codesniffer': '^3' },
  });
  const tool = composer({ require: { 'symfony/console': '^7' }, autoload: { 'psr-4': { 'Tool\\': 'tools/' } } });

  // Tooling only: no autoload, platform requirements only, no PHP in src/
  expect(await detect(t, { 'package.json': nuxt, 'composer.json': tooling })).toStrictEqual(JS_APP);
  expect(await detect(t, { 'package.json': '{}', 'composer.json': '{}' })).toStrictEqual(JS_PACKAGE);
  expect(await detect(t, { 'package.json': spa, 'index.html': '', 'composer.json': tooling })).toStrictEqual(JS_APP);
  // A Next or Nuxt app with a PHP tool inside is still a JavaScript app
  expect(await detect(t, { 'package.json': nuxt, 'composer.json': tool })).toStrictEqual(JS_APP);
  expect(await detect(t, { 'package.json': '{}', 'next.config.mjs': '', 'composer.json': tool })).toStrictEqual(JS_APP);

  // A PHP entry point makes it PHP, even with Nuxt: Symfony, a public or web root, Craft, a *.php at the root
  for (const entry of ['bin/console', 'public/index.php', 'web/index.php', 'craft', 'functions.php']) {
    expect((await detect(t, { 'package.json': nuxt, 'composer.json': tooling, [entry]: '' }))[0]).toBe('php');
  }
  // Vite with Vue or React is also the frontend of PHP apps: PHP code keeps it PHP
  expect(await detect(t, { 'package.json': spa, 'index.html': '', 'composer.json': tool })).toStrictEqual(PHP_PACKAGE);
  expect(await detect(t, { 'package.json': '{}', 'composer.json': '{}', 'src/Thing.php': '' })).toStrictEqual(
    PHP_PACKAGE,
  );
  // A WordPress theme or plugin type stays PHP
  expect((await detect(t, { 'package.json': '{}', 'composer.json': composer({ type: 'wordpress-theme' }) }))[0]).toBe(
    'php',
  );
  // A composer.json it cannot read is left to the fallback, as before
  expect(
    (await detectStack(await folder(t, { 'package.json': nuxt, 'composer.json': '{ not json' }, 'stacks-'))).recognized,
  ).toBe(false);
});

test('keeps a JavaScript workflow file on js whatever composer.json says', async (t) => {
  const file = '    uses: datalogix/workflows/.github/workflows/package.yml@v2\n    with:\n      stack: js\n';
  const library = composer({ autoload: { 'psr-4': { 'Acme\\': 'src/' } } });
  expect(await detect(t, { 'package.json': '{}', 'composer.json': library, [WORKFLOW_PATH]: file })).toStrictEqual([
    'js',
    'package',
    'JavaScript package',
  ]);
});

test('tells a PHP package without Laravel from a PHP app', async (t) => {
  // Composer's default type is library: any composer.json without Laravel is a PHP package
  expect(await detect(t, { 'composer.json': '{}' })).toStrictEqual(PHP_PACKAGE);
  expect(
    await detect(t, { 'composer.json': composer({ type: 'symfony-bundle', require: { 'symfony/console': '^7' } }) }),
  ).toStrictEqual(PHP_PACKAGE);
  // A Symfony app (bin/console), a plain PHP app (public/index.php or web/index.php), Craft CMS (craft) or Composer's
  // type project
  for (const files of [
    { 'composer.json': composer({ type: 'project' }) },
    { 'composer.json': '{}', 'bin/console': '' },
    { 'composer.json': '{}', 'public/index.php': '' },
    { 'composer.json': '{}', 'web/index.php': '' },
    { 'composer.json': '{}', craft: '' },
  ]) {
    expect(await detect(t, files)).toStrictEqual(['php', 'project', 'PHP app']);
  }
  expect(fromFlags({ stack: 'php', kind: 'app' }, { stack: 'laravel', kind: 'project' }).label).toBe('PHP app');
});

test('keeps a package workflow file without a stack input on laravel, its default', async (t) => {
  // composer.json does not name Laravel, but the file runs the Laravel package tests
  const file = '    uses: datalogix/workflows/.github/workflows/package.yml@v2\n';
  expect(await detect(t, { 'composer.json': '{}', [WORKFLOW_PATH]: file })).toStrictEqual(PACKAGE);
  expect(await detect(t, { 'composer.json': LARAVEL_PACKAGE, [WORKFLOW_PATH]: naming('php') })).toStrictEqual(
    PHP_PACKAGE,
  );
});

test('tells a Vue or React app built with Vite from a component library', async (t) => {
  const vite = (extra = {}, deps = { vue: '^3' }) =>
    JSON.stringify({ private: true, dependencies: deps, devDependencies: { vite: '^8' }, ...extra });
  const JS_APP = ['js', 'project', 'JavaScript app'];
  const JS_PACKAGE = ['js', 'package', 'JavaScript package'];
  expect(await detect(t, { 'package.json': vite(), 'index.html': '' })).toStrictEqual(JS_APP);
  expect(await detect(t, { 'package.json': vite({}, { react: '^19' }), 'index.html': '' })).toStrictEqual(JS_APP);
  // A component library publishes what it builds
  expect(
    await detect(t, { 'package.json': vite({ exports: { '.': './dist/index.js' } }), 'index.html': '' }),
  ).toStrictEqual(JS_PACKAGE);
  expect(await detect(t, { 'package.json': vite({ main: 'dist/index.js' }), 'index.html': '' })).toStrictEqual(
    JS_PACKAGE,
  );
  // Without index.html, Vite, or Vue or React, it is not a single-page app
  expect(await detect(t, { 'package.json': vite() })).toStrictEqual(JS_PACKAGE);
  expect(
    await detect(t, { 'package.json': JSON.stringify({ dependencies: { vue: '^3' } }), 'index.html': '' }),
  ).toStrictEqual(JS_PACKAGE);
  expect(await detect(t, { 'package.json': vite({}, { lit: '^3' }), 'index.html': '' })).toStrictEqual(JS_PACKAGE);
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
