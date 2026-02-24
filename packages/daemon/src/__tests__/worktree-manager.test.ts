/**
 * Tests for WorktreeManager - git worktree creation and management.
 *
 * Uses a real temporary git repository to test:
 *   - Worktree creation with branch
 *   - Worktree listing
 *   - Worktree removal
 *   - isGitRepo detection
 *   - Non-git directory handling
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorktreeManager } from "../agents/worktree-manager.js";
import { WorktreeFailedError } from "../agents/errors.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

describe("WorktreeManager", () => {
  let wm: WorktreeManager;
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    wm = new WorktreeManager();

    // Create a temporary directory with a git repo
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "saqr-wt-test-"));
    repoDir = path.join(tempDir, "test-repo");
    await fs.mkdir(repoDir, { recursive: true });

    // Initialize git repo with an initial commit
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: repoDir,
    });
    await fs.writeFile(path.join(repoDir, "README.md"), "# Test\n");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "initial"], {
      cwd: repoDir,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      // Remove worktrees first (git worktree prune)
      await execFileAsync("git", ["worktree", "prune"], { cwd: repoDir });
    } catch {
      // Ignore
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // -----------------------------------------------------------------------
  // isGitRepo
  // -----------------------------------------------------------------------

  describe("isGitRepo", () => {
    it("returns true for a git repository", async () => {
      expect(await wm.isGitRepo(repoDir)).toBe(true);
    });

    it("returns false for a non-git directory", async () => {
      const nonGitDir = path.join(tempDir, "not-a-repo");
      await fs.mkdir(nonGitDir, { recursive: true });
      expect(await wm.isGitRepo(nonGitDir)).toBe(false);
    });

    it("returns false for a nonexistent path", async () => {
      expect(await wm.isGitRepo("/tmp/this-does-not-exist-xyz")).toBe(
        false,
      );
    });
  });

  // -----------------------------------------------------------------------
  // createWorktree
  // -----------------------------------------------------------------------

  describe("createWorktree", () => {
    it("creates a worktree with a new branch", async () => {
      const result = await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/test1",
      });

      expect(result.branchName).toBe("agent/test1");
      expect(result.projectPath).toBe(repoDir);
      expect(result.commitHash).toBeTruthy();
      expect(result.commitHash).not.toBe("unknown");

      // Verify the worktree directory exists
      const stat = await fs.stat(result.path);
      expect(stat.isDirectory()).toBe(true);

      // Verify the branch exists in the worktree
      const { stdout: branch } = await execFileAsync(
        "git",
        ["branch", "--show-current"],
        { cwd: result.path },
      );
      expect(branch.trim()).toBe("agent/test1");
    });

    it("places worktree in .agent-worktrees sibling directory", async () => {
      const result = await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/feature",
      });

      const expectedBase = path.resolve(repoDir, "..", ".agent-worktrees");
      expect(result.path.startsWith(expectedBase)).toBe(true);
    });

    it("throws WorktreeFailedError for non-git directory", async () => {
      const nonGitDir = path.join(tempDir, "not-git");
      await fs.mkdir(nonGitDir, { recursive: true });

      await expect(
        wm.createWorktree({
          projectPath: nonGitDir,
          branchName: "agent/test",
        }),
      ).rejects.toThrow(WorktreeFailedError);
    });

    it("creates multiple worktrees for the same repo", async () => {
      const wt1 = await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/wt1",
      });
      const wt2 = await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/wt2",
      });

      expect(wt1.path).not.toBe(wt2.path);
      expect(wt1.branchName).toBe("agent/wt1");
      expect(wt2.branchName).toBe("agent/wt2");

      // Both directories should exist
      await expect(fs.stat(wt1.path)).resolves.toBeTruthy();
      await expect(fs.stat(wt2.path)).resolves.toBeTruthy();
    });

    it("forks from specified baseBranch", async () => {
      // Create a second branch with a different file
      await execFileAsync("git", ["checkout", "-b", "develop"], {
        cwd: repoDir,
      });
      await fs.writeFile(
        path.join(repoDir, "develop.txt"),
        "develop content\n",
      );
      await execFileAsync("git", ["add", "."], { cwd: repoDir });
      await execFileAsync("git", ["commit", "-m", "develop commit"], {
        cwd: repoDir,
      });
      await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

      const wt = await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/from-develop",
        baseBranch: "develop",
      });

      // The worktree should have the develop.txt file
      const exists = await fs
        .stat(path.join(wt.path, "develop.txt"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // listWorktrees
  // -----------------------------------------------------------------------

  describe("listWorktrees", () => {
    it("lists main worktree when no extras exist", async () => {
      const worktrees = await wm.listWorktrees(repoDir);
      // At minimum, the main repo is listed as a worktree
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
    });

    it("lists created worktrees", async () => {
      await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/list1",
      });
      await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/list2",
      });

      const worktrees = await wm.listWorktrees(repoDir);
      // Main + 2 worktrees
      expect(worktrees.length).toBeGreaterThanOrEqual(3);

      const branches = worktrees.map((w) => w.branchName);
      expect(branches).toContain("agent/list1");
      expect(branches).toContain("agent/list2");
    });

    it("returns empty array for non-git directory", async () => {
      const nonGitDir = path.join(tempDir, "not-git-list");
      await fs.mkdir(nonGitDir, { recursive: true });
      const worktrees = await wm.listWorktrees(nonGitDir);
      expect(worktrees).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // removeWorktree
  // -----------------------------------------------------------------------

  describe("removeWorktree", () => {
    it("removes a created worktree", async () => {
      const wt = await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/remove-me",
      });

      // Verify it exists
      await expect(fs.stat(wt.path)).resolves.toBeTruthy();

      // Remove it
      await wm.removeWorktree(wt.path);

      // Verify directory is gone
      const exists = await fs
        .stat(wt.path)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it("branch is preserved after worktree removal", async () => {
      const wt = await wm.createWorktree({
        projectPath: repoDir,
        branchName: "agent/preserve-branch",
      });

      await wm.removeWorktree(wt.path);

      // Branch should still exist in the repo
      const { stdout: branches } = await execFileAsync(
        "git",
        ["branch", "--list", "agent/preserve-branch"],
        { cwd: repoDir },
      );
      expect(branches.trim()).toContain("agent/preserve-branch");
    });

    it("throws WorktreeFailedError for invalid worktree path", async () => {
      await expect(
        wm.removeWorktree("/tmp/nonexistent-worktree-path-xyz"),
      ).rejects.toThrow(WorktreeFailedError);
    });
  });
});
