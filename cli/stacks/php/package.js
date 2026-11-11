import { packageKind } from '../../kinds/package/index.js';
import { inspectTools, NO_TOOLS, toolSteps } from '../laravel/tools.js';

// What a PHP package without Laravel adds to package.yml (cli/kinds/package/index.js): the same lint and test tools as
// a Laravel package, read from composer.json; package.yml runs laravel-package-tests without the Laravel axis

export default packageKind({
  id: 'php',
  empty: { tools: NO_TOOLS },
  /** What collectState reads from the folder for a PHP package: its lint and test tools. */
  inspect: async (root) => ({ tools: await inspectTools(root) }),
  steps: () => toolSteps('package'),
});
