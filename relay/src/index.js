/**
 * Relays monitoring webhooks to GitHub as `incident` repository_dispatch events.
 *
 * Monitoring services cannot send the Authorization header GitHub requires, so each application's
 * webhook points here, naming the provider and the repository in the path:
 *
 *   https://<worker>/<provider>/<owner>/<repo>
 *
 * The provider is never guessed from the request: the path selects it, and only repositories configured
 * for that provider are accepted, so a request cannot pick a weaker verification than the one configured.
 *
 * Configuration:
 *   ALLOWED_OWNER  (var)       GitHub owner whose repositories may be targeted, e.g. datalogix (in any case)
 *   GITHUB_TOKEN   (secret)    Fine-grained token with Contents: read and write on the project repositories
 *   SECRETS        (KV)        One entry per repository and provider: "<provider>:<owner>/<repo>" (lowercase) => secret.
 *                              Kept in KV, not in a single secret, so one project can be added or changed
 *                              (by the setup command) without rewriting the others. Also holds, for a while, the
 *                              events already delivered ("delivery:<provider>:<owner>/<repo>:<sha256 of the body>").
 */

import { providers } from './providers/index.js';
import { deliveryKey, secretKey } from './keys.js';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_BODY_BYTES = 1024 * 1024;
// Wide enough for the provider's retries, which keep the original timestamp; narrow enough to stop old replays
const MAX_EVENT_AGE_MS = 60 * 60 * 1000;
// A delivered event is remembered for longer than it is accepted (up to an hour either side of its timestamp), so a
// replay within its age is never sent again
const DELIVERY_TTL_SECONDS = (2 * MAX_EVENT_AGE_MS) / 1000 + 5 * 60;

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The raw body, or null once it passes MAX_BODY_BYTES: counted while reading, so a body sent without Content-Length is cut too. */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        return null;
      }
      chunks.push(chunk);
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    const segments = new URL(request.url).pathname.split('/').filter(Boolean);
    if (segments.length !== 3) {
      return new Response('Not found', { status: 404 });
    }

    const [providerId, owner, repo] = segments;
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    // GitHub owner names are case-insensitive
    if (!provider || owner.toLowerCase() !== env.ALLOWED_OWNER?.toLowerCase()) {
      return new Response('Not found', { status: 404 });
    }
    const repository = `${owner}/${repo}`;

    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }

    const body = await readBody(request);
    if (!body) {
      return new Response('Payload too large', { status: 413 });
    }

    // A repository without a secret answers like a bad signature, and in the same time (the body is verified with a
    // random key), so the configured repositories cannot be listed
    const secret = await env.SECRETS.get(secretKey(providerId, repository));
    const configured = typeof secret === 'string' && secret !== '';
    const verified = await provider.verify(request, body, configured ? secret : crypto.randomUUID());
    if (!configured) {
      console.warn(`No ${providerId} secret for ${repository}`);
    }
    if (!configured || !verified) {
      return new Response('Invalid signature', { status: 401 });
    }

    let webhook;
    try {
      webhook = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const incident = provider.normalize(webhook);
    if (!incident) {
      // An event the provider sends but the incident flow does not use: acknowledge so it is not retried
      return new Response(null, { status: 204 });
    }

    const sentAt = provider.sentAt(webhook);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_EVENT_AGE_MS) {
      return new Response('Stale event', { status: 401 });
    }

    // A signed event replayed within its age (or retried after it reached GitHub): acknowledged, not sent again.
    // KV is eventually consistent, so two copies within about a minute may both pass
    const delivered = deliveryKey(providerId, repository, await sha256(body));
    if (await env.SECRETS.get(delivered)) {
      return new Response(null, { status: 204 });
    }

    const message = incident.issue.details?.message;
    if (typeof message === 'string') {
      // Counted and cut by code point, so an emoji is not cut in half
      const chars = Array.from(message);
      if (chars.length > MAX_MESSAGE_LENGTH) {
        incident.issue.details.message = chars.slice(0, MAX_MESSAGE_LENGTH).join('') + '…';
      }
    }

    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${repository}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'datalogix-incident-relay',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'incident',
          client_payload: { provider: { id: provider.id, name: provider.name }, ...incident },
        }),
      });
    } catch (error) {
      console.error(`GitHub request failed for ${repository}: ${error.message}`);
      return new Response('GitHub unreachable', { status: 502 });
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`GitHub answered ${response.status} for ${repository}: ${text}`);
      // A 5xx (or a rate limit) makes the provider retry later. GitHub answers a rate limit with 429 or with 403 and a
      // Retry-After header, no requests remaining or the message. Any other 4xx fails again on every retry, so it is
      // acknowledged to stop the provider
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0' ||
            /rate limit/i.test(text)));
      if (response.status >= 500 || rateLimited) {
        return new Response('GitHub rejected the event', { status: 502 });
      }
      return new Response('GitHub rejected the event', { status: 200 });
    }

    // Only once GitHub has it: a failed delivery is retried by the provider and must go through then
    try {
      await env.SECRETS.put(delivered, '1', { expirationTtl: DELIVERY_TTL_SECONDS });
    } catch (error) {
      console.error(`Could not remember the delivery for ${repository}: ${error.message}`);
    }

    return new Response(null, { status: 204 });
  },
};
