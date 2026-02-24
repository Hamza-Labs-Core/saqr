/**
 * Tests for Tier Enforcement Middleware
 *
 * Covers:
 * - Storage quota enforcement
 * - Device limit enforcement
 * - Feature access control
 */

import { describe, it, expect } from 'vitest';
import { checkStorageQuota, checkDeviceLimit, checkFeatureAccess } from '../middleware/tier-enforcement.js';
import { createMockEnv } from './helpers/mock-env.js';
import type { Env, Tier } from '../types.js';

describe('Tier Enforcement', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  // -----------------------------------------------------------------------
  // Storage Quota
  // -----------------------------------------------------------------------

  describe('checkStorageQuota', () => {
    it('should allow usage within free tier limit (5 MB)', () => {
      const result = checkStorageQuota(1000000, 500000, 'free', env);
      expect(result).toBeNull();
    });

    it('should reject usage exceeding free tier limit', () => {
      // Free tier = 5242880 bytes (5 MB)
      const result = checkStorageQuota(5000000, 500000, 'free', env);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(413);

      // Verify error body
      // We need to parse the response to check
    });

    it('should reject when incoming data pushes over the limit', () => {
      const result = checkStorageQuota(5242880, 1, 'free', env);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(413);
    });

    it('should allow usage within pro tier limit (500 MB)', () => {
      const result = checkStorageQuota(100000000, 50000000, 'pro', env);
      expect(result).toBeNull();
    });

    it('should reject usage exceeding pro tier limit', () => {
      // Pro tier = 524288000 bytes (500 MB)
      const result = checkStorageQuota(500000000, 50000000, 'pro', env);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(413);
    });

    it('should allow usage within team tier limit (5 GB)', () => {
      const result = checkStorageQuota(1000000000, 500000000, 'team', env);
      expect(result).toBeNull();
    });

    it('should allow zero usage', () => {
      const result = checkStorageQuota(0, 0, 'free', env);
      expect(result).toBeNull();
    });

    it('should include storage details in error response', async () => {
      const result = checkStorageQuota(5000000, 500000, 'free', env);
      expect(result).not.toBeNull();

      const body = await result!.json() as Record<string, unknown>;
      expect(body.error).toBe('storage_exceeded');
      expect(body.storage_used_bytes).toBe(5000000);
      expect(body.storage_quota_bytes).toBe(5242880);
      expect(body.incoming_bytes).toBe(500000);
    });
  });

  // -----------------------------------------------------------------------
  // Device Limits
  // -----------------------------------------------------------------------

  describe('checkDeviceLimit', () => {
    it('should allow free tier with 0 devices', () => {
      const result = checkDeviceLimit(0, 'free', env);
      expect(result).toBeNull();
    });

    it('should allow free tier with 1 device (limit is 2)', () => {
      const result = checkDeviceLimit(1, 'free', env);
      expect(result).toBeNull();
    });

    it('should reject free tier at device limit (2)', () => {
      const result = checkDeviceLimit(2, 'free', env);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('should reject free tier above device limit', () => {
      const result = checkDeviceLimit(5, 'free', env);
      expect(result).not.toBeNull();
    });

    it('should allow pro tier with 4 devices (limit is 5)', () => {
      const result = checkDeviceLimit(4, 'pro', env);
      expect(result).toBeNull();
    });

    it('should reject pro tier at device limit (5)', () => {
      const result = checkDeviceLimit(5, 'pro', env);
      expect(result).not.toBeNull();
    });

    it('should allow team tier with unlimited devices (limit 0 = unlimited)', () => {
      const result = checkDeviceLimit(100, 'team', env);
      expect(result).toBeNull();
    });

    it('should include device details in error response', async () => {
      const result = checkDeviceLimit(2, 'free', env);
      expect(result).not.toBeNull();

      const body = await result!.json() as Record<string, unknown>;
      expect(body.error).toBe('device_limit');
      expect(body.current_devices).toBe(2);
      expect(body.max_devices).toBe(2);
      expect(body.tier).toBe('free');
    });
  });

  // -----------------------------------------------------------------------
  // Feature Access
  // -----------------------------------------------------------------------

  describe('checkFeatureAccess', () => {
    it('should block WebSocket streaming for free tier', () => {
      const result = checkFeatureAccess('websocket_stream', 'free');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('should allow WebSocket streaming for pro tier', () => {
      const result = checkFeatureAccess('websocket_stream', 'pro');
      expect(result).toBeNull();
    });

    it('should allow WebSocket streaming for team tier', () => {
      const result = checkFeatureAccess('websocket_stream', 'team');
      expect(result).toBeNull();
    });

    it('should allow unknown features (no restriction)', () => {
      const result = checkFeatureAccess('unknown_feature', 'free');
      expect(result).toBeNull();
    });

    it('should include feature details in error response', async () => {
      const result = checkFeatureAccess('websocket_stream', 'free');
      expect(result).not.toBeNull();

      const body = await result!.json() as Record<string, unknown>;
      expect(body.error).toBe('tier_restricted');
      expect(body.feature).toBe('websocket_stream');
      expect(body.required_tier).toBe('pro');
    });
  });
});
