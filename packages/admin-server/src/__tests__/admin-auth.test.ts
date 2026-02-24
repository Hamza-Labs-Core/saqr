/**
 * Tests for admin authentication — JWT verification + admin role check.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { authenticateAdmin } from '../auth/admin-auth.js';
import { signToken } from '../auth/jwt.js';
import type { AdminEnv } from '../types.js';
import {
  createMockAdminEnv,
  createAuthRequest,
  createRequest,
  createAdminToken,
  createUserToken,
  seedAdminUser,
  seedRegularUser,
  TEST_JWT_SECRET,
  TEST_JWT_ISSUER,
  TEST_JWT_AUDIENCE,
} from './helpers/mock-env.js';

describe('authenticateAdmin', () => {
  let env: AdminEnv;

  beforeEach(() => {
    env = createMockAdminEnv();
  });

  it('should return authCtx for a valid admin JWT', async () => {
    await seedAdminUser(env);
    const token = await createAdminToken();
    const request = createAuthRequest('GET', '/api/admin/users', token);

    const result = await authenticateAdmin(request, env);

    expect('authCtx' in result).toBe(true);
    if ('authCtx' in result) {
      expect(result.authCtx.userId).toBe('usr_admin123');
      expect(result.authCtx.email).toBe('admin@saqr.dev');
      expect(result.authCtx.role).toBe('admin');
    }
  });

  it('should return 403 for a valid JWT with non-admin role', async () => {
    await seedRegularUser(env);
    const token = await createUserToken();
    const request = createAuthRequest('GET', '/api/admin/users', token);

    const result = await authenticateAdmin(request, env);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(403);
      const body = await result.error.json() as { error: string; message: string };
      expect(body.error).toBe('forbidden');
      expect(body.message).toBe('Admin role required');
    }
  });

  it('should return 401 when Authorization header is missing', async () => {
    const request = createRequest('GET', '/api/admin/users');

    const result = await authenticateAdmin(request, env);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
      const body = await result.error.json() as { error: string };
      expect(body.error).toBe('missing_token');
    }
  });

  it('should return 401 for an expired JWT', async () => {
    await seedAdminUser(env);
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      {
        sub: 'usr_admin123',
        email: 'admin@saqr.dev',
        tier: 'free',
        role: 'admin',
        iss: TEST_JWT_ISSUER,
        aud: TEST_JWT_AUDIENCE,
        iat: now - 7200,
        exp: now - 3600, // expired 1 hour ago
      },
      TEST_JWT_SECRET,
    );
    const request = createAuthRequest('GET', '/api/admin/users', token);

    const result = await authenticateAdmin(request, env);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
      const body = await result.error.json() as { error: string; message: string };
      expect(body.error).toBe('invalid_token');
      expect(body.message).toContain('expired');
    }
  });

  it('should return 401 for an invalid/malformed JWT', async () => {
    const request = createAuthRequest('GET', '/api/admin/users', 'not-a-valid-jwt');

    const result = await authenticateAdmin(request, env);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
      const body = await result.error.json() as { error: string };
      expect(body.error).toBe('invalid_token');
    }
  });

  it('should return 403 when admin role was revoked in KV', async () => {
    // Seed as admin first, then change to regular user
    await seedAdminUser(env);
    // Create token while user is admin
    const token = await createAdminToken();

    // Now revoke admin role in KV (simulate demotion)
    const email = 'admin@saqr.dev';
    const rawRecord = await env.AUTH_KV.get(`user:${email}`);
    expect(rawRecord).not.toBeNull();
    const record = JSON.parse(rawRecord!);
    record.role = 'user';
    await env.AUTH_KV.put(`user:${email}`, JSON.stringify(record));

    const request = createAuthRequest('GET', '/api/admin/users', token);

    const result = await authenticateAdmin(request, env);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(403);
      const body = await result.error.json() as { error: string; message: string };
      expect(body.error).toBe('forbidden');
      expect(body.message).toBe('Admin role required');
    }
  });
});
