import { afterEach, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import relay from '../src/index.js';
import { secretKey } from '../src/keys.js';

const secret = 'whsec_test';
const store = new Map([['nightwatch:datalogix/app', secret]]);
const delivered = new Map();
const env = {
  ALLOWED_OWNER: 'datalogix',
  GITHUB_TOKEN: 'token',
  SECRETS: {
    get: async (key) => store.get(key) ?? delivered.get(key)?.value ?? null,
    put: async (key, value, options) => delivered.set(key, { value, options }),
  },
};
const sign = (body) => createHmac('sha256', secret).update(body).digest('hex');
const event = (overrides = {}) =>
  JSON.stringify({
    event: 'issue.opened',
    timestamp: new Date().toISOString(),
    payload: {
      issue: {
        id: 7,
        type: 'exception',
        title: 'Error',
        url: 'https://nightwatch.laravel.com/x',
        details: { message: 'x'.repeat(5000) },
      },
      environment: { id: 1, name: 'production' },
    },
    ...overrides,
  });
const webhook = event();
const post = (path, body, signature, headers = {}) =>
  new Request(`https://relay.test${path}`, {
    method: 'POST',
    body,
    headers: { ...(signature ? { 'Nightwatch-Signature': signature } : {}), ...headers },
  });

afterEach(() => {
  delivered.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('accepts only configured provider and repository pairs', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const status = async (path) => (await relay.fetch(post(path, webhook, sign(webhook)), env)).status;
  expect(await status('/unknown/datalogix/app')).toBe(404);
  expect(await status('/nightwatch/other/app')).toBe(404);
  expect(await status('/datalogix/app')).toBe(404);
  expect(await status('/nightwatch/datalogix/app/extra')).toBe(404);
  expect(await status('/constructor/datalogix/app')).toBe(404);
  expect(await status('/__proto__/datalogix/app')).toBe(404);

  const notAllowed = await relay.fetch(new Request('https://relay.test/nightwatch/datalogix/app'), env);
  expect(notAllowed.status).toBe(405);
  expect(notAllowed.headers.get('Allow')).toBe('POST');
  expect(fetch).not.toHaveBeenCalled();
});

test('answers a repository without a secret like a bad signature', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const verify = vi.spyOn(crypto.subtle, 'verify');
  const unknown = await relay.fetch(post('/nightwatch/datalogix/unknown', webhook, sign(webhook)), env);
  // Verified anyway, so the response time does not tell it apart from a configured repository
  expect(verify).toHaveBeenCalledOnce();
  const unsigned = await relay.fetch(post('/nightwatch/datalogix/app', webhook, 'a'.repeat(64)), env);
  expect([unknown.status, await unknown.text()]).toEqual([unsigned.status, await unsigned.text()]);
  expect(unknown.status).toBe(401);
  expect(warn).toHaveBeenCalledWith('No nightwatch secret for datalogix/unknown');

  const large = 'x'.repeat(1024 * 1024 + 1);
  expect((await relay.fetch(post('/nightwatch/datalogix/unknown', large, sign(large)), env)).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});

test('verifies the signature over the raw bytes', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  // A byte-order mark and an invalid UTF-8 byte in the title: decoding and encoding again would change both
  const [before, after] = event().split('Error');
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(before),
    Buffer.from([0xff]),
    Buffer.from(after),
  ]);
  const signature = createHmac('sha256', secret).update(bytes).digest('hex');
  expect((await relay.fetch(post('/nightwatch/datalogix/app', bytes, signature), env)).status).toBe(204);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('rejects bad signatures without calling GitHub', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  expect((await relay.fetch(post('/nightwatch/datalogix/app', webhook, 'a'.repeat(64)), env)).status).toBe(401);
  expect((await relay.fetch(post('/nightwatch/datalogix/app', webhook), env)).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});

test('treats an empty secret as not configured', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const empty = { ...env, SECRETS: { get: async () => '' } };
  expect((await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), empty)).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});

