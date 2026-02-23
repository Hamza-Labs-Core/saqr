import { describe, it, expect } from "vitest";
import {
  SESSION_MODES,
  isSessionMode,
} from "../sessions/index.js";
import type {
  SessionMode,
  SessionState,
  SessionMetadata,
} from "../sessions/index.js";

describe("sessions/types", () => {
  describe("SESSION_MODES", () => {
    it("should contain exactly 3 modes", () => {
      expect(SESSION_MODES).toHaveLength(3);
    });

    it("should contain observed, managed, and resumed", () => {
      expect(SESSION_MODES).toEqual(["observed", "managed", "resumed"]);
    });
  });

  describe("isSessionMode", () => {
    it("should return true for all valid session modes", () => {
      for (const mode of SESSION_MODES) {
        expect(isSessionMode(mode)).toBe(true);
      }
    });

    it("should return false for invalid session modes", () => {
      expect(isSessionMode("active")).toBe(false);
      expect(isSessionMode("")).toBe(false);
      expect(isSessionMode("OBSERVED")).toBe(false);
    });
  });

  describe("SessionState interface", () => {
    it("should accept a valid SessionState object (compile-time check)", () => {
      const state: SessionState = {
        sessionId: "sess-123",
        provider: "claude-code",
        mode: "managed",
        lifecycleState: "running",
        projectId: "my-project-a3f7b2",
        cwd: "/home/user/project",
        model: "claude-opus-4-6",
        startedAt: "2026-02-22T10:00:00.000Z",
        lastSequence: 15,
        lastPrompt: "Implement the user login feature",
        lastEventAt: "2026-02-22T10:05:00.000Z",
        agentPid: 12345,
        totalInputTokens: 50000,
        totalOutputTokens: 10000,
        toolCallCount: 8,
        errorCount: 1,
      };

      expect(state.sessionId).toBe("sess-123");
      expect(state.provider).toBe("claude-code");
      expect(state.mode).toBe("managed");
      expect(state.lifecycleState).toBe("running");
    });

    it("should accept minimal SessionState (only required fields)", () => {
      const state: SessionState = {
        sessionId: "sess-456",
        provider: "opencode",
        mode: "observed",
        lifecycleState: "idle",
        projectId: "proj-abcdef",
        cwd: "/tmp/workspace",
        startedAt: "2026-02-22T12:00:00.000Z",
        lastSequence: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        toolCallCount: 0,
        errorCount: 0,
      };

      expect(state.model).toBeUndefined();
      expect(state.endedAt).toBeUndefined();
      expect(state.parentSessionId).toBeUndefined();
    });
  });

  describe("SessionMetadata interface", () => {
    it("should accept a valid SessionMetadata object (compile-time check)", () => {
      const metadata: SessionMetadata = {
        sessionId: "sess-789",
        provider: "codex",
        mode: "managed",
        projectId: "proj-xyz123",
        cwd: "/home/user/work",
        model: "gpt-4",
        startedAt: "2026-02-22T08:00:00.000Z",
        endedAt: "2026-02-22T09:00:00.000Z",
        eventCount: 42,
        lastPrompt: "Fix the CSS layout",
        agentVersion: "codex/0.1.0",
        totalInputTokens: 100000,
        totalOutputTokens: 25000,
        toolCallCount: 15,
        exitStatus: "normal",
        machineId: "machine-abc",
      };

      expect(metadata.sessionId).toBe("sess-789");
      expect(metadata.exitStatus).toBe("normal");
      expect(metadata.machineId).toBe("machine-abc");
    });
  });
});
