/**
 * IssueWorkflow - Agent-from-issue automation.
 *
 * Orchestrates the full workflow of:
 * 1. Parsing issue body for agent task description
 * 2. Creating a worktree for the issue
 * 3. Spawning an agent with issue context
 * 4. Creating a PR when agent completes
 * 5. Updating the issue with a link to the PR
 *
 * @module issue-workflow
 */

import type {
  GitHubApiClient,
  IssueWorkflowOptions,
  Issue,
  PullRequest,
} from "./types.js";
import { WorktreeManager } from "./worktree-manager.js";
import { PRManager } from "./pr-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed task description from an issue body.
 */
export interface ParsedTask {
  /** Short summary of what needs to be done. */
  summary: string;
  /** Detailed description of the task. */
  description: string;
  /** Files or paths mentioned in the issue. */
  mentionedFiles: string[];
  /** Labels extracted from the issue. */
  labels: string[];
}

/**
 * Status of an issue workflow execution.
 */
export type IssueWorkflowStatus =
  | "pending"
  | "worktree_created"
  | "agent_running"
  | "pr_created"
  | "completed"
  | "failed";

/**
 * Result of a completed issue workflow.
 */
export interface IssueWorkflowResult {
  issueNumber: number;
  status: IssueWorkflowStatus;
  worktreePath?: string;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}

/**
 * Callback for spawning an agent on a worktree.
 */
export type AgentSpawnFn = (
  worktreePath: string,
  task: ParsedTask,
  issueContext: Issue,
) => Promise<{ success: boolean; error?: string }>;

// ---------------------------------------------------------------------------
// IssueWorkflow
// ---------------------------------------------------------------------------

/**
 * Orchestrates the agent-from-issue workflow.
 *
 * Connects GitHub issues to agents by:
 * 1. Fetching and parsing the issue
 * 2. Creating a dedicated worktree
 * 3. Spawning an agent to work on the issue
 * 4. Creating a PR with the agent's changes
 * 5. Linking the PR back to the issue
 */
export class IssueWorkflow {
  private readonly apiClient: GitHubApiClient;
  private readonly worktreeManager: WorktreeManager;
  private readonly prManager: PRManager;
  private readonly workflows = new Map<string, IssueWorkflowResult>();

  constructor(
    apiClient: GitHubApiClient,
    worktreeManager: WorktreeManager,
    prManager: PRManager,
  ) {
    this.apiClient = apiClient;
    this.worktreeManager = worktreeManager;
    this.prManager = prManager;
  }

  /**
   * Parse an issue body for task description, mentioned files, etc.
   *
   * @param issue - The GitHub issue.
   * @returns Parsed task information.
   */
  parseIssueBody(issue: Issue): ParsedTask {
    const body = issue.body ?? "";

    // Extract mentioned files (paths like src/foo.ts or ./bar/baz.js)
    const filePattern = /(?:^|\s)((?:\.\/|src\/|lib\/|test\/|packages\/)[^\s,)]+)/gm;
    const mentionedFiles: string[] = [];
    let fileMatch;
    while ((fileMatch = filePattern.exec(body)) !== null) {
      mentionedFiles.push(fileMatch[1].trim());
    }

