/**
 * Tier Enforcement Middleware
 *
 * Checks storage quotas, device limits, and feature access
 * based on the user's subscription tier.
 */

import type { Env, AuthContext, Tier, TierLimits } from '../types.js';
import { getTierLimits, errorResponse } from '../helpers.js';

/**
 * Check if a user has exceeded their storage quota.
 *
 * @param currentUsageBytes - Current storage usage in bytes
 * @param incomingBytes - Size of incoming data in bytes
 * @param tier - User's subscription tier
 * @param env - Worker environment
 * @returns Error response if quota exceeded, null if OK
 */
export function checkStorageQuota(
  currentUsageBytes: number,
  incomingBytes: number,
  tier: Tier,
  env: Env,
): Response | null {
  const limits = getTierLimits(tier, env);
  const quotaBytes = limits.storageBytes;

  // 0 means unlimited
  if (quotaBytes <= 0) return null;

  if (currentUsageBytes + incomingBytes > quotaBytes) {
    return errorResponse(
      413,
      'storage_exceeded',
      `Storage quota exceeded. ${tier} tier allows ${formatQuota(quotaBytes)}. ` +
        `Current usage: ${formatQuota(currentUsageBytes)}.`,
      {
        storage_used_bytes: currentUsageBytes,
        storage_quota_bytes: quotaBytes,
        incoming_bytes: incomingBytes,
        tier,
      },
    );
  }

  return null;
}

/**
 * Check if a user has exceeded their device/machine limit.
 *
 * @param currentMachineCount - Number of currently registered machines
 * @param tier - User's subscription tier
 * @param env - Worker environment
 * @returns Error response if limit exceeded, null if OK
 */
export function checkDeviceLimit(
  currentMachineCount: number,
  tier: Tier,
  env: Env,
): Response | null {
  const limits = getTierLimits(tier, env);
  const machineLimit = limits.machineLimit;

  // 0 means unlimited
  if (machineLimit <= 0) return null;

  if (currentMachineCount >= machineLimit) {
    return errorResponse(
      403,
      'device_limit',
      `Device limit reached. ${tier} tier allows ${machineLimit} devices. ` +
        `Remove a device before adding a new one.`,
      {
        current_devices: currentMachineCount,
        max_devices: machineLimit,
        tier,
      },
    );
  }

  return null;
}

/**
 * Check if a feature is available for the user's tier.
 * Currently used for WebSocket streaming (Pro+ only).
 *
 * @param feature - Feature name to check
 * @param tier - User's subscription tier
 * @returns Error response if feature not available, null if OK
 */
export function checkFeatureAccess(
  feature: string,
  tier: Tier,
): Response | null {
  switch (feature) {
    case 'websocket_stream':
      if (tier === 'free') {
        return errorResponse(
          403,
          'tier_restricted',
          'Real-time sync requires Pro or Team tier. Free tier uses polling only.',
          { feature, tier, required_tier: 'pro' },
        );
      }
      return null;

    default:
      return null;
  }
}

/**
 * Get retention days for a given tier.
 */
export function getRetentionDays(tier: Tier, env: Env): number {
  const limits = getTierLimits(tier, env);
  return limits.retentionDays;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatQuota(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
