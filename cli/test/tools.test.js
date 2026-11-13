import { beforeEach, expect, test, vi } from 'vitest';
import { packageAnswers, renderPackageWorkflow } from '../kinds/package/workflow.js';
import { projectAnswers, renderProjectWorkflow } from '../kinds/project/workflow.js';
import { commandValue, toolInputs, validCommand } from '../lib/tools.js';
import { askSteps } from '../lib/ui.js';
import { parseInputs } from '../lib/workflow-file.js';
import {
  inspectTools,
  NO_TOOLS,
  scriptCommands,
  suggestedLint,
  suggestedTests,
  toolSteps,
} from '../stacks/laravel/tools.js';
import app from '../stacks/laravel/app.js';
import laravelPackage from '../stacks/laravel/package.js';
import { APP_STATE, folder } from './helpers.js';

// What the prompts showed, and the answers a test gives them in order
const prompts = vi.hoisted(() => ({ asked: [], answers: [] }));
const reply = vi.hoisted(() => async (options) => (prompts.asked.push(options), prompts.answers.shift()));

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  multiselect: reply,
  select: reply,
  text: reply,
}));

beforeEach(() => Object.assign(prompts, { asked: [], answers: [] }));

// The composer.json of a Laravel 13 starter kit: Pint, Larastan, Pest, and a test script that also lints
const STARTER = {
  require: { 'laravel/framework': '^13.0' },
  'require-dev': { 'laravel/pint': '^1.27', 'larastan/larastan': '^3.9', 'pestphp/pest': '^5.1' },
  scripts: {
    lint: ['pint --parallel'],
    'lint:check': ['pint --parallel --test'],
    'types:check': ['phpstan analyse'],
    'ci:check': ['@test'],
    test: ['@php artisan config:clear --ansi', '@lint:check', '@types:check', '@php artisan test'],
  },
};

test('reads the installed tools and the scripts of composer.json', async (t) => {
  const root = await folder(t, { 'composer.json': JSON.stringify(STARTER) });
  const read = await inspectTools(root);
  expect(read).toMatchObject({ pint: true, phpstan: true, pest: true, phpunit: true });
  expect(scriptCommands(read.scripts, 'test')).toStrictEqual([
    '@php artisan config:clear --ansi',
    'pint --parallel --test',
    'phpstan analyse',
    '@php artisan test',
  ]);
  // Without composer.json, nothing is installed
  expect(await inspectTools(await folder(t))).toStrictEqual(NO_TOOLS);
  expect(await inspectTools(await folder(t, { 'composer.json': '{' }))).toStrictEqual(NO_TOOLS);
  expect(scriptCommands({ a: ['@b'], b: ['@a', 'x'] }, 'a')).toStrictEqual(['x']);
});

test('reads PHPUnit, every PHPStan package, and only the commands of a script', async (t) => {
  const tools = async (composer) => inspectTools(await folder(t, { 'composer.json': JSON.stringify(composer) }));
  expect(await tools({ 'require-dev': { 'phpunit/phpunit': '^12' } })).toStrictEqual({
    ...NO_TOOLS,
    phpunit: true,
  });
  for (const name of ['phpstan/phpstan', 'nunomaduro/larastan']) {
    expect((await tools({ 'require-dev': { [name]: '*' } })).phpstan, name).toBe(true);
  }
  // composer also takes objects in a script's list
  expect((await tools({ scripts: { test: ['@php artisan test', { x: 1 }], one: 'pint' } })).scripts).toStrictEqual({
    test: ['@php artisan test'],
    one: ['pint'],
  });
});

