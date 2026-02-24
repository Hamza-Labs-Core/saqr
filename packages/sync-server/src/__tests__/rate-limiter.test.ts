/**
 * Tests for Rate Limiter Middleware
 *
 * Covers:
 * - Rate limit enforcement
 * - Tier-based limits
 * - Counter increment
 * - KV failure (fail-open)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit } from '../middleware/rate-limiter.js';
import { createMockEnv, MockKVNamespace, createMockAuthCtx } from './helpers/mock-env.js';
import type { Env, AuthContext } from '../types.js';
import { currentMinuteKey } from '../helpers.js';

describe('Rate Limiter', () => {
  let env: Env;
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = new MockKVNamespace();
    env = createMockEnv({
      AUTH_KV: kv as unknown as KVNamespace,
    });
  });

  it('should allow requests within rate limit', async () => {
    const authCtx = createMockAuthCtx({ tier: 'free' });
    const result = await checkRateLimit(env, authCtx);
    expect(result).toBeNull(); // null means allowed
  });

  it('should reject requests when rate limit exceeded (free tier)', async () => {
    const authCtx = createMockAuthCtx({ tier: 'free', userId: 'usr_ratelimited' });
    const minuteKey = currentMinuteKey();
    const kvKey = `ratelimit:usr_ratelimited:${minuteKey}`;

    // Set counter to the limit (60 for free tier)
    await kv.put(kvKey, '60');

    const result = await checkRateLimit(env, authCtx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);

    const body = await result!.json() as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after).toBeDefined();
    expect(body.tier).toBe('free');
  });

  it('should allow pro tier with higher limit', async () => {
    const authCtx = createMockAuthCtx({ tier: 'pro', userId: 'usr_protier' });
    const minuteKey = currentMinuteKey();
    const kvKey = `ratelimit:usr_protier:${minuteKey}`;

    // Set counter to 100 (below pro limit of 600)
    await kv.put(kvKey, '100');

    const result = await checkRateLimit(env, authCtx);
    expect(result).toBeNull();
  });

  it('should reject pro tier when limit exceeded', async () => {
    const authCtx = createMockAuthCtx({ tier: 'pro', userId: 'usr_protier' });
    const minuteKey = currentMinuteKey();
    const kvKey = `ratelimit:usr_protier:${minuteKey}`;

    await kv.put(kvKey, '600');

    const result = await checkRateLimit(env, authCtx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it('should allow team tier with highest limit', async () => {
    const authCtx = createMockAuthCtx({ tier: 'team', userId: 'usr_teamtier' });
    const minuteKey = currentMinuteKey();
    const kvKey = `ratelimit:usr_teamtier:${minuteKey}`;

    // Set counter to 5000 (below team limit of 6000)
    await kv.put(kvKey, '5000');

    const result = await checkRateLimit(env, authCtx);
    expect(result).toBeNull();
  });

  it('should increment counter on each allowed request', async () => {
    const authCtx = createMockAuthCtx({ tier: 'free', userId: 'usr_counter' });

    // First request
    await checkRateLimit(env, authCtx);

    const minuteKey = currentMinuteKey();
    const kvKey = `ratelimit:usr_counter:${minuteKey}`;
    const count = await kv.get(kvKey);
    expect(count).toBe('1');

    // Second request
    await checkRateLimit(env, authCtx);
    const count2 = await kv.get(kvKey);
    expect(count2).toBe('2');
  });

  it('should fail open when KV is unavailable', async () => {
    // Create env with a broken KV
    const brokenKV = {
      get: async () => { throw new Error('KV unavailable'); },
      put: async () => { throw new Error('KV unavailable'); },
      delete: async () => { throw new Error('KV unavailable'); },
    } as unknown as KVNamespace;

    const brokenEnv = createMockEnv({
      AUTH_KV: brokenKV,
    });

    const authCtx = createMockAuthCtx({ tier: 'free' });
    const result = await checkRateLimit(brokenEnv, authCtx);
    // Should fail open (allow the request)
    expect(result).toBeNull();
  });
});
