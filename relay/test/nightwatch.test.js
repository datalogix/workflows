import { expect, test } from 'vitest';
import nightwatch from '../src/providers/nightwatch.js';

test('normalizes an exception', () => {
  const incident = nightwatch.normalize({
    event: 'issue.opened',
    payload: {
      issue: {
        id: 12,
        ref: 'NW-12',
        type: 'exception',
        title: 'Call to a member function on null',
        status: 'open',
        priority: 'high',
        url: 'https://nightwatch.laravel.com/issues/12',
        details: {
          handled: false,
          class: 'Error',
          message: 'Boom',
          file: 'app/A.php',
          line: 9,
          laravel_version: '13.1',
          php_version: '8.4',
        },
      },
      environment: { id: 1, name: 'production' },
    },
  });

  expect(incident.event).toBe('opened');
  expect(incident.issue.id).toBe('12');
  expect(incident.issue.type).toBe('exception');
  expect(incident.issue.details.class).toBe('Error');
  expect(incident.issue.details.runtime).toBe('Laravel 13.1 / PHP 8.4');
  expect(incident.environment).toStrictEqual({ name: 'production' });
  expect(incident.actor).toBe(null);
});

test('normalizes a performance issue and a resolution', () => {
  const slow = nightwatch.normalize({
    event: 'issue.reopened',
    payload: {
      issue: {
        id: 3,
        type: 'performance',
        title: 'Slow route',
        details: { methods: ['GET'], path: '/reports', duration: 4200, threshold: 1000 },
      },
      environment: { name: 'staging' },
    },
  });
  expect(slow.event).toBe('reopened');
  expect(slow.issue.type).toBe('performance');
  expect(slow.issue.details.path).toBe('/reports');

  const resolved = nightwatch.normalize({
    event: 'issue.resolved',
    payload: {
      issue: { id: 3, type: 'performance', title: 'Slow route' },
      actor: { id: 1, name: 'Foo', email: 'foo@bar.com' },
    },
  });
  expect(resolved.event).toBe('resolved');
  expect(resolved.environment).toBe(null);
  expect(resolved.actor).toStrictEqual({ name: 'Foo' });
});

test('ignores other events and payloads without an issue', () => {
  expect(nightwatch.normalize({ event: 'deployment.created', payload: {} })).toBe(null);
  expect(nightwatch.normalize({ event: 'issue.opened', payload: {} })).toBe(null);
  expect(nightwatch.normalize(null)).toBe(null);
});

test('normalizes an issue without details', () => {
  const incident = nightwatch.normalize({ event: 'issue.opened', payload: { issue: { id: 1, title: 'Error' } } });
  expect(incident.issue.details.message).toBe(undefined);
  expect(incident.issue.details.runtime).toBe(undefined);
  expect(incident.environment).toBe(null);
});

test('reports the Laravel version alone when PHP is missing', () => {
  const incident = nightwatch.normalize({
    event: 'issue.opened',
    payload: { issue: { id: 1, details: { laravel_version: '13.1' } } },
  });
  expect(incident.issue.details.runtime).toBe('Laravel 13.1');
});

test('reads when the webhook was sent', () => {
  expect(nightwatch.sentAt({ timestamp: '2026-10-21T12:00:00Z' })).toBe(Date.UTC(2026, 9, 21, 12));
  expect(nightwatch.sentAt({})).toBeNaN();
  expect(nightwatch.sentAt(null)).toBeNaN();
});

test('normalizes ignored events, a zero id and unknown types', () => {
  const incident = nightwatch.normalize({
    event: 'issue.ignored',
    payload: { issue: { id: 0, type: 'something-new', title: 'Error' } },
  });
  expect(incident.event).toBe('ignored');
  expect(incident.issue.id).toBe('0');
  expect(incident.issue.type).toBe('something-new');
});
