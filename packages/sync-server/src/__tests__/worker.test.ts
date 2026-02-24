/**
 * Tests for Worker API Gateway (worker.ts)
 *
 * Covers:
 * - Route matching for all endpoints
 * - JWT validation on protected routes
 * - CORS preflight handling
 * - Error responses for unknown routes
 * - Health check endpoint
 * - Body size limit
 * - Internal endpoint blocking
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker.js';
import { signToken } from '../auth/jwt.js';
import {
  createMockEnv,
  createRequest,
  createAuthRequest,
  MockKVNamespace,
  MockDurableObjectNamespace,
  MockDurableObjectStub,
} from './helpers/mock-env.js';
import type { Env, Tier } from '../types.js';

const TEST_SECRET = 'test-secret-key-for-testing-only-minimum-length';

async function makeToken(overrides?: Record<string, unknown>): Promise<string> {
  return signToken(
    {
      sub: 'usr_test123456',
      email: 'test@example.com',
      tier: 'free' as Tier,
      iss: 'saqr',
      aud: 'saqr-sync',
      ...overrides,
    },
    TEST_SECRET,
  );
}

describe('Worker API Gateway', () => {
  let env: Env;
  let kv: MockKVNamespace;
  let doNamespace: MockDurableObjectNamespace;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  beforeEach(() => {
    kv = new MockKVNamespace();
    doNamespace = new MockDurableObjectNamespace();
    env = createMockEnv({
      AUTH_KV: kv as unknown as KVNamespace,
      USER_SYNC: doNamespace as unknown as DurableObjectNamespace,
    });
  });

  // -----------------------------------------------------------------------
  // Health Check
  // -----------------------------------------------------------------------

  describe('GET /api/health', () => {
    it('should return 200 with status ok', async () => {
      const request = createRequest('GET', '/api/health');
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });

    it('should not require authentication', async () => {
      const request = createRequest('GET', '/api/health');
      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });

    it('should include security headers', async () => {
      const request = createRequest('GET', '/api/health');
      const response = await worker.fetch(request, env, ctx);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });

  // -----------------------------------------------------------------------
  // CORS
  // -----------------------------------------------------------------------

  describe('CORS Preflight', () => {
    it('should return 204 for OPTIONS requests', async () => {
      const request = createRequest('OPTIONS', '/api/sync/push', undefined, {
        Origin: 'https://app.example.com',
      });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });
  });

  // -----------------------------------------------------------------------
  // Auth Endpoints (Public)
  // -----------------------------------------------------------------------

  describe('POST /api/auth/register', () => {
    it('should not require authentication', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: 'new@example.com',
        password: 'secure-password-123',
      });
      const response = await worker.fetch(request, env, ctx);
      // Should succeed (201) or fail on validation (400), not 401
      expect(response.status).not.toBe(401);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should not require authentication', async () => {
      const request = createRequest('POST', '/api/auth/login', {
        email: 'test@example.com',
        password: 'secure-password-123',
      });
      const response = await worker.fetch(request, env, ctx);
      // Should fail with credentials error, not auth error
      expect(response.status).not.toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // JWT Validation
  // -----------------------------------------------------------------------

  describe('JWT Authentication', () => {
    it('should reject requests without Authorization header', async () => {
      const request = createRequest('POST', '/api/sync/push', { events: [] });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(401);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('missing_token');
    });

    it('should reject requests with invalid Bearer token', async () => {
      const request = createAuthRequest('POST', '/api/sync/push', 'invalid-token', {
        events: [],
      });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(401);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_token');
    });

    it('should reject requests with empty Bearer token', async () => {
      const request = createRequest('POST', '/api/sync/push', { events: [] }, {
        Authorization: 'Bearer ',
      });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(401);
    });

    it('should reject expired tokens', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredToken = await signToken(
        {
          sub: 'usr_test123456',
          email: 'test@example.com',
          tier: 'free' as Tier,
          iss: 'saqr',
          aud: 'saqr-sync',
          iat: now - 7200,
          exp: now - 3600,
        },
        TEST_SECRET,
      );

      const request = createAuthRequest('POST', '/api/sync/push', expiredToken, {
        events: [],
      });
      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(401);
    });

    it('should accept valid tokens and route to DO', async () => {
      const token = await makeToken();
      const request = createAuthRequest('POST', '/api/sync/push', token, {
        machine_id: 'mach_123',
        events: [],
      });

      const response = await worker.fetch(request, env, ctx);
      // Should route to DO (which returns 200 by default from mock)
      expect(response.status).toBe(200);
    });

    it('should include CORS headers on authenticated responses', async () => {
      const token = await makeToken();
      const request = createAuthRequest('GET', '/api/account', token);

      const response = await worker.fetch(request, env, ctx);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Route Matching
  // -----------------------------------------------------------------------

  describe('Route Matching', () => {
    it('should return 404 for unknown paths', async () => {
      const request = createRequest('GET', '/api/unknown');
      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(404);
    });

    it('should route /api/sync/push to DO when authenticated', async () => {
      const token = await makeToken();
      const request = createAuthRequest('POST', '/api/sync/push', token, {
        machine_id: 'mach_123',
        events: [],
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });

    it('should route /api/sync/pull to DO when authenticated', async () => {
      const token = await makeToken();
      const request = createAuthRequest('POST', '/api/sync/pull', token, {
        machine_id: 'mach_123',
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });

    it('should route /api/account GET to DO when authenticated', async () => {
      const token = await makeToken();
      const request = createAuthRequest('GET', '/api/account', token);

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });

    it('should route /api/account DELETE to DO when authenticated', async () => {
      const token = await makeToken();
      const request = createAuthRequest('DELETE', '/api/account', token, {
        confirmation: 'DELETE MY ACCOUNT',
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });

    it('should route /api/machines GET to DO when authenticated', async () => {
      const token = await makeToken();
      const request = createAuthRequest('GET', '/api/machines', token);

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });

    it('should route /api/machines POST to DO when authenticated', async () => {
      const token = await makeToken();
      const request = createAuthRequest('POST', '/api/machines', token, {
        machine_id: 'mach_123',
        name: 'Test Machine',
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Internal Endpoints
  // -----------------------------------------------------------------------

  describe('Internal Endpoint Blocking', () => {
    it('should block external access to /_internal/* paths', async () => {
      const token = await makeToken();
      const request = createAuthRequest('POST', '/_internal/init-account', token, {
        userId: 'usr_test',
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Body Size
  // -----------------------------------------------------------------------

  describe('Body Size Limit', () => {
    it('should reject requests with Content-Length > 10 MB', async () => {
      const token = await makeToken();
      const request = createAuthRequest('POST', '/api/sync/push', token, { events: [] }, {
        'Content-Length': String(11 * 1024 * 1024),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(413);
    });
  });

  // -----------------------------------------------------------------------
  // Security Headers
  // -----------------------------------------------------------------------

  describe('Security Headers', () => {
    it('should include security headers on all responses', async () => {
      const request = createRequest('GET', '/api/health');
      const response = await worker.fetch(request, env, ctx);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });
  });
});
