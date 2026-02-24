/**
 * Mock Cloudflare Workers environment bindings for admin-server testing.
 *
 * Provides MockKVNamespace, mock AdminEnv, request helpers,
 * token generators, and user seeding utilities.
 */

import type { AdminEnv, KVUserRecord } from '../../types.js';
import { signToken } from '../../auth/jwt.js';

// ---------------------------------------------------------------------------
// Mock KV Namespace
// ---------------------------------------------------------------------------

export class MockKVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiration && Date.now() / 1000 > entry.expiration) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number },
  ): Promise<void> {
    const expiration = options?.expiration
      ? options.expiration
      : options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : undefined;
    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    const keys: { name: string }[] = [];
    for (const key of this.store.keys()) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        keys.push({ name: key });
      }
    }
    return { keys, list_complete: true };
  }

  /** Test helper: clear all entries */
  clear(): void {
    this.store.clear();
  }

  /** Test helper: get raw store size */
  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Default Test Constants
// ---------------------------------------------------------------------------

export const TEST_JWT_SECRET = 'test-secret-key-for-admin-server-testing-only-minimum-length';
export const TEST_JWT_ISSUER = 'saqr';
export const TEST_JWT_AUDIENCE = 'saqr-admin';

// ---------------------------------------------------------------------------
// Create Mock Admin Environment
// ---------------------------------------------------------------------------

export function createMockAdminEnv(overrides?: Partial<AdminEnv>): AdminEnv {
  return {
    AUTH_KV: new MockKVNamespace() as unknown as KVNamespace,
    REGISTRY_KV: new MockKVNamespace() as unknown as KVNamespace,
    JWT_SECRET: TEST_JWT_SECRET,
    JWT_ISSUER: TEST_JWT_ISSUER,
    JWT_AUDIENCE: TEST_JWT_AUDIENCE,
    ALLOWED_ORIGINS: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Request Helpers
// ---------------------------------------------------------------------------

export function createRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const url = `https://admin.test.dev${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

export function createAuthRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return createRequest(method, path, body, {
    Authorization: `Bearer ${token}`,
    ...headers,
  });
}

// ---------------------------------------------------------------------------
// Token Generators
// ---------------------------------------------------------------------------

/**
 * Generate a valid JWT for an admin user.
 */
export async function createAdminToken(
  overrides?: Partial<{
    sub: string;
    email: string;
    tier: string;
    role: string;
    iss: string;
    aud: string;
    iat: number;
    exp: number;
  }>,
): Promise<string> {
  const payload = {
    sub: 'usr_admin123',
    email: 'admin@saqr.dev',
    tier: 'free',
    role: 'admin',
    iss: TEST_JWT_ISSUER,
    aud: TEST_JWT_AUDIENCE,
    ...overrides,
  };
  return signToken(payload, TEST_JWT_SECRET);
}

/**
 * Generate a valid JWT for a non-admin (regular) user.
 */
export async function createUserToken(
  overrides?: Partial<{
    sub: string;
    email: string;
    tier: string;
    role: string;
    iss: string;
    aud: string;
    iat: number;
    exp: number;
  }>,
): Promise<string> {
  const payload = {
    sub: 'usr_user456',
    email: 'user@saqr.dev',
    tier: 'free',
    role: 'user',
    iss: TEST_JWT_ISSUER,
    aud: TEST_JWT_AUDIENCE,
    ...overrides,
  };
  return signToken(payload, TEST_JWT_SECRET);
}

// ---------------------------------------------------------------------------
// User Seeding Helpers
// ---------------------------------------------------------------------------

/**
 * Seed an admin user record in AUTH_KV.
 * Creates both the `user:{email}` and `userid:{userId}` keys.
 */
export async function seedAdminUser(
  env: AdminEnv,
  userId = 'usr_admin123',
  email = 'admin@saqr.dev',
): Promise<KVUserRecord> {
  const record: KVUserRecord = {
    userId,
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$fakesalt$fakehash',
    email,
    tier: 'free',
    createdAt: new Date().toISOString(),
    role: 'admin',
  };
  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(record));
  await env.AUTH_KV.put(`userid:${userId}`, email);
  return record;
}

/**
 * Seed a regular (non-admin) user record in AUTH_KV.
 * Creates both the `user:{email}` and `userid:{userId}` keys.
 */
export async function seedRegularUser(
  env: AdminEnv,
  userId = 'usr_user456',
  email = 'user@saqr.dev',
): Promise<KVUserRecord> {
  const record: KVUserRecord = {
    userId,
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$fakesalt$fakehash',
    email,
    tier: 'free',
    createdAt: new Date().toISOString(),
    role: 'user',
  };
  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(record));
  await env.AUTH_KV.put(`userid:${userId}`, email);
  return record;
}
