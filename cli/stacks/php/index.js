import { join } from 'node:path';
import { exists, readComposer, usesLaravel } from '../laravel/index.js';
import app from './app.js';
import pkg from './package.js';

// PHP without Laravel: a folder with composer.json, no artisan file and no Laravel dependency. An app has Symfony's
// bin/console, public/index.php or Composer's type project; anything else is a package (library)
const APP_FILES = ['bin/console', 'public/index.php'];

export default {
  id: 'php',
  label: 'PHP',
  async detect(root) {
    const composer = await readComposer(root);
    if (!composer || (await exists(join(root, 'artisan'))) || usesLaravel(composer)) return null;
    if (composer.type === 'project') return 'project';
    for (const file of APP_FILES) if (await exists(join(root, file))) return 'project';
    // Composer's default type is library, so bundles, plugins and the like are packages too
    return 'package';
  },
  kinds: { project: app, package: pkg },
};
