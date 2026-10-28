import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from '../../lib/project.js';
import { run } from '../../lib/shell.js';
import { secretKey } from '../../../relay/src/keys.js';

// The monitoring relay (relay/), which projects use to turn monitoring problems into issues

const WRANGLER = ['--yes', 'wrangler@4'];

/** Relay settings: the worker URL from cli/config.json, the owner and KV namespace from relay/wrangler.toml. */
export async function loadRelayConfig() {
  const config = JSON.parse(await readFile(join(packageRoot, 'cli', 'config.json'), 'utf8'));
  const wrangler = await readFile(join(packageRoot, 'relay', 'wrangler.toml'), 'utf8');
  const namespaceId = /\[\[kv_namespaces\]\][^[]*?\bid\s*=\s*"([^"]+)"/s.exec(wrangler)?.[1] ?? '';
  const owner = /ALLOWED_OWNER\s*=\s*"([^"]+)"/.exec(wrangler)?.[1] ?? '';
  const configured = Boolean(config.relayUrl) && Boolean(namespaceId) && !namespaceId.startsWith('REPLACE');
  return { url: (config.relayUrl ?? '').replace(/\/+$/, ''), namespaceId, owner, configured };
}

/** URL to set as the webhook in the provider. */
export function webhookUrl(relay, provider, repository) {
  return `${relay.url}/${provider}/${repository}`;
}

/**
 * Runs wrangler in an empty private folder, so it never picks up a wrangler.toml from the project.
 * `prepare(dir)` returns the extra arguments and may write files in the folder, which is removed afterwards.
 * `runner` replaces shell.run in tests.
 */
async function wrangler(args, { prepare = async () => [], runner = run } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'datalogix-'));
  try {
    return await runner('npx', [...WRANGLER, ...args, ...(await prepare(dir))], { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether the relay accepts the repository: it compares the owner with ALLOWED_OWNER, ignoring case as GitHub does. */
export function relayAccepts(relay, repository) {
  return !relay.owner || !repository || repository.split('/')[0].toLowerCase() === relay.owner.toLowerCase();
}

/** Whether the relay can be reached from this system: npx is a .cmd on Windows, which cannot run without a shell. */
export const relaySupported = () => process.platform !== 'win32';

/**
 * Stores a repository's webhook secret in the relay's KV namespace. The value goes through a temporary
 * file readable only by you, so it never appears in a command line or the shell history.
 */
export async function registerSecret(relay, provider, repository, secret, runner = run) {
  const key = secretKey(provider, repository);
  const result = await wrangler(['kv', 'key', 'put', key, '--namespace-id', relay.namespaceId, '--remote'], {
    prepare: async (dir) => {
      const file = join(dir, 'secret');
      await writeFile(file, secret, { mode: 0o600 });
      return ['--path', file];
    },
    runner,
  });
  if (result.code !== 0) {
    const output = `${result.stderr}\n${result.stdout}`;
    throw new Error(
      /not authenticated|wrangler login/i.test(output)
        ? 'not logged in to Cloudflare: run npx wrangler login'
        : output.trim().split('\n').at(-1) || `wrangler exited with code ${result.code}`,
    );
  }
}

/** Whether the relay has a secret for the repository (null when it cannot be checked). */
export async function hasSecret(relay, provider, repository, runner = run) {
  if (!relaySupported()) return null;
  const key = secretKey(provider, repository);
  const result = await wrangler(['kv', 'key', 'get', key, '--namespace-id', relay.namespaceId, '--remote'], {
    runner,
  });
  if (result.code === 0) return result.stdout.trim() !== '' && !/^Value not found/im.test(result.stdout);
  return /not found/i.test(`${result.stderr}${result.stdout}`) ? false : null;
}
