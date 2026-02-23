/**
 * Tests for HostAllowlist — HTTP host validation, DNS rebinding, and CORS.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  HostAllowlist,
  validateHost,
  corsHeaders,
} from "../security/host-allowlist.js";

describe("HostAllowlist", () => {
  let allowlist: HostAllowlist;

  beforeEach(() => {
    allowlist = new HostAllowlist();
  });

  // -------------------------------------------------------------------------
  // Host validation
  // -------------------------------------------------------------------------

  describe("isHostAllowed", () => {
    it("should allow localhost", () => {
      expect(allowlist.isHostAllowed("localhost")).toBe(true);
    });

    it("should allow 127.0.0.1", () => {
      expect(allowlist.isHostAllowed("127.0.0.1")).toBe(true);
    });

    it("should allow ::1", () => {
      expect(allowlist.isHostAllowed("::1")).toBe(true);
    });

    it("should allow [::1]", () => {
      expect(allowlist.isHostAllowed("[::1]")).toBe(true);
    });

    it("should allow localhost with port", () => {
      expect(allowlist.isHostAllowed("localhost:3100")).toBe(true);
    });

    it("should allow 127.0.0.1 with port", () => {
      expect(allowlist.isHostAllowed("127.0.0.1:3100")).toBe(true);
    });

    it("should allow [::1] with port", () => {
      expect(allowlist.isHostAllowed("[::1]:3100")).toBe(true);
    });

    it("should reject external hosts", () => {
      expect(allowlist.isHostAllowed("evil.com")).toBe(false);
    });

    it("should reject DNS rebinding host", () => {
      expect(allowlist.isHostAllowed("attacker.example.com")).toBe(false);
    });

    it("should reject empty host header", () => {
      expect(allowlist.isHostAllowed("")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(allowlist.isHostAllowed("LOCALHOST")).toBe(true);
      expect(allowlist.isHostAllowed("LocalHost:3100")).toBe(true);
    });

    it("should reject hosts with similar prefixes", () => {
      expect(allowlist.isHostAllowed("localhost.evil.com")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Custom allowlist
  // -------------------------------------------------------------------------

  describe("custom allowlist", () => {
    it("should accept custom allowed hosts", () => {
      const custom = new HostAllowlist({
        allowedHosts: ["myapp.local", "192.168.1.100"],
      });

      expect(custom.isHostAllowed("myapp.local")).toBe(true);
      expect(custom.isHostAllowed("192.168.1.100:8080")).toBe(true);
      expect(custom.isHostAllowed("localhost")).toBe(false);
    });

    it("should support dynamic host addition", () => {
      expect(allowlist.isHostAllowed("custom.local")).toBe(false);

      allowlist.addHost("custom.local");
      expect(allowlist.isHostAllowed("custom.local")).toBe(true);
    });

    it("should support host removal", () => {
      expect(allowlist.isHostAllowed("localhost")).toBe(true);

      const removed = allowlist.removeHost("localhost");
      expect(removed).toBe(true);
      expect(allowlist.isHostAllowed("localhost")).toBe(false);
    });

    it("should return false when removing non-existent host", () => {
      const removed = allowlist.removeHost("nonexistent.com");
      expect(removed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Origin validation
  // -------------------------------------------------------------------------

  describe("isOriginAllowed", () => {
    it("should allow localhost origins", () => {
      expect(allowlist.isOriginAllowed("http://localhost")).toBe(true);
      expect(allowlist.isOriginAllowed("http://127.0.0.1")).toBe(true);
    });

    it("should allow localhost origins with any port", () => {
      expect(allowlist.isOriginAllowed("http://localhost:3000")).toBe(true);
      expect(allowlist.isOriginAllowed("http://127.0.0.1:8080")).toBe(true);
    });

    it("should reject non-localhost origins", () => {
      expect(allowlist.isOriginAllowed("https://evil.com")).toBe(false);
    });

    it("should allow requests with no Origin header by default", () => {
      expect(allowlist.isOriginAllowed(undefined)).toBe(true);
      expect(allowlist.isOriginAllowed("")).toBe(true);
    });

    it("should reject no-Origin when configured", () => {
      const strict = new HostAllowlist({ allowNoOrigin: false });
      expect(strict.isOriginAllowed(undefined)).toBe(false);
    });

    it("should support custom origins", () => {
      const custom = new HostAllowlist({
        allowedOrigins: ["https://myapp.example.com"],
      });

      expect(custom.isOriginAllowed("https://myapp.example.com")).toBe(true);
      expect(custom.isOriginAllowed("https://evil.com")).toBe(false);
    });

    it("should support dynamic origin management", () => {
      expect(allowlist.isOriginAllowed("https://new.example.com")).toBe(false);

      allowlist.addOrigin("https://new.example.com");
      expect(allowlist.isOriginAllowed("https://new.example.com")).toBe(true);

      allowlist.removeOrigin("https://new.example.com");
      expect(allowlist.isOriginAllowed("https://new.example.com")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // CORS headers
  // -------------------------------------------------------------------------

  describe("corsHeaders", () => {
    it("should include Access-Control-Allow-Origin for allowed origins", () => {
      const headers = allowlist.corsHeaders("http://localhost");
      expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost");
    });

    it("should not include Access-Control-Allow-Origin for disallowed origins", () => {
      const headers = allowlist.corsHeaders("https://evil.com");
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("should include Vary: Origin when origin is allowed", () => {
      const headers = allowlist.corsHeaders("http://localhost");
      expect(headers["Vary"]).toBe("Origin");
    });

    it("should include Access-Control-Allow-Methods", () => {
      const headers = allowlist.corsHeaders("http://localhost");
      expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
      expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    });

    it("should include Access-Control-Allow-Headers", () => {
      const headers = allowlist.corsHeaders("http://localhost");
      expect(headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
      expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    });

    it("should include Access-Control-Max-Age", () => {
      const headers = allowlist.corsHeaders("http://localhost");
      expect(headers["Access-Control-Max-Age"]).toBe("86400");
    });

    it("should include Access-Control-Allow-Credentials", () => {
      const headers = allowlist.corsHeaders("http://localhost");
      expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    });

    it("should support custom max-age", () => {
      const custom = new HostAllowlist({ corsMaxAge: 3600 });
      const headers = custom.corsHeaders("http://localhost");
      expect(headers["Access-Control-Max-Age"]).toBe("3600");
    });

    it("should support custom methods and headers", () => {
      const custom = new HostAllowlist({
        allowedMethods: ["GET", "POST"],
        allowedHeaders: ["X-Custom-Header"],
      });

      const headers = custom.corsHeaders("http://localhost");
      expect(headers["Access-Control-Allow-Methods"]).toBe("GET, POST");
      expect(headers["Access-Control-Allow-Headers"]).toBe("X-Custom-Header");
    });
  });

  // -------------------------------------------------------------------------
  // Convenience functions
  // -------------------------------------------------------------------------

  describe("validateHost convenience function", () => {
    it("should validate localhost", () => {
      expect(validateHost("localhost")).toBe(true);
    });

    it("should reject external hosts", () => {
      expect(validateHost("evil.com")).toBe(false);
    });

    it("should accept custom config", () => {
      expect(
        validateHost("custom.local", {
          allowedHosts: ["custom.local"],
        }),
      ).toBe(true);
    });
  });

  describe("corsHeaders convenience function", () => {
    it("should return CORS headers", () => {
      const headers = corsHeaders("http://localhost");
      expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost");
    });
  });
});
