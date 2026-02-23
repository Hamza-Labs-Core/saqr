/**
 * Tests for PRManager - PR creation, status tracking, labels/reviewers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PRManager, DEFAULT_PR_TEMPLATE } from "../pr-manager.js";
import type { GitHubApiClient, GitCommandRunner } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockApiClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } satisfies GitHubApiClient;
}

function createMockGitRunner() {
  return {
    run: vi.fn().mockResolvedValue(""),
  } satisfies GitCommandRunner;
}

function makePRResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    number: 42,
    title: "Fix the bug",
    body: "This fixes the bug",
    state: "open",
    head: { ref: "fix/bug-42" },
    base: { ref: "main" },
    url: "https://api.github.com/repos/owner/repo/pulls/42",
    html_url: "https://github.com/owner/repo/pull/42",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T01:00:00Z",
    merged_at: null,
    labels: [],
    requested_reviewers: [],
    assignees: [],
    draft: false,
    merged: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PRManager", () => {
  let client: ReturnType<typeof createMockApiClient>;
  let git: ReturnType<typeof createMockGitRunner>;
  let pm: PRManager;

  beforeEach(() => {
    client = createMockApiClient();
    git = createMockGitRunner();
    pm = new PRManager(client, git);
  });

  // -----------------------------------------------------------------------
  // createPR
  // -----------------------------------------------------------------------

  describe("createPR", () => {
    it("creates a PR with correct API call", async () => {
      client.post.mockResolvedValue(makePRResponse());

      const pr = await pm.createPR({
        owner: "owner",
        repo: "repo",
        title: "Fix the bug",
        body: "This fixes the bug",
        head: "fix/bug-42",
        base: "main",
      });

      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/pulls",
        {
          title: "Fix the bug",
          body: "This fixes the bug",
          head: "fix/bug-42",
          base: "main",
          draft: false,
        },
      );
      expect(pr.number).toBe(42);
      expect(pr.title).toBe("Fix the bug");
      expect(pr.state).toBe("open");
      expect(pr.headBranch).toBe("fix/bug-42");
      expect(pr.baseBranch).toBe("main");
    });

    it("creates a draft PR", async () => {
      client.post.mockResolvedValue(
        makePRResponse({ draft: true }),
      );

      const pr = await pm.createPR({
        owner: "owner",
        repo: "repo",
        title: "WIP",
        body: "",
        head: "wip/draft",
        base: "main",
        draft: true,
      });

      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/pulls",
        expect.objectContaining({ draft: true }),
      );
      expect(pr.state).toBe("draft");
    });

    it("adds labels after PR creation", async () => {
      client.post.mockResolvedValue(makePRResponse());

      const pr = await pm.createPR({
        owner: "owner",
        repo: "repo",
        title: "Labeled",
        body: "",
        head: "feature/x",
        base: "main",
        labels: ["bug", "priority-high"],
      });

      // First call creates PR, second adds labels
      expect(client.post).toHaveBeenCalledTimes(2);
      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/issues/42/labels",
        { labels: ["bug", "priority-high"] },
      );
      expect(pr.labels).toEqual(["bug", "priority-high"]);
    });

    it("adds reviewers after PR creation", async () => {
      client.post.mockResolvedValue(makePRResponse());

      const pr = await pm.createPR({
        owner: "owner",
        repo: "repo",
        title: "Review me",
        body: "",
        head: "feature/y",
        base: "main",
        reviewers: ["alice", "bob"],
      });

      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/pulls/42/requested_reviewers",
        { reviewers: ["alice", "bob"] },
      );
      expect(pr.reviewers).toEqual(["alice", "bob"]);
    });

    it("adds assignees after PR creation", async () => {
      client.post.mockResolvedValue(makePRResponse());

      const pr = await pm.createPR({
        owner: "owner",
        repo: "repo",
        title: "Assign me",
        body: "",
        head: "feature/z",
        base: "main",
        assignees: ["charlie"],
      });

      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/issues/42/assignees",
        { assignees: ["charlie"] },
      );
      expect(pr.assignees).toEqual(["charlie"]);
    });
  });

  // -----------------------------------------------------------------------
  // createPRFromWorktree
  // -----------------------------------------------------------------------

  describe("createPRFromWorktree", () => {
    it("auto-detects changes and generates PR", async () => {
      git.run
        .mockResolvedValueOnce("abc123 Add feature\ndef456 Fix typo") // log
        .mockResolvedValueOnce("src/feature.ts\nsrc/utils.ts"); // diff

      client.post.mockResolvedValue(makePRResponse({ title: "Add feature" }));

      const pr = await pm.createPRFromWorktree(
        "/worktree",
        "owner",
        "repo",
        "feature/auto",
        "main",
      );

      expect(git.run).toHaveBeenCalledWith(
        ["log", "main..feature/auto", "--oneline"],
        "/worktree",
      );
      expect(git.run).toHaveBeenCalledWith(
        ["diff", "--name-only", "main...feature/auto"],
        "/worktree",
      );
      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/pulls",
        expect.objectContaining({
          head: "feature/auto",
          base: "main",
        }),
      );
    });

    it("uses custom PR template", async () => {
      git.run
        .mockResolvedValueOnce("abc Fix it")
        .mockResolvedValueOnce("file.ts");

      client.post.mockResolvedValue(makePRResponse());

      await pm.createPRFromWorktree(
        "/worktree",
        "owner",
        "repo",
        "fix/custom",
        "main",
        {
          titleTemplate: "[Auto] {summary}",
          bodyTemplate: "Branch: {branch}\n\nCommits:\n{commits}\n\nFiles:\n{files}",
        },
      );

      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/pulls",
        expect.objectContaining({
          title: expect.stringContaining("[Auto]"),
        }),
      );
    });

    it("handles empty commits gracefully", async () => {
      git.run
        .mockResolvedValueOnce("") // no commits
        .mockResolvedValueOnce(""); // no files

      client.post.mockResolvedValue(makePRResponse());

      const pr = await pm.createPRFromWorktree(
        "/worktree",
        "owner",
        "repo",
        "empty/branch",
        "main",
      );

      expect(pr).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------

  describe("getStatus", () => {
    it("returns open for an open PR", async () => {
      client.get.mockResolvedValue({
        state: "open",
        merged: false,
        draft: false,
      });

      const status = await pm.getStatus("owner", "repo", 42);
      expect(status).toBe("open");
    });

    it("returns merged for a merged PR", async () => {
      client.get.mockResolvedValue({
        state: "closed",
        merged: true,
        draft: false,
      });

      const status = await pm.getStatus("owner", "repo", 42);
      expect(status).toBe("merged");
    });

    it("returns closed for a closed non-merged PR", async () => {
      client.get.mockResolvedValue({
        state: "closed",
        merged: false,
        draft: false,
      });

      const status = await pm.getStatus("owner", "repo", 42);
      expect(status).toBe("closed");
    });

    it("returns draft for a draft PR", async () => {
      client.get.mockResolvedValue({
        state: "open",
        merged: false,
        draft: true,
      });

      const status = await pm.getStatus("owner", "repo", 42);
      expect(status).toBe("draft");
    });

    it("caches status result", async () => {
      client.get.mockResolvedValue({
        state: "open",
        merged: false,
        draft: false,
      });

      await pm.getStatus("owner", "repo", 42);
      expect(pm.getCachedStatus(42)).toBe("open");
    });
  });

  // -----------------------------------------------------------------------
  // getPR
  // -----------------------------------------------------------------------

  describe("getPR", () => {
    it("fetches and maps a PR", async () => {
      client.get.mockResolvedValue(
        makePRResponse({
          labels: [{ name: "enhancement" }],
          requested_reviewers: [{ login: "alice" }],
          assignees: [{ login: "bob" }],
        }),
      );

      const pr = await pm.getPR("owner", "repo", 42);

      expect(pr.labels).toEqual(["enhancement"]);
      expect(pr.reviewers).toEqual(["alice"]);
      expect(pr.assignees).toEqual(["bob"]);
      expect(pr.htmlUrl).toBe("https://github.com/owner/repo/pull/42");
    });

    it("maps merged state correctly", async () => {
      client.get.mockResolvedValue(
        makePRResponse({
          state: "closed",
          merged: true,
          merged_at: "2025-01-02T00:00:00Z",
        }),
      );

      const pr = await pm.getPR("owner", "repo", 42);
      expect(pr.state).toBe("merged");
      expect(pr.mergedAt).toBe("2025-01-02T00:00:00Z");
    });
  });

  // -----------------------------------------------------------------------
  // DEFAULT_PR_TEMPLATE
  // -----------------------------------------------------------------------

  describe("DEFAULT_PR_TEMPLATE", () => {
    it("has expected template strings", () => {
      expect(DEFAULT_PR_TEMPLATE.titleTemplate).toContain("{summary}");
      expect(DEFAULT_PR_TEMPLATE.bodyTemplate).toContain("{commits}");
      expect(DEFAULT_PR_TEMPLATE.bodyTemplate).toContain("{files}");
    });
  });
});
