import { DEFAULT_LANGUAGE } from '../../lib/claude.js';
import { TOOL_INPUTS, toolAnswers, toolInputs } from '../../lib/tools.js';
import {
  afterInputs,
  flagOf,
  parseInputs,
  scalar,
  stackOf,
  templateBase,
  withInputs,
} from '../../lib/workflow-file.js';

// The workflow file of a package calls package.yml, at the same path as a project's
export const PACKAGE_REF = 'datalogix/workflows/.github/workflows/package.yml@v2';

// The Claude layers a package turns on, by answer and input (the layers question): off by default in package.yml
export const PACKAGE_LAYERS = { claude: 'claude', review: 'review', securityReview: 'security-review' };

/** Whether the answers turn on any Claude layer. */
export const claudeOn = (a) => Object.keys(PACKAGE_LAYERS).some((answer) => a?.[answer] === true);

/**
 * Answers implied by a package's workflow file: its stack, the tests it turns off, the Claude layers it turns on (off
 * unless the input is true), the team language and its lint and test tools.
 */
export function packageAnswers(inputs) {
  return {
    stack: stackOf(inputs),
    tests: flagOf(inputs.tests),
    coverage: flagOf(inputs.coverage),
    ...Object.fromEntries(
      Object.entries(PACKAGE_LAYERS).map(([answer, input]) => [
        answer,
        scalar(inputs[input])?.toLowerCase() === 'true',
      ]),
    ),
    language: scalar(inputs.language) || DEFAULT_LANGUAGE,
    ...toolAnswers(inputs),
  };
}

/** The example package workflow (examples/package.yml) up to its inputs. */
export function packageTemplate(branch) {
  return templateBase(branch, null, 'package.yml');
}

/** The Claude layer and language inputs of the answers; an answer not given leaves its input as it is. */
function claudeInputs(answers) {
  const inputs = {};
  for (const [answer, input] of Object.entries(PACKAGE_LAYERS)) {
    // Off is package.yml's default: only a layer that is on is written
    if (answers[answer] === true) inputs[input] = 'true';
  }
  if (answers.language?.trim() && answers.language.trim() !== DEFAULT_LANGUAGE)
    inputs.language = answers.language.trim();
  return inputs;
}

/**
 * A package's workflow file (examples/package.yml) with pushes to the default branch, the Claude layers, the language
 * and the lint and test inputs of the answers, and every other input of the existing file.
 */
export async function renderPackageWorkflow(existing = '', branch = 'main', answers = {}) {
  const current = parseInputs(existing);
  // laravel is the default of package.yml: only another stack is written
  const stack = answers.stack && answers.stack !== 'laravel' ? { stack: answers.stack } : {};
  // The layers and the language are managed only once the layers question was answered
  const layers = Object.keys(PACKAGE_LAYERS).some((answer) => answers[answer] !== undefined)
    ? [...Object.values(PACKAGE_LAYERS), 'language']
    : [];
  const managed = [...(answers.stack ? ['stack'] : []), ...layers, ...TOOL_INPUTS];
  const kept = Object.entries(current).filter(([key]) => !managed.includes(key));
  const inputs = [
    ...Object.entries(stack),
    ...Object.entries(layers.length ? claudeInputs(answers) : {}),
    ...kept,
    ...Object.entries(toolInputs(answers, current)),
  ];
  return withInputs(await packageTemplate(branch), inputs, afterInputs(existing));
}
