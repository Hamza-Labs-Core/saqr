/**
 * User Management Handlers — List users, promote/demote admin role.
 *
 * Users are stored in AUTH_KV with:
 *   user:{email} → KVUserRecord
 *   userid:{userId} → email
 */

import type { AdminEnv, KVUserRecord } from '../types.js';
import { jsonResponse, errorResponse } from '../helpers.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/users — List users (paginated via KV list).
 */
export async function handleListUsers(
  env: AdminEnv,
  url: URL,
): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const cursor = url.searchParams.get('cursor') || undefined;

  const result = await env.AUTH_KV.list({
    prefix: 'user:',
    limit,
    cursor,
  });

  const users: Array<{
    userId: string;
    email: string;
    tier: string;
    role: string;
    createdAt: string;
  }> = [];

  for (const key of result.keys) {
    const raw = await env.AUTH_KV.get(key.name);
    if (!raw) continue;

    try {
      const record = JSON.parse(raw) as KVUserRecord;
      users.push({
        userId: record.userId,
        email: record.email,
        tier: record.tier,
        role: record.role || 'user',
        createdAt: record.createdAt,
      });
    } catch {
      // Skip malformed records
    }
  }

  return jsonResponse(200, {
    users,
    total: users.length,
    has_more: !result.list_complete,
    cursor: result.list_complete ? undefined : (result as unknown as { cursor?: string }).cursor,
  });
}

/**
 * GET /api/admin/users/:id — Get user details.
 */
export async function handleGetUser(
  env: AdminEnv,
  userId: string,
): Promise<Response> {
  const email = await env.AUTH_KV.get(`userid:${userId}`);
  if (!email) {
    return errorResponse(404, 'not_found', `User "${userId}" not found`);
  }

  const raw = await env.AUTH_KV.get(`user:${email}`);
  if (!raw) {
    return errorResponse(404, 'not_found', `User record not found`);
  }

  let record: KVUserRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to read user record');
  }

  return jsonResponse(200, {
    userId: record.userId,
    email: record.email,
    tier: record.tier,
    role: record.role || 'user',
    createdAt: record.createdAt,
  });
}

/**
 * POST /api/admin/users/:id/promote — Set role to admin.
 */
export async function handlePromoteUser(
  env: AdminEnv,
  userId: string,
): Promise<Response> {
  const email = await env.AUTH_KV.get(`userid:${userId}`);
  if (!email) {
    return errorResponse(404, 'not_found', `User "${userId}" not found`);
  }

  const raw = await env.AUTH_KV.get(`user:${email}`);
  if (!raw) {
    return errorResponse(404, 'not_found', `User record not found`);
  }

  let record: KVUserRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to read user record');
  }

  record.role = 'admin';
  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(record));

  return jsonResponse(200, {
    userId: record.userId,
    email: record.email,
    role: 'admin',
  });
}

/**
 * POST /api/admin/users/:id/demote — Set role back to user.
 */
export async function handleDemoteUser(
  env: AdminEnv,
  userId: string,
): Promise<Response> {
  const email = await env.AUTH_KV.get(`userid:${userId}`);
  if (!email) {
    return errorResponse(404, 'not_found', `User "${userId}" not found`);
  }

  const raw = await env.AUTH_KV.get(`user:${email}`);
  if (!raw) {
    return errorResponse(404, 'not_found', `User record not found`);
  }

  let record: KVUserRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to read user record');
  }

  record.role = 'user';
  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(record));

  return jsonResponse(200, {
    userId: record.userId,
    email: record.email,
    role: 'user',
  });
}
