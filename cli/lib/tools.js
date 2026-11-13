import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flagOf, scalar } from './workflow-file.js';

// The lint and test inputs every entry point takes (project.yml, package.yml): pint, phpstan, rector, eslint, prettier,
// stylelint, lint-command and test-command. The stack's questions (lint, lintCommand, testRun, testCommand) choose them;
// min-coverage is read, not asked (cli/lib/coverage.js)

// The lint tools turned off by an input of their name (default on)
const PHP_LINT_TOOLS = ['pint', 'phpstan', 'rector'];
const JS_LINT_TOOLS = ['eslint', 'prettier', 'stylelint'];
export const LINT_TOOLS = [...PHP_LINT_TOOLS, ...JS_LINT_TOOLS];
export const TOOL_INPUTS = [...LINT_TOOLS, 'lint-command', 'test-command'];

// What the js-lint action runs (.github/actions/js-lint/js-lint.sh), and the configs that make it run each tool
export const NO_JS_LINT = { eslint: false, prettier: false, stylelint: false };
const JS_CONFIGS = {
  eslint: ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']
    .map((ext) => `eslint.config.${ext}`)
    .concat(['', '.js', '.cjs', '.yaml', '.yml', '.json'].map((ext) => `.eslintrc${ext}`)),
  prettier: ['', '.json', '.json5', '.yaml', '.yml', '.toml', '.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']
    .map((ext) => `.prettierrc${ext}`)
    .concat(['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((ext) => `prettier.config.${ext}`)),
  stylelint: ['', '.json', '.yaml', '.yml', '.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']
    .map((ext) => `.stylelintrc${ext}`)
    .concat(['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((ext) => `stylelint.config.${ext}`)),
};
// The check scripts the action runs in place of the tool
const JS_SCRIPTS = { prettier: ['format:check', 'prettier:check'], stylelint: ['lint:css', 'stylelint'] };

/**
 * The tools the js-lint action runs in the project, which the eslint, prettier and stylelint inputs turn off: ESLint
 * without a lint (or check) script; Prettier and Stylelint with their check script, or declared with a config, unless
 * the lint script names them.
 */
export async function inspectJsLint(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    return NO_JS_LINT;
  }
  const scripts = manifest.scripts ?? {};
  const declared = (name) => name in { ...manifest.dependencies, ...manifest.devDependencies };
  const hasConfig = async (tool) => {
    if (tool !== 'eslint' && tool in manifest) return true;
    for (const file of JS_CONFIGS[tool]) {
      if (
        await access(join(root, file)).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    return false;
  };
  const lint = ['lint', 'check'].find((name) => scripts[name]);
  const lintText = lint ? String(scripts[lint]) : '';
  const runs = async (tool) => {
    const script = JS_SCRIPTS[tool].find((name) => scripts[name]);
    if (script) return !lintText.includes(script);
    return declared(tool) && !lintText.includes(tool) && (await hasConfig(tool));
  };
  return {
    eslint: !lint && declared('eslint') && (await hasConfig('eslint')),
    prettier: await runs('prettier'),
    stylelint: await runs('stylelint'),
  };
}

// Turns the test suite off (test-command: none)
export const NO_TESTS = 'none';

/** What a lint or test command can be: one line, and no single quote, since it is written between them. */
export function validCommand(value) {
  if (!value?.trim()) return 'Type a command';
  if (/[\n']/.test(value)) return 'Use one line and double quotes';
  return undefined;
}

/** A command as a YAML value: plain when it is only words, between single quotes otherwise (&&, :, #). */
export function commandValue(command) {
  return /^[\w./=-]+(?: [\w./=-]+)*$/.test(command) ? command : `'${command}'`;
}

/** The lint and test answers implied by a workflow file's inputs. */
export function toolAnswers(inputs) {
  return {
    ...Object.fromEntries(LINT_TOOLS.map((tool) => [tool, flagOf(inputs[tool])])),
    lintCommand: scalar(inputs['lint-command']) || null,
    testCommand: scalar(inputs['test-command']) || null,
    minCoverage: scalar(inputs['min-coverage']) || null,
  };
}

/**
 * The lint and test inputs to write, as { input: raw value }: from the answers, or the current ones (`current`, the
 * file's raw inputs) when they were not asked. A tool the answers leave on is not written, as its default is on.
 */
export function toolInputs(answers, current) {
  const inputs = {};
  const keep = (...names) => {
    for (const name of names) if (current[name] !== undefined) inputs[name] = current[name];
  };
  // The JS stack asks only ESLint, Prettier and Stylelint (jsLint), and keeps the rest
  const jsAsked = answers.jsLint !== undefined;
  if (jsAsked) for (const tool of JS_LINT_TOOLS) if (answers[tool] === false) inputs[tool] = 'false';
  if (answers.lint === undefined) keep(...(jsAsked ? PHP_LINT_TOOLS : LINT_TOOLS), 'lint-command');
  else {
    for (const tool of LINT_TOOLS) if (answers[tool] === false) inputs[tool] = 'false';
    if (answers.lint.includes('command') && answers.lintCommand?.trim()) {
      inputs['lint-command'] = commandValue(answers.lintCommand.trim());
    }
  }
  if (answers.testRun === undefined) keep('test-command');
  else {
    const command = answers.testRun === 'other' ? answers.testCommand?.trim() : answers.testRun;
    if (command) inputs['test-command'] = commandValue(command);
  }
  return inputs;
}
