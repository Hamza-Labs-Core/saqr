import { describe, it, expect } from "vitest";
import {
  BUILT_IN_PROVIDERS,
  ALL_PROVIDERS,
  isAgentProvider,
  PROVIDER_INFO,
  PROVIDER_CAPABILITIES,
  AGENT_LIFECYCLE_STATES,
} from "../agents/index.js";
import type {
  AgentProvider,
  ProviderInfo,
  ProviderCapabilities,
  AgentLifecycleState,
} from "../agents/index.js";

describe("agents/types", () => {
  describe("ALL_PROVIDERS", () => {
    it("should contain exactly 4 providers", () => {
      expect(ALL_PROVIDERS).toHaveLength(4);
    });

    it("should include claude-code, opencode, codex, and custom", () => {
      expect(ALL_PROVIDERS).toContain("claude-code");
      expect(ALL_PROVIDERS).toContain("opencode");
      expect(ALL_PROVIDERS).toContain("codex");
      expect(ALL_PROVIDERS).toContain("custom");
    });
  });

  describe("BUILT_IN_PROVIDERS", () => {
    it("should contain exactly 3 providers (no custom)", () => {
      expect(BUILT_IN_PROVIDERS).toHaveLength(3);
      expect(BUILT_IN_PROVIDERS).not.toContain("custom");
    });
  });

  describe("isAgentProvider", () => {
    it("should return true for all valid providers", () => {
      for (const provider of ALL_PROVIDERS) {
        expect(isAgentProvider(provider)).toBe(true);
      }
    });

    it("should return false for invalid providers", () => {
      expect(isAgentProvider("github-copilot")).toBe(false);
      expect(isAgentProvider("")).toBe(false);
      expect(isAgentProvider("Claude-Code")).toBe(false);
    });
  });

  describe("PROVIDER_INFO", () => {
    it("should have info for every provider", () => {
      for (const provider of ALL_PROVIDERS) {
        const info: ProviderInfo = PROVIDER_INFO[provider];
        expect(info).toBeDefined();
        expect(info.provider).toBe(provider);
        expect(info.displayName).toBeTruthy();
        expect(info.description).toBeTruthy();
        expect(info.hookMechanism).toBeTruthy();
      }
    });

    it("should have correct hook mechanisms", () => {
      expect(PROVIDER_INFO["claude-code"].hookMechanism).toBe("settings-json");
      expect(PROVIDER_INFO["opencode"].hookMechanism).toBe("plugin");
      expect(PROVIDER_INFO["codex"].hookMechanism).toBe("jsonl-watcher");
      expect(PROVIDER_INFO["custom"].hookMechanism).toBe("stdin-stdout");
    });
  });

  describe("PROVIDER_CAPABILITIES", () => {
    it("should have capabilities for every provider", () => {
      for (const provider of ALL_PROVIDERS) {
        const caps: ProviderCapabilities = PROVIDER_CAPABILITIES[provider];
        expect(caps).toBeDefined();
        expect(typeof caps.subAgents).toBe("boolean");
        expect(typeof caps.compaction).toBe("boolean");
        expect(typeof caps.permissions).toBe("boolean");
        expect(typeof caps.sessionResume).toBe("boolean");
        expect(typeof caps.streaming).toBe("boolean");
        expect(typeof caps.modelSelection).toBe("boolean");
      }
    });

    it("should report correct capabilities for Claude Code", () => {
      const caps = PROVIDER_CAPABILITIES["claude-code"];
      expect(caps.subAgents).toBe(true);
      expect(caps.compaction).toBe(true);
      expect(caps.permissions).toBe(false);
      expect(caps.sessionResume).toBe(true);
    });

    it("should report no sub-agents for OpenCode and Codex", () => {
      expect(PROVIDER_CAPABILITIES["opencode"].subAgents).toBe(false);
      expect(PROVIDER_CAPABILITIES["codex"].subAgents).toBe(false);
    });

    it("should report permissions for OpenCode and Codex but not Claude Code", () => {
      expect(PROVIDER_CAPABILITIES["claude-code"].permissions).toBe(false);
      expect(PROVIDER_CAPABILITIES["opencode"].permissions).toBe(true);
      expect(PROVIDER_CAPABILITIES["codex"].permissions).toBe(true);
    });

    it("should report minimal capabilities for custom provider", () => {
      const caps = PROVIDER_CAPABILITIES["custom"];
      expect(caps.subAgents).toBe(false);
      expect(caps.compaction).toBe(false);
      expect(caps.permissions).toBe(false);
      expect(caps.sessionResume).toBe(false);
      expect(caps.streaming).toBe(false);
      expect(caps.modelSelection).toBe(false);
    });
  });

  describe("AGENT_LIFECYCLE_STATES", () => {
    it("should contain all lifecycle states", () => {
      expect(AGENT_LIFECYCLE_STATES).toEqual([
        "initializing",
        "idle",
        "running",
        "error",
        "closed",
      ]);
    });

    it("should be usable as AgentLifecycleState type (compile-time check)", () => {
      const state: AgentLifecycleState = "running";
      expect(AGENT_LIFECYCLE_STATES).toContain(state);
    });
  });

  describe("AgentProvider type", () => {
    it("should accept all valid provider strings (compile-time check)", () => {
      const providers: AgentProvider[] = [
        "claude-code",
        "opencode",
        "codex",
        "custom",
      ];
      expect(providers).toHaveLength(4);
    });
  });
});
