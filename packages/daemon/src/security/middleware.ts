/**
 * Security Middleware — Combined HTTP security middleware stack.
 *
 * Integrates host allowlisting, CORS, path sandbox checks,
 * rate limiting, and request logging into a composable middleware.
 *
 * @module security/middleware
 */

import { HostAllowlist, type HostAllowlistConfig } from "./host-allowlist.js";
import { PathSandbox, PathViolationError, type PathSandboxConfig } from "./path-sandbox.js";

/**
 * Configuration for the security middleware.
 */
export interface SecurityConfig {
  /** Host allowlist configuration */
  hostAllowlist?: HostAllowlistConfig;

  /** Path sandbox configuration */
  pathSandbox?: PathSandboxConfig;

  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig;

  /** Whether to log requests for audit. Default: true */
  enableAuditLog?: boolean;

  /** Whether to enable host validation. Default: true */
  enableHostValidation?: boolean;

  /** Whether to enable CORS. Default: true */
  enableCors?: boolean;

  /** Whether to enable rate limiting. Default: true */
  enableRateLimit?: boolean;
}

/**
 * Rate limit configuration using a sliding window.
 */
export interface RateLimitConfig {
  /** Maximum requests per window. Default: 100 */
  maxRequests?: number;

  /** Window size in milliseconds. Default: 60000 (1 minute) */
  windowMs?: number;
}

/**
 * Simplified HTTP request interface for middleware.
 */
export interface SecurityRequest {
  /** HTTP method */
  method: string;

  /** Request URL/path */
  url: string;

  /** Request headers (lowercase keys) */
  headers: Record<string, string | undefined>;

  /** Client IP address (for rate limiting) */
  remoteAddress?: string;
}

/**
 * Simplified HTTP response interface for middleware.
 */
export interface SecurityResponse {
  /** Set HTTP status code */
  statusCode: number;

  /** Response headers to set */
  headers: Record<string, string>;

  /** Response body (for error responses) */
  body?: string;

  /** Whether the request should be blocked */
  blocked: boolean;
}

/**
 * Audit log entry.
 */
export interface AuditLogEntry {
  timestamp: string;
  method: string;
  url: string;
  remoteAddress: string;
  host: string;
  origin: string | undefined;
  allowed: boolean;
  reason?: string;
}

/**
 * Rate limiter entry for a client.
 */
interface RateLimitEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[];
}

/**
 * Security middleware that combines multiple security checks.
 */
export class SecurityMiddleware {
  private readonly hostAllowlist: HostAllowlist;
  private readonly pathSandbox: PathSandbox | null;
  private readonly config: Required<SecurityConfig>;
  private readonly rateLimitMap: Map<string, RateLimitEntry>;
  private readonly auditLog: AuditLogEntry[];
  private readonly maxAuditLogSize: number;
  private readonly _nowFn: () => number;

  constructor(config: SecurityConfig = {}, nowFn?: () => number) {
    this.config = {
      hostAllowlist: config.hostAllowlist ?? {},
      pathSandbox: config.pathSandbox ?? { allowedPaths: [] },
      rateLimit: config.rateLimit ?? {},
      enableAuditLog: config.enableAuditLog ?? true,
      enableHostValidation: config.enableHostValidation ?? true,
      enableCors: config.enableCors ?? true,
      enableRateLimit: config.enableRateLimit ?? true,
    };

    this.hostAllowlist = new HostAllowlist(this.config.hostAllowlist);

    this.pathSandbox =
      this.config.pathSandbox.allowedPaths.length > 0
        ? new PathSandbox(this.config.pathSandbox)
        : null;

    this.rateLimitMap = new Map();
    this.auditLog = [];
    this.maxAuditLogSize = 10000;
    this._nowFn = nowFn ?? (() => Date.now());
  }

  /**
   * Process an incoming request through the security middleware stack.
   *
   * Checks are applied in order:
   * 1. Rate limiting
   * 2. Host header validation (DNS rebinding protection)
   * 3. CORS preflight handling
   * 4. Origin validation
   *
   * @param request - The incoming request
   * @returns The security response (check `blocked` property)
   */
  processRequest(request: SecurityRequest): SecurityResponse {
    const response: SecurityResponse = {
      statusCode: 200,
      headers: {},
      blocked: false,
    };

    const clientIp = request.remoteAddress ?? "unknown";
    const host = request.headers["host"] ?? "";
    const origin = request.headers["origin"];

    // 1. Rate limiting
    if (this.config.enableRateLimit) {
      if (this.isRateLimited(clientIp)) {
        response.statusCode = 429;
        response.blocked = true;
        response.body = "Too Many Requests";
        response.headers["Retry-After"] = String(
          Math.ceil(
            (this.config.rateLimit.windowMs ?? 60000) / 1000,
          ),
        );
        this.logRequest(request, false, "Rate limited");
        return response;
      }
    }

    // 2. Host header validation
    if (this.config.enableHostValidation) {
      if (!this.hostAllowlist.isHostAllowed(host)) {
        response.statusCode = 403;
        response.blocked = true;
        response.body = "Forbidden: Invalid Host header";
        this.logRequest(request, false, "Invalid host header");
        return response;
      }
    }

    // 3. CORS preflight
    if (this.config.enableCors) {
      const corsHeaders = this.hostAllowlist.corsHeaders(origin);
      Object.assign(response.headers, corsHeaders);

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.blocked = true; // Block in the sense that no further processing needed
        response.body = "";
        this.logRequest(request, true, "CORS preflight");
        return response;
      }
    }