test('rejects a signed body that is not JSON', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  expect((await relay.fetch(post('/nightwatch/datalogix/app', 'not json', sign('not json')), env)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

test('rejects bodies over 1 MB', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const large = 'x'.repeat(1024 * 1024 + 1);
  expect((await relay.fetch(post('/nightwatch/datalogix/app', large, sign(large)), env)).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});

test('rejects a declared Content-Length over 1 MB before reading the body', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const request = post('/nightwatch/datalogix/app', webhook, sign(webhook), {
    'Content-Length': String(1024 * 1024 + 1),
  });
  expect(request.headers.get('Content-Length')).toBe(String(1024 * 1024 + 1));
  expect((await relay.fetch(request, env)).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});

test('counts the body limit in bytes', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  // 600,000 characters but 1,200,000 bytes in UTF-8, with no Content-Length header to stop it earlier
  const wide = 'é'.repeat(600_000);
  const request = post('/nightwatch/datalogix/app', wide, sign(wide));
  expect(request.headers.get('Content-Length')).toBeNull();
  expect((await relay.fetch(request, env)).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});

test('accepts a body of exactly 1 MB', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const limit = 'x'.repeat(1024 * 1024);
  // Past the size check: rejected only because it is not JSON
  expect((await relay.fetch(post('/nightwatch/datalogix/app', limit, sign(limit)), env)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

test('rejects stale or undated events without calling GitHub', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const hours = (n) => new Date(Date.now() + n * 60 * 60 * 1000).toISOString();
  for (const timestamp of [hours(-2), hours(2), undefined, 'not a date']) {
    const body = event({ timestamp });
    const response = await relay.fetch(post('/nightwatch/datalogix/app', body, sign(body)), env);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Stale event');
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('accepts an event exactly one hour old or ahead, and rejects one a second past that', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const sentAt = new Date('2026-10-01T10:00:00.000Z');
  const body = event({ timestamp: sentAt.toISOString() });
  const at = async (offset) => {
    // The same body each time: forget the earlier delivery, which would make it a replay
    delivered.clear();
    vi.setSystemTime(sentAt.getTime() + offset);
    return relay.fetch(post('/nightwatch/datalogix/app', body, sign(body)), env);
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  const hour = 60 * 60 * 1000;

  expect((await at(hour)).status).toBe(204);
  expect((await at(-hour)).status).toBe(204);
  for (const offset of [hour + 1000, -hour - 1000]) {
    const response = await at(offset);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Stale event');
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('acknowledges events it does not relay', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const other = JSON.stringify({ event: 'something.else', payload: {} });
  expect((await relay.fetch(post('/nightwatch/datalogix/app', other, sign(other)), env)).status).toBe(204);
  expect(fetch).not.toHaveBeenCalled();
});

test('dispatches a normalized incident to GitHub', async () => {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  });

  const response = await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env);
  expect(response.status).toBe(204);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.github.com/repos/datalogix/app/dispatches');
  expect(calls[0].init.headers.Authorization).toBe('Bearer token');

  const sent = JSON.parse(calls[0].init.body);
  expect(sent.event_type).toBe('incident');
  expect(sent.client_payload.provider).toStrictEqual({ id: 'nightwatch', name: 'Nightwatch' });
  expect(sent.client_payload.event).toBe('opened');
  expect(sent.client_payload.issue.id).toBe('7');
  expect(sent.client_payload.environment.name).toBe('production');
  expect(sent.client_payload.issue.details.message).toBe('x'.repeat(2000) + '…');
});

test('truncates long messages without splitting an emoji', async () => {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  });
  const body = event({
    payload: { issue: { id: 7, title: 'Error', details: { message: 'x' + '🔥'.repeat(3000) } } },
  });

  expect((await relay.fetch(post('/nightwatch/datalogix/app', body, sign(body)), env)).status).toBe(204);
  expect(calls).toHaveLength(1);
  expect(calls[0].client_payload.issue.details.message).toBe('x' + '🔥'.repeat(1999) + '…');
});

test('keeps a message within the limit counted by code point', async () => {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  });
  const body = event({
    payload: { issue: { id: 7, title: 'Error', details: { message: '🔥'.repeat(1500) } } },
  });

  expect((await relay.fetch(post('/nightwatch/datalogix/app', body, sign(body)), env)).status).toBe(204);
  expect(calls).toHaveLength(1);
  expect(calls[0].client_payload.issue.details.message).toBe('🔥'.repeat(1500));
});

test('acknowledges an event GitHub refuses, so the provider does not retry it', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad', { status: 404 }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env);
  expect([response.status, await response.text()]).toEqual([200, 'GitHub rejected the event']);
  expect(error).toHaveBeenCalledWith(expect.stringMatching(/GitHub answered 404 for datalogix\/app: bad/));
  expect(delivered.size).toBe(0);
});

test('reports GitHub failures that a retry may fix', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const status of [500, 503, 429]) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('busy', { status }));
    expect((await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env)).status).toBe(502);
  }
  // GitHub answers its rate limits with 403 too
  for (const init of [
    { status: 403, headers: { 'retry-after': '60' } },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    { status: 403, body: 'You have exceeded a secondary rate limit' },
  ]) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(init.body ?? 'busy', init));
    expect((await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env)).status).toBe(502);
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response('Resource not accessible', { status: 403 }),
  );
  expect((await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env)).status).toBe(200);
});

