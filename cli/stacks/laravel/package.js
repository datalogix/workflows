import { packageKind } from '../../kinds/package/index.js';
import { inspectTools, NO_TOOLS, toolSteps } from './tools.js';

// What a Laravel package adds to package.yml (cli/kinds/package/index.js): its lint and test tools

export default packageKind({
  empty: { tools: NO_TOOLS },
  /** What collectState reads from the folder for a Laravel package: its lint and test tools. */
  inspect: async (root) => ({ tools: await inspectTools(root) }),
  steps: () => toolSteps('package'),
});
