import { TOOL_INPUTS, toolAnswers, toolInputs } from '../../lib/tools.js';
import { afterInputs, flagOf, parseInputs, stackOf, templateBase, withInputs } from '../../lib/workflow-file.js';

// The workflow file of a package calls package.yml, at the same path as a project's
export const PACKAGE_REF = 'datalogix/workflows/.github/workflows/package.yml@v2';

/** Answers implied by a package's workflow file: its stack, the layers it turns off and its lint and test tools. */
export function packageAnswers(inputs) {
  return {
    stack: stackOf(inputs),
    tests: flagOf(inputs.tests),
    coverage: flagOf(inputs.coverage),
    ...toolAnswers(inputs),
  };
}

/** The example package workflow (examples/package.yml) up to its inputs. */
export function packageTemplate(branch) {
  return templateBase(branch, null, 'package.yml');
}

/**
 * A package's workflow file (examples/package.yml) with pushes to the default branch, the lint and test inputs of the
 * answers and every other input of the existing file.
 */
export async function renderPackageWorkflow(existing = '', branch = 'main', answers = {}) {
  const current = parseInputs(existing);
  const kept = Object.entries(current).filter(([key]) => !TOOL_INPUTS.includes(key));
  const inputs = [...kept, ...Object.entries(toolInputs(answers, current))];
  return withInputs(await packageTemplate(branch), inputs, afterInputs(existing));
}