test('reads Rector only with its config, offers it and leaves its scripts out of the lint command', async (t) => {
  const composer = {
    'require-dev': { 'rector/rector': '^2.8' },
    scripts: { 'rector:check': ['rector --dry-run'] },
  };
  const without = await inspectTools(await folder(t, { 'composer.json': JSON.stringify(composer) }));
  expect(without.rector).toBe(false);
  const installed = await inspectTools(
    await folder(t, { 'composer.json': JSON.stringify(composer), 'rector.php': '<?php' }),
  );
  expect(installed.rector).toBe(true);
  expect(suggestedLint(installed, ['rector', 'command'])).toBe('');
  expect(suggestedLint(installed, ['command'])).toBe('composer rector:check');

  prompts.answers = [['command']];
  await askSteps(toolSteps('package'), {
    ...ctxWith(installed),
    flags: { 'lint-command': 'x', 'test-command': 'none' },
  });
  expect(prompts.asked[0].options.map((option) => option.value)).toStrictEqual(['rector', 'command']);
  expect(prompts.asked[0].initialValues).toStrictEqual(['rector']);

  // Installed but unchecked: turned off, and written as rector: false
  const answers = await askSteps(toolSteps('package'), {
    ...ctxWith(installed),
    flags: { lint: 'none', 'test-command': 'none' },
  });
  expect(answers.rector).toBe(false);
  expect(toolInputs(answers, {})).toMatchObject({ rector: 'false' });
  expect(toolInputs({}, { rector: 'false' })).toStrictEqual({ rector: 'false' });
});

test('suggests a test command that does not lint again', async (t) => {
  const starter = await inspectTools(await folder(t, { 'composer.json': JSON.stringify(STARTER) }));
  expect(suggestedTests(starter, 'project')).toStrictEqual({ value: 'php artisan test', label: 'php artisan test' });
  expect(suggestedTests(starter, 'package')).toStrictEqual({ value: 'vendor/bin/pest', label: 'vendor/bin/pest' });

  // A test script that only tests is what the workflow already runs
  const plain = { ...NO_TOOLS, phpunit: true, scripts: { test: ['@php artisan test'] } };
  expect(suggestedTests(plain, 'project')).toStrictEqual({ value: '', label: 'composer test' });
  expect(suggestedTests({ ...NO_TOOLS, phpunit: true }, 'project')).toStrictEqual({
    value: '',
    label: 'php artisan test',
  });
  expect(suggestedTests({ ...NO_TOOLS, phpunit: true }, 'package')).toStrictEqual({
    value: '',
    label: 'vendor/bin/phpunit',
  });

  // A test script that also runs a formatter of a PHP package lints again
  for (const linter of ['vendor/bin/php-cs-fixer fix --dry-run', 'vendor/bin/ecs check']) {
    const formatted = { ...NO_TOOLS, phpunit: true, scripts: { test: [linter, 'vendor/bin/phpunit'] } };
    expect(suggestedTests(formatted, 'package').label).toBe('vendor/bin/phpunit');
  }
});

test('suggests the check scripts the chosen tools do not cover', async (t) => {
  const starter = await inspectTools(await folder(t, { 'composer.json': JSON.stringify(STARTER) }));
  // lint fixes, ci:check runs the tests
  expect(suggestedLint(starter, ['command'])).toBe('composer lint:check && composer types:check');
  expect(suggestedLint(starter, ['pint', 'command'])).toBe('composer types:check');
  expect(suggestedLint(starter, ['pint', 'phpstan', 'command'])).toBe('');
  // A check script without commands suggests nothing
  expect(suggestedLint({ ...NO_TOOLS, scripts: { check: [] } }, ['command'])).toBe('');
});

test('writes only the inputs that differ from the defaults', async () => {
  expect(toolInputs({ lint: ['pint', 'phpstan'], testRun: '' }, {})).toStrictEqual({});
  expect(
    toolInputs(
      { lint: ['command'], pint: false, phpstan: false, lintCommand: ' composer lint:check ', testRun: 'none' },
      {},
    ),
  ).toStrictEqual({ pint: 'false', phpstan: 'false', 'lint-command': "'composer lint:check'", 'test-command': 'none' });
  expect(toolInputs({ lint: [], testRun: 'other', testCommand: 'vendor/bin/pest --parallel' }, {})).toStrictEqual({
    'test-command': 'vendor/bin/pest --parallel',
  });
  // Not asked: the file keeps what it has
  const current = { pint: 'false', 'lint-command': "'composer a && composer b'", 'test-command': 'none' };
  expect(toolInputs({}, current)).toStrictEqual(current);
});

