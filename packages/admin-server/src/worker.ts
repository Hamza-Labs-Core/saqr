/**
 * Admin Server — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /api/health                              -> Health check (no auth)
 *   GET  /api/admin/codeguard/curated             -> List curated rules
 *   POST /api/admin/codeguard/curated             -> Add curated rule
 *   PUT  /api/admin/codeguard/curated/:id         -> Update curated rule
 *   DELETE /api/admin/codeguard/curated/:id       -> Delete curated rule
 *   GET  /api/admin/codeguard/popular             -> List popular rules
 *   POST /api/admin/codeguard/popular/:id/hide    -> Hide popular rule
 *   POST /api/admin/codeguard/popular/:id/unhide  -> Unhide popular rule
 *   GET  /api/admin/users                         -> List users
 *   GET  /api/admin/users/:id                     -> Get user details
 *   POST /api/admin/users/:id/promote             -> Promote to admin
 *   POST /api/admin/users/:id/demote              -> Demote to user
 */

import type { AdminEnv } from './types.js';
import { authenticateAdmin } from './auth/admin-auth.js';
import {
  handleListCurated,
  handleAddCurated,
  handleUpdateCurated,
  handleDeleteCurated,
} from './codeguard/curated-handlers.js';
import {
  handleListPopular,
  handleHidePopular,
  handleUnhidePopular,
} from './codeguard/popular-handlers.js';
import {
  handleListUsers,
  handleGetUser,
  handlePromoteUser,
  handleDemoteUser,
} from './users/user-handlers.js';
import {
  jsonResponse,
  errorResponse,
  checkBodySize,
  withCorsHeaders,
  withSecurityHeaders,
  handleCorsPreFlight,
} from './helpers.js';

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB — admin ops are small

export default {
  async fetch(
    request: Request,
    env: AdminEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCorsPreFlight(request, env);
    }

    const respond = (response: Response): Response => {
      return withSecurityHeaders(withCorsHeaders(response, origin, env));
    };

    // Health check (no auth)
    if (url.pathname === '/api/health') {
      return respond(
        jsonResponse(200, { status: 'ok', service: 'admin', timestamp: new Date().toISOString() }),
      );
    }

    // All /api/admin/* routes require admin auth
    if (!url.pathname.startsWith('/api/admin/')) {
      return respond(errorResponse(404, 'not_found', 'Not found'));
    }

    // Check body size for mutations (handles both Content-Length and chunked)
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const sizeError = await checkBodySize(request, MAX_BODY_SIZE);
      if (sizeError) {
        return respond(sizeError);
      }
    }

    // Authenticate admin
    const authResult = await authenticateAdmin(request, env);
    if ('error' in authResult) {
      return respond(authResult.error);
    }
    const { authCtx } = authResult;

    // --- Curated Rules ---
    if (url.pathname === '/api/admin/codeguard/curated') {
      if (request.method === 'GET') {
        return respond(await handleListCurated(env));
      }
      if (request.method === 'POST') {
        return respond(await handleAddCurated(request, env, authCtx));
      }
      return respond(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
    }

    // Curated rules with :id
    const curatedMatch = url.pathname.match(/^\/api\/admin\/codeguard\/curated\/([a-z0-9-]+)$/);
    if (curatedMatch) {
      const ruleId = curatedMatch[1];
      if (request.method === 'PUT') {
        return respond(await handleUpdateCurated(request, env, authCtx, ruleId));
      }
      if (request.method === 'DELETE') {
        return respond(await handleDeleteCurated(env, authCtx, ruleId));
      }
      return respond(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
    }

    // --- Popular Rules ---
    if (url.pathname === '/api/admin/codeguard/popular') {
      if (request.method === 'GET') {
        return respond(await handleListPopular(env));
      }
      return respond(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
    }

    // Popular hide/unhide
    const popularHideMatch = url.pathname.match(/^\/api\/admin\/codeguard\/popular\/([a-z0-9-]+)\/(hide|unhide)$/);
    if (popularHideMatch) {
      const ruleId = popularHideMatch[1];
      const action = popularHideMatch[2];
      if (request.method === 'POST') {
        if (action === 'hide') {
          return respond(await handleHidePopular(env, ruleId));
        }
        return respond(await handleUnhidePopular(env, ruleId));
      }
      return respond(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
    }

    // --- User Management ---
    if (url.pathname === '/api/admin/users') {
      if (request.method === 'GET') {
        return respond(await handleListUsers(env, url));
      }
      return respond(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
    }

    // User promote/demote
    const userActionMatch = url.pathname.match(/^\/api\/admin\/users\/([a-z0-9_]+)\/(promote|demote)$/);
    if (userActionMatch) {
      const userId = userActionMatch[1];
      const action = userActionMatch[2];
      if (request.method === 'POST') {
        if (action === 'promote') {
          return respond(await handlePromoteUser(env, userId));
        }
        return respond(await handleDemoteUser(env, userId));
      }
      return respond(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
    }

    // User details
    const userDetailMatch = url.pathname.match(/^\/api\/admin\/users\/([a-z0-9_]+)$/);
    if (userDetailMatch) {
      const userId = userDetailMatch[1];
      if (request.method === 'GET') {
        return respond(await handleGetUser(env, userId));
      }
      return respond(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
    }

    return respond(errorResponse(404, 'not_found', 'Not found'));
  },
};
