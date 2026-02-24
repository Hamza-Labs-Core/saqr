/**
 * Rate Limiter Middleware
 *
 * Per-tier rate limiting using KV counters.
 * Free: 60/min, Pro: 600/min, Team: 6000/min
 */

import type { Env, AuthContext } from '../types.js';
import { getTierLimits, currentMinuteKey, secondsUntilNextMinute, errorResponse } from '../helpers.js';

/**
 * Check rate limit for the given auth context.
 * Returns a 429 response if rate limit exceeded, null if OK.
 */
export async function checkRateLimit(
  env: Env,
  authCtx: AuthContext,
): Promise<Response | null> {
  const limits = getTierLimits(authCtx.tier, env);
  const rateLimit = limits.ratePerMin;

  // 0 means unlimited (shouldn't happen, but just in case)
  if (rateLimit <= 0) return null;

  const minuteKey = currentMinuteKey();
  const kvKey = `ratelimit:${authCtx.userId}:${minuteKey}`;

  try {
    const countStr = await env.AUTH_KV.get(kvKey);
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count >= rateLimit) {
      const retryAfter = secondsUntilNextMinute();
      return errorResponse(
        429,
        'rate_limited',
        `Rate limit exceeded (${rateLimit}/min for ${authCtx.tier} tier). Try again in ${retryAfter}s.`,
        {
          retry_after: retryAfter,
          limit: rateLimit,
          tier: authCtx.tier,
        },
      );
    }

    // Increment counter with 2-minute TTL
    await env.AUTH_KV.put(kvKey, String(count + 1), { expirationTtl: 120 });
  } catch {
    // Fail open: if KV is unavailable, allow the request
    return null;
  }

  return null;
}