test('quotes a command only when YAML needs it, and refuses one it cannot write', () => {
  expect(commandValue('php artisan test')).toBe('php artisan test');
  expect(commandValue('composer lint:check')).toBe("'composer lint:check'");
  expect(validCommand('')).toBe('Type a command');
  expect(validCommand("echo 'a'")).toBe('Use one line and double quotes');
});

test('writes the lint and test inputs in both workflow files and reads them back', async () => {
  const answers = { lint: ['pint', 'command'], phpstan: false, lintCommand: 'composer lint:check', testRun: 'none' };
  const project = await renderProjectWorkflow({ deploy: 'none', ...answers });
  expect(parseInputs(project)).toStrictEqual({
    phpstan: 'false',
    'lint-command': "'composer lint:check'",
    'test-command': 'none',
  });
  expect(projectAnswers(parseInputs(project))).toMatchObject({
    pint: undefined,
    phpstan: false,
    lintCommand: 'composer lint:check',
    testCommand: 'none',
  });
  // Answered again with the defaults, the inputs go away
  expect(
    parseInputs(await renderProjectWorkflow({ deploy: 'none', lint: ['pint', 'phpstan'], testRun: '' }, project)),
  ).toStrictEqual({});
  // Not asked (partial answers): kept
  expect(parseInputs(await renderProjectWorkflow({ deploy: 'none' }, project))).toStrictEqual(parseInputs(project));

  const existing = (await renderPackageWorkflow()).concat('    with:\n      php: \'["8.4"]\'\n      pint: false\n');
  const pkg = await renderPackageWorkflow(existing, 'main', {
    lint: ['pint'],
    phpstan: false,
    testRun: 'other',
    testCommand: 'composer test',
  });
  expect(parseInputs(pkg)).toStrictEqual({ php: '\'["8.4"]\'', phpstan: 'false', 'test-command': 'composer test' });
  expect(packageAnswers(parseInputs(pkg))).toMatchObject({
    pint: undefined,
    phpstan: false,
    testCommand: 'composer test',
  });
  expect(await renderPackageWorkflow(existing)).toBe(existing);
});

const ctxWith = (installed, current = null) => ({ state: { ...APP_STATE, tools: installed, current }, flags: {} });

test('checks the installed tools and suggests the test command', async (t) => {
  const installed = await inspectTools(await folder(t, { 'composer.json': JSON.stringify(STARTER) }));
  prompts.answers = [['pint', 'command'], 'composer types:check', 'php artisan test'];
  const answers = await askSteps(toolSteps('project'), ctxWith(installed));

  const [lint, command, tests] = prompts.asked;
  expect(lint.options.map((option) => option.value)).toStrictEqual(['pint', 'phpstan', 'command']);
  expect(lint.initialValues).toStrictEqual(['pint', 'phpstan']);
  expect(command.initialValue).toBe('composer types:check');
  expect(tests.initialValue).toBe('php artisan test');
  expect(tests.options.map((option) => option.value)).toStrictEqual(['php artisan test', 'other', 'none']);
  // PHPStan is installed but unchecked: turned off
  expect(answers).toMatchObject({
    lint: ['pint', 'command'],
    pint: undefined,
    phpstan: false,
    testRun: 'php artisan test',
  });
  expect(parseInputs(await renderProjectWorkflow({ deploy: 'none', ...answers }))).toStrictEqual({
    phpstan: 'false',
    'lint-command': "'composer types:check'",
    'test-command': 'php artisan test',
  });
});

