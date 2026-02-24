import { describe, it, expect } from "vitest";
import * as shared from "../index.js";

describe("@saqr/shared barrel export", () => {
  describe("events exports", () => {
    it("should export UNIFIED_EVENT_TYPES", () => {
      expect(shared.UNIFIED_EVENT_TYPES).toBeDefined();
      expect(shared.UNIFIED_EVENT_TYPES).toHaveLength(12);
    });

    it("should export isUnifiedEventType", () => {
      expect(typeof shared.isUnifiedEventType).toBe("function");
      expect(shared.isUnifiedEventType("SessionStarted")).toBe(true);
    });

    it("should export createUnifiedEvent", () => {
      expect(typeof shared.createUnifiedEvent).toBe("function");
    });

    it("should export EVENT_MAPPING_TABLE", () => {
      expect(shared.EVENT_MAPPING_TABLE).toBeDefined();
      expect(shared.EVENT_MAPPING_TABLE).toHaveLength(12);
    });

    it("should export NATIVE_TO_UNIFIED", () => {
      expect(shared.NATIVE_TO_UNIFIED).toBeDefined();
      expect(shared.NATIVE_TO_UNIFIED["claude-code"]).toBeDefined();
    });

    it("should export getNativeEventName and getUnifiedEventType", () => {
      expect(typeof shared.getNativeEventName).toBe("function");
      expect(typeof shared.getUnifiedEventType).toBe("function");
    });
  });

  describe("agents exports", () => {
    it("should export BUILT_IN_PROVIDERS", () => {
      expect(shared.BUILT_IN_PROVIDERS).toBeDefined();
      expect(shared.BUILT_IN_PROVIDERS).toHaveLength(3);
    });

    it("should export ALL_PROVIDERS", () => {
      expect(shared.ALL_PROVIDERS).toBeDefined();
      expect(shared.ALL_PROVIDERS).toHaveLength(4);
    });

    it("should export isAgentProvider", () => {
      expect(typeof shared.isAgentProvider).toBe("function");
      expect(shared.isAgentProvider("claude-code")).toBe(true);
    });

    it("should export PROVIDER_INFO", () => {
      expect(shared.PROVIDER_INFO).toBeDefined();
      expect(shared.PROVIDER_INFO["claude-code"].displayName).toBe("Claude Code");
    });

    it("should export PROVIDER_CAPABILITIES", () => {
      expect(shared.PROVIDER_CAPABILITIES).toBeDefined();
      expect(shared.PROVIDER_CAPABILITIES["claude-code"].subAgents).toBe(true);
    });

    it("should export AGENT_LIFECYCLE_STATES", () => {
      expect(shared.AGENT_LIFECYCLE_STATES).toBeDefined();
      expect(shared.AGENT_LIFECYCLE_STATES).toHaveLength(5);
    });
  });

  describe("sessions exports", () => {
    it("should export SESSION_MODES", () => {
      expect(shared.SESSION_MODES).toBeDefined();
      expect(shared.SESSION_MODES).toHaveLength(3);
    });

    it("should export isSessionMode", () => {
      expect(typeof shared.isSessionMode).toBe("function");
      expect(shared.isSessionMode("managed")).toBe(true);
    });
  });

  describe("crypto exports", () => {
    it("should export KEY_PURPOSES", () => {
      expect(shared.KEY_PURPOSES).toBeDefined();
      expect(shared.KEY_PURPOSES).toHaveLength(3);
    });

    it("should export DEFAULT_KEY_DERIVATION_PARAMS", () => {
      expect(shared.DEFAULT_KEY_DERIVATION_PARAMS).toBeDefined();
      expect(shared.DEFAULT_KEY_DERIVATION_PARAMS.memoryCost).toBe(65536);
    });
  });

  describe("complete export surface", () => {
    it("should export all expected runtime values", () => {
      const expectedExports = [
        // Events
        "UNIFIED_EVENT_TYPES",
        "isUnifiedEventType",
        "createUnifiedEvent",
        "EVENT_MAPPING_TABLE",
        "NATIVE_TO_UNIFIED",
        "getNativeEventName",
        "getUnifiedEventType",
        // Agents
        "BUILT_IN_PROVIDERS",
        "ALL_PROVIDERS",
        "isAgentProvider",
        "PROVIDER_INFO",
        "PROVIDER_CAPABILITIES",
        "AGENT_LIFECYCLE_STATES",
        // Sessions
        "SESSION_MODES",
        "isSessionMode",
        // Crypto
        "KEY_PURPOSES",
        "DEFAULT_KEY_DERIVATION_PARAMS",
      ];

      for (const name of expectedExports) {
        expect(shared).toHaveProperty(name);
      }
    });
  });
});
