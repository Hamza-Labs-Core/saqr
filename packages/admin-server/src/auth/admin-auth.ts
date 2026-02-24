/**
 * Admin Authentication — JWT verification + admin role check.
 *
 * Admin users are regular Saqr users with role: "admin" in their KVUserRecord.
 * No separate admin registration — promotion is admin-only via user management.
 */

import type { AdminEnv, AdminAuthContext, KVUserRecord } from '../types.js';
import { verifyToken, JWTError } from './jwt.js';
import { errorResponse } from '../helpers.js';

/**
 * Authenticate an admin request.
 *
 * 1. Verify JWT (same secret as sync-server)
 * 2. Look up user in AUTH_KV by userId
 * 3. Check role === "admin" on the KV record
 *
 * Returns AdminAuthContext on success, or a Response on failure.
 */
export async function authenticateAdmin(
  request: Request,
  env: AdminEnv,
): Promise<{ authCtx: AdminAuthContext } | { error: Response }> {
  // Extract Bearer token
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      error: errorResponse(401, 'missing_token', 'Authorization header with Bearer token required'),
    };
  }

  const token = authHeader.slice(7);
  if (!token) {
    return {
      error: errorResponse(401, 'missing_token', 'Bearer token is empty'),
    };
  }

  // Verify JWT
  let payload;
  try {
    payload = await verifyToken(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
  } catch (err) {
    const message = err instanceof JWTError ? err.message : 'Token expired or invalid';
    return {
      error: errorResponse(401, 'invalid_token', message),
    };
  }

  // Look up user record in KV for authoritative role check
  const email = await env.AUTH_KV.get(`userid:${payload.sub}`);
  if (!email) {
    return {
      error: errorResponse(401, 'user_not_found', 'User account not found'),
    };
  }

  const userRecordStr = await env.AUTH_KV.get(`user:${email}`);
  if (!userRecordStr) {
    return {
      error: errorResponse(401, 'user_not_found', 'User record not found'),
    };
  }

  let userRecord: KVUserRecord;
  try {
    userRecord = JSON.parse(userRecordStr);
  } catch {
    return {
      error: errorResponse(500, 'internal_error', 'Failed to read user record'),
    };
  }

  // Check admin role
  if (userRecord.role !== 'admin') {
    return {
      error: errorResponse(403, 'forbidden', 'Admin role required'),
    };
  }

  return {
    authCtx: {
      userId: payload.sub,
      email: userRecord.email,
      role: 'admin',
    },
  };
}
