/**
 * Tests for Deep Link Handler.
 *
 * URL scheme parsing (agentcontext://), route mapping.
 */
import { describe, it, expect } from "vitest";
import {
  parseDeepLink,
  type DeepLinkRoute,
  DEEP_LINK_SCHEME,
} from "../deep-link.js";

describe("Deep Link Handler", () => {
  describe("DEEP_LINK_SCHEME", () => {
    it("should be agentcontext", () => {
      expect(DEEP_LINK_SCHEME).toBe("agentcontext");
    });
  });

  describe("parseDeepLink", () => {
    it("should parse agent view URL", () => {
      const result = parseDeepLink("agentcontext://agent/abc123");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("agent");
      expect(result?.params.agentId).toBe("abc123");
    });

    it("should parse dashboard URL", () => {
      const result = parseDeepLink("agentcontext://dashboard");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("dashboard");
    });

    it("should parse settings URL", () => {
      const result = parseDeepLink("agentcontext://settings");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("settings");
    });

    it("should parse settings with section", () => {
      const result = parseDeepLink("agentcontext://settings/notifications");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("settings");
      expect(result?.params.section).toBe("notifications");
    });

    it("should parse agent session URL", () => {
      const result = parseDeepLink("agentcontext://agent/abc123/session/sess-456");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("agent-session");
      expect(result?.params.agentId).toBe("abc123");
      expect(result?.params.sessionId).toBe("sess-456");
    });

    it("should parse permission response URL", () => {
      const result = parseDeepLink("agentcontext://permission/req-789/approve");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("permission");
      expect(result?.params.requestId).toBe("req-789");
      expect(result?.params.action).toBe("approve");
    });

    it("should parse permission deny URL", () => {
      const result = parseDeepLink("agentcontext://permission/req-789/deny");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("permission");
      expect(result?.params.requestId).toBe("req-789");
      expect(result?.params.action).toBe("deny");
    });

    it("should return null for unknown scheme", () => {
      const result = parseDeepLink("https://example.com/agent/123");
      expect(result).toBeNull();
    });

    it("should return null for empty URL", () => {
      const result = parseDeepLink("");
      expect(result).toBeNull();
    });

    it("should return null for invalid URL", () => {
      const result = parseDeepLink("not-a-url");
      expect(result).toBeNull();
    });

    it("should return null for unknown route", () => {
      const result = parseDeepLink("agentcontext://unknown-route");
      expect(result).toBeNull();
    });

    it("should handle URL with query parameters", () => {
      const result = parseDeepLink("agentcontext://agent/abc123?focus=true");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("agent");
      expect(result?.params.agentId).toBe("abc123");
      expect(result?.queryParams?.get("focus")).toBe("true");
    });

    it("should handle URL with trailing slash", () => {
      const result = parseDeepLink("agentcontext://dashboard/");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("dashboard");
    });

    it("should handle new-agent deep link", () => {
      const result = parseDeepLink("agentcontext://new-agent");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("new-agent");
    });

    it("should handle update deep link", () => {
      const result = parseDeepLink("agentcontext://update");

      expect(result).not.toBeNull();
      expect(result?.route).toBe("update");
    });
  });
});
