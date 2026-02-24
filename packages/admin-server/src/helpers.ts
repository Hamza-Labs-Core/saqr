/**
 * Utility functions for the admin server.
 * Copied from sync-server with admin-specific adjustments.
 */

import type { AdminEnv } from './types.js';

// ---------------------------------------------------------------------------
// Response Helpers
// ---------------------------------------------------------------------------

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

export function errorResponse(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse(status, { error, message, ...extra });
}

/**
 * Check request body size, enforcing the limit even without Content-Length.
 * Uses request.clone() for streaming checks so the original body remains consumable.
 * Returns an error Response if over the limit, or null if OK.
 */
export async function checkBodySize(
  request: Request,
  maxBytes: number,
): Promise<Response | null> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength) > maxBytes) {
    return errorResponse(413, 'payload_too_large', `Request body exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
  }

  if (!contentLength && request.body) {
    const clone = request.clone();
    const reader = clone.body!.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel();
        return errorResponse(413, 'payload_too_large', `Request body exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export function parseAllowedOrigins(env: AdminEnv): Set<string> {
  const raw = env.ALLOWED_ORIGINS;
  if (!raw || raw.trim() === '') return new Set();
  return new Set(
    raw.split(',').map(o => o.trim()).filter(o => o.length > 0),
  );
}

export function isOriginAllowed(origin: string | null | undefined, allowedOrigins: Set<string>): string | null {
  if (!origin || allowedOrigins.size === 0) return null;
  return allowedOrigins.has(origin) ? origin : null;
}

export function withCorsHeaders(response: Response, origin: string | null | undefined, env: AdminEnv): Response {
  const allowed = isOriginAllowed(origin, parseAllowedOrigins(env));
  const headers = new Headers(response.headers);

  if (allowed) {
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }

  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function handleCorsPreFlight(request: Request, env: AdminEnv): Response {
  const origin = request.headers.get('Origin');
  const allowed = isOriginAllowed(origin, parseAllowedOrigins(env));

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isValidRuleId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && KEBAB_CASE_RE.test(id);
}

export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
