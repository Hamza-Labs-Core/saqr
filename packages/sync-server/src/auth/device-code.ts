/**
 * Device Code Flow — RFC 8628 OAuth 2.0 Device Authorization Grant.
 *
 * Endpoints:
 *   POST /auth/device-code  → Issue a device code + user code
 *   POST /auth/device-poll   → Poll for approval, return tokens when approved
 *   POST /auth/device-approve → Approve a device code (called by website after user login)
 */

import type { Env, KVUserRecord, Tier } from '../types.js';
import type {
  DeviceCodeRequest,
  DeviceCodeResponse,
  DevicePollRequest,
  DeviceCodeRecord,
} from '@saqr/shared';
import { signToken } from './jwt.js';
import { generateId, jsonResponse, errorResponse } from '../helpers.js';

/** Device code TTL: 15 minutes. */
const DEVICE_CODE_TTL_SECONDS = 900;

/** Minimum poll interval: 5 seconds. */
const POLL_INTERVAL_SECONDS = 5;

/** Refresh token TTL: 30 days. */
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** User code length: 8 characters, uppercase alphanumeric. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 to avoid confusion

/**
 * Generate a user-friendly code (e.g., "ABCD-1234").
 */
function generateUserCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// ---------------------------------------------------------------------------
// POST /auth/device-code
// ---------------------------------------------------------------------------

/**
 * Handle device code initiation.
 * Returns a user code and verification URL for the user to visit.
 */
