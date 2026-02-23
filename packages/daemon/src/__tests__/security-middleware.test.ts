/**
 * Tests for SecurityMiddleware — combined HTTP security middleware stack.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  SecurityMiddleware,
  securityMiddleware,
} from "../security/middleware.js";
import type { SecurityRequest } from "../security/middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<SecurityRequest> = {}): SecurityRequest {
  const defaultHeaders: Record<string, string | undefined> = {
    host: "localhost:3100",
  };

  return {
    method: overrides.method ?? "GET",
    url: overrides.url ?? "/api/health",
    headers: {
      ...defaultHeaders,
      ...(overrides.headers ?? {}),
    },
    remoteAddress: overrides.remoteAddress ?? "127.0.0.1",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SecurityMiddleware", () => {
  // -------------------------------------------------------------------------
  // Basic request processing
  // -------------------------------------------------------------------------

  describe("processRequest", () => {
    it("should allow valid localhost requests", () => {
      const mw = new SecurityMiddleware();
      const response = mw.processRequest(makeRequest());

      expect(response.blocked).toBe(false);
      expect(response.statusCode).toBe(200);
    });

    it("should block requests with invalid host header", () => {
      const mw = new SecurityMiddleware();
      const response = mw.processRequest(
        makeRequest({
          headers: { host: "evil.com" },
        }),
      );

      expect(response.blocked).toBe(true);
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("Invalid Host");
    });

    it("should block requests with no host header", () => {
      const mw = new SecurityMiddleware();
      const response = mw.processRequest(
        makeRequest({
          headers: { host: "" },
        }),
      );

      expect(response.blocked).toBe(true);
      expect(response.statusCode).toBe(403);
    });

    it("should allow when host validation is disabled", () => {
      const mw = new SecurityMiddleware({
        enableHostValidation: false,
      });

      const response = mw.processRequest(
        makeRequest({
          headers: { host: "evil.com" },
        }),
      );

      expect(response.blocked).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // CORS handling
  // -------------------------------------------------------------------------

  describe("CORS", () => {
    it("should add CORS headers for allowed origins", () => {
      const mw = new SecurityMiddleware();
      const response = mw.processRequest(
        makeRequest({
          headers: {
            host: "localhost:3100",
            origin: "http://localhost:3000",
          },
        }),
      );

      expect(response.blocked).toBe(false);
      expect(response.headers["Access-Control-Allow-Origin"]).toBe(
        "http://localhost:3000",
      );
      expect(response.headers["Vary"]).toBe("Origin");
    });

    it("should handle OPTIONS preflight", () => {
      const mw = new SecurityMiddleware();
      const response = mw.processRequest(
        makeRequest({
          method: "OPTIONS",
          headers: {
            host: "localhost:3100",
            origin: "http://localhost:3000",
          },
        }),
      );

      // Preflight is "blocked" (no further processing needed)
      expect(response.blocked).toBe(true);
      expect(response.statusCode).toBe(204);
      expect(response.headers["Access-Control-Allow-Methods"]).toBeTruthy();
    });

    it("should reject requests with invalid origin", () => {
      const mw = new SecurityMiddleware();
      const response = mw.processRequest(
        makeRequest({
          method: "POST",
          headers: {
            host: "localhost:3100",
            origin: "https://evil.com",
          },
        }),
      );

      expect(response.blocked).toBe(true);
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("Invalid Origin");
    });

    it("should allow requests without origin (non-browser)", () => {
      const mw = new SecurityMiddleware();
      const response = mw.processRequest(
        makeRequest({
          headers: { host: "localhost:3100" },
        }),
      );

      expect(response.blocked).toBe(false);
    });

    it("should skip CORS when disabled", () => {
      const mw = new SecurityMiddleware({ enableCors: false });
      const response = mw.processRequest(makeRequest());

      expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe("rate limiting", () => {
    it("should allow requests within rate limit", () => {
      const mw = new SecurityMiddleware({
        rateLimit: { maxRequests: 5, windowMs: 60000 },
      });

      for (let i = 0; i < 5; i++) {
        const response = mw.processRequest(makeRequest());
        expect(response.blocked).toBe(false);
      }
    });

    it("should block requests exceeding rate limit", () => {
      const mw = new SecurityMiddleware({
        rateLimit: { maxRequests: 3, windowMs: 60000 },
      });

      // First 3 should pass
      for (let i = 0; i < 3; i++) {
        const response = mw.processRequest(makeRequest());
        expect(response.blocked).toBe(false);
      }

      // 4th should be blocked
      const response = mw.processRequest(makeRequest());
      expect(response.blocked).toBe(true);
      expect(response.statusCode).toBe(429);
      expect(response.body).toContain("Too Many Requests");
      expect(response.headers["Retry-After"]).toBeTruthy();
    });

    it("should rate limit per IP", () => {
      const mw = new SecurityMiddleware({
        rateLimit: { maxRequests: 2, windowMs: 60000 },
      });

      // 2 requests from IP-A
      mw.processRequest(makeRequest({ remoteAddress: "192.168.1.1" }));
      mw.processRequest(makeRequest({ remoteAddress: "192.168.1.1" }));

      // 3rd from IP-A should be blocked
      const blockedA = mw.processRequest(
        makeRequest({ remoteAddress: "192.168.1.1" }),
      );
      expect(blockedA.blocked).toBe(true);

      // IP-B should still be allowed
      const allowedB = mw.processRequest(
        makeRequest({ remoteAddress: "192.168.1.2" }),
      );
      expect(allowedB.blocked).toBe(false);
    });

    it("should reset after window expires", () => {
      let now = 1000;
      const mw = new SecurityMiddleware(
        {
          rateLimit: { maxRequests: 2, windowMs: 1000 },
        },
        () => now,
      );

      mw.processRequest(makeRequest());
      mw.processRequest(makeRequest());

      const blocked = mw.processRequest(makeRequest());
      expect(blocked.blocked).toBe(true);

      // Advance time past window
      now = 2001;

      const allowed = mw.processRequest(makeRequest());
      expect(allowed.blocked).toBe(false);
    });

    it("should skip rate limiting when disabled", () => {
      const mw = new SecurityMiddleware({
        enableRateLimit: false,
        rateLimit: { maxRequests: 1, windowMs: 60000 },
      });

      // Should not be rate limited even though max is 1
      mw.processRequest(makeRequest());
      const second = mw.processRequest(makeRequest());
      expect(second.blocked).toBe(false);
    });

    it("should provide rate limit status", () => {
      const mw = new SecurityMiddleware({
        rateLimit: { maxRequests: 10, windowMs: 60000 },
      });

      const status = mw.getRateLimitStatus("127.0.0.1");
      expect(status.remaining).toBe(10);
      expect(status.resetIn).toBeGreaterThan(0);

      // Make some requests
      mw.processRequest(
        makeRequest({ remoteAddress: "127.0.0.1" }),
      );
      mw.processRequest(
        makeRequest({ remoteAddress: "127.0.0.1" }),
      );

      const status2 = mw.getRateLimitStatus("127.0.0.1");
      expect(status2.remaining).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  // Path sandbox integration
  // -------------------------------------------------------------------------

  describe("path sandbox", () => {
    let tmpDir: string;
    let allowedDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(
        path.join(os.tmpdir(), "saqr-mw-sandbox-test-"),
      );
      allowedDir = path.join(tmpDir, "allowed");
      await mkdir(allowedDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("should validate allowed paths", async () => {
      const mw = new SecurityMiddleware({
        pathSandbox: { allowedPaths: [allowedDir] },
      });

      await writeFile(path.join(allowedDir, "file.txt"), "data");

      const result = mw.validatePath(
        path.join(allowedDir, "file.txt"),
      );
      expect(result).toBe(path.join(allowedDir, "file.txt"));
    });

    it("should reject disallowed paths", () => {
      const mw = new SecurityMiddleware({
        pathSandbox: { allowedPaths: [allowedDir] },
      });

      expect(() => mw.validatePath("/etc/passwd")).toThrow();
    });

    it("should check path allowance without throwing", () => {
      const mw = new SecurityMiddleware({
        pathSandbox: { allowedPaths: [allowedDir] },
      });

      expect(
        mw.isPathAllowed(path.join(allowedDir, "file.txt")),
      ).toBe(true);
      expect(mw.isPathAllowed("/etc/passwd")).toBe(false);
    });

    it("should allow everything when no sandbox is configured", () => {
      const mw = new SecurityMiddleware();

      expect(mw.isPathAllowed("/any/path")).toBe(true);
      expect(mw.validatePath("/any/path")).toBe("/any/path");
    });
  });

  // -------------------------------------------------------------------------
  // Audit logging
  // -------------------------------------------------------------------------

  describe("audit logging", () => {
    it("should log requests when enabled", () => {
      const mw = new SecurityMiddleware({ enableAuditLog: true });

      mw.processRequest(makeRequest());

      const log = mw.getAuditLog();
      expect(log.length).toBe(1);
      expect(log[0]!.method).toBe("GET");
      expect(log[0]!.url).toBe("/api/health");
      expect(log[0]!.allowed).toBe(true);
    });

    it("should log blocked requests with reason", () => {
      const mw = new SecurityMiddleware({ enableAuditLog: true });

      mw.processRequest(
        makeRequest({ headers: { host: "evil.com" } }),
      );

      const log = mw.getAuditLog();
      expect(log.length).toBe(1);
      expect(log[0]!.allowed).toBe(false);
      expect(log[0]!.reason).toContain("host");
    });

    it("should not log when disabled", () => {
      const mw = new SecurityMiddleware({ enableAuditLog: false });

      mw.processRequest(makeRequest());

      expect(mw.getAuditLog().length).toBe(0);
    });

    it("should clear audit log", () => {
      const mw = new SecurityMiddleware({ enableAuditLog: true });

      mw.processRequest(makeRequest());
      expect(mw.getAuditLog().length).toBe(1);

      mw.clearAuditLog();
      expect(mw.getAuditLog().length).toBe(0);
    });

    it("should include timestamp in log entries", () => {
      const mw = new SecurityMiddleware();
      mw.processRequest(makeRequest());

      const log = mw.getAuditLog();
      expect(log[0]!.timestamp).toBeTruthy();
      // Should be a valid ISO date
      expect(new Date(log[0]!.timestamp).getTime()).toBeGreaterThan(0);
    });

    it("should include remote address and host", () => {
      const mw = new SecurityMiddleware();
      mw.processRequest(
        makeRequest({ remoteAddress: "10.0.0.1" }),
      );

      const log = mw.getAuditLog();
      expect(log[0]!.remoteAddress).toBe("10.0.0.1");
      expect(log[0]!.host).toBe("localhost:3100");
    });
  });

  // -------------------------------------------------------------------------
  // securityMiddleware convenience function
  // -------------------------------------------------------------------------

  describe("securityMiddleware factory", () => {
    it("should create a SecurityMiddleware instance", () => {
      const mw = securityMiddleware();
      expect(mw).toBeInstanceOf(SecurityMiddleware);
    });

    it("should accept config", () => {
      const mw = securityMiddleware({
        enableRateLimit: false,
      });

      // Rate limiting disabled: should not block
      for (let i = 0; i < 200; i++) {
        const result = mw.processRequest(makeRequest());
        expect(result.blocked).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Combined stack
  // -------------------------------------------------------------------------

  describe("combined middleware stack", () => {
    it("should apply checks in order: rate limit -> host -> cors -> origin", () => {
      let now = 1000;
      const mw = new SecurityMiddleware(
        {
          rateLimit: { maxRequests: 1, windowMs: 60000 },
        },
        () => now,
      );

      // First request passes
      const r1 = mw.processRequest(makeRequest());
      expect(r1.blocked).toBe(false);

      // Second request is rate limited (429, not 403)
      const r2 = mw.processRequest(makeRequest());
      expect(r2.blocked).toBe(true);
      expect(r2.statusCode).toBe(429); // Rate limit hits before host check
    });

    it("should add security headers to all responses", () => {
      const mw = new SecurityMiddleware();

      const response = mw.processRequest(
        makeRequest({
          headers: {
            host: "localhost:3100",
            origin: "http://localhost:3000",
          },
        }),
      );

      // Should have CORS headers
      expect(response.headers["Access-Control-Allow-Methods"]).toBeTruthy();
      expect(response.headers["Access-Control-Allow-Headers"]).toBeTruthy();
    });
  });
});
