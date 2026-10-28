import { expect, test } from 'vitest';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hasSecret, registerSecret, relayAccepts } from '../kinds/project/relay.js';
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
