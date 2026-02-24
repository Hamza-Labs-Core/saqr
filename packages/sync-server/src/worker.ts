/**
 * Main Cloudflare Worker — API gateway for the sync server.
 *
 * Routes:
 *   POST /api/auth/register    -> Register new user
 *   POST /api/auth/login       -> Authenticate and issue JWT
 *   POST /api/sync/push        -> Route to user DO (push encrypted events)
 *   POST /api/sync/pull        -> Route to user DO (pull events)
 *   GET  /api/account          -> Get account info (via DO)
 *   DELETE /api/account        -> Delete account + crypto-shred (via DO)
 *   GET  /api/machines         -> List machines (via DO)
 *   POST /api/machines         -> Register machine (via DO)
 *   DELETE /api/machines/:id   -> Delete machine (via DO)
 *   GET  /api/health           -> Health check
 */

import type { Env, AuthContext } from './types.js';
import { verifyToken, JWTError } from './auth/jwt.js';
import { handleRegister, handleLogin } from './auth/handlers.js';
import { checkRateLimit } from './middleware/rate-limiter.js';
import { handleGetCurated, handleGetPopular } from './codeguard/public-handlers.js';
import { handleTelemetryPush } from './codeguard/telemetry-handlers.js';
import {
  jsonResponse,
  errorResponse,
  withCorsHeaders,
  withSecurityHeaders,
  handleCorsPreFlight,
} from './helpers.js';

// Maximum request body size: 10 MB
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Paths that require JWT authentication.
 */
function requiresAuth(pathname: string): boolean {
  return (
    pathname.startsWith('/api/sync/') ||
    pathname.startsWith('/api/account') ||
    pathname.startsWith('/api/machines') ||
    pathname === '/api/codeguard/telemetry'
  );
}

function isPublicCodeguardRoute(pathname: string): boolean {
  return (
    pathname === '/api/codeguard/curated' ||
    pathname === '/api/codeguard/popular'
  );
}

/**
 * Extract and verify JWT from Authorization header.
 */
async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<{ authCtx: AuthContext } | { error: Response }> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      error: errorResponse(401, 'missing_token', 'Authorization header with Bearer token required'),
    };
  }

  const token = authHeader.slice(7);
  if (!token) {
    return {
      error: errorResponse(401, 'missing_token', 'Bearer token is empty'),
    };
  }

  try {
    const payload = await verifyToken(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    const authCtx: AuthContext = {
      userId: payload.sub,
      email: payload.email,
      tier: payload.tier,
      machineId: request.headers.get('X-Machine-Id') || undefined,
    };

    return { authCtx };
  } catch (err) {
    const message =
      err instanceof JWTError ? err.message : 'Token expired or invalid';
    return {
      error: errorResponse(401, 'invalid_token', message),
    };
  }
}

/**
 * Route an authenticated request to the user's Durable Object.
 */
async function routeToDO(
  request: Request,
  env: Env,
  authCtx: AuthContext,
): Promise<Response> {
  const doId = env.USER_SYNC.idFromName(authCtx.userId);
  const doStub = env.USER_SYNC.get(doId);

  // Build headers with auth context added
  const headers = new Headers(request.headers);
  headers.set('X-Auth-Context', JSON.stringify(authCtx));

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  // Forward request to DO
  // Note: duplex option is needed for Node.js environments (tests)
  // but not for Cloudflare Workers runtime
  const init: RequestInit & { duplex?: string } = {
    method: request.method,
    headers,
  };

  if (hasBody && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }

  const doRequest = new Request(request.url, init);

  return doStub.fetch(doRequest);
}

// ---------------------------------------------------------------------------
// Worker Entry Point
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCorsPreFlight(request, env);
    }

    // Helper to add CORS + security headers to all responses
    const respond = (response: Response): Response => {
      return withSecurityHeaders(withCorsHeaders(response, origin, env));
    };

    // --- Health check (no auth) ---
    if (url.pathname === '/api/health') {
      return respond(
        jsonResponse(200, {
          status: 'ok',
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // --- Public auth endpoints (no middleware chain) ---
    if (url.pathname === '/api/auth/register' && request.method === 'POST') {
      return respond(await handleRegister(request, env));
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      return respond(await handleLogin(request, env));
    }

    // --- Public codeguard endpoints (no auth) ---
    if (url.pathname === '/api/codeguard/curated' && request.method === 'GET') {
      return respond(await handleGetCurated(env));
    }

    if (url.pathname === '/api/codeguard/popular' && request.method === 'GET') {
      return respond(await handleGetPopular(env, url));
    }

    // --- Block internal endpoints from external access ---
    if (url.pathname.startsWith('/_internal/')) {
      return respond(errorResponse(404, 'not_found', 'Not found'));
    }

    // --- Authenticated endpoints ---
    if (!requiresAuth(url.pathname) && !isPublicCodeguardRoute(url.pathname)) {
      return respond(errorResponse(404, 'not_found', 'Not found'));
    }

    // Check body size for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const contentLength = request.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
        return respond(
          errorResponse(413, 'payload_too_large', 'Request body exceeds 10 MB limit'),
        );
      }
    }

    // JWT authentication
    const authResult = await authenticateRequest(request, env);
    if ('error' in authResult) {
      return respond(authResult.error);
    }
    const { authCtx } = authResult;

    // Rate limiting
    const rateLimitResult = await checkRateLimit(env, authCtx);
    if (rateLimitResult) {
      return respond(rateLimitResult);
    }

    // --- Codeguard telemetry (authed but not routed to DO) ---
    if (url.pathname === '/api/codeguard/telemetry' && request.method === 'POST') {
      return respond(await handleTelemetryPush(request, env, authCtx));
    }

    // Route to Durable Object
    try {
      const doResponse = await routeToDO(request, env, authCtx);
      return respond(doResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return respond(errorResponse(500, 'internal_error', message));
    }
  },
};
