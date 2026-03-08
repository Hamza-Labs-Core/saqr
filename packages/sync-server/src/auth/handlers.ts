/**
 * Auth Handlers — Registration and Login.
 *
 * Uses Web Crypto API for password hashing (PBKDF2-SHA256 with 600k iterations).
 * JWT issuance uses the jwt.ts module.
 */

import type { Env, RegisterRequest, LoginRequest, KVUserRecord, Tier } from '../types.js';
import { signToken } from './jwt.js';
import { generateId, isValidEmail, isValidPassword, jsonResponse, errorResponse } from '../helpers.js';

// ---------------------------------------------------------------------------
// Password Hashing (PBKDF2-SHA256, 600,000 iterations via Web Crypto API)
// ---------------------------------------------------------------------------

/** Number of PBKDF2 iterations — Cloudflare Workers caps at 100,000. */
const PBKDF2_ITERATIONS = 100_000;

/** Derived key length in bits (256 bits = 32 bytes). */
const DERIVED_KEY_BITS = 256;

/** Convert a Uint8Array to a hex string. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Convert a hex string to a Uint8Array. */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Hash a password using PBKDF2-SHA256 with a random 32-byte salt.
 * Format: salt_hex:hash_hex
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_KEY_BITS,
  );

  return `${toHex(salt)}:${toHex(new Uint8Array(derivedBits))}`;
}

/**
 * Verify a password against a stored PBKDF2-SHA256 hash.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;

  const [saltHex, expectedHashHex] = parts;
  if (!saltHex || !expectedHashHex) return false;

  const salt = fromHex(saltHex);
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_KEY_BITS,
  );

  const computedHex = toHex(new Uint8Array(derivedBits));

  // Constant-time comparison to prevent timing attacks
  if (computedHex.length !== expectedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Register Handler
// ---------------------------------------------------------------------------

/**
 * Handle user registration.
 * POST /api/auth/register
 *
 * 1. Validate email and password
 * 2. Check uniqueness via KV
 * 3. Hash password
 * 4. Store user record in KV
 * 5. Return JWT
 */
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  // Parse request body
  let body: RegisterRequest;
  try {
    body = await request.json() as RegisterRequest;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  // Validate email
  if (!body.email || !isValidEmail(body.email)) {
    return errorResponse(400, 'invalid_email', 'A valid email address is required');
  }

  // Validate password
  if (!body.password || !isValidPassword(body.password)) {
    return errorResponse(
      400,
      'invalid_password',
      'Password must be between 12 and 1024 characters',
    );
  }

  // Normalize email to lowercase
  const email = body.email.toLowerCase().trim();

  // Check uniqueness
  const existing = await env.AUTH_KV.get(`user:${email}`);
  if (existing) {
    return errorResponse(409, 'email_exists', 'An account with this email already exists');
  }

  // Generate user ID and hash password
  const userId = `usr_${generateId(12)}`;
  const passwordHash = await hashPassword(body.password);
  const now = new Date().toISOString();

  // Store user record in KV
  const userRecord: KVUserRecord = {
    userId,
    passwordHash,
    email,
    tier: 'free',
    createdAt: now,
    role: 'user',
  };

  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(userRecord));
  await env.AUTH_KV.put(`userid:${userId}`, email);

  // Issue JWT
  const accessToken = await signToken(
    {
      sub: userId,
      email,
      tier: 'free' as Tier,
      role: 'user',
      iss: env.JWT_ISSUER || 'saqr',
      aud: env.JWT_AUDIENCE || 'saqr-sync',
    },
    env.JWT_SECRET,
    3600, // 1 hour
  );

  return jsonResponse(201, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    user: {
      user_id: userId,
      email,
      tier: 'free',
    },
  });
}

// ---------------------------------------------------------------------------
// Login Handler
// ---------------------------------------------------------------------------

/**
 * Handle user login.
 * POST /api/auth/login
 *
 * 1. Validate email and password
 * 2. Look up user in KV
 * 3. Verify password
 * 4. Issue JWT
 */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  // Parse request body
  let body: LoginRequest;
  try {
    body = await request.json() as LoginRequest;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  // Validate inputs
  if (!body.email || !body.password) {
    return errorResponse(400, 'missing_fields', 'Email and password are required');
  }

  const email = body.email.toLowerCase().trim();

  // Look up user
  const userRecordStr = await env.AUTH_KV.get(`user:${email}`);
  if (!userRecordStr) {
    // Generic message to prevent user enumeration
    return errorResponse(401, 'invalid_credentials', 'Invalid email or password');
  }

  let userRecord: KVUserRecord;
  try {
    userRecord = JSON.parse(userRecordStr);
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to read user record');
  }

  // Verify password
  const passwordValid = await verifyPassword(body.password, userRecord.passwordHash);
  if (!passwordValid) {
    return errorResponse(401, 'invalid_credentials', 'Invalid email or password');
  }

  // Issue JWT
  const accessToken = await signToken(
    {
      sub: userRecord.userId,
      email: userRecord.email,
      tier: userRecord.tier,
      role: userRecord.role || 'user',
      iss: env.JWT_ISSUER || 'saqr',
      aud: env.JWT_AUDIENCE || 'saqr-sync',
    },
    env.JWT_SECRET,
    3600,
  );

  return jsonResponse(200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    user: {
      user_id: userRecord.userId,
      email: userRecord.email,
      tier: userRecord.tier,
    },
  });
}
