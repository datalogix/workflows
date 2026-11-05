import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import app from './app.js';
import pkg from './package.js';

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Whether composer.json depends on Laravel (laravel/framework or illuminate/*) or registers a Laravel provider. */
async function usesLaravel(root) {
  try {
    const composer = JSON.parse(await readFile(join(root, 'composer.json'), 'utf8'));
    const names = Object.keys({ ...composer.require, ...composer['require-dev'] });
    return Boolean(composer.extra?.laravel) || names.some((name) => /^(laravel\/framework|illuminate\/)/.test(name));
  } catch {
    return false;
  }
}

export default {
  id: 'laravel',
  label: 'Laravel',
  async detect(root) {
    if (await exists(join(root, 'artisan'))) return 'project';
    if (await usesLaravel(root)) return 'package';
    return null;
  },
  kinds: { project: app, package: pkg },
};
