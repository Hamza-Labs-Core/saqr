/**
 * Tests for Device Code Flow — RFC 8628 endpoints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleDeviceCode,
  handleDevicePoll,
  handleDeviceApprove,
  handleRefreshToken,
} from './device-code.js';
import type { Env } from '../types.js';

// ---------------------------------------------------------------------------
// Mock KV
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, expiration: opts?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function createMockEnv(overrides?: Partial<Env>): Env {
  return {
    AUTH_KV: createMockKV(),
    REGISTRY_KV: createMockKV(),
    JWT_SECRET: 'test-secret-key-for-jwt-testing-only',
    JWT_ISSUER: 'saqr',
    JWT_AUDIENCE: 'saqr-sync',
    ALLOWED_ORIGINS: '',
    WEBSITE_URL: 'https://saqr.dev',
    USER_SYNC: {} as any,
    SYNC_BUCKET: {} as any,
    FREE_TIER_STORAGE_BYTES: '5242880',
    PRO_TIER_STORAGE_BYTES: '524288000',
    TEAM_TIER_STORAGE_BYTES: '5368709120',
    FREE_TIER_MACHINES: '2',
    PRO_TIER_MACHINES: '5',
    TEAM_TIER_MACHINES: '0',
    FREE_TIER_RATE_PER_MIN: '60',
    PRO_TIER_RATE_PER_MIN: '600',
    TEAM_TIER_RATE_PER_MIN: '6000',
    FREE_TIER_RETENTION_DAYS: '30',
    PRO_TIER_RETENTION_DAYS: '365',
    TEAM_TIER_RETENTION_DAYS: '0',
    ...overrides,
  } as Env;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleDeviceCode', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns a device code and user code', async () => {
    const req = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {
      client_id: 'cli',
    });

    const res = await handleDeviceCode(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.device_code).toBeDefined();
    expect(body.device_code.length).toBe(32);
    expect(body.verification_uri).toBe('https://saqr.dev/auth/device');
    expect(body.verification_uri_complete).toContain(body.user_code);
    expect(body.expires_in).toBe(900);
    expect(body.interval).toBe(5);
  });

  it('stores device code in KV', async () => {
    const req = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {
      client_id: 'desktop',
      scope: ['sync', 'remote'],
    });

    await handleDeviceCode(req, env);

    // Both device: and usercode: keys should be stored
    expect(env.AUTH_KV.put).toHaveBeenCalledTimes(2);
    const calls = (env.AUTH_KV.put as any).mock.calls;
    expect(calls[0][0]).toMatch(/^device:/);
    expect(calls[1][0]).toMatch(/^usercode:/);
  });

  it('rejects missing client_id', async () => {
    const req = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {});
    const res = await handleDeviceCode(req, env);
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('https://sync.saqr.dev/api/auth/device-code', {
      method: 'POST',
      body: 'not json',
    });
    const res = await handleDeviceCode(req, env);
    expect(res.status).toBe(400);
  });
});

describe('handleDevicePoll', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns authorization_pending when not yet approved', async () => {
    // First initiate a device code
    const initReq = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {
      client_id: 'cli',
    });
    const initRes = await handleDeviceCode(initReq, env);
    const initBody = await initRes.json() as any;

    // Poll for it
    const pollReq = jsonRequest('https://sync.saqr.dev/api/auth/device-poll', {
      device_code: initBody.device_code,
      client_id: 'cli',
    });
    const pollRes = await handleDevicePoll(pollReq, env);
    expect(pollRes.status).toBe(400);

    const pollBody = await pollRes.json() as any;
    expect(pollBody.error).toBe('authorization_pending');
  });

  it('returns tokens after approval', async () => {
    // Initiate
    const initReq = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {
      client_id: 'cli',
    });
    const initRes = await handleDeviceCode(initReq, env);
    const initBody = await initRes.json() as any;

    // Approve (simulating an authenticated user)
    const approveReq = jsonRequest('https://sync.saqr.dev/api/auth/device-approve', {
      user_code: initBody.user_code,
      action: 'approve',
    });
    await handleDeviceApprove(approveReq, env, 'usr_123', 'test@example.com', 'free', 'user');

    // Poll again — should get tokens
    const pollReq = jsonRequest('https://sync.saqr.dev/api/auth/device-poll', {
      device_code: initBody.device_code,
      client_id: 'cli',
    });
    const pollRes = await handleDevicePoll(pollReq, env);
    expect(pollRes.status).toBe(200);

    const pollBody = await pollRes.json() as any;
    expect(pollBody.access_token).toBeDefined();
    expect(pollBody.refresh_token).toBeDefined();
    expect(pollBody.token_type).toBe('Bearer');
    expect(pollBody.expires_in).toBe(3600);
  });

  it('returns access_denied when denied', async () => {
    // Initiate
    const initReq = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {
      client_id: 'cli',
    });
    const initRes = await handleDeviceCode(initReq, env);
    const initBody = await initRes.json() as any;

    // Deny
    const denyReq = jsonRequest('https://sync.saqr.dev/api/auth/device-approve', {
      user_code: initBody.user_code,
      action: 'deny',
    });
    await handleDeviceApprove(denyReq, env, 'usr_123', 'test@example.com', 'free', 'user');

    // Poll — should get denied
    const pollReq = jsonRequest('https://sync.saqr.dev/api/auth/device-poll', {
      device_code: initBody.device_code,
      client_id: 'cli',
    });
    const pollRes = await handleDevicePoll(pollReq, env);
    expect(pollRes.status).toBe(400);

    const pollBody = await pollRes.json() as any;
    expect(pollBody.error).toBe('access_denied');
  });

  it('rejects wrong client_id', async () => {
    const initReq = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {
      client_id: 'cli',
    });
    const initRes = await handleDeviceCode(initReq, env);
    const initBody = await initRes.json() as any;

    const pollReq = jsonRequest('https://sync.saqr.dev/api/auth/device-poll', {
      device_code: initBody.device_code,
      client_id: 'wrong_client',
    });
    const pollRes = await handleDevicePoll(pollReq, env);
    expect(pollRes.status).toBe(400);
  });

  it('returns expired_token for unknown device code', async () => {
    const pollReq = jsonRequest('https://sync.saqr.dev/api/auth/device-poll', {
      device_code: 'nonexistent',
      client_id: 'cli',
    });
    const res = await handleDevicePoll(pollReq, env);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('expired_token');
  });
});

describe('handleDeviceApprove', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('rejects invalid user_code', async () => {
    const req = jsonRequest('https://sync.saqr.dev/api/auth/device-approve', {
      user_code: 'XXXX-YYYY',
      action: 'approve',
    });
    const res = await handleDeviceApprove(req, env, 'usr_123', 'test@example.com', 'free', 'user');
    expect(res.status).toBe(404);
  });

  it('rejects double approval', async () => {
    // Initiate
    const initReq = jsonRequest('https://sync.saqr.dev/api/auth/device-code', {
      client_id: 'cli',
    });
    const initRes = await handleDeviceCode(initReq, env);
    const initBody = await initRes.json() as any;

    // First approval
    const approveReq1 = jsonRequest('https://sync.saqr.dev/api/auth/device-approve', {
      user_code: initBody.user_code,
      action: 'approve',
    });
    const res1 = await handleDeviceApprove(approveReq1, env, 'usr_123', 'test@example.com', 'free', 'user');
    expect(res1.status).toBe(200);

    // Second approval should fail
    const approveReq2 = jsonRequest('https://sync.saqr.dev/api/auth/device-approve', {
      user_code: initBody.user_code,
      action: 'approve',
    });
    const res2 = await handleDeviceApprove(approveReq2, env, 'usr_123', 'test@example.com', 'free', 'user');
    expect(res2.status).toBe(409);
  });
});

describe('handleRefreshToken', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('rejects invalid refresh token', async () => {
    const req = jsonRequest('https://sync.saqr.dev/api/auth/refresh', {
      refresh_token: 'invalid_token',
    });
    const res = await handleRefreshToken(req, env);
    expect(res.status).toBe(401);
  });

  it('issues new access token with valid refresh token', async () => {
    // Set up a valid refresh token and user record
    const refreshData = {
      userId: 'usr_test1',
      email: 'test@example.com',
      tier: 'free',
      role: 'user',
    };
    await env.AUTH_KV.put('refresh:srt_validtoken', JSON.stringify(refreshData));

    const userRecord = {
      userId: 'usr_test1',
      passwordHash: 'fakehash',
      email: 'test@example.com',
      tier: 'free',
      createdAt: new Date().toISOString(),
      role: 'user',
    };
    await env.AUTH_KV.put('user:test@example.com', JSON.stringify(userRecord));

    const req = jsonRequest('https://sync.saqr.dev/api/auth/refresh', {
      refresh_token: 'srt_validtoken',
    });
    const res = await handleRefreshToken(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.access_token).toBeDefined();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
  });

  it('rejects refresh if user no longer exists', async () => {
    const refreshData = {
      userId: 'usr_deleted',
      email: 'deleted@example.com',
      tier: 'free',
      role: 'user',
    };
    await env.AUTH_KV.put('refresh:srt_deleteduser', JSON.stringify(refreshData));
    // No user record in KV

    const req = jsonRequest('https://sync.saqr.dev/api/auth/refresh', {
      refresh_token: 'srt_deleteduser',
    });
    const res = await handleRefreshToken(req, env);
    expect(res.status).toBe(401);
  });
});
