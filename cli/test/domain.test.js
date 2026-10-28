import { expect, test } from 'vitest';
import { domainOf, isDomain, pathOf } from '../kinds/project/domain.js';

test('validates domains and reads them from URLs', () => {
  expect(isDomain('app.example.com')).toBe(true);
  expect(isDomain('https://app.example.com')).toBe(false);
  expect(isDomain('localhost')).toBe(false);
  expect(domainOf('https://staging.example.com/up')).toBe('staging.example.com');
  expect(domainOf('nonsense')).toBe(null);
});

test('reads the health check path from a URL', () => {
  expect(pathOf('https://app.example.com/up')).toBe('/up');
  expect(pathOf('https://app.example.com')).toBe('/');
  expect(pathOf('nonsense')).toBe(null);
});
