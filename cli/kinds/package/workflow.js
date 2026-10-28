import { afterInputs, flagOf, parseInputs, stackOf, templateBase, withInputs } from '../../lib/workflow-file.js';

// The workflow file of a package calls package.yml, at the same path as a project's
export const PACKAGE_REF = 'datalogix/workflows/.github/workflows/package.yml@v2';

/** Answers implied by a package's workflow file: its stack and the layers it turns off. */
export function packageAnswers(inputs) {
  return { stack: stackOf(inputs), tests: flagOf(inputs.tests), coverage: flagOf(inputs.coverage) };
}

/** The example package workflow (examples/package.yml) up to its inputs. */
export function packageTemplate(branch) {
  return templateBase(branch, null, 'package.yml');
}

/**
 * A package's workflow file (examples/package.yml) with pushes to the default branch, keeping every input of the
 * existing file.
 */
export async function renderPackageWorkflow(existing = '', branch = 'main') {
  return withInputs(await packageTemplate(branch), Object.entries(parseInputs(existing)), afterInputs(existing));
}
