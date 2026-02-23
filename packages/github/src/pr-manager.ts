/**
 * PRManager - Pull request lifecycle management.
 *
 * Handles creating PRs from agent worktree work, applying templates,
 * managing labels/reviewers/assignees, and tracking PR status.
 *
 * @module pr-manager
 */

import type {
  GitHubApiClient,
  PRCreateOptions,
  PRStatus,
  PullRequest,
  GitCommandRunner,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default Git Command Runner
// ---------------------------------------------------------------------------

class DefaultGitRunner implements GitCommandRunner {
  async run(args: string[], cwd: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  }
}

// ---------------------------------------------------------------------------
// PR Template
// ---------------------------------------------------------------------------

/**
 * A PR template that auto-generates title and body from commit info.
 */
export interface PRTemplate {
  /** Template for the PR title. Use {branch}, {issueNumber}, {summary}. */
  titleTemplate: string;
  /** Template for the PR body. Use {commits}, {files}, {issueNumber}. */
  bodyTemplate: string;
}

/**
 * Default PR template used when none is specified.
 */
export const DEFAULT_PR_TEMPLATE: PRTemplate = {
  titleTemplate: "{summary}",
  bodyTemplate: `## Changes

{commits}

## Files Changed

{files}

---
*Created by Saqr agent*`,
};

// ---------------------------------------------------------------------------
// PRManager
// ---------------------------------------------------------------------------

/**
 * Manages pull request lifecycle for agent workflows.
 *
 * Provides automatic change detection, PR creation with templates,
 * label/reviewer management, and status tracking.
 */
export class PRManager {
  private readonly apiClient: GitHubApiClient;
  private readonly git: GitCommandRunner;
  private readonly statusCache = new Map<number, PRStatus>();

  constructor(apiClient: GitHubApiClient, gitRunner?: GitCommandRunner) {
    this.apiClient = apiClient;
    this.git = gitRunner ?? new DefaultGitRunner();
  }

  /**
   * Create a PR from agent worktree work. Auto-detects changes and
   * generates title/body from commits.
   *
   * @param options - PR creation options.
   * @returns The created pull request.
   */
  async createPR(options: PRCreateOptions): Promise<PullRequest> {
    const response = await this.apiClient.post<{
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
      url: string;
      html_url: string;
      created_at: string;
      updated_at: string;
      merged_at: string | null;
      labels: Array<{ name: string }>;
      requested_reviewers: Array<{ login: string }>;
      assignees: Array<{ login: string }>;
      draft: boolean;
    }>(`/repos/${options.owner}/${options.repo}/pulls`, {
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
      draft: options.draft ?? false,
    });

    const pr = mapApiPR(response);

    // Add labels if specified
    if (options.labels && options.labels.length > 0) {
      await this.addLabels(options.owner, options.repo, pr.number, options.labels);
      pr.labels = options.labels;
    }

    // Add reviewers if specified
    if (options.reviewers && options.reviewers.length > 0) {
      await this.addReviewers(
        options.owner,
        options.repo,
        pr.number,
        options.reviewers,
      );
      pr.reviewers = options.reviewers;
    }

    // Add assignees if specified
    if (options.assignees && options.assignees.length > 0) {
      await this.addAssignees(
        options.owner,
        options.repo,
        pr.number,
        options.assignees,
      );
      pr.assignees = options.assignees;
    }

    this.statusCache.set(pr.number, pr.state);
    return pr;
  }

  /**
   * Create a PR from a worktree with auto-detected changes.
   *
   * @param worktreePath - Path to the agent worktree.
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param head - The head branch name.
   * @param base - The base branch name.
   * @param template - Optional PR template.
   * @returns The created pull request.
   */
  async createPRFromWorktree(
    worktreePath: string,
    owner: string,
    repo: string,
    head: string,
    base: string,
    template?: PRTemplate,
  ): Promise<PullRequest> {
    const tpl = template ?? DEFAULT_PR_TEMPLATE;

    // Get commit messages
    const commitsOutput = await this.git.run(
      ["log", `${base}..${head}`, "--oneline"],
      worktreePath,
    );
    const commits = commitsOutput.trim();

    // Get changed files
    const filesOutput = await this.git.run(
      ["diff", "--name-only", `${base}...${head}`],
      worktreePath,
    );
    const files = filesOutput.trim();

    // Generate title from first commit or branch name
    const firstCommitLine = commits.split("\n")[0] ?? head;
    const summary = firstCommitLine.replace(/^[a-f0-9]+\s+/, "");

    const title = tpl.titleTemplate.replace("{summary}", summary).replace("{branch}", head);
    const body = tpl.bodyTemplate
      .replace("{commits}", commits || "No commits")
      .replace("{files}", files || "No files changed");

    return this.createPR({
      owner,
      repo,
      title,
      body,
      head,
      base,
    });
  }

  /**
   * Get the current status of a PR.
   *
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param prNumber - PR number.
   * @returns The current PR status.
   */
  async getStatus(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRStatus> {
    const response = await this.apiClient.get<{
      state: string;
      merged: boolean;
      draft: boolean;
    }>(`/repos/${owner}/${repo}/pulls/${prNumber}`);

    let status: PRStatus;
    if (response.merged) {
      status = "merged";
    } else if (response.draft) {
      status = "draft";
    } else if (response.state === "closed") {
      status = "closed";
    } else {
      status = "open";
    }

    this.statusCache.set(prNumber, status);
    return status;
  }

  /**
   * Get a pull request by number.
   *
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param prNumber - PR number.
   * @returns The pull request details.
   */
  async getPR(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequest> {
    const response = await this.apiClient.get<{
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
      url: string;
      html_url: string;
      created_at: string;
      updated_at: string;
      merged_at: string | null;
      labels: Array<{ name: string }>;
      requested_reviewers: Array<{ login: string }>;
      assignees: Array<{ login: string }>;
      draft: boolean;
      merged: boolean;
    }>(`/repos/${owner}/${repo}/pulls/${prNumber}`);

    return mapApiPR(response);
  }

  /**
   * Add labels to a PR.
   */
  async addLabels(
    owner: string,
    repo: string,
    prNumber: number,
    labels: string[],
  ): Promise<void> {
    await this.apiClient.post(
      `/repos/${owner}/${repo}/issues/${prNumber}/labels`,
      { labels },
    );
  }

  /**
   * Add reviewers to a PR.
   */
  async addReviewers(
    owner: string,
    repo: string,
    prNumber: number,
    reviewers: string[],
  ): Promise<void> {
    await this.apiClient.post(
      `/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
      { reviewers },
    );
  }

  /**
   * Add assignees to a PR.
   */
  async addAssignees(
    owner: string,
    repo: string,
    prNumber: number,
    assignees: string[],
  ): Promise<void> {
    await this.apiClient.post(
      `/repos/${owner}/${repo}/issues/${prNumber}/assignees`,
      { assignees },
    );
  }

  /**
   * Get cached status for a PR (no API call).
   */
  getCachedStatus(prNumber: number): PRStatus | undefined {
    return this.statusCache.get(prNumber);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapApiPR(raw: {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
  url: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  labels: Array<{ name: string }>;
  requested_reviewers: Array<{ login: string }>;
  assignees: Array<{ login: string }>;
  draft?: boolean;
  merged?: boolean;
}): PullRequest {
  let state: PRStatus;
  if (raw.merged) {
    state = "merged";
  } else if (raw.draft) {
    state = "draft";
  } else if (raw.state === "closed") {
    state = "closed";
  } else {
    state = "open";
  }

  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state,
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    url: raw.url,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at,
    labels: raw.labels.map((l) => l.name),
    reviewers: raw.requested_reviewers.map((r) => r.login),
    assignees: raw.assignees.map((a) => a.login),
  };
}

export type { PRCreateOptions, PRStatus };
