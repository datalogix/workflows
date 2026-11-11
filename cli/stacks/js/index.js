import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_FILES } from '../php/index.js';
import app from './app.js';
import pkg from './package.js';

// JavaScript and TypeScript: a folder with package.json, an app (Next, Nuxt, or a Vue or React single-page app built
// with Vite) or else a library. A composer.json at the root makes it a PHP project, except for a Next or Nuxt app
// without a PHP entry point, or a composer.json only there for tooling (see detect)
const APP_PACKAGES = ['next', 'nuxt'];
const APP_CONFIG = /^(next|nuxt)\.config\.(js|cjs|mjs|ts|mts)$/;
const SPA_PACKAGES = ['vue', 'react'];
// What a library publishes; a component library built with Vite has them, an app does not
const PUBLISHED = ['exports', 'main', 'module'];
// Where a PHP app starts: Symfony's bin/console, a public or web root's index.php, Craft's craft script (and any *.php
// at the root, such as a WordPress theme's functions.php)
const PHP_ENTRY_POINTS = APP_FILES;
// Composer's platform packages: requiring only these installs no PHP code
const PLATFORM = /^(php(-64bit|-ipv6|-zts|-debug)?|hhvm|composer(-plugin-api|-runtime-api)?|ext-.+|lib-.+)$/;
// The Composer types of a tooling-only composer.json: the default (library) and project
const TOOLING_TYPES = [undefined, 'library', 'project'];

/** A Vue or React single-page app built with Vite: Vite and the UI library, index.html at the root, nothing published. */
function isSpa(manifest, names, files) {
  return (
    names.includes('vite') &&
    names.some((name) => SPA_PACKAGES.includes(name)) &&
    files.includes('index.html') &&
    !PUBLISHED.some((field) => field in manifest)
  );
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Whether the folder has a Next or Nuxt app: the package among the dependencies, or its config file. */
const isNextOrNuxt = (names, files) =>
  names.some((name) => APP_PACKAGES.includes(name)) || files.some((file) => APP_CONFIG.test(file));

/**
 * The kind of a JavaScript folder from package.json alone, whatever composer.json says: 'project' for a Next or Nuxt
 * app or a Vite single-page app, 'package' for a library, null without a readable package.json. --stack js uses it.
 */
export async function jsKind(root) {
  const manifest = await readJson(join(root, 'package.json'));
  if (!manifest) return null;
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const files = await readdir(root).catch(() => []);
  return isNextOrNuxt(names, files) || isSpa(manifest, names, files) ? 'project' : 'package';
}

/** Whether the folder has a PHP entry point: PHP_ENTRY_POINTS, or a *.php file at the root. */
async function hasPhpEntryPoint(root, files) {
  if (files.some((file) => file.endsWith('.php'))) return true;
  for (const file of PHP_ENTRY_POINTS) if (await exists(join(root, file))) return true;
  return false;
}

/**
 * Whether composer.json is only there for tooling (PHP linters or scripts of a JavaScript project): no autoload, only
 * platform requirements, the default type or project, and no PHP source in src/.
 */
async function toolingOnly(composer, root) {
  if (composer.autoload || composer['autoload-dev']) return false;
  if (Object.keys(composer.require ?? {}).some((name) => !PLATFORM.test(name))) return false;
  if (!TOOLING_TYPES.includes(composer.type)) return false;
  const sources = await readdir(join(root, 'src')).catch(() => []);
  return !sources.some((file) => file.endsWith('.php'));
}

export default {
  id: 'js',
  label: 'JavaScript',
  async detect(root) {
    const kind = await jsKind(root);
    if (!kind) return null;
    const composerText = await readFile(join(root, 'composer.json'), 'utf8').catch(() => null);
    if (composerText === null) return kind;
    // A composer.json it cannot read: left to the other stacks
    let composer;
    try {
      composer = JSON.parse(composerText);
    } catch {
      return null;
    }
    const files = await readdir(root).catch(() => []);
    // A PHP app with frontend scripts (Symfony, Craft, WordPress) is a PHP project
    if (await hasPhpEntryPoint(root, files)) return null;
    // Next and Nuxt are never the frontend of a PHP app in the same root: a PHP tool inside one does not make it PHP
    const manifest = await readJson(join(root, 'package.json'));
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    if (isNextOrNuxt(names, files)) return 'project';
    // Vite with Vue or React is also the frontend of PHP apps: only a tooling composer.json leaves it to JavaScript
    return (await toolingOnly(composer, root)) ? kind : null;
  },
  /** The kind when --stack js names this stack: package.json decides, whatever composer.json says. */
  kindOf: jsKind,
  kinds: { project: app, package: pkg },
};
