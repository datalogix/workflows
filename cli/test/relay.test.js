import { expect, test } from 'vitest';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  cloudflareLoggedIn,
  deployRelay,
  hasSecret,
  loadRelayConfig,
  registerSecret,
  relayAccepts,
  relayConfig,
  relayNamespace,
  relayWorker,
} from '../kinds/project/relay.js';
import { onPlatform, RELAY as relay } from './helpers.js';

/** A runner that answers every wrangler call with the result, recording what it was called with. */
function runner(result, onCall = () => {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push([command, args, options]);
    await onCall(args);
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return Object.assign(run, { calls });
}

test('reads whether the relay has the secret of a repository', async (t) => {
  onPlatform(t, 'linux');
  const has = (result) => hasSecret(relay, 'nightwatch', 'datalogix/app', runner(result));
  expect(await has({ stdout: 'whsec_123\n' })).toBe(true);
  expect(await has({ stdout: 'Value not found for key\n' })).toBe(false);
  expect(await has({ stdout: '⛅️ wrangler 4.0.0\n-----\nValue not found for key\n' })).toBe(false);
  expect(await has({ code: 1, stderr: 'key not found' })).toBe(false);
  // Anything else cannot tell
  expect(await has({ code: 1, stderr: 'fetch failed' })).toBe(null);

  const calls = runner({ stdout: 'x' });
  await hasSecret(relay, 'nightwatch', 'datalogix/app', calls);
  const [[command, args, { cwd }]] = calls.calls;
  expect([command, ...args]).toStrictEqual([
    'npx',
    '--yes',
    'wrangler@4',
    'kv',
    'key',
    'get',
    'nightwatch:datalogix/app',
    '--namespace-id',
    'id',
    '--remote',
  ]);
  // An empty private folder, so no wrangler.toml of the project is picked up
  expect(cwd).toMatch(/datalogix-/);
});

test('stores the secret through a file only you can read, removed afterwards', async () => {
  let file;
  let secret;
  let mode;
  const ok = runner({}, async (args) => {
    file = args.at(-1);
    secret = await readFile(file, 'utf8');
    mode = (await stat(file)).mode & 0o777;
  });
  await registerSecret(relay, 'nightwatch', 'datalogix/app', 'whsec_123', ok);
  expect(secret).toBe('whsec_123');
  expect(mode).toBe(0o600);
  const [[command, args]] = ok.calls;
  expect([command, ...args]).toStrictEqual([
    'npx',
    '--yes',
    'wrangler@4',
    'kv',
    'key',
    'put',
    'nightwatch:datalogix/app',
    '--namespace-id',
    'id',
    '--remote',
    '--path',
    file,
  ]);
  // The secret never in a command line, and its private folder is gone
  expect(args).not.toContain('whsec_123');
  await expect(access(dirname(file))).rejects.toThrow();
});

test('explains why storing the secret failed', async () => {
  const fail = (result) => registerSecret(relay, 'nightwatch', 'datalogix/app', 'x', runner(result));
  await expect(fail({ code: 1, stderr: 'You are not authenticated' })).rejects.toThrow(
    'not logged in to Cloudflare: run npx wrangler login',
  );
  await expect(fail({ code: 1, stderr: 'line one\nnamespace not found' })).rejects.toThrow('namespace not found');
  await expect(fail({ code: 2 })).rejects.toThrow('wrangler exited with code 2');
});

test('cannot read the relay on Windows, where npx needs a shell', async (t) => {
  onPlatform(t, 'win32');
  const never = runner({}, () => expect.unreachable('wrangler'));
  expect(await hasSecret(relay, 'nightwatch', 'datalogix/app', never)).toBe(null);
  expect(never.calls).toStrictEqual([]);
});

test('accepts the owner of the relay in any case, as GitHub does', () => {
  expect(relayAccepts({ owner: 'datalogix' }, 'Datalogix/app')).toBe(true);
  expect(relayAccepts({ owner: 'Datalogix' }, 'datalogix/app')).toBe(true);
  expect(relayAccepts({ owner: 'datalogix' }, 'other/app')).toBe(false);
});

test("reads the relay settings the org command stored in the owner's .github repository", async () => {
  const read = [];
  const organization = (content) => ({
    file: async (name, path) => (read.push(`${name}/${path}`), content === null ? null : { content }),
  });
  const settings = '{"url":"https://relay.test/","namespaceId":"id","owner":"datalogix"}';
  expect(await loadRelayConfig('datalogix', organization(settings))).toStrictEqual({
    url: 'https://relay.test',
    namespaceId: 'id',
    owner: 'datalogix',
    configured: true,
  });
  expect(read).toStrictEqual(['.github/workflows/relay.json']);
  expect((await loadRelayConfig('datalogix', organization(null))).configured).toBe(false);
  expect((await loadRelayConfig(null)).configured).toBe(false);
  // A file someone broke by hand reads as no relay
  expect(relayConfig('not json').configured).toBe(false);
  expect(relayConfig('{"url":"https://relay.test"}').configured).toBe(false);
});

test('tells whether wrangler is logged in to Cloudflare', async () => {
  expect(await cloudflareLoggedIn(runner({ stdout: 'You are logged in with an OAuth Token' }))).toBe(true);
  expect(await cloudflareLoggedIn(runner({ stdout: 'You are not authenticated. Please run wrangler login.' }))).toBe(
    false,
  );
  expect(await cloudflareLoggedIn(runner({ code: 1 }))).toBe(false);
});

test('reuses the relay namespace, else creates it', async () => {
  const id = 'b'.repeat(32);
  const existing = runner({ stdout: `⛅️ wrangler 4\n[{"id":"${id}","title":"incident-relay-secrets"}]` });
  expect(await relayNamespace(existing)).toStrictEqual({ id, created: false });
  expect(existing.calls).toHaveLength(1);

  const answers = [{ stdout: '[]' }, { stdout: `Created namespace\n  id = "${id}"` }];
  const created = runner({}, () => {});
  const fresh = Object.assign(
    async (...args) => (await created(...args), { code: 0, stderr: '', ...answers.shift() }),
    {
      calls: created.calls,
    },
  );
  expect(await relayNamespace(fresh)).toStrictEqual({ id, created: true });
  expect(created.calls[1][1].slice(2)).toStrictEqual(['kv', 'namespace', 'create', 'incident-relay-secrets']);
});

test('deploys the relay of this version with its namespace and owner, and the token on stdin', async () => {
  const id = 'c'.repeat(32);
  let config;
  let sources;
  const calls = [];
  const deploy = async (command, args, options) => {
    calls.push([args.slice(2), options.input]);
    if (args.includes('deploy')) {
      config = await readFile(`${options.cwd}/wrangler.toml`, 'utf8');
      sources = await readdir(`${options.cwd}/src`);
      return { code: 0, stdout: 'Uploaded incident-relay\n  https://incident-relay.acme.workers.dev\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  expect(await deployRelay({ namespaceId: id, owner: 'acme', token: 'github_pat_x' }, deploy)).toBe(
    'https://incident-relay.acme.workers.dev',
  );
  expect(config).toContain(`id = "${id}"`);
  expect(config).toContain('ALLOWED_OWNER = "acme"');
  expect(sources).toContain('index.js');
  expect(calls).toStrictEqual([
    [['deploy'], undefined],
    [['secret', 'put', 'GITHUB_TOKEN', '--name', 'incident-relay-acme'], 'github_pat_x'],
  ]);
  expect(config).toMatch(/^name = "incident-relay-acme"$/m);

  // Without a token the one stored before stays
  calls.length = 0;
  await deployRelay({ namespaceId: id, owner: 'acme', worker: 'incident-relay' }, deploy);
  expect(calls).toStrictEqual([[['deploy'], undefined]]);
  expect(config).toMatch(/^name = "incident-relay"$/m);

  await expect(deployRelay({ namespaceId: id, owner: 'acme' }, runner({ stdout: 'done' }))).rejects.toThrow(
    'printed no workers.dev URL',
  );
});

test('names the worker after its owner, and keeps the worker of a relay already deployed', () => {
  expect(relayWorker('Acme')).toBe('incident-relay-acme');
  expect(relayWorker('acme', 'https://incident-relay.acme.workers.dev')).toBe('incident-relay');
  expect(relayWorker('acme', 'https://incident-relay-acme.acme.workers.dev')).toBe('incident-relay-acme');
  // A URL that is not workers.dev (a custom domain) gives no name: the one every relay had before
  expect(relayWorker('acme', 'https://relay.acme.com')).toBe('incident-relay');
});
