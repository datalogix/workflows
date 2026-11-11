import { join } from 'node:path';
import { exists, readComposer, usesLaravel } from '../laravel/index.js';
import app from './app.js';
import pkg from './package.js';

// PHP without Laravel: a folder with composer.json, no artisan file and no Laravel dependency, that the js stack (tried
// before) did not take as a JavaScript project with a tooling composer.json. An app has Symfony's bin/console,
// public/index.php, a web/index.php and craft (Craft CMS) or Composer's type project; anything else is a package
// (library)
export const APP_FILES = ['bin/console', 'public/index.php', 'web/index.php', 'craft'];

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