test('reports GitHub being unreachable', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new TypeError('fetch failed');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env);
  expect(response.status).toBe(502);
  expect(await response.text()).toBe('GitHub unreachable');
  expect(error).toHaveBeenCalledWith(expect.stringMatching(/datalogix\/app: fetch failed/));
});

test('builds the secret key from the provider and the repository', () => {
  expect(secretKey('nightwatch', 'datalogix/app')).toBe('nightwatch:datalogix/app');
});

test('sends a replayed or retried event to GitHub only once', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const send = async () => (await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env)).status;
  expect(await send()).toBe(204);
  expect(await send()).toBe(204);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [[key, { options }]] = [...delivered];
  expect(key).toMatch(/^delivery:nightwatch:datalogix\/app:[0-9a-f]{64}$/);
  expect(options).toStrictEqual({ expirationTtl: 7500 });
});

test('lets a retry through when GitHub rejected the first delivery', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async () => new Response('boom', { status: 500 }))
    .mockImplementation(async () => new Response(null, { status: 204 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const send = async () => (await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), env)).status;
  expect(await send()).toBe(502);
  expect(await send()).toBe(204);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('acknowledges a delivered event even when it cannot be remembered', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  // KV refused the write (its free plan's daily limit): a 5xx would make the provider send it again, and the issue
  // would be opened twice
  const failing = {
    ...env,
    SECRETS: {
      ...env.SECRETS,
      put: async () => {
        throw new Error('KV put() limit exceeded for the day');
      },
    },
  };
  expect((await relay.fetch(post('/nightwatch/datalogix/app', webhook, sign(webhook)), failing)).status).toBe(204);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(
    'Could not remember the delivery for datalogix/app: KV put() limit exceeded for the day',
  );
});

test('ignores the case of the owner and the repository, as GitHub does', async () => {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    calls.push(url);
    return new Response(null, { status: 204 });
  });
  const upper = { ...env, ALLOWED_OWNER: 'Datalogix' };
  expect((await relay.fetch(post('/nightwatch/DataLogix/App', webhook, sign(webhook)), upper)).status).toBe(204);
  expect(calls).toStrictEqual(['https://api.github.com/repos/DataLogix/App/dispatches']);
  expect(secretKey('nightwatch', 'DataLogix/App')).toBe('nightwatch:datalogix/app');
});
