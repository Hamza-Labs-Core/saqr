/**
 * JWT Auth Module using Web Crypto API (no external dependencies).
 * Copied from sync-server — same HS256 implementation.
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
// Sign Token (for tests — admin-server primarily verifies)
// ---------------------------------------------------------------------------

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

export async function verifyToken(
  token: string,
  secret: string,
  options?: { issuer?: string; audience?: string },
): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JWTError('Malformed token: expected 3 parts', 'malformed');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg: string; typ: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    throw new JWTError('Invalid header encoding', 'malformed');
  }

  if (header.alg !== 'HS256') {
    throw new JWTError(`Unsupported algorithm: ${header.alg}`, 'unsupported_alg');
  }

  const key = await importKey(secret);
  const encoder = new TextEncoder();
  const signingInput = `${headerB64}.${payloadB64}`;

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

  let payload: JWTPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new JWTError('Invalid payload encoding', 'malformed');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new JWTError('Token expired', 'expired');
  }

  // Check not-before (nbf)
  if (payload.nbf && payload.nbf > now) {
    throw new JWTError('Token not yet valid', 'not_yet_valid');
  }

  if (options?.issuer && payload.iss !== options.issuer) {
    throw new JWTError(`Invalid issuer: expected ${options.issuer}`, 'invalid_issuer');
  }

  if (options?.audience && payload.aud !== options.audience) {
    throw new JWTError(`Invalid audience: expected ${options.audience}`, 'invalid_audience');
  }

  return payload;
}
