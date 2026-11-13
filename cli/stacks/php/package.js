import { packageKind } from '../../kinds/package/index.js';
import { jsStep, jsTestsStep, nodeScripts, typecheckStep } from '../laravel/app.js';
import { inspectTools, NO_TOOLS, toolSteps } from '../laravel/tools.js';

// What a PHP package without Laravel adds to package.yml (cli/kinds/package/index.js): the same lint and test tools as
// a Laravel package, read from composer.json, and the package.json scripts; package.yml runs laravel-package-tests
// without the Laravel axis

export default packageKind({
  id: 'php',
  empty: { tools: NO_TOOLS, nodeScripts: [] },
  /** What collectState reads from the folder for a PHP package: its lint and test tools and package.json scripts. */
  inspect: async (root) => ({ tools: await inspectTools(root), nodeScripts: await nodeScripts(root) }),
  steps: () => [...toolSteps('package'), jsStep, typecheckStep, jsTestsStep],
});
