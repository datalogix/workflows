/**
 * Sentry issue alerts, sent by an internal integration with "Alert Rule Action" on, picked as the action of an alert
 * rule: https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issue-alerts/
 *
 * Events: only `triggered` (resource event_alert), each one an event of a Sentry issue, which opens or reopens the
 * GitHub issue. Sentry's issue webhooks (resolved, archived) carry neither the environment nor a signed time they were
 * sent, so they are ignored: close the GitHub issue there.
 * Signature: HMAC-SHA256 of the raw body with the integration's Client Secret, in the Sentry-Hook-Signature header.
 * Sent at: the event's `timestamp` (epoch seconds), signed with the body; an alert fires as the event arrives.
 * Environment: the event's `environment`, or its `environment` tag.
 */

import { verifyHmacSha256 } from '../signatures.js';

// A tag of the event, as Sentry sends them: [key, value] pairs or { key, value } objects
function tag(event, key) {
  for (const entry of Array.isArray(event.tags) ? event.tags : []) {
    if (Array.isArray(entry) && entry[0] === key) return entry[1];
    if (entry && entry.key === key) return entry.value;
  }
  return undefined;
}

// The frame that most likely holds the bug: the innermost one of the app, else the innermost one
function culpritFrame(exception) {
  const frames = exception?.stacktrace?.frames ?? [];
  return [...frames].reverse().find((frame) => frame.in_app) ?? frames.at(-1);
}

export default {
  id: 'sentry',
  name: 'Sentry',

  verify(request, body, secret) {
    return verifyHmacSha256(body, request.headers.get('Sentry-Hook-Signature'), secret);
  },

  sentAt(webhook) {
    const timestamp = webhook?.data?.event?.timestamp;
    return typeof timestamp === 'number' ? timestamp * 1000 : Date.parse(webhook?.data?.event?.datetime);
  },

  normalize(webhook) {
    const event = webhook?.data?.event;
    if (webhook?.action !== 'triggered' || !event || event.issue_id === undefined || event.issue_id === null) {
      return null;
    }

    // The exception thrown last is the one Sentry titles the issue after
    const exception = event.exception?.values?.at(-1);
    const frame = culpritFrame(exception);
    const handled = tag(event, 'handled');
    const environment = event.environment ?? tag(event, 'environment');
    const runtime = event.contexts?.runtime;

    return {
      event: 'opened',
      issue: {
        id: String(event.issue_id),
        type: 'exception',
        title: event.title ?? '',
        priority: event.level ?? null,
        url: event.web_url ?? null,
        details: {
          class: exception?.type,
          message: exception?.value,
          file: frame?.filename,
          line: frame?.lineno,
          handled: handled === undefined ? undefined : handled === 'yes',
          runtime: runtime?.name ? `${runtime.name}${runtime.version ? ` ${runtime.version}` : ''}` : undefined,
        },
      },
      environment: environment ? { name: String(environment) } : null,
      actor: null,
    };
  },
};
