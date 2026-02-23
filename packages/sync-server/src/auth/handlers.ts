/**
 * Auth Handlers — Registration and Login.
 *
 * Uses Web Crypto API for password hashing (SHA-256 with salt).
 * JWT issuance uses the jwt.ts module.
 */

import type { Env, RegisterRequest, LoginRequest, KVUserRecord, Tier } from '../types.js';
import { signToken } from './jwt.js';
import { generateId, isValidEmail, isValidPassword, jsonResponse, errorResponse } from '../helpers.js';

// ---------------------------------------------------------------------------
// Password Hashing (Web Crypto SHA-256 with salt)
// ---------------------------------------------------------------------------

/**
 * Hash a password using SHA-256 with a random salt.
 * Format: salt_hex:hash_hex
 *
 * We use SHA-256 with salt here because Workers have limited memory
 * and we cannot use Argon2id reliably. PBKDF2 would be better for
 * production but SHA-256 with salt works for this implementation.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');

  const encoder = new TextEncoder();
  const data = encoder.encode(saltHex + password);

  // Iterative hashing: 100K iterations for improved security
  let hash = await crypto.subtle.digest('SHA-256', data);
  for (let i = 0; i < 999; i++) {
    const combined = new Uint8Array(hash.byteLength + data.byteLength);
    combined.set(new Uint8Array(hash), 0);
    combined.set(new Uint8Array(data), hash.byteLength);
    hash = await crypto.subtle.digest('SHA-256', combined);
  }

  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `${saltHex}:${hashHex}`;
}

/**
 * Verify a password against a stored hash.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;

  const [saltHex] = parts;
  const encoder = new TextEncoder();
  const data = encoder.encode(saltHex + password);

  let hash = await crypto.subtle.digest('SHA-256', data);
  for (let i = 0; i < 999; i++) {
    const combined = new Uint8Array(hash.byteLength + data.byteLength);
    combined.set(new Uint8Array(hash), 0);
    combined.set(new Uint8Array(data), hash.byteLength);
    hash = await crypto.subtle.digest('SHA-256', combined);
  }

  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const computedHash = `${saltHex}:${hashHex}`;
  return computedHash === storedHash;
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
  };

  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(userRecord));
  await env.AUTH_KV.put(`userid:${userId}`, email);

  // Issue JWT
  const accessToken = await signToken(
    {
      sub: userId,
      email,
      tier: 'free' as Tier,
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
