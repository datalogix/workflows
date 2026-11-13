import { packageKind } from '../../kinds/package/index.js';
import { jsStep, nodeScripts } from './app.js';
import { inspectTools, NO_TOOLS, toolSteps } from './tools.js';

// What a Laravel package adds to package.yml (cli/kinds/package/index.js): its lint and test tools and package.json
// scripts

export default packageKind({
  empty: { tools: NO_TOOLS, nodeScripts: [] },
  /** What collectState reads from the folder for a Laravel package: its lint and test tools and package.json scripts. */
  inspect: async (root) => ({ tools: await inspectTools(root), nodeScripts: await nodeScripts(root) }),
  steps: () => [...toolSteps('package'), jsStep],
});
