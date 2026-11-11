import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import app from './app.js';
import pkg from './package.js';

export const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The parsed composer.json of the folder, or null when it is missing or not valid JSON. */
export async function readComposer(root) {
  try {
    return JSON.parse(await readFile(join(root, 'composer.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether composer.json depends on Laravel (laravel/framework, illuminate/* or orchestra/testbench) or registers a
 * Laravel provider.
 */
export function usesLaravel(composer) {
  if (!composer) return false;
  const names = Object.keys({ ...composer.require, ...composer['require-dev'] });
  return (
    Boolean(composer.extra?.laravel) ||
    names.some((name) => /^(laravel\/framework|illuminate\/|orchestra\/testbench)/.test(name))
  );
}

export default {
  id: 'laravel',
  label: 'Laravel',
  async detect(root) {
    if (await exists(join(root, 'artisan'))) return 'project';
    if (usesLaravel(await readComposer(root))) return 'package';
    return null;
  },
  kinds: { project: app, package: pkg },
};
