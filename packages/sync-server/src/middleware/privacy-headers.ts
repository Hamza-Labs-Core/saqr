/**
 * Privacy Headers — Cookie-free enforcement and strict privacy policy.
 *
 * Ensures that all responses have strict privacy headers:
 * - No Set-Cookie headers ever
 * - Strict CSP headers
 * - Referrer-Policy: no-referrer
 * - Restrictive Permissions-Policy
 * - X-Content-Type-Options: nosniff
 */

// ---------------------------------------------------------------------------
// Privacy Header Constants
// ---------------------------------------------------------------------------

export const PRIVACY_HEADERS: Record<string, string> = {
  // Prevent all cookies
  'Cache-Control': 'no-store, no-cache, must-revalidate',

  // Strict Content Security Policy
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",

  // Never send referrer information
  'Referrer-Policy': 'no-referrer',

  // Restrictive Permissions Policy (deny all browser APIs)
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',

  // Prevent MIME type sniffing
  'X-Content-Type-Options': 'nosniff',

  // Prevent clickjacking
  'X-Frame-Options': 'DENY',

  // Only HTTPS
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',

  // Do not track acknowledgment
  'X-DNS-Prefetch-Control': 'off',

  // Prevent cross-origin data leakage
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ---------------------------------------------------------------------------
// Privacy Headers Middleware
// ---------------------------------------------------------------------------

/**
 * Add all privacy headers to a response and strip any Set-Cookie headers.
 *
 * @param response - The response to augment
 * @returns A new response with privacy headers
 */
export function addPrivacyHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  // Add all privacy headers
  for (const [key, value] of Object.entries(PRIVACY_HEADERS)) {
    headers.set(key, value);
  }

  // CRITICAL: Remove any Set-Cookie headers (cookie-free enforcement)
  headers.delete('Set-Cookie');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Verify that a response has all required privacy headers.
 * Useful for testing and compliance auditing.
 *
 * @param response - The response to verify
 * @returns Object with isCompliant boolean and any missing headers
 */
export function verifyPrivacyHeaders(
  response: Response,
): { isCompliant: boolean; missing: string[]; hasCookies: boolean } {
  const missing: string[] = [];

  for (const key of Object.keys(PRIVACY_HEADERS)) {
    if (!response.headers.has(key)) {
      missing.push(key);
    }
  }

  const hasCookies = response.headers.has('Set-Cookie');

  return {
    isCompliant: missing.length === 0 && !hasCookies,
    missing,
    hasCookies,
  };
}
