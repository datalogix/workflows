import { packageKind } from '../../kinds/package/index.js';

// What a JavaScript or TypeScript library adds to package.yml (cli/kinds/package/index.js): nothing to ask, as the
// tests run the scripts of package.json (node-package-tests), and no coverage report yet

export default packageKind({ id: 'js', coverage: false });
