/**
 * Inspector error notifications, sent by the Webhook notification channel of an application:
 * https://docs.inspector.dev/concepts/notifications/webhook-channel
 *
 * Events: error_group_detected_notification (a new error) opens the GitHub issue, error_frequency_increasing_notification
 * and nth_error_notification (one that keeps happening) reopen it. Single occurrences, alerts and transactions are
 * ignored, and Inspector sends no event when an error is resolved: close the GitHub issue by hand.
 * Signature: none. Inspector sends the application's ingestion key in the X-Inspector-Key header, which the relay
 * compares with the keys stored for the repository.
 * Environment: not in the payload. Each environment is its own application in Inspector, with its own key, so the
 * secret of a repository is a JSON object of keys by environment, e.g. {"production":"<key>","staging":"<key>"}, and
 * the key that matches names the environment.
 * Sent at: when it arrives. Without a signature the payload's times prove nothing (whoever has the key can send any),
 * and their timezone is not documented, so they are not checked; a body sent twice is still caught by its hash.
 * Issue id: Inspector sends none, so it is a hash of the application and the error's class, file and line, which is how
 * it groups errors.
 */

const EVENTS = {
  error_group_detected_notification: 'opened',
  error_frequency_increasing_notification: 'reopened',
  nth_error_notification: 'reopened',
};

const encoder = new TextEncoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

// Compares digests of the same length, so the time does not tell how much of the key matched
async function sameKey(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** The keys of the secret by environment, or an empty object when it is not such JSON. */
function keysOf(secret) {
  try {
    const keys = JSON.parse(secret);
    return keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
  } catch {
    return {};
  }
}

export default {
  id: 'inspector',
  name: 'Inspector',

  async verify(request, body, secret) {
    const given = request.headers.get('X-Inspector-Key');
    if (!given) {
      return false;
    }

    let environment = null;
    // Every key is compared, so the time does not tell which one matched
    for (const [name, key] of Object.entries(keysOf(secret))) {
      if (typeof key === 'string' && key !== '' && (await sameKey(given, key)) && !environment) {
        environment = name;
      }
    }
    return environment ? { environment } : false;
  },

  sentAt() {
    return Date.now();
  },

  async normalize(webhook, verified) {
    const event = EVENTS[webhook?.event];
    const error = webhook?.payload;
    if (!event || !error?.class) {
      return null;
    }

    // With the application, which is one per environment, so staging and production do not share an issue
    const digest = await sha256([webhook.application?.id, error.class, error.file, error.line].join('\n'));
    const id = Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const line = Number(error.line);

    return {
      event,
      issue: {
        id,
        type: 'exception',
        title: `${error.class}${error.message ? `: ${error.message}` : ''}`,
        priority: null,
        url: null,
        details: {
          class: error.class,
          message: error.message,
          file: error.file,
          line: Number.isInteger(line) ? line : undefined,
          handled: typeof error.handled === 'boolean' ? error.handled : undefined,
        },
      },
      environment: verified?.environment ? { name: verified.environment } : null,
      actor: null,
    };
  },
};
