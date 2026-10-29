import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pkg from './package.js';

// JavaScript and TypeScript: a folder with package.json and no composer.json. Next and Nuxt apps are recognized, so
// setup says they are not supported yet instead of setting them up as a library
const APP_PACKAGES = ['next', 'nuxt'];
const APP_CONFIG = /^(next|nuxt)\.config\.(js|cjs|mjs|ts|mts)$/;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export default {
  id: 'js',
  label: 'JavaScript',
  async detect(root) {
    // A PHP project with frontend scripts is not a JavaScript one
    if ((await readFile(join(root, 'composer.json')).catch(() => null)) !== null) return null;
    const manifest = await readJson(join(root, 'package.json'));
    if (!manifest) return null;
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    const files = await readdir(root).catch(() => []);
    if (names.some((name) => APP_PACKAGES.includes(name)) || files.some((file) => APP_CONFIG.test(file)))
      return 'project';
    return 'package';
  },
  // Apps (Next, Nuxt) come later: withModule says they are not supported yet
  kinds: { package: pkg },
};
