import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NO_TESTS, validCommand } from '../../lib/tools.js';
import { clack, dim, orExit, question } from '../../lib/ui.js';

// The lint and test tools of a Laravel app or package, read from composer.json, and the setup questions that choose
// the pint, phpstan, lint-command and test-command inputs (cli/lib/tools.js)

export const NO_TOOLS = { pint: false, phpstan: false, pest: false, phpunit: false, scripts: {} };

const PHPSTAN = ['phpstan/phpstan', 'larastan/larastan', 'nunomaduro/larastan'];
const LINT_CHOICES = ['pint', 'phpstan', 'command'];
// --lint pint,phpstan,command, or none
const lintChoices = (value) => (value.trim() === 'none' ? [] : value.split(',').map((choice) => choice.trim()));
const validLint = (value) =>
  lintChoices(value ?? '').every((choice) => LINT_CHOICES.includes(choice))
    ? undefined
    : `use ${LINT_CHOICES.join(', ')} separated by commas, or none`;
const validTests = (value) => (value?.trim() === NO_TESTS ? undefined : validCommand(value));

// A lint tool in a script's commands
const LINT = /\b(pint|phpstan|larastan|psalm|rector|phpcs)\b/;
// The composer scripts a lint command suggests: those that only check
const CHECK_SCRIPT = /(^|:)check$|^(analy[sz]e|phpstan|stan|psalm|types)$/;
const TESTS = /\b(artisan test|pest|phpunit|paratest)\b|^@test$/;

/** The tools composer.json requires and its scripts (each as its list of commands). */
export async function inspectTools(root) {
  let composer;
  try {
    composer = JSON.parse(await readFile(join(root, 'composer.json'), 'utf8'));
  } catch {
    return NO_TOOLS;
  }
  const names = new Set(Object.keys({ ...composer.require, ...composer['require-dev'] }));
  const scripts = Object.fromEntries(
    Object.entries(composer.scripts ?? {}).map(([name, value]) => [
      name,
      [value].flat().filter((c) => typeof c === 'string'),
    ]),
  );
  return {
    pint: names.has('laravel/pint'),
    phpstan: PHPSTAN.some((name) => names.has(name)),
    pest: names.has('pestphp/pest'),
    phpunit: names.has('phpunit/phpunit') || names.has('pestphp/pest'),
    scripts,
  };
}

/** The commands a script runs, with the scripts it calls (@name) expanded. */
export function scriptCommands(scripts, name, seen = new Set()) {
  if (!scripts[name] || seen.has(name)) return [];
  seen.add(name);
  return scripts[name].flatMap((command) => {
    const called = /^@([\w:-]+)$/.exec(command)?.[1];
    return called && scripts[called] ? scriptCommands(scripts, called, seen) : [command];
  });
}

/**
 * The test command to suggest: { value, label }, value '' when it is what the workflow runs without test-command
 * (composer test when defined; otherwise php artisan test for an app, Pest or PHPUnit for a package). composer test is
 * not suggested when it also runs a lint tool, which the lint question covers.
 */
export function suggestedTests(tools, kind) {
  const fallback = kind === 'package' ? (tools.pest ? 'vendor/bin/pest' : 'vendor/bin/phpunit') : 'php artisan test';
  if (!tools.scripts.test) return { value: '', label: fallback };
  if (scriptCommands(tools.scripts, 'test').some((command) => LINT.test(command))) {
    return { value: fallback, label: fallback };
  }
  return { value: '', label: 'composer test' };
}

/** The lint command to suggest: the composer scripts that only check, without those of the tools chosen above. */
export function suggestedLint(tools, chosen = []) {
  const covered = (command) =>
    (chosen.includes('pint') && /\bpint\b/.test(command)) ||
    (chosen.includes('phpstan') && /\b(phpstan|larastan)\b/.test(command));
  return Object.keys(tools.scripts)
    .filter((name) => CHECK_SCRIPT.test(name))
    .filter((name) => {
      const commands = scriptCommands(tools.scripts, name);
      return commands.length && !commands.some((command) => TESTS.test(command) || covered(command));
    })
    .map((name) => `composer ${name}`)
    .join(' && ');
}

