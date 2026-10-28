const encoder = new TextEncoder();

/**
 * HMAC-SHA256 of the raw body (bytes, or a string encoded as UTF-8) with the secret, given as a hex digest with or
 * without a "sha256=" prefix. crypto.subtle.verify compares in constant time.
 */
export async function verifyHmacSha256(body, header, secret) {
  if (!header) {
    return false;
  }

  const hex = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return false;
  }

  const signature = new Uint8Array(hex.match(/../g).map((byte) => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);

  return crypto.subtle.verify('HMAC', key, signature, typeof body === 'string' ? encoder.encode(body) : body);
}
