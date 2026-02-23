/**
 * Tests for SessionStore - session persistence to disk.
 *
 * Uses temporary directories to test:
 *   - Save a session state to disk
 *   - Load a session state from disk
 *   - List saved sessions
 *   - Delete a saved session
 *   - Handle missing/corrupt data gracefully
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../agents/session-store.js";
import type { PersistedSessionState } from "../agents/session-store.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function makeSessionState(
  overrides: Partial<PersistedSessionState> = {},
): PersistedSessionState {
  return {
    sessionId: "session-001",
    providerId: "claude-code",
    model: "claude-sonnet-4-5",
    workingDirectory: "/home/user/project",
    worktreePath: "/home/user/.agent-worktrees/agent-session001",
    branchName: "agent/session001",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    state: "idle",
    turnCount: 5,
    tokenUsage: {
      inputTokens: 10000,
      outputTokens: 5000,
    },
    permissionAllowList: ["Read", "Glob", "Grep"],
    providerState: { claudeSessionId: "abc-123" },
    ...overrides,
  };
}

describe("SessionStore", () => {
  let store: SessionStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "saqr-session-store-"),
    );
    store = new SessionStore({ baseDir: tempDir });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  describe("save", () => {
    it("writes session state to disk as JSON", async () => {
      const state = makeSessionState({ sessionId: "save-test-1" });
      await store.save("save-test-1", state);

      const filePath = path.join(tempDir, "save-test-1", "handle.json");
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.sessionId).toBe("save-test-1");
      expect(parsed.providerId).toBe("claude-code");
      expect(parsed.model).toBe("claude-sonnet-4-5");
    });

    it("creates directory structure if it does not exist", async () => {
      const state = makeSessionState({ sessionId: "new-session" });
      await store.save("new-session", state);

      const dirExists = await fs
        .stat(path.join(tempDir, "new-session"))
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
    });

    it("overwrites existing state on re-save", async () => {
      const state1 = makeSessionState({
        sessionId: "overwrite-test",
        turnCount: 5,
      });
      await store.save("overwrite-test", state1);

      const state2 = makeSessionState({
        sessionId: "overwrite-test",
        turnCount: 10,
      });
      await store.save("overwrite-test", state2);

      const loaded = await store.load("overwrite-test");
      expect(loaded?.turnCount).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // Load
  // -----------------------------------------------------------------------

  describe("load", () => {
    it("loads a previously saved session state", async () => {
      const state = makeSessionState({ sessionId: "load-test" });
      await store.save("load-test", state);

      const loaded = await store.load("load-test");
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe("load-test");
      expect(loaded!.providerId).toBe("claude-code");
      expect(loaded!.turnCount).toBe(5);
      expect(loaded!.permissionAllowList).toEqual(["Read", "Glob", "Grep"]);
    });

    it("returns null for nonexistent session", async () => {
      const loaded = await store.load("does-not-exist");
      expect(loaded).toBeNull();
    });

    it("returns null for corrupt JSON", async () => {
      // Write invalid JSON
      const sessionDir = path.join(tempDir, "corrupt-session");
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionDir, "handle.json"),
        "not valid json{{{",
      );

      const loaded = await store.load("corrupt-session");
      expect(loaded).toBeNull();
    });

    it("preserves all fields through save/load cycle", async () => {
      const state = makeSessionState({
        sessionId: "roundtrip",
        worktreePath: "/custom/path",
        branchName: "agent/custom",
        turnCount: 42,
        tokenUsage: { inputTokens: 99999, outputTokens: 88888 },
        permissionAllowList: ["Write", "Bash"],
        providerState: { foo: "bar", nested: { a: 1 } },
      });

      await store.save("roundtrip", state);
      const loaded = await store.load("roundtrip");

      expect(loaded).toEqual(state);
    });
  });

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  describe("list", () => {
    it("returns empty array when no sessions saved", async () => {
      const sessions = await store.list();
      expect(sessions).toEqual([]);
    });

    it("lists all saved session IDs", async () => {
      await store.save("s1", makeSessionState({ sessionId: "s1" }));
      await store.save("s2", makeSessionState({ sessionId: "s2" }));
      await store.save("s3", makeSessionState({ sessionId: "s3" }));

      const sessions = await store.list();
      expect(sessions).toHaveLength(3);
      expect(sessions.sort()).toEqual(["s1", "s2", "s3"]);
    });

    it("does not include directories without handle.json", async () => {
      await store.save("real-session", makeSessionState({ sessionId: "real-session" }));

      // Create a directory without handle.json
      await fs.mkdir(path.join(tempDir, "orphan-dir"), { recursive: true });

      const sessions = await store.list();
      expect(sessions).toEqual(["real-session"]);
    });

    it("returns empty array when base directory does not exist", async () => {
      const noStore = new SessionStore({
        baseDir: "/tmp/saqr-nonexistent-xyz-abc",
      });
      const sessions = await noStore.list();
      expect(sessions).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  describe("delete", () => {
    it("removes a saved session from disk", async () => {
      await store.save("delete-me", makeSessionState({ sessionId: "delete-me" }));

      // Verify it exists
      const beforeDelete = await store.load("delete-me");
      expect(beforeDelete).not.toBeNull();

      await store.delete("delete-me");

      // Verify it's gone
      const afterDelete = await store.load("delete-me");
      expect(afterDelete).toBeNull();

      const listed = await store.list();
      expect(listed).not.toContain("delete-me");
    });

    it("does not throw when deleting nonexistent session", async () => {
      await expect(store.delete("nonexistent")).resolves.not.toThrow();
    });

    it("removes the entire session directory", async () => {
      await store.save("dir-check", makeSessionState({ sessionId: "dir-check" }));
      await store.delete("dir-check");

      const exists = await fs
        .stat(path.join(tempDir, "dir-check"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getBaseDir
  // -----------------------------------------------------------------------

  describe("getBaseDir", () => {
    it("returns the configured base directory", () => {
      expect(store.getBaseDir()).toBe(tempDir);
    });

    it("defaults to ~/.saqr/sessions", () => {
      const defaultStore = new SessionStore();
      const expected = path.join(os.homedir(), ".saqr", "sessions");
      expect(defaultStore.getBaseDir()).toBe(expected);
    });
  });
});
