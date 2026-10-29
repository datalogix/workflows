import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrganization } from '../../lib/github.js';
import { packageRoot } from '../../lib/project.js';
import { run, runInteractive } from '../../lib/shell.js';
import { secretKey } from '../../../relay/src/keys.js';

// The monitoring relay (relay/), which projects use to turn monitoring problems into issues. The org command deploys
// it and stores its settings in the organization's public .github repository, where every project's setup reads them

const WRANGLER = ['--yes', 'wrangler@4'];
const WORKER = 'incident-relay';
const NAMESPACE = 'incident-relay-secrets';

/**
 * The worker of an owner's relay. One per owner, since a worker accepts a single ALLOWED_OWNER and two organizations on
 * one Cloudflare account would otherwise replace each other's. A relay already deployed (its `url`) keeps its worker, so
 * the webhooks set in the providers keep working: the one in its workers.dev URL, else the single name used before.
 */
export function relayWorker(owner, url = '') {
  if (!url) return `${WORKER}-${owner.toLowerCase()}`;
  return /^https:\/\/([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev(\/|$)/i.exec(url)?.[1].toLowerCase() ?? WORKER;
}

export const RELAY_REPO = '.github';
export const RELAY_PATH = 'workflows/relay.json';
export const NO_RELAY = { url: '', namespaceId: '', owner: '', configured: false };

/** Relay settings from the text of relay.json; not configured without a URL and a namespace. */
export function relayConfig(content) {
  let config;
  try {
    config = JSON.parse(content ?? '{}') ?? {};
  } catch {
    config = {};
  }
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const url = text(config.url).replace(/\/+$/, '');
  const namespaceId = text(config.namespaceId);
  return { url, namespaceId, owner: text(config.owner), configured: Boolean(url && namespaceId) };
}

/** Relay settings of an owner, from <owner>/.github (written by the org command). */
export async function loadRelayConfig(owner, organization = owner && createOrganization(owner)) {
  if (!owner) return NO_RELAY;
  return relayConfig((await organization.file(RELAY_REPO, RELAY_PATH))?.content);
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
async function wrangler(args, { prepare = async () => [], runner = run, input } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'datalogix-'));
  try {
    return await runner('npx', [...WRANGLER, ...args, ...(await prepare(dir))], {
      cwd: dir,
      ...(input !== undefined && { input }),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Why a wrangler command failed: not logged in, else the last line it printed. */
function wranglerError(result) {
  const output = `${result.stderr}\n${result.stdout}`;
  return new Error(
    /not authenticated|wrangler login/i.test(output)
      ? 'not logged in to Cloudflare: run npx wrangler login'
      : output.trim().split('\n').at(-1) || `wrangler exited with code ${result.code}`,
  );
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
  if (result.code !== 0) throw wranglerError(result);
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

/** Whether wrangler is logged in to Cloudflare. */
export async function cloudflareLoggedIn(runner = run) {
  const result = await wrangler(['whoami'], { runner });
  return result.code === 0 && !/not authenticated/i.test(`${result.stdout}${result.stderr}`);
}

/** Logs wrangler in to Cloudflare in the browser, attached to the terminal (it may print the link to open). */
export async function cloudflareLogin(runner = runInteractive) {
  const dir = await mkdtemp(join(tmpdir(), 'datalogix-'));
  try {
    return (await runner('npx', [...WRANGLER, 'login'], { cwd: dir })) === 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The JSON array a wrangler command printed, past any banner around it. */
function printedArray(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  return start === -1 || end < start ? [] : JSON.parse(stdout.slice(start, end + 1));
}

/** The relay's KV namespace: the one created before, else a new one. */
export async function relayNamespace(runner = run) {
  const list = await wrangler(['kv', 'namespace', 'list'], { runner });
  if (list.code !== 0) throw wranglerError(list);
  // Older wrangler versions prefixed the title with the worker's name
  const found = printedArray(list.stdout).find(
    (namespace) => namespace.title === NAMESPACE || namespace.title?.endsWith(`-${NAMESPACE}`),
  );
  if (found) return { id: found.id, created: false };
  const created = await wrangler(['kv', 'namespace', 'create', NAMESPACE], { runner });
  if (created.code !== 0) throw wranglerError(created);
  const id = /\b[0-9a-f]{32}\b/.exec(created.stdout)?.[0];
  if (!id) throw new Error('wrangler created the KV namespace but printed no id');
  return { id, created: true };
}

/**
 * Deploys the relay of this version (relay/src) with the namespace and owner, from a private folder with a
 * wrangler.toml made from relay/wrangler.toml, and stores the GitHub token when given (on stdin). Returns the
 * worker's URL.
 */
export async function deployRelay({ namespaceId, owner, token, worker = relayWorker(owner) }, runner = run) {
  const template = await readFile(join(packageRoot, 'relay', 'wrangler.toml'), 'utf8');
  const config = template
    .replace(/^(name\s*=\s*)"[^"]*"/m, `$1"${worker}"`)
    .replace(/(\[\[kv_namespaces\]\][^[]*?\bid\s*=\s*)"[^"]*"/s, `$1"${namespaceId}"`)
    .replace(/(ALLOWED_OWNER\s*=\s*)"[^"]*"/, `$1"${owner}"`);
  const deployed = await wrangler(['deploy'], {
    runner,
    prepare: async (dir) => {
      await cp(join(packageRoot, 'relay', 'src'), join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'wrangler.toml'), config);
      return [];
    },
  });
  if (deployed.code !== 0) throw wranglerError(deployed);
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deployed.stdout)?.[0];
  if (!url) throw new Error('wrangler deployed the relay but printed no workers.dev URL');
  if (token) {
    const secret = await wrangler(['secret', 'put', 'GITHUB_TOKEN', '--name', worker], { runner, input: token });
    if (secret.code !== 0) throw wranglerError(secret);
  }
  return url;
}
