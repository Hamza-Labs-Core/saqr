/**
 * Utility functions for the sync server.
 */

import type { Env, Tier, TierLimits } from './types.js';

// ---------------------------------------------------------------------------
// ID Generation
// ---------------------------------------------------------------------------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a random alphanumeric ID.
 * Uses crypto.getRandomValues for secure randomness.
 */
export function generateId(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Time Helpers
// ---------------------------------------------------------------------------

/** Returns the current hour key in format "YYYY-MM-DDThh" */
export function currentMinuteKey(): string {
  const now = new Date();
  return now.toISOString().slice(0, 16); // "2026-02-22T10:30"
}

/** Returns seconds until the next minute boundary */
export function secondsUntilNextMinute(): number {
  const now = new Date();
  return 60 - now.getSeconds();
}

// ---------------------------------------------------------------------------
// Tier Configuration
// ---------------------------------------------------------------------------

export function getTierLimits(tier: Tier, env: Env): TierLimits {
  switch (tier) {
    case 'free':
      return {
        machineLimit: parseInt(env.FREE_TIER_MACHINES || '2'),
        storageBytes: parseInt(env.FREE_TIER_STORAGE_BYTES || '5242880'),
        retentionDays: parseInt(env.FREE_TIER_RETENTION_DAYS || '30'),
        ratePerMin: parseInt(env.FREE_TIER_RATE_PER_MIN || '60'),
      };
    case 'pro':
      return {
        machineLimit: parseInt(env.PRO_TIER_MACHINES || '5'),
        storageBytes: parseInt(env.PRO_TIER_STORAGE_BYTES || '524288000'),
        retentionDays: parseInt(env.PRO_TIER_RETENTION_DAYS || '365'),
        ratePerMin: parseInt(env.PRO_TIER_RATE_PER_MIN || '600'),
      };
    case 'team':
      return {
        machineLimit: parseInt(env.TEAM_TIER_MACHINES || '0'),
        storageBytes: parseInt(env.TEAM_TIER_STORAGE_BYTES || '5368709120'),
        retentionDays: parseInt(env.TEAM_TIER_RETENTION_DAYS || '0'),
        ratePerMin: parseInt(env.TEAM_TIER_RATE_PER_MIN || '6000'),
      };
    default:
      return {
        machineLimit: 2,
        storageBytes: 5242880,
        retentionDays: 30,
        ratePerMin: 60,
      };
  }
}

// ---------------------------------------------------------------------------
// Response Helpers
// ---------------------------------------------------------------------------

/** Create a JSON response with consistent Content-Type header */
export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

/** Create a standard error response */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse(status, { error, message, ...extra });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * Parse the ALLOWED_ORIGINS env var (comma-separated) into a Set.
 * Returns an empty set if the value is empty or undefined (deny all CORS).
 */
export function parseAllowedOrigins(env: Env): Set<string> {
  const raw = env.ALLOWED_ORIGINS;
  if (!raw || raw.trim() === '') return new Set();
  return new Set(
    raw.split(',').map(o => o.trim()).filter(o => o.length > 0),
  );
}

/**
 * Check whether the given origin is in the allowed list.
 * Returns the origin string if allowed, or null if not.
 */
export function isOriginAllowed(origin: string | null | undefined, allowedOrigins: Set<string>): string | null {
  if (!origin || allowedOrigins.size === 0) return null;
  return allowedOrigins.has(origin) ? origin : null;
}

/** Add CORS headers to a response. Only reflects the origin if it is in the allowed list. */
export function withCorsHeaders(response: Response, origin: string | null | undefined, env: Env): Response {
  const allowed = isOriginAllowed(origin, parseAllowedOrigins(env));
  const headers = new Headers(response.headers);

  if (allowed) {
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  // If origin is not allowed, do not set Allow-Origin or Allow-Credentials at all.

  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Machine-Id');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Handle CORS preflight. Only reflects the origin if it is in the allowed list. */
export function handleCorsPreFlight(request: Request, env: Env): Response {
  const origin = request.headers.get('Origin');
  const allowed = isOriginAllowed(origin, parseAllowedOrigins(env));

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Machine-Id',
    'Access-Control-Max-Age': '86400',
  };

  if (allowed) {
    headers['Access-Control-Allow-Origin'] = allowed;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return new Response(null, { status: 204, headers });
}

// ---------------------------------------------------------------------------
// Security Headers
// ---------------------------------------------------------------------------

/** Add security headers to a response */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate email format (simplified RFC 5322) */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email) && email.length <= 254;
}

/** Validate password requirements */
export function isValidPassword(password: string): boolean {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 12 && password.length <= 1024;
}

// ---------------------------------------------------------------------------
// Encoding Helpers
// ---------------------------------------------------------------------------

/** Convert base64 string to ArrayBuffer */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (!base64) return new ArrayBuffer(0);
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Convert ArrayBuffer to base64 string */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
