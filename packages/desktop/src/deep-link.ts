/**
 * Deep Link Handler.
 *
 * Parses agentcontext:// URL scheme and maps to application routes.
 *
 * @module deep-link
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The URL scheme for AgentContext deep links. */
export const DEEP_LINK_SCHEME = "agentcontext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed deep link with route and parameters. */
export interface DeepLinkRoute {
  route: string;
  params: Record<string, string>;
  queryParams?: URLSearchParams;
}

// ---------------------------------------------------------------------------
// Known Routes
// ---------------------------------------------------------------------------

/**
 * Routes that are recognized by the deep link handler.
 */
const KNOWN_SIMPLE_ROUTES = [
  "dashboard",
  "settings",
  "new-agent",
  "update",
] as const;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parses a deep link URL and returns the matched route with parameters.
 * Returns null if the URL is invalid or doesn't match any known route.
 *
 * Supported URL patterns:
 * - agentcontext://dashboard
 * - agentcontext://settings
 * - agentcontext://settings/{section}
 * - agentcontext://agent/{agentId}
 * - agentcontext://agent/{agentId}/session/{sessionId}
 * - agentcontext://permission/{requestId}/{action}
 * - agentcontext://new-agent
 * - agentcontext://update
 */
export function parseDeepLink(url: string): DeepLinkRoute | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Check scheme
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return null;
  }

  // hostname is the first path segment, pathname has the rest
  // For agentcontext://agent/abc123, hostname = "agent", pathname = "/abc123"
  const host = parsed.hostname;
  const pathSegments = parsed.pathname
    .split("/")
    .filter((s) => s.length > 0);

  const queryParams =
    parsed.search.length > 1 ? parsed.searchParams : undefined;

  // Simple routes: dashboard, settings (no sub-path), new-agent, update
  if (
    (KNOWN_SIMPLE_ROUTES as readonly string[]).includes(host) &&
    pathSegments.length === 0
  ) {
    return {
      route: host,
      params: {},
      queryParams,
    };
  }

  // Settings with section: agentcontext://settings/{section}
  if (host === "settings" && pathSegments.length === 1) {
    return {
      route: "settings",
      params: { section: pathSegments[0] },
      queryParams,
    };
  }

  // Agent view: agentcontext://agent/{agentId}
  if (host === "agent" && pathSegments.length === 1) {
    return {
      route: "agent",
      params: { agentId: pathSegments[0] },
      queryParams,
    };
  }

  // Agent session: agentcontext://agent/{agentId}/session/{sessionId}
  if (
    host === "agent" &&
    pathSegments.length === 3 &&
    pathSegments[1] === "session"
  ) {
    return {
      route: "agent-session",
      params: {
        agentId: pathSegments[0],
        sessionId: pathSegments[2],
      },
      queryParams,
    };
  }

  // Permission: agentcontext://permission/{requestId}/{action}
  if (host === "permission" && pathSegments.length === 2) {
    const action = pathSegments[1];
    if (action !== "approve" && action !== "deny") {
      return null;
    }
    return {
      route: "permission",
      params: {
        requestId: pathSegments[0],
        action,
      },
      queryParams,
    };
  }

  // Unknown route
  return null;
}
