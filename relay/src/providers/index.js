/**
 * Monitoring providers the relay accepts, keyed by the first segment of the webhook URL.
 *
 * Each provider exports an object with:
 *
 *   id    string  the URL segment and the prefix of its keys in the SECRETS namespace, e.g. "nightwatch"
 *   name  string  shown in GitHub issues, e.g. "Nightwatch"
 *
 *   verify(request, body, secret) => Promise<boolean | object>
 *     Proves that the raw body (a Uint8Array) came from the provider, with the secret configured for the repository.
 *     An object counts as verified and is passed to normalize, e.g. Inspector's { environment } of the key that matched.
 *
 *   sentAt(webhook) => number
 *     When the provider sent the parsed webhook, in epoch milliseconds (NaN when missing).
 *
 *   normalize(webhook, verified) => Incident | null | Promise<Incident | null>
 *     Converts the parsed webhook into the incident format below, or returns null for events to ignore. verified is
 *     what verify returned.
 *
 * Incident (what the incident workflow reads):
 *   {
 *     event: "opened" | "reopened" | "resolved" | "ignored",
 *     issue: {
 *       id: string,                       // stable across events of the same problem
 *       type: "exception" | "performance" | string, // another type of the provider, handled only when listed
 *       title: string,
 *       priority: string | null,
 *       url: string | null,               // the problem in the provider's dashboard
 *       details: {                        // all optional
 *         class, message, file, line, handled,          // exceptions
 *         methods, path, action, name, duration, threshold, // performance, in the units the provider reports
 *         runtime                                        // e.g. "Laravel 13.1 / PHP 8.4"
 *       }
 *     },
 *     environment: { name: string } | null,  // must match the GitHub environment (production, staging)
 *     actor: { name: string } | null         // who resolved or ignored it
 *   }
 *
 * A new provider also needs tests with a real webhook from it and its setup in docs/production-errors.md.
 */

import inspector from './inspector.js';
import nightwatch from './nightwatch.js';
import sentry from './sentry.js';

export const providers = Object.fromEntries([nightwatch, sentry, inspector].map((provider) => [provider.id, provider]));
