/**
 * Tests for IssueWorkflow - full workflow orchestration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IssueWorkflow } from "../issue-workflow.js";
import { WorktreeManager } from "../worktree-manager.js";
import { PRManager } from "../pr-manager.js";
import type { GitHubApiClient, GitCommandRunner, Issue } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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

function makeIssueResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    number: 7,
    title: "Fix authentication bug",
    body: "The login form breaks when using `src/auth.ts`.\n\nPlease fix the validation in src/utils/validate.ts.",
    state: "open",
    labels: [{ name: "bug" }],
    assignees: [{ login: "alice" }],
    url: "https://api.github.com/repos/owner/repo/issues/7",
    html_url: "https://github.com/owner/repo/issues/7",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T01:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IssueWorkflow", () => {
  let client: ReturnType<typeof createMockApiClient>;
  let git: ReturnType<typeof createMockGitRunner>;
  let wm: WorktreeManager;
  let pm: PRManager;
  let workflow: IssueWorkflow;
  let tempDir: string;

  beforeEach(async () => {
    client = createMockApiClient();
    git = createMockGitRunner();
    wm = new WorktreeManager(git);
    pm = new PRManager(client, git);
    workflow = new IssueWorkflow(client, wm, pm);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "saqr-gh-iw-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // -----------------------------------------------------------------------
  // parseIssueBody
  // -----------------------------------------------------------------------

  describe("parseIssueBody", () => {
    it("extracts summary from first line", () => {
      const issue: Issue = {
        id: 1,
        number: 1,
        title: "Issue Title",
        body: "Fix the authentication bug\n\nMore details here.",
        state: "open",
        labels: ["bug"],
        assignees: [],
        url: "",
        htmlUrl: "",
        createdAt: "",
        updatedAt: "",
      };

      const task = workflow.parseIssueBody(issue);
      expect(task.summary).toBe("Fix the authentication bug");
    });

    it("extracts backtick-quoted file paths", () => {
      const issue: Issue = {
        id: 2,
        number: 2,
        title: "File paths",
        body: "Please update `src/auth.ts` and `packages/github/src/types.ts`.",
        state: "open",
        labels: [],
        assignees: [],
        url: "",
        htmlUrl: "",
        createdAt: "",
        updatedAt: "",
      };

      const task = workflow.parseIssueBody(issue);
      expect(task.mentionedFiles).toContain("src/auth.ts");
      expect(task.mentionedFiles).toContain("packages/github/src/types.ts");
    });

    it("extracts path-like references", () => {
      const issue: Issue = {
        id: 3,
        number: 3,
        title: "Path refs",
        body: "The bug is in src/utils/validate.ts and also lib/helper.ts",
        state: "open",
        labels: [],
        assignees: [],
        url: "",
        htmlUrl: "",
        createdAt: "",
        updatedAt: "",
      };

      const task = workflow.parseIssueBody(issue);
      expect(task.mentionedFiles).toContain("src/utils/validate.ts");
      expect(task.mentionedFiles).toContain("lib/helper.ts");
    });

    it("preserves labels from the issue", () => {
      const issue: Issue = {
        id: 4,
        number: 4,
        title: "Labels",
        body: "Fix it.",
        state: "open",
        labels: ["bug", "priority-high"],
        assignees: [],
        url: "",
        htmlUrl: "",
        createdAt: "",
        updatedAt: "",
      };

      const task = workflow.parseIssueBody(issue);
      expect(task.labels).toEqual(["bug", "priority-high"]);
    });

    it("uses title as summary for empty body", () => {
      const issue: Issue = {
        id: 5,
        number: 5,
        title: "Quick fix needed",
        body: "",
        state: "open",
        labels: [],
        assignees: [],
        url: "",
        htmlUrl: "",
        createdAt: "",
        updatedAt: "",
      };

      const task = workflow.parseIssueBody(issue);
      expect(task.summary).toBe("Quick fix needed");
    });

    it("strips markdown headers from summary", () => {
      const issue: Issue = {
        id: 6,
        number: 6,
        title: "Header test",
        body: "## Bug Description\n\nSomething is broken.",
        state: "open",
        labels: [],
        assignees: [],
        url: "",
        htmlUrl: "",
        createdAt: "",
        updatedAt: "",
      };

      const task = workflow.parseIssueBody(issue);
      expect(task.summary).toBe("Bug Description");
    });

    it("deduplicates file paths found in multiple patterns", () => {
      const issue: Issue = {
        id: 7,
        number: 7,
        title: "Dedup",
        body: "Fix `src/auth.ts` - the file src/auth.ts has a bug",
        state: "open",
        labels: [],
        assignees: [],
        url: "",
        htmlUrl: "",
        createdAt: "",
        updatedAt: "",
      };

      const task = workflow.parseIssueBody(issue);
      const authCount = task.mentionedFiles.filter(
        (f) => f === "src/auth.ts",
      ).length;
      expect(authCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // fetchIssue
  // -----------------------------------------------------------------------

  describe("fetchIssue", () => {
    it("fetches and maps an issue from the API", async () => {
      client.get.mockResolvedValue(makeIssueResponse());

      const issue = await workflow.fetchIssue("owner", "repo", 7);

      expect(client.get).toHaveBeenCalledWith("/repos/owner/repo/issues/7");
      expect(issue.number).toBe(7);
      expect(issue.title).toBe("Fix authentication bug");
      expect(issue.labels).toEqual(["bug"]);
      expect(issue.assignees).toEqual(["alice"]);
    });

    it("handles null body", async () => {
      client.get.mockResolvedValue(makeIssueResponse({ body: null }));

      const issue = await workflow.fetchIssue("owner", "repo", 7);
      expect(issue.body).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // execute (full workflow)
  // -----------------------------------------------------------------------

  describe("execute", () => {
    it("runs the full workflow: fetch -> worktree -> agent -> PR -> comment", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      // Mock: fetch issue
      client.get.mockResolvedValue(makeIssueResponse());

      // Mock: create PR (post)
      client.post.mockResolvedValue({
        id: 200,
        number: 10,
        title: "Fix #7: Fix authentication bug",
        body: "Closes #7",
        state: "open",
        head: { ref: "agent/issue-7" },
        base: { ref: "main" },
        url: "https://api.github.com/repos/owner/repo/pulls/10",
        html_url: "https://github.com/owner/repo/pull/10",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        merged_at: null,
        labels: [],
        requested_reviewers: [],
        assignees: [],
        draft: false,
        merged: false,
      });

      const spawnAgent = vi.fn().mockResolvedValue({ success: true });

      const result = await workflow.execute(
        {
          owner: "owner",
          repo: "repo",
          issueNumber: 7,
          repoPath,
        },
        spawnAgent,
      );

      expect(result.status).toBe("completed");
      expect(result.issueNumber).toBe(7);
      expect(result.prNumber).toBe(10);
      expect(result.prUrl).toBe("https://github.com/owner/repo/pull/10");
      expect(result.branchName).toBe("agent/issue-7");

      // Verify agent was spawned with correct context
      expect(spawnAgent).toHaveBeenCalledWith(
        expect.any(String), // worktree path
        expect.objectContaining({ summary: expect.any(String) }),
        expect.objectContaining({ number: 7 }),
      );

      // Verify comment was posted on the issue
      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/issues/7/comments",
        expect.objectContaining({
          body: expect.stringContaining("pull request"),
        }),
      );
    });

    it("returns failed status when agent fails", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      client.get.mockResolvedValue(makeIssueResponse());

      const spawnAgent = vi.fn().mockResolvedValue({
        success: false,
        error: "Agent crashed",
      });

      const result = await workflow.execute(
        {
          owner: "owner",
          repo: "repo",
          issueNumber: 7,
          repoPath,
        },
        spawnAgent,
      );

      expect(result.status).toBe("failed");
      expect(result.error).toBe("Agent crashed");
    });

    it("returns failed status when fetch fails", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      client.get.mockRejectedValue(new Error("Not found"));

      const spawnAgent = vi.fn();

      const result = await workflow.execute(
        {
          owner: "owner",
          repo: "repo",
          issueNumber: 999,
          repoPath,
        },
        spawnAgent,
      );

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Not found");
      expect(spawnAgent).not.toHaveBeenCalled();
    });

    it("uses custom base branch", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      client.get.mockResolvedValue(makeIssueResponse());
      client.post.mockResolvedValue({
        id: 300,
        number: 15,
        title: "Fix",
        body: "",
        state: "open",
        head: { ref: "agent/issue-7" },
        base: { ref: "develop" },
        url: "",
        html_url: "https://github.com/owner/repo/pull/15",
        created_at: "",
        updated_at: "",
        merged_at: null,
        labels: [],
        requested_reviewers: [],
        assignees: [],
      });

      const spawnAgent = vi.fn().mockResolvedValue({ success: true });

      const result = await workflow.execute(
        {
          owner: "owner",
          repo: "repo",
          issueNumber: 7,
          repoPath,
          baseBranch: "develop",
        },
        spawnAgent,
      );

      expect(result.status).toBe("completed");

      // Verify the PR was created against develop
      expect(client.post).toHaveBeenCalledWith(
        "/repos/owner/repo/pulls",
        expect.objectContaining({ base: "develop" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Workflow Status Tracking
  // -----------------------------------------------------------------------

  describe("workflow status tracking", () => {
    it("tracks workflow status", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      client.get.mockResolvedValue(makeIssueResponse());
      client.post.mockResolvedValue({
        id: 400,
        number: 20,
        title: "Fix",
        body: "",
        state: "open",
        head: { ref: "agent/issue-7" },
        base: { ref: "main" },
        url: "",
        html_url: "https://github.com/owner/repo/pull/20",
        created_at: "",
        updated_at: "",
        merged_at: null,
        labels: [],
        requested_reviewers: [],
        assignees: [],
      });

      const spawnAgent = vi.fn().mockResolvedValue({ success: true });

      await workflow.execute(
        {
          owner: "owner",
          repo: "repo",
          issueNumber: 7,
          repoPath,
        },
        spawnAgent,
      );

      const status = workflow.getWorkflowStatus("owner", "repo", 7);
      expect(status).toBeDefined();
      expect(status!.status).toBe("completed");
    });

    it("lists all workflows", async () => {
      const repoPath = path.join(tempDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      client.get.mockResolvedValue(makeIssueResponse({ number: 1 }));
      client.post.mockResolvedValue({
        id: 500,
        number: 25,
        title: "Fix",
        body: "",
        state: "open",
        head: { ref: "agent/issue-1" },
        base: { ref: "main" },
        url: "",
        html_url: "",
        created_at: "",
        updated_at: "",
        merged_at: null,
        labels: [],
        requested_reviewers: [],
        assignees: [],
      });

      const spawnAgent = vi.fn().mockResolvedValue({ success: true });
      await workflow.execute(
        { owner: "o", repo: "r", issueNumber: 1, repoPath },
        spawnAgent,
      );

      const all = workflow.listWorkflows();
      expect(all.length).toBeGreaterThanOrEqual(1);
    });

    it("returns undefined for unknown workflow", () => {
      expect(workflow.getWorkflowStatus("x", "y", 999)).toBeUndefined();
    });
  });
});
