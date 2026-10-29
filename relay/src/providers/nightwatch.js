/**
 * Laravel Nightwatch issue webhooks: https://nightwatch.laravel.com/docs/webhooks
 *
 * Events: issue.opened, issue.reopened, issue.resolved, issue.ignored.
 * Signature: HMAC-SHA256 of the raw body with the application's signing secret, in the Nightwatch-Signature header.
 * Sent at: the ISO 8601 `timestamp` of the webhook.
 */

import { verifyHmacSha256 } from '../signatures.js';

const EVENTS = {
  'issue.opened': 'opened',
  'issue.reopened': 'reopened',
  'issue.resolved': 'resolved',
  'issue.ignored': 'ignored',
};

export default {
  id: 'nightwatch',
  name: 'Nightwatch',

  verify(request, body, secret) {
    return verifyHmacSha256(body, request.headers.get('Nightwatch-Signature'), secret);
  },

  sentAt(webhook) {
    return Date.parse(webhook?.timestamp);
  },

  normalize(webhook) {
    const event = EVENTS[webhook?.event];
    const issue = webhook?.payload?.issue;
    if (!event || !issue || issue.id === undefined || issue.id === null) {
      return null;
    }

    const details = issue.details ?? {};

    return {
      event,
      issue: {
        id: String(issue.id),
        // A type the incident workflow does not know is passed on as is, so incident-types decides whether it is handled
        type: issue.type ? String(issue.type) : 'exception',
        title: issue.title ?? '',
        priority: issue.priority ?? null,
        url: issue.url ?? null,
        details: {
          class: details.class,
          message: details.message,
          file: details.file,
          line: details.line,
          handled: details.handled,
          methods: details.methods,
          path: details.path,
          action: details.action,
          name: details.name,
          duration: details.duration,
          threshold: details.threshold,
          runtime: details.laravel_version
            ? `Laravel ${details.laravel_version}${details.php_version ? ` / PHP ${details.php_version}` : ''}`
            : undefined,
        },
      },
      environment: webhook.payload.environment?.name ? { name: webhook.payload.environment.name } : null,
      actor: webhook.payload.actor?.name ? { name: webhook.payload.actor.name } : null,
    };
  },
};