export async function handleDeviceCode(request: Request, env: Env): Promise<Response> {
  let body: DeviceCodeRequest;
  try {
    body = await request.json() as DeviceCodeRequest;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  if (!body.client_id || typeof body.client_id !== 'string') {
    return errorResponse(400, 'invalid_client', 'client_id is required');
  }

  const deviceCode = generateId(32);
  const userCode = generateUserCode();
  const scope = body.scope ?? ['sync'];
  const now = new Date().toISOString();

  // Determine the base URL for verification
  const url = new URL(request.url);
  const baseUrl = env.WEBSITE_URL || `${url.protocol}//${url.host}`;
  const verificationUri = `${baseUrl}/auth/device`;
  const verificationUriComplete = `${verificationUri}?code=${userCode}`;

  const record: DeviceCodeRecord = {
    userCode,
    deviceCode,
    clientId: body.client_id,
    scope,
    status: 'pending',
    createdAt: now,
    expiresIn: DEVICE_CODE_TTL_SECONDS,
  };

  // Store by device_code (for polling) and by user_code (for approval UI)
  await Promise.all([
    env.AUTH_KV.put(`device:${deviceCode}`, JSON.stringify(record), {
      expirationTtl: DEVICE_CODE_TTL_SECONDS + 60, // buffer for clock skew
    }),
    env.AUTH_KV.put(`usercode:${userCode}`, deviceCode, {
      expirationTtl: DEVICE_CODE_TTL_SECONDS + 60,
    }),
  ]);

  const response: DeviceCodeResponse = {
    user_code: userCode,
    device_code: deviceCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: POLL_INTERVAL_SECONDS,
  };

  return jsonResponse(200, response);
}

// ---------------------------------------------------------------------------
// POST /auth/device-poll
// ---------------------------------------------------------------------------

/**
 * Handle device code polling.
 * Returns tokens when approved, or a pending/error status otherwise.
 */
export async function handleDevicePoll(request: Request, env: Env): Promise<Response> {
  let body: DevicePollRequest;
  try {
    body = await request.json() as DevicePollRequest;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  if (!body.device_code || !body.client_id) {
    return errorResponse(400, 'invalid_request', 'device_code and client_id are required');
  }

  const recordStr = await env.AUTH_KV.get(`device:${body.device_code}`);
  if (!recordStr) {
    return errorResponse(400, 'expired_token', 'Device code has expired or is invalid');
  }

  let record: DeviceCodeRecord;
  try {
    record = JSON.parse(recordStr);
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to read device code record');
  }

  // Verify client_id matches
  if (record.clientId !== body.client_id) {
    return errorResponse(400, 'invalid_client', 'client_id does not match');
  }

  // Check expiration
  const createdAt = new Date(record.createdAt).getTime();
  const now = Date.now();
  if (now - createdAt > record.expiresIn * 1000) {
    // Clean up expired record
    await env.AUTH_KV.delete(`device:${body.device_code}`);
    return jsonResponse(400, {
      error: 'expired_token',
      error_description: 'The device code has expired. Please restart the login flow.',
    });
  }

  switch (record.status) {
    case 'pending':
      return jsonResponse(400, {
        error: 'authorization_pending',
        error_description: 'The user has not yet approved this device.',
      });

    case 'denied':
      // Clean up denied record
      await env.AUTH_KV.delete(`device:${body.device_code}`);
      return jsonResponse(400, {
        error: 'access_denied',
        error_description: 'The user denied this device.',
      });

    case 'approved':
      // Clean up used record
      await Promise.all([
        env.AUTH_KV.delete(`device:${body.device_code}`),
        env.AUTH_KV.delete(`usercode:${record.userCode}`),
      ]);

      return jsonResponse(200, {
        access_token: record.accessToken,
        refresh_token: record.refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });

    default:
      return errorResponse(500, 'internal_error', 'Unknown device code status');
  }
}

// ---------------------------------------------------------------------------
// POST /auth/device-approve
// ---------------------------------------------------------------------------

interface DeviceApproveRequest {
  user_code: string;
  action: 'approve' | 'deny';
}

/**
 * Handle device code approval from the website.
 * Called after the user logs in on the website and approves the device.
 *
 * Requires authentication (user must be logged in).
 */
export async function handleDeviceApprove(
  request: Request,
  env: Env,
  userId: string,
  email: string,
  tier: Tier,
  role: string,
): Promise<Response> {
  let body: DeviceApproveRequest;
  try {
    body = await request.json() as DeviceApproveRequest;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  if (!body.user_code || !body.action) {
    return errorResponse(400, 'invalid_request', 'user_code and action are required');
  }

  if (body.action !== 'approve' && body.action !== 'deny') {
    return errorResponse(400, 'invalid_action', 'action must be "approve" or "deny"');
  }

  // Look up device code by user code
  const deviceCode = await env.AUTH_KV.get(`usercode:${body.user_code}`);
  if (!deviceCode) {
    return errorResponse(404, 'code_not_found', 'This code has expired or is invalid');
  }

  const recordStr = await env.AUTH_KV.get(`device:${deviceCode}`);
  if (!recordStr) {
    return errorResponse(404, 'code_not_found', 'Device code record not found');
  }

  let record: DeviceCodeRecord;
  try {
    record = JSON.parse(recordStr);
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to read device code record');
  }

  if (record.status !== 'pending') {
    return errorResponse(409, 'already_resolved', 'This code has already been used');
  }

  if (body.action === 'deny') {
    record.status = 'denied';
    await env.AUTH_KV.put(`device:${deviceCode}`, JSON.stringify(record), {
      expirationTtl: 60, // clean up after 1 minute
    });
    return jsonResponse(200, { status: 'denied' });
  }

  // Approve: generate tokens for the user
  const accessToken = await signToken(
    {
      sub: userId,
      email,
      tier: tier as Tier,
      role: role as 'user' | 'admin',
      iss: env.JWT_ISSUER || 'saqr',
      aud: env.JWT_AUDIENCE || 'saqr-sync',
    },
    env.JWT_SECRET,
    3600,
  );

  const refreshToken = `srt_${generateId(32)}`;

  // Store refresh token
  await env.AUTH_KV.put(
    `refresh:${refreshToken}`,
    JSON.stringify({ userId, email, tier, role, createdAt: new Date().toISOString() }),
    { expirationTtl: REFRESH_TOKEN_TTL_SECONDS },
  );

  // Update device code record with tokens
  record.status = 'approved';
  record.approvedBy = userId;
  record.accessToken = accessToken;
  record.refreshToken = refreshToken;

  await env.AUTH_KV.put(`device:${deviceCode}`, JSON.stringify(record), {
    expirationTtl: 300, // keep for 5 minutes for client to poll
  });

  return jsonResponse(200, { status: 'approved' });
}

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

/**
 * Handle token refresh.
 * Issues a new access token given a valid refresh token.
 */
export async function handleRefreshToken(request: Request, env: Env): Promise<Response> {
  let body: { refresh_token: string };
  try {
    body = await request.json() as { refresh_token: string };
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  if (!body.refresh_token) {
    return errorResponse(400, 'invalid_request', 'refresh_token is required');
  }

  const recordStr = await env.AUTH_KV.get(`refresh:${body.refresh_token}`);
  if (!recordStr) {
    return errorResponse(401, 'invalid_token', 'Refresh token is invalid or expired');
  }

  let record: { userId: string; email: string; tier: Tier; role: string };
  try {
    record = JSON.parse(recordStr);
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to read refresh token');
  }

  // Verify user still exists
  const userStr = await env.AUTH_KV.get(`user:${record.email}`);
  if (!userStr) {
    await env.AUTH_KV.delete(`refresh:${body.refresh_token}`);
    return errorResponse(401, 'invalid_token', 'User account no longer exists');
  }

  const user: KVUserRecord = JSON.parse(userStr);

  // Issue new access token with current user data
  const accessToken = await signToken(
    {
      sub: user.userId,
      email: user.email,
      tier: user.tier,
      role: user.role || 'user',
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
  });
}