// The tools the lint question offers, those installed
const offered = (tools) => ['pint', 'phpstan'].filter((tool) => tools[tool]);

/** The lint and test questions of a Laravel app (kind 'project') or package ('package'). */
export function toolSteps(kind) {
  const tools = (ctx) => ctx.state.tools ?? NO_TOOLS;
  return [
    {
      id: 'lint',
      flag: 'lint',
      validate: validLint,
      parse: lintChoices,
      ask: async ({ header, ctx }) => {
        const current = ctx.state.current;
        const installed = offered(tools(ctx));
        return orExit(
          await clack.multiselect({
            message: question(header, `Lint checks${dim('  installed tools come checked; none turns lint off')}`),
            options: [
              ...(installed.includes('pint')
                ? [{ value: 'pint', label: 'Laravel Pint', hint: 'only the files changed by the pull request' }]
                : []),
              ...(installed.includes('phpstan') ? [{ value: 'phpstan', label: 'PHPStan', hint: 'phpstan.neon' }] : []),
              { value: 'command', label: 'Another command…', hint: 'e.g. composer lint:check' },
            ],
            initialValues: [
              ...installed.filter((tool) => current?.[tool] !== false),
              ...(current?.lintCommand ? ['command'] : []),
            ],
            required: false,
          }),
        );
      },
      // A tool that is installed but not checked is turned off; one that is not installed stays at its default
      then: (answers, ctx) => {
        for (const tool of offered(tools(ctx))) answers[tool] = answers.lint.includes(tool) ? undefined : false;
      },
    },
    {
      id: 'lintCommand',
      flag: 'lint-command',
      validate: validCommand,
      when: (a) => a.lint?.includes('command'),
      ask: async ({ header, answers, ctx }) =>
        orExit(
          await clack.text({
            message: question(header, 'Lint command'),
            initialValue: ctx.state.current?.lintCommand ?? suggestedLint(tools(ctx), answers.lint),
            placeholder: 'composer lint:check',
            validate: validCommand,
          }),
        ),
    },
    {
      id: 'testRun',
      // A command given with --test-command is the one testCommand takes
      flag: 'test-command',
      validate: validTests,
      parse: (value) => (value.trim() === NO_TESTS ? NO_TESTS : 'other'),
      ask: async ({ header, ctx }) => {
        const suggested = suggestedTests(tools(ctx), kind);
        const current = ctx.state.current?.testCommand ?? null;
        const installed = tools(ctx).phpunit || Boolean(tools(ctx).scripts.test);
        const initialValue =
          current === NO_TESTS || (!current && !installed)
            ? NO_TESTS
            : current && current !== suggested.value
              ? 'other'
              : suggested.value;
        return orExit(
          await clack.select({
            message: question(header, 'Test suite'),
            initialValue,
            options: [
              { value: suggested.value, label: suggested.label, hint: 'suggested' },
              { value: 'other', label: 'Another command…', hint: 'e.g. vendor/bin/pest --parallel' },
              { value: NO_TESTS, label: 'Off', hint: 'no test suite' },
            ],
          }),
        );
      },
    },
    {
      id: 'testCommand',
      flag: 'test-command',
      validate: validCommand,
      when: (a) => a.testRun === 'other',
      ask: async ({ header, ctx }) => {
        const current = ctx.state.current?.testCommand;
        return orExit(
          await clack.text({
            message: question(header, 'Test command'),
            initialValue: current && current !== NO_TESTS ? current : '',
            placeholder: 'vendor/bin/pest --parallel',
            validate: validCommand,
          }),
        );
      },
    },
  ];
}