    // 4. Origin validation (for non-GET requests with an Origin header)
    if (origin && !this.hostAllowlist.isOriginAllowed(origin)) {
      response.statusCode = 403;
      response.blocked = true;
      response.body = "Forbidden: Invalid Origin";
      this.logRequest(request, false, "Invalid origin");
      return response;
    }

    this.logRequest(request, true);
    return response;
  }

  /**
   * Validate a file path against the sandbox.
   *
   * @param filePath - The file path to validate
   * @returns The sanitized path
   * @throws PathViolationError if the path is outside the sandbox
   */
  validatePath(filePath: string): string {
    if (!this.pathSandbox) {
      // No sandbox configured, allow everything
      return filePath;
    }

    return this.pathSandbox.sanitizePath(filePath);
  }

  /**
   * Check if a path is allowed by the sandbox.
   */
  isPathAllowed(filePath: string): boolean {
    if (!this.pathSandbox) {
      return true;
    }
    return this.pathSandbox.isPathAllowed(filePath);
  }

  /**
   * Get the audit log entries.
   */
  getAuditLog(): readonly AuditLogEntry[] {
    return [...this.auditLog];
  }

  /**
   * Clear the audit log.
   */
  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  /**
   * Get the rate limit status for a client.
   */
  getRateLimitStatus(
    clientIp: string,
  ): { remaining: number; resetIn: number } {
    const maxRequests = this.config.rateLimit.maxRequests ?? 100;
    const windowMs = this.config.rateLimit.windowMs ?? 60000;
    const now = this._nowFn();
    const windowStart = now - windowMs;

    const entry = this.rateLimitMap.get(clientIp);
    if (!entry) {
      return { remaining: maxRequests, resetIn: windowMs };
    }

    const recentCount = entry.timestamps.filter(
      (t) => t > windowStart,
    ).length;

    const oldestInWindow = entry.timestamps.find((t) => t > windowStart);
    const resetIn = oldestInWindow
      ? oldestInWindow + windowMs - now
      : windowMs;

    return {
      remaining: Math.max(0, maxRequests - recentCount),
      resetIn,
    };
  }

  /** Maximum number of tracked IPs before cleanup. */
  private static readonly MAX_RATE_LIMIT_ENTRIES = 10000;

  /**
   * Check if a client IP is rate limited.
   */
  private isRateLimited(clientIp: string): boolean {
    const maxRequests = this.config.rateLimit.maxRequests ?? 100;
    const windowMs = this.config.rateLimit.windowMs ?? 60000;
    const now = this._nowFn();
    const windowStart = now - windowMs;

    // Periodic cleanup: evict stale entries when map grows too large
    if (this.rateLimitMap.size > SecurityMiddleware.MAX_RATE_LIMIT_ENTRIES) {
      for (const [ip, e] of this.rateLimitMap) {
        e.timestamps = e.timestamps.filter((t) => t > windowStart);
        if (e.timestamps.length === 0) {
          this.rateLimitMap.delete(ip);
        }
      }
    }

    let entry = this.rateLimitMap.get(clientIp);
    if (!entry) {
      entry = { timestamps: [] };
      this.rateLimitMap.set(clientIp, entry);
    }

    // Clean old entries for this IP
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    // Check limit
    if (entry.timestamps.length >= maxRequests) {
      return true;
    }

    // Record this request
    entry.timestamps.push(now);
    return false;
  }

  /**
   * Log a request for audit.
   */
  private logRequest(
    request: SecurityRequest,
    allowed: boolean,
    reason?: string,
  ): void {
    if (!this.config.enableAuditLog) return;

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      remoteAddress: request.remoteAddress ?? "unknown",
      host: request.headers["host"] ?? "",
      origin: request.headers["origin"],
      allowed,
      reason,
    };

    this.auditLog.push(entry);

    // Prevent unbounded growth
    if (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog.splice(0, Math.floor(this.maxAuditLogSize / 2));
    }
  }
}

/**
 * Create a configured security middleware instance.
 *
 * @param config - Security configuration
 * @returns A SecurityMiddleware instance
 */
export function securityMiddleware(config?: SecurityConfig): SecurityMiddleware {
  return new SecurityMiddleware(config);
}