    // Also find backtick-quoted file paths
    const backtickPattern = /`([^`]*\/[^`]+)`/g;
    let backtickMatch;
    while ((backtickMatch = backtickPattern.exec(body)) !== null) {
      const path = backtickMatch[1].trim();
      if (!mentionedFiles.includes(path)) {
        mentionedFiles.push(path);
      }
    }

    // Extract a summary: first line of the body, or the title
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    const summary = lines[0]?.replace(/^#+\s*/, "").trim() ?? issue.title;

    return {
      summary,
      description: body,
      mentionedFiles,
      labels: issue.labels,
    };
  }

  /**
   * Fetch an issue from GitHub.
   *
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param issueNumber - Issue number.
   * @returns The issue.
   */
  async fetchIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<Issue> {
    const response = await this.apiClient.get<{
      id: number;
      number: number;
      title: string;
      body: string | null;
      state: string;
      labels: Array<{ name: string }>;
      assignees: Array<{ login: string }>;
      url: string;
      html_url: string;
      created_at: string;
      updated_at: string;
    }>(`/repos/${owner}/${repo}/issues/${issueNumber}`);

    return {
      id: response.id,
      number: response.number,
      title: response.title,
      body: response.body ?? "",
      state: response.state as "open" | "closed",
      labels: response.labels.map((l) => l.name),
      assignees: response.assignees.map((a) => a.login),
      url: response.url,
      htmlUrl: response.html_url,
      createdAt: response.created_at,
      updatedAt: response.updated_at,
    };
  }

  /**
   * Execute the full issue-to-PR workflow.
   *
   * @param options - Workflow options.
   * @param spawnAgent - Callback to spawn an agent.
   * @returns The workflow result.
   */
  async execute(
    options: IssueWorkflowOptions,
    spawnAgent: AgentSpawnFn,
  ): Promise<IssueWorkflowResult> {
    const workflowKey = `${options.owner}/${options.repo}#${options.issueNumber}`;
    const result: IssueWorkflowResult = {
      issueNumber: options.issueNumber,
      status: "pending",
    };
    this.workflows.set(workflowKey, result);

    try {
      // 1. Fetch and parse the issue
      const issue = await this.fetchIssue(
        options.owner,
        options.repo,
        options.issueNumber,
      );
      const task = this.parseIssueBody(issue);

      // 2. Create a worktree for this issue
      const branchName = `agent/issue-${options.issueNumber}`;
      const worktree = await this.worktreeManager.create(
        options.repoPath,
        branchName,
        { baseBranch: options.baseBranch },
      );

      result.worktreePath = worktree.path;
      result.branchName = branchName;
      result.status = "worktree_created";
      this.workflows.set(workflowKey, { ...result });

      // 3. Spawn the agent
      result.status = "agent_running";
      this.workflows.set(workflowKey, { ...result });

      const agentResult = await spawnAgent(worktree.path, task, issue);

      if (!agentResult.success) {
        result.status = "failed";
        result.error = agentResult.error ?? "Agent execution failed";
        this.workflows.set(workflowKey, { ...result });
        return result;
      }

      // 4. Create a PR
      const baseBranch = options.baseBranch ?? "main";
      const pr = await this.prManager.createPR({
        owner: options.owner,
        repo: options.repo,
        title: `Fix #${options.issueNumber}: ${task.summary}`,
        body: `Closes #${options.issueNumber}\n\n${task.description}`,
        head: branchName,
        base: baseBranch,
        labels: options.labels,
      });

      result.prNumber = pr.number;
      result.prUrl = pr.htmlUrl;
      result.status = "pr_created";
      this.workflows.set(workflowKey, { ...result });

      // 5. Add a comment on the issue linking to the PR
      await this.apiClient.post(
        `/repos/${options.owner}/${options.repo}/issues/${options.issueNumber}/comments`,
        {
          body: `A pull request has been created to address this issue: ${pr.htmlUrl}`,
        },
      );

      result.status = "completed";
      this.workflows.set(workflowKey, { ...result });
      return result;
    } catch (error) {
      result.status = "failed";
      result.error =
        error instanceof Error ? error.message : "Unknown error";
      this.workflows.set(workflowKey, { ...result });
      return result;
    }
  }

  /**
   * Get the status of a workflow.
   *
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param issueNumber - Issue number.
   * @returns The workflow result, or undefined if not found.
   */
  getWorkflowStatus(
    owner: string,
    repo: string,
    issueNumber: number,
  ): IssueWorkflowResult | undefined {
    const key = `${owner}/${repo}#${issueNumber}`;
    return this.workflows.get(key);
  }

  /**
   * List all tracked workflows.
   */
  listWorkflows(): IssueWorkflowResult[] {
    return Array.from(this.workflows.values());
  }
}

export type { IssueWorkflowOptions };
