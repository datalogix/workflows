import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import app from './app.js';
import pkg from './package.js';

// JavaScript and TypeScript: a folder with package.json and no composer.json, a Next or Nuxt app or else a library
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
  kinds: { project: app, package: pkg },
};
