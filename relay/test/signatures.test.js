import { expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHmacSha256 } from '../src/signatures.js';

test('verifies HMAC-SHA256 signatures', async () => {
  const sign = (body) => createHmac('sha256', 'secret').update(body).digest('hex');
  expect(await verifyHmacSha256('body', sign('body'), 'secret')).toBe(true);
  expect(await verifyHmacSha256('body', `sha256=${sign('body')}`, 'secret')).toBe(true);
  expect(await verifyHmacSha256('body', sign('body').toUpperCase(), 'secret')).toBe(true);
  expect(await verifyHmacSha256('body', `SHA256=${sign('body')}`, 'secret')).toBe(true);
  expect(await verifyHmacSha256('other', sign('body'), 'secret')).toBe(false);
  expect(await verifyHmacSha256('body', sign('body'), 'wrong')).toBe(false);
  expect(await verifyHmacSha256('body', 'not-hex', 'secret')).toBe(false);
  expect(await verifyHmacSha256('body', null, 'secret')).toBe(false);
});