test('starts from the workflow file, and offers only what is installed', async () => {
  const installed = { ...NO_TOOLS, pint: true, phpunit: true };
  prompts.answers = [['pint', 'command'], 'composer stan', 'other', 'vendor/bin/phpunit --testdox'];
  const current = {
    pint: undefined,
    phpstan: undefined,
    lintCommand: 'composer stan',
    testCommand: 'vendor/bin/phpunit --testdox',
  };
  await askSteps(toolSteps('package'), ctxWith(installed, current));
  const [lint, command, tests, testCommand] = prompts.asked;
  expect(lint.options.map((option) => option.value)).toStrictEqual(['pint', 'command']);
  expect(lint.initialValues).toStrictEqual(['pint', 'command']);
  expect(command.initialValue).toBe('composer stan');
  expect(tests.initialValue).toBe('other');
  expect(testCommand.initialValue).toBe('vendor/bin/phpunit --testdox');

  // Nothing installed and no test script: the suite starts off
  prompts.asked = [];
  prompts.answers = [[], 'none'];
  await askSteps(toolSteps('project'), ctxWith(NO_TOOLS));
  expect(prompts.asked.map((options) => options.initialValue ?? options.initialValues)).toStrictEqual([[], 'none']);
  // A suite turned off stays off
  prompts.asked = [];
  prompts.answers = [[], 'none'];
  await askSteps(toolSteps('project'), ctxWith({ ...NO_TOOLS, phpunit: true }, { testCommand: 'none' }));
  expect(prompts.asked[1].initialValue).toBe('none');
  // Turned on again with another command: the command starts empty
  prompts.asked = [];
  prompts.answers = [[], 'other', 'vendor/bin/pest'];
  await askSteps(toolSteps('project'), ctxWith({ ...NO_TOOLS, phpunit: true }, { testCommand: 'none' }));
  expect(prompts.asked[2].initialValue).toBe('');
});

test('answers the questions from flags', async () => {
  const installed = { ...NO_TOOLS, pint: true, phpstan: true, phpunit: true };
  const flags = { lint: 'phpstan, command', 'lint-command': 'composer lint:check', 'test-command': 'none' };
  const answers = await askSteps(toolSteps('project'), { ...ctxWith(installed), flags });
  expect(prompts.asked).toStrictEqual([]);
  expect(answers).toMatchObject({
    lint: ['phpstan', 'command'],
    pint: false,
    lintCommand: 'composer lint:check',
    testRun: 'none',
  });

  const custom = await askSteps(toolSteps('project'), {
    ...ctxWith(installed),
    flags: { lint: 'none', 'test-command': 'vendor/bin/pest --parallel' },
  });
  expect(custom).toMatchObject({
    lint: [],
    pint: false,
    phpstan: false,
    testRun: 'other',
    testCommand: 'vendor/bin/pest --parallel',
  });

  expect(await askSteps(toolSteps('project'), { ...ctxWith(installed), flags: { lint: ' none ' } })).toMatchObject({
    lint: [],
    pint: false,
    phpstan: false,
  });

  await expect(askSteps(toolSteps('project'), { ...ctxWith(installed), flags: { lint: 'eslint' } })).rejects.toThrow(
    '--lint: use pint, phpstan, rector, command separated by commas, or none',
  );
});

test('asks the lint and test questions for apps and packages', async (t) => {
  const ids = (module) => module.setup.steps().map((step) => step.id);
  for (const module of [app, laravelPackage]) {
    expect(ids(module)).toEqual(expect.arrayContaining(['lint', 'lintCommand', 'testRun', 'testCommand']));
  }
  // What collectState reads from the folder
  const root = await folder(t, { 'composer.json': JSON.stringify(STARTER) });
  expect((await laravelPackage.inspect(root)).tools.phpstan).toBe(true);
  expect((await app.inspect(root)).tools.pint).toBe(true);
});
