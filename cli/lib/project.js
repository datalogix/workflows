import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './shell.js';

/** Root of this package (the datalogix/workflows checkout that npx downloaded). */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** owner/repo from a GitHub remote URL (https or ssh), or null. */
export function parseRemote(url) {
  const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The project's repository from its git remote, and the project's root folder. */
export async function detectProject(cwd) {
  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  const root = top.code === 0 ? top.stdout.trim() : cwd;
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: root });
  return { root, repository: remote.code === 0 ? parseRemote(remote.stdout) : null };
}

export function isRepository(value) {
  return /^[\w.-]+\/[\w.-]+$/.test(value);
}
