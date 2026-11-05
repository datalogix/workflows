import { flagOf, scalar } from './workflow-file.js';

// The lint and test inputs every entry point takes (project.yml, package.yml): pint, phpstan, lint-command and
// test-command. The stack's questions (lint, lintCommand, testRun, testCommand) choose them

export const TOOL_INPUTS = ['pint', 'phpstan', 'lint-command', 'test-command'];

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
    pint: flagOf(inputs.pint),
    phpstan: flagOf(inputs.phpstan),
    lintCommand: scalar(inputs['lint-command']) || null,
    testCommand: scalar(inputs['test-command']) || null,
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
  if (answers.lint === undefined) keep('pint', 'phpstan', 'lint-command');
  else {
    if (answers.pint === false) inputs.pint = 'false';
    if (answers.phpstan === false) inputs.phpstan = 'false';
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
