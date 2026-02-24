/**
 * HostAllowlist — HTTP request security for the daemon server.
 *
 * Prevents DNS rebinding attacks by validating the Host header.
 * Provides CORS configuration (localhost only by default).
 * Validates Origin headers for cross-origin requests.
 *
 * @module security/host-allowlist
 */

/**
 * Configuration for the host allowlist.
 */
export interface HostAllowlistConfig {
  /** Allowed hostnames (without port). Default: ["127.0.0.1", "localhost", "::1"] */
  allowedHosts?: string[];

  /** Allowed origins for CORS. Default: localhost origins */
  allowedOrigins?: string[];

  /** Whether to allow requests with no Origin header (non-browser). Default: true */
  allowNoOrigin?: boolean;

  /** Custom CORS max-age in seconds. Default: 86400 (24h) */
  corsMaxAge?: number;

  /** Additional allowed CORS methods. Default: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] */
  allowedMethods?: string[];

  /** Additional allowed CORS headers. Default: ["Content-Type", "Authorization", "X-Request-ID"] */
  allowedHeaders?: string[];
}

/** Default allowed hosts — localhost only */
const DEFAULT_ALLOWED_HOSTS = [
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
];

/** Default allowed origins — localhost with common dev ports */
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1",
  "http://localhost",
  "http://[::1]",
];

/** Default allowed HTTP methods */
const DEFAULT_ALLOWED_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
];

/** Default allowed headers */
const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Request-ID",
];

/**
 * HostAllowlist validates incoming HTTP requests to prevent
 * DNS rebinding attacks and enforce CORS policy.
 */
export class HostAllowlist {
  private readonly allowedHosts: Set<string>;
  private readonly allowedOrigins: Set<string>;
  private readonly allowNoOrigin: boolean;
  private readonly corsMaxAge: number;
  private readonly allowedMethods: string[];
  private readonly allowedHeaders: string[];

  constructor(config: HostAllowlistConfig = {}) {
    this.allowedHosts = new Set(
      (config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((h) =>
        h.toLowerCase(),
      ),
    );
    this.allowedOrigins = new Set(
      config.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
    );
    this.allowNoOrigin = config.allowNoOrigin ?? true;
    this.corsMaxAge = config.corsMaxAge ?? 86400;
    this.allowedMethods = config.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
    this.allowedHeaders = config.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS;
  }

  /**
   * Validate the Host header of an incoming request.
   *
   * Strips the port from the Host header and checks against the allowlist.
   * This prevents DNS rebinding attacks where an attacker's domain
   * resolves to 127.0.0.1.
   *
   * @param hostHeader - The Host header value from the HTTP request
   * @returns true if the host is allowed
   */
  isHostAllowed(hostHeader: string): boolean {
    if (!hostHeader) {
      return false;
    }

    // Extract hostname (strip port)
    const host = this.extractHostname(hostHeader).toLowerCase();
    return this.allowedHosts.has(host);
  }

  /**
   * Validate the Origin header for CORS.
   *
   * @param origin - The Origin header value, or undefined if absent
   * @returns true if the origin is allowed
   */
  isOriginAllowed(origin: string | undefined): boolean {
    // No origin header (non-browser request like curl, server-to-server)
    if (origin === undefined || origin === "") {
      return this.allowNoOrigin;
    }

    // Check exact match
    if (this.allowedOrigins.has(origin)) {
      return true;
    }

    // Check origin with any port on allowed hosts
    try {
      const url = new URL(origin);
      const hostOnly = `${url.protocol}//${url.hostname}`;
      return this.allowedOrigins.has(hostOnly);
    } catch {
      return false;
    }
  }

  /**
   * Generate CORS response headers for a given origin.
   *
   * @param origin - The request Origin header
   * @returns CORS headers to include in the response
   */
  corsHeaders(origin?: string): Record<string, string> {
    const headers: Record<string, string> = {};

    if (origin && this.isOriginAllowed(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }

    headers["Access-Control-Allow-Methods"] = this.allowedMethods.join(", ");
    headers["Access-Control-Allow-Headers"] = this.allowedHeaders.join(", ");
    headers["Access-Control-Max-Age"] = String(this.corsMaxAge);
    headers["Access-Control-Allow-Credentials"] = "true";

    return headers;
  }

  /**
   * Add a host to the allowlist.
   */
  addHost(host: string): void {
    this.allowedHosts.add(host.toLowerCase());
  }

  /**
   * Remove a host from the allowlist.
   */
  removeHost(host: string): boolean {
    return this.allowedHosts.delete(host.toLowerCase());
  }

  /**
   * Add an origin to the CORS allowlist.
   */
  addOrigin(origin: string): void {
    this.allowedOrigins.add(origin);
  }

  /**
   * Remove an origin from the CORS allowlist.
   */
  removeOrigin(origin: string): boolean {
    return this.allowedOrigins.delete(origin);
  }

  /**
   * Extract hostname from a Host header value (strips port).
   */
  private extractHostname(hostHeader: string): string {
    // Handle IPv6 addresses in brackets like [::1]:3100 or [::1]
    if (hostHeader.startsWith("[")) {
      const bracketEnd = hostHeader.indexOf("]");
      if (bracketEnd >= 0) {
        return hostHeader.substring(0, bracketEnd + 1);
      }
    }

    // Count colons - if more than 1, it's a bare IPv6 address (no port)
    const colonCount = (hostHeader.match(/:/g) || []).length;
    if (colonCount > 1) {
      // Bare IPv6 address like ::1 or fe80::1 — return as-is
      return hostHeader;
    }

    // Handle hostname:port (exactly one colon)
    if (colonCount === 1) {
      const colonIdx = hostHeader.indexOf(":");
      const afterColon = hostHeader.substring(colonIdx + 1);
      if (/^\d+$/.test(afterColon)) {
        return hostHeader.substring(0, colonIdx);
      }
    }

    return hostHeader;
  }
}

/**
 * Convenience function to validate a host header.
 *
 * @param hostHeader - The Host header from an incoming request
 * @param config - Optional allowlist config
 * @returns true if the host is allowed
 */
export function validateHost(
  hostHeader: string,
  config?: HostAllowlistConfig,
): boolean {
  const allowlist = new HostAllowlist(config);
  return allowlist.isHostAllowed(hostHeader);
}

/**
 * Convenience function to generate CORS headers.
 *
 * @param origin - The request Origin header
 * @param config - Optional allowlist config
 * @returns CORS headers record
 */
export function corsHeaders(
  origin?: string,
  config?: HostAllowlistConfig,
): Record<string, string> {
  const allowlist = new HostAllowlist(config);
  return allowlist.corsHeaders(origin);
}
