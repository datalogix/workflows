import { packageKind } from '../../kinds/package/index.js';
import { inspectJsLint, jsLintStep, NO_JS_LINT } from './lint.js';

// What a JavaScript or TypeScript library adds to package.yml (cli/kinds/package/index.js): the tests run the scripts
// of package.json (node-package-tests), so only the ESLint, Prettier and Stylelint it runs on its own are asked; no
// coverage report yet

export default packageKind({
  id: 'js',
  coverage: false,
  empty: { jsLint: NO_JS_LINT },
  inspect: async (root) => ({ jsLint: await inspectJsLint(root) }),
  steps: () => [jsLintStep],
});
