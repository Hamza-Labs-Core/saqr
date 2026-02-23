/**
 * Tests for WorktreeManager - worktree CRUD, conflict detection, agent tracking.
 *
 * Uses a mock GitCommandRunner to avoid actual git operations.
 * All tests that call create() provide a writable worktreeBase in /tmp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorktreeManager } from "../worktree-manager.js";
import type { GitCommandRunner } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockGitRunner(): GitCommandRunner & {
  run: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn().mockResolvedValue(""),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreeManager", () => {
  let git: ReturnType<typeof createMockGitRunner>;
  let wm: WorktreeManager;
  let tempDir: string;

  beforeEach(async () => {
    git = createMockGitRunner();
    wm = new WorktreeManager(git);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "saqr-gh-wt-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe("create", () => {
    it("creates a worktree with a new branch", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const result = await wm.create(repoPath, "feature/test");

      expect(git.run).toHaveBeenCalledWith(
        expect.arrayContaining(["worktree", "add", "-b", "feature/test"]),
        repoPath,
      );
      expect(result.branch).toBe("feature/test");
      expect(result.repoPath).toBe(repoPath);
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("creates worktree from specified base branch", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      await wm.create(repoPath, "fix/bug", { baseBranch: "develop" });

      expect(git.run).toHaveBeenCalledWith(
        expect.arrayContaining(["worktree", "add", "-b", "fix/bug"]),
        repoPath,
      );
      const args = git.run.mock.calls[0][0];
      expect(args).toContain("develop");
    });

    it("falls back to checkout if branch already exists", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      git.run.mockRejectedValueOnce(new Error("already exists"));
      git.run.mockResolvedValueOnce(""); // second call succeeds

      const result = await wm.create(repoPath, "existing-branch");

      expect(git.run).toHaveBeenCalledTimes(2);
      expect(result.branch).toBe("existing-branch");
    });

    it("throws if git command fails with non-exists error", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      git.run.mockRejectedValue(new Error("fatal: unknown error"));

      await expect(wm.create(repoPath, "bad")).rejects.toThrow("unknown error");
    });

    it("assigns agent ID when provided", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const result = await wm.create(repoPath, "agent-work", {
        agentId: "agent-123",
      });

      expect(result.agentId).toBe("agent-123");
    });

    it("uses custom worktree base directory", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });
      const customBase = path.join(tempDir, "custom-worktrees");

      const result = await wm.create(repoPath, "custom-base", {
        worktreeBase: customBase,
      });

      expect(result.path).toContain(customBase);
    });

    it("generates unique paths for multiple worktrees", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const wt1 = await wm.create(repoPath, "branch-a");
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 2));
      const wt2 = await wm.create(repoPath, "branch-b");

      expect(wt1.path).not.toBe(wt2.path);
    });
  });

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  describe("list", () => {
    it("parses porcelain worktree output", async () => {
      git.run.mockResolvedValue(
        [
          "worktree /repo",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /worktrees/repo-feature",
          "HEAD def456",
          "branch refs/heads/feature",
          "",
        ].join("\n"),
      );

      const worktrees = await wm.list("/repo");

      expect(worktrees).toHaveLength(2);
      expect(worktrees[0].path).toBe("/repo");
      expect(worktrees[0].branch).toBe("main");
      expect(worktrees[1].path).toBe("/worktrees/repo-feature");
      expect(worktrees[1].branch).toBe("feature");
    });

    it("returns empty array when git fails", async () => {
      git.run.mockRejectedValue(new Error("not a git repo"));

      const result = await wm.list("/not-a-repo");
      expect(result).toEqual([]);
    });

    it("includes agent tracking info for known worktrees", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      // First create a worktree so it's tracked
      const created = await wm.create(repoPath, "tracked-branch", {
        agentId: "agent-42",
      });

      git.run.mockResolvedValue(
        [
          `worktree ${created.path}`,
          "HEAD abc123",
          "branch refs/heads/tracked-branch",
          "",
        ].join("\n"),
      );

      const listed = await wm.list(repoPath);
      const tracked = listed.find((w) => w.path === created.path);
      expect(tracked?.agentId).toBe("agent-42");
    });

    it("uses HEAD as fallback branch name", async () => {
      git.run.mockResolvedValue(
        ["worktree /repo", "HEAD abc123", "detached", ""].join("\n"),
      );

      const worktrees = await wm.list("/repo");
      expect(worktrees[0].branch).toBe("HEAD");
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe("remove", () => {
    it("removes a worktree by path", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      // Create first so it's tracked
      const wt = await wm.create(repoPath, "to-remove");
      git.run.mockClear();

      await wm.remove(wt.path);

      expect(git.run).toHaveBeenCalledWith(
        ["worktree", "remove", wt.path],
        repoPath,
      );
    });

    it("supports force removal", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const wt = await wm.create(repoPath, "force-remove");
      git.run.mockClear();

      await wm.remove(wt.path, true);

      expect(git.run).toHaveBeenCalledWith(
        ["worktree", "remove", "--force", wt.path],
        repoPath,
      );
    });

    it("removes worktree from internal tracking", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const wt = await wm.create(repoPath, "track-test", {
        agentId: "agent-1",
      });

      await wm.remove(wt.path);

      expect(wm.getWorktreeForAgent("agent-1")).toBeUndefined();
    });

    it("throws if worktree path is unknown and git fails", async () => {
      git.run.mockRejectedValue(new Error("fatal"));

      await expect(wm.remove("/unknown/path")).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // detectConflicts
  // -----------------------------------------------------------------------

  describe("detectConflicts", () => {
    it("detects files modified in multiple worktrees", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      // Create two worktrees
      const wt1 = await wm.create(repoPath, "branch-1");
      const wt2 = await wm.create(repoPath, "branch-2");

      // Mock list to return both
      const listOutput = [
        `worktree ${wt1.path}`,
        "HEAD aaa",
        "branch refs/heads/branch-1",
        "",
        `worktree ${wt2.path}`,
        "HEAD bbb",
        "branch refs/heads/branch-2",
        "",
      ].join("\n");

      // Order: list call, then diff for each worktree
      git.run
        .mockResolvedValueOnce(listOutput) // list
        .mockResolvedValueOnce("src/index.ts\nsrc/utils.ts") // diff wt1
        .mockResolvedValueOnce("src/index.ts\npackage.json"); // diff wt2

      const conflicts = await wm.detectConflicts(repoPath);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].conflictingFiles).toEqual(["src/index.ts"]);
      expect(conflicts[0].worktreePath1).toBe(wt1.path);
      expect(conflicts[0].worktreePath2).toBe(wt2.path);
    });

    it("returns empty array when no conflicts", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const wt1 = await wm.create(repoPath, "safe-1");
      const wt2 = await wm.create(repoPath, "safe-2");

      const listOutput = [
        `worktree ${wt1.path}`,
        "HEAD aaa",
        "branch refs/heads/safe-1",
        "",
        `worktree ${wt2.path}`,
        "HEAD bbb",
        "branch refs/heads/safe-2",
        "",
      ].join("\n");

      git.run
        .mockResolvedValueOnce(listOutput)
        .mockResolvedValueOnce("src/a.ts")
        .mockResolvedValueOnce("src/b.ts");

      const conflicts = await wm.detectConflicts(repoPath);
      expect(conflicts).toEqual([]);
    });

    it("skips worktrees that fail diff", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const wt1 = await wm.create(repoPath, "ok-branch");

      const listOutput = [
        `worktree ${wt1.path}`,
        "HEAD aaa",
        "branch refs/heads/ok-branch",
        "",
        "worktree /broken/wt",
        "HEAD bbb",
        "branch refs/heads/broken",
        "",
      ].join("\n");

      git.run
        .mockResolvedValueOnce(listOutput)
        .mockResolvedValueOnce("src/a.ts") // wt1 diff
        .mockRejectedValueOnce(new Error("broken")); // broken wt diff

      const conflicts = await wm.detectConflicts(repoPath);
      expect(conflicts).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Agent tracking
  // -----------------------------------------------------------------------

  describe("agent tracking", () => {
    it("assignAgent updates the agent ID", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const wt = await wm.create(repoPath, "track-me");

      wm.assignAgent(wt.path, "new-agent");

      const found = wm.getWorktreeForAgent("new-agent");
      expect(found).toBeDefined();
      expect(found!.path).toBe(wt.path);
    });

    it("getWorktreeForAgent returns undefined for unknown agent", () => {
      expect(wm.getWorktreeForAgent("ghost")).toBeUndefined();
    });

    it("getWorktreeForAgent finds the right worktree", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      await wm.create(repoPath, "other", { agentId: "agent-a" });
      const target = await wm.create(repoPath, "target", {
        agentId: "agent-b",
      });

      const found = wm.getWorktreeForAgent("agent-b");
      expect(found?.path).toBe(target.path);
    });
  });
});
