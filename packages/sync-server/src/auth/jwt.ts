/**
 * JWT Auth Module using Web Crypto API (no external dependencies).
 *
 * Implements HS256 (HMAC-SHA256) JWT signing and verification
 * using the built-in Web Crypto API available in Cloudflare Workers.
 */

import type { JWTPayload } from '../types.js';

// ---------------------------------------------------------------------------
// Encoding Helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let input: string;
  if (typeof data === 'string') {
    input = btoa(data);
  } else {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    input = btoa(binary);
  }
  return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  // Restore base64 padding
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4;
  if (padding === 2) base64 += '==';
  else if (padding === 3) base64 += '=';
  return atob(base64);
}

// ---------------------------------------------------------------------------
// Key Import
// ---------------------------------------------------------------------------

async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// ---------------------------------------------------------------------------
// Sign Token
// ---------------------------------------------------------------------------

/**
 * Create a JWT with HS256 algorithm.
 *
 * @param payload - Claims to include in the JWT
 * @param secret - Secret key for HMAC-SHA256 signing
 * @param expiresInSeconds - Token lifetime in seconds (default: 3600 = 1 hour)
 * @returns Signed JWT string
 */
export async function signToken(
  payload: Omit<JWTPayload, 'iat' | 'exp'> & { iat?: number; exp?: number },
  secret: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = {
    ...payload,
    iat: payload.iat ?? now,
    exp: payload.exp ?? now + expiresInSeconds,
  } as JWTPayload;

  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signingInput),
  );

  const signatureB64 = base64UrlEncode(signature);
  return `${signingInput}.${signatureB64}`;
}

// ---------------------------------------------------------------------------
// Verify Token
// ---------------------------------------------------------------------------

export class JWTError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'JWTError';
  }
}

/**
 * Verify a JWT and return its decoded payload.
 *
 * @param token - The JWT string to verify
 * @param secret - Secret key for HMAC-SHA256 verification
 * @param options - Optional issuer and audience validation
 * @returns Decoded JWT payload
 * @throws JWTError if verification fails
 */
export async function verifyToken(
  token: string,
  secret: string,
  options?: { issuer?: string; audience?: string },
): Promise<JWTPayload> {
  // 1. Split into parts
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JWTError('Malformed token: expected 3 parts', 'malformed');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 2. Verify header
  let header: { alg: string; typ: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    throw new JWTError('Invalid header encoding', 'malformed');
  }

  if (header.alg !== 'HS256') {
    throw new JWTError(`Unsupported algorithm: ${header.alg}`, 'unsupported_alg');
  }

  // 3. Verify signature
  const key = await importKey(secret);
  const encoder = new TextEncoder();
  const signingInput = `${headerB64}.${payloadB64}`;

  // Decode the signature from base64url
  const signatureStr = base64UrlDecode(signatureB64);
  const signatureBytes = new Uint8Array(signatureStr.length);
  for (let i = 0; i < signatureStr.length; i++) {
    signatureBytes[i] = signatureStr.charCodeAt(i);
  }

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(signingInput),
  );

  if (!valid) {
    throw new JWTError('Invalid signature', 'invalid_signature');
  }

  // 4. Decode payload
  let payload: JWTPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new JWTError('Invalid payload encoding', 'malformed');
  }

  // 5. Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new JWTError('Token expired', 'expired');
  }

  // 6. Check issuer
  if (options?.issuer && payload.iss !== options.issuer) {
    throw new JWTError(`Invalid issuer: expected ${options.issuer}`, 'invalid_issuer');
  }

  // 7. Check audience
  if (options?.audience && payload.aud !== options.audience) {
    throw new JWTError(`Invalid audience: expected ${options.audience}`, 'invalid_audience');
  }

  return payload;
}
