import { expect, test, vi } from 'vitest';
import inspector from '../src/providers/inspector.js';

// Shaped like the examples of Inspector's webhook channel documentation
const notification = (event = 'error_group_detected_notification', payload = {}) => ({
  event,
  application: { id: 12345, name: 'Your App Name', client_version: '4.7.22' },
  payload: {
    last_seen_at: '2026-10-29 12:00:00',
    created_at: '2026-10-29 11:58:00',
    handled: false,
    message: 'Missing required parameters for [Route: home] [URI: /]',
    class: 'ErrorException',
    file: 'app/Http/Controllers/YourController.php',
    line: '17',
    ...payload,
  },
});
const keys = JSON.stringify({ production: 'production-key', staging: 'staging-key' });
const request = (headers) => new Request('https://relay.test', { method: 'POST', headers });

test('normalizes a new error', async () => {
  const incident = await inspector.normalize(notification(), { environment: 'production' });
  expect(incident).toStrictEqual({
    event: 'opened',
    issue: {
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      type: 'exception',
      title: 'ErrorException: Missing required parameters for [Route: home] [URI: /]',
      priority: null,
      url: null,
      details: {
        class: 'ErrorException',
        message: 'Missing required parameters for [Route: home] [URI: /]',
        file: 'app/Http/Controllers/YourController.php',
        line: 17,
        handled: false,
      },
    },
    environment: { name: 'production' },
    actor: null,
  });
});

test('reopens an error that keeps happening', async () => {
  expect((await inspector.normalize(notification('error_frequency_increasing_notification'))).event).toBe('reopened');
  expect((await inspector.normalize(notification('nth_error_notification', { nth: 100 }))).event).toBe('reopened');
});

test('gives an error the same id in every notification, and another one in another application', async () => {
  const id = async (webhook) => (await inspector.normalize(webhook)).issue.id;
  const first = await id(notification());
  expect(await id(notification('nth_error_notification', { last_seen_at: '2026-10-30 08:00:00', nth: 100 }))).toBe(
    first,
  );
  expect(await id({ ...notification(), application: { id: 999 } })).not.toBe(first);
  expect(await id(notification(undefined, { line: '18' }))).not.toBe(first);
});

test('ignores single occurrences, alerts, transactions and errors without a class', async () => {
  for (const event of [
    'error_occurrence_detected_notification',
    'alert_violation_notification',
    'transaction_group_notification',
  ]) {
    expect(await inspector.normalize(notification(event))).toBe(null);
  }
  expect(await inspector.normalize(notification(undefined, { class: undefined }))).toBe(null);
  expect(await inspector.normalize({})).toBe(null);
});

test('takes the arrival as when the notification was sent, whatever its times say', () => {
  vi.useFakeTimers({ now: Date.parse('2026-10-29T15:00:00Z') });
  expect(inspector.sentAt(notification())).toBe(Date.parse('2026-10-29T15:00:00Z'));
  expect(inspector.sentAt({})).toBe(Date.parse('2026-10-29T15:00:00Z'));
  vi.useRealTimers();
});

test('verifies the X-Inspector-Key header and names the environment of the key', async () => {
  expect(await inspector.verify(request({ 'X-Inspector-Key': 'production-key' }), '', keys)).toStrictEqual({
    environment: 'production',
  });
  expect(await inspector.verify(request({ 'X-Inspector-Key': 'staging-key' }), '', keys)).toStrictEqual({
    environment: 'staging',
  });
  expect(await inspector.verify(request({ 'X-Inspector-Key': 'other' }), '', keys)).toBe(false);
  expect(await inspector.verify(request({}), '', keys)).toBe(false);
});

test('rejects every key when the secret is not an object of keys', async () => {
  const header = request({ 'X-Inspector-Key': 'production-key' });
  for (const secret of ['production-key', '["production-key"]', 'null', '{"production":""}', '{"production":1}']) {
    expect(await inspector.verify(header, '', secret)).toBe(false);
  }
});
