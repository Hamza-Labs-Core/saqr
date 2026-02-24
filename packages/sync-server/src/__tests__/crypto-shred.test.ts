/**
 * Tests for Crypto-Shredding (account/crypto-shred.ts)
 *
 * Covers:
 * - Account deletion removes KV entries
 * - Account deletion removes R2 objects
 * - Best-effort behavior on failures
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { deleteAccount } from '../account/crypto-shred.js';
import { createMockEnv, MockKVNamespace, MockR2Bucket } from './helpers/mock-env.js';
import type { Env } from '../types.js';

describe('Crypto-Shredding', () => {
  let env: Env;
  let kv: MockKVNamespace;
  let r2: MockR2Bucket;

  beforeEach(() => {
    kv = new MockKVNamespace();
    r2 = new MockR2Bucket();
    env = createMockEnv({
      AUTH_KV: kv as unknown as KVNamespace,
      SYNC_BUCKET: r2 as unknown as R2Bucket,
    });
  });

  it('should delete user KV entries', async () => {
    // Setup KV entries
    await kv.put('user:test@example.com', JSON.stringify({ userId: 'usr_test123' }));
    await kv.put('userid:usr_test123', 'test@example.com');
    expect(kv.size).toBe(2);

    const result = await deleteAccount('usr_test123', 'test@example.com', env);

    expect(result.deleted).toBe(true);
    expect(result.kvEntriesDeleted).toBe(2);

    // Verify KV entries are gone
    const userRecord = await kv.get('user:test@example.com');
    expect(userRecord).toBeNull();

    const userId = await kv.get('userid:usr_test123');
    expect(userId).toBeNull();
  });

  it('should delete R2 objects under user prefix', async () => {
    // Setup R2 objects
    await r2.put('users/usr_test123/events/mach_01/proj_a/sess_1/000001.enc', 'data1');
    await r2.put('users/usr_test123/events/mach_01/proj_a/sess_1/000002.enc', 'data2');
    await r2.put('users/usr_other/events/mach_02/proj_b/sess_2/000001.enc', 'other-data');
    expect(r2.size).toBe(3);

    const result = await deleteAccount('usr_test123', 'test@example.com', env);

    expect(result.deleted).toBe(true);

    // User's objects should be deleted
    const obj1 = await r2.get('users/usr_test123/events/mach_01/proj_a/sess_1/000001.enc');
    expect(obj1).toBeNull();
    const obj2 = await r2.get('users/usr_test123/events/mach_01/proj_a/sess_1/000002.enc');
    expect(obj2).toBeNull();

    // Other user's objects should remain
    const otherObj = await r2.get('users/usr_other/events/mach_02/proj_b/sess_2/000001.enc');
    expect(otherObj).not.toBeNull();
  });

  it('should return deletion ID', async () => {
    const result = await deleteAccount('usr_test123', 'test@example.com', env);
    expect(result.deletionId).toBeDefined();
    expect(result.deletionId.startsWith('del_')).toBe(true);
  });

  it('should return descriptive message', async () => {
    const result = await deleteAccount('usr_test123', 'test@example.com', env);
    expect(result.message).toContain('permanently destroyed');
  });

  it('should succeed even when KV entries do not exist', async () => {
    // No entries in KV
    const result = await deleteAccount('usr_nonexistent', 'nobody@example.com', env);
    expect(result.deleted).toBe(true);
  });

  it('should succeed even when R2 is empty', async () => {
    const result = await deleteAccount('usr_test123', 'test@example.com', env);
    expect(result.deleted).toBe(true);
  });

  it('should handle KV errors gracefully (best effort)', async () => {
    const brokenKV = {
      get: async () => { throw new Error('KV error'); },
      put: async () => { throw new Error('KV error'); },
      delete: async () => { throw new Error('KV error'); },
    } as unknown as KVNamespace;

    const brokenEnv = createMockEnv({
      AUTH_KV: brokenKV,
      SYNC_BUCKET: r2 as unknown as R2Bucket,
    });

    // Should not throw, just best-effort
    const result = await deleteAccount('usr_test123', 'test@example.com', brokenEnv);
    expect(result.deleted).toBe(true);
  });
});
