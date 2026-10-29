import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import sentry from '../src/providers/sentry.js';

// Shaped like the issue alert example of Sentry's documentation, with the environment real events carry
const alert = (event = {}) => ({
  action: 'triggered',
  installation: { uuid: 'a8e5d37a-696c-4c54-adb5-b3f28d64c7de' },
  data: {
    event: {
      event_id: 'e4874d664c3540c1a32eab185f12c5ab',
      issue_id: '1117540176',
      title: 'ReferenceError: heck is not defined',
      level: 'error',
      environment: 'production',
      timestamp: 1566248777.677,
      datetime: '2019-08-19T21:06:17.677000Z',
      web_url: 'https://sentry.io/organizations/test-org/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/',
      tags: [
        ['handled', 'no'],
        ['level', 'error'],
      ],
      contexts: { runtime: { name: 'php', version: '8.4.1' } },
      exception: {
        values: [
          {
            type: 'ReferenceError',
            value: 'heck is not defined',
            stacktrace: {
              frames: [
                { filename: 'app/Http/Controllers/A.php', lineno: 12, in_app: true },
                { filename: 'vendor/laravel/framework/src/X.php', lineno: 40, in_app: false },
              ],
            },
          },
        ],
      },
      ...event,
    },
    triggered_rule: 'Errors to GitHub',
  },
  actor: { type: 'application', id: 'sentry', name: 'Sentry' },
});

test('normalizes an issue alert', () => {
  expect(sentry.normalize(alert())).toStrictEqual({
    event: 'opened',
    issue: {
      id: '1117540176',
      type: 'exception',
      title: 'ReferenceError: heck is not defined',
      priority: 'error',
      url: 'https://sentry.io/organizations/test-org/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/',
      details: {
        class: 'ReferenceError',
        message: 'heck is not defined',
        // The innermost frame of the app, not of the framework
        file: 'app/Http/Controllers/A.php',
        line: 12,
        handled: false,
        runtime: 'php 8.4.1',
      },
    },
    environment: { name: 'production' },
    actor: null,
  });
});

test('reads the environment from the tags, and has none without it', () => {
  const tagged = alert({ environment: undefined, tags: [{ key: 'environment', value: 'staging' }] });
  expect(sentry.normalize(tagged).environment).toStrictEqual({ name: 'staging' });
  expect(sentry.normalize(alert({ environment: undefined, tags: [] })).environment).toBe(null);
});

test('ignores the webhooks of other resources and alerts without an issue', () => {
  // An issue webhook (resolved): no environment, nor a signed time it was sent
  expect(sentry.normalize({ action: 'resolved', data: { issue: { id: '1117540176' } } })).toBe(null);
  expect(sentry.normalize(alert({ issue_id: null }))).toBe(null);
  expect(sentry.normalize({})).toBe(null);
});

test('takes when the event happened as when the alert was sent', () => {
  expect(sentry.sentAt(alert())).toBe(1566248777677);
  expect(sentry.sentAt(alert({ timestamp: undefined }))).toBe(Date.parse('2019-08-19T21:06:17.677000Z'));
  expect(sentry.sentAt({})).toBeNaN();
});

test('verifies the Sentry-Hook-Signature header', async () => {
  const body = JSON.stringify(alert());
  const signature = createHmac('sha256', 'client-secret').update(body).digest('hex');
  const request = (header) => new Request('https://relay.test', { method: 'POST', headers: header });
  expect(await sentry.verify(request({ 'Sentry-Hook-Signature': signature }), body, 'client-secret')).toBe(true);
  expect(await sentry.verify(request({ 'Sentry-Hook-Signature': signature }), body, 'other')).toBe(false);
  expect(await sentry.verify(request({ 'Nightwatch-Signature': signature }), body, 'client-secret')).toBe(false);
});
