/**
 * TypeScript types for GitHub data used across the @saqr/github package.
 *
 * Includes types for repositories, branches, pull requests, issues,
 * check runs, webhook event payloads, and API response envelopes.
 *
 * @module types
 */

// ---------------------------------------------------------------------------
// Core GitHub Entities
// ---------------------------------------------------------------------------

/**
 * Represents a GitHub repository.
 */
export interface Repository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  sshUrl: string;
  topics: string[];
  language: string | null;
  updatedAt: string;
}

/**
 * Represents a branch in a GitHub repository.
 */
export interface Branch {
  name: string;
  sha: string;
  protected: boolean;
}

/**
 * Status of a pull request.
 */
export type PRStatus = "open" | "closed" | "merged" | "draft";

/**
 * Represents a GitHub pull request.
 */
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PRStatus;
  headBranch: string;
  baseBranch: string;
  url: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  labels: string[];
  reviewers: string[];
  assignees: string[];
}

/**
 * Represents a GitHub issue.
 */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  url: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Conclusion of a check run.
 */
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped"
  | "stale"
  | null;

/**
 * Represents a GitHub check run.
 */
export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: CheckRunConclusion;
  headSha: string;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Webhook Event Payloads
// ---------------------------------------------------------------------------

/**
 * Base shape for all webhook events.
 */
export interface WebhookEvent<T = unknown> {
  action: string;
  sender: { login: string; id: number };
  repository?: { id: number; full_name: string; owner: { login: string }; name: string };
  installation?: { id: number };
  payload: T;
}

/**
 * Payload for push events.
 */
export interface PushEventPayload {
  ref: string;
  before: string;
  after: string;
  commits: Array<{
    id: string;
    message: string;
    author: { name: string; email: string };
    added: string[];
    removed: string[];
    modified: string[];
  }>;
}

/**
 * Payload for pull_request events.
 */
export interface PullRequestEventPayload {
  action: string;
  number: number;
  pull_request: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: string;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    html_url: string;
    user: { login: string };
    labels: Array<{ name: string }>;
    requested_reviewers: Array<{ login: string }>;
    assignees: Array<{ login: string }>;
    merged: boolean;
    merged_at: string | null;
  };
}

/**
 * Payload for issues events.
 */
export interface IssuesEventPayload {
  action: string;
  issue: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    user: { login: string };
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
  };
}

/**
 * Payload for check_run events.
 */
export interface CheckRunEventPayload {
  action: string;
  check_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    html_url: string;
    started_at: string | null;
    completed_at: string | null;
    output: {
      title: string | null;
      summary: string | null;
    };
  };
}

/**
 * Payload for pull_request_review events.
 */
export interface PullRequestReviewEventPayload {
  action: string;
  review: {
    id: number;
    body: string | null;
    state: "approved" | "changes_requested" | "commented" | "dismissed";
    user: { login: string };
    html_url: string;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
  };
}

/**
 * Payload for pull_request review comment events.
 */
export interface PullRequestReviewCommentEventPayload {
  action: string;
  comment: {
    id: number;
    body: string;
    user: { login: string };
    html_url: string;
    path: string;
    line: number | null;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
  };
}

// ---------------------------------------------------------------------------
// GitHub API Response Types
// ---------------------------------------------------------------------------

/**
 * Paginated response from the GitHub API.
 */
export interface PaginatedResponse<T> {
  items: T[];
  totalCount: number;
  hasNextPage: boolean;
  nextPage: number | null;
}

/**
 * Options for creating a pull request.
 */
export interface PRCreateOptions {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
  assignees?: string[];
}

/**
 * GitHub App installation token response.
 */
export interface InstallationToken {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
  repositorySelection: "all" | "selected";
}

/**
 * GitHub App configuration for authentication.
 */
export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
}

/**
 * OAuth device code response.
 */
export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * OAuth access token response.
 */
export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: string;
  scope: string;
}

// ---------------------------------------------------------------------------
// Token Storage Interface
// ---------------------------------------------------------------------------

/**
 * Interface for secure token storage.
 */
export interface TokenStorage {
  /** Store a token by key. */
  store(key: string, token: string): Promise<void>;
  /** Retrieve a token by key. Returns null if not found. */
  retrieve(key: string): Promise<string | null>;
  /** Delete a token by key. */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// GitHub API Client Interface (for testing)
// ---------------------------------------------------------------------------

/**
 * Interface for GitHub API calls. All modules depend on this interface
 * rather than making direct HTTP calls, enabling easy testing with mocks.
 */
export interface GitHubApiClient {
  /** Make a GET request to the GitHub API. */
  get<T = unknown>(path: string, params?: Record<string, string>): Promise<T>;
  /** Make a POST request to the GitHub API. */
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Make a PATCH request to the GitHub API. */
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Make a PUT request to the GitHub API. */
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Make a DELETE request to the GitHub API. */
  delete<T = unknown>(path: string): Promise<T>;
}

// ---------------------------------------------------------------------------
// Worktree Types
// ---------------------------------------------------------------------------

/**
 * Represents a git worktree used for agent work.
 */
export interface Worktree {
  /** Absolute path to the worktree directory. */
  path: string;
  /** The branch checked out in this worktree. */
  branch: string;
  /** The repository this worktree belongs to. */
  repoPath: string;
  /** Agent ID using this worktree, if any. */
  agentId?: string;
  /** Timestamp when the worktree was created. */
  createdAt: Date;
}

/**
 * Describes a conflict between worktrees on the same repo.
 */
export interface WorktreeConflict {
  /** Path to the first worktree. */
  worktreePath1: string;
  /** Path to the second worktree. */
  worktreePath2: string;
  /** Files that conflict. */
  conflictingFiles: string[];
  /** Description of the conflict. */
  description: string;
}

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

/**
 * Priority levels for notifications.
 */
export type NotificationPriority = "info" | "warning" | "critical";

/**
 * A notification to be routed to a connected client.
 */
export interface Notification {
  id: string;
  type: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  repository?: string;
  prNumber?: number;
  url?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Issue Workflow Types
// ---------------------------------------------------------------------------

/**
 * Options for the agent-from-issue workflow.
 */
export interface IssueWorkflowOptions {
  owner: string;
  repo: string;
  issueNumber: number;
  repoPath: string;
  baseBranch?: string;
  labels?: string[];
  assignAgent?: string;
}

// ---------------------------------------------------------------------------
// Git Command Runner Interface (for testing)
// ---------------------------------------------------------------------------

/**
 * Interface for running git commands. Abstracted for testability.
 */
export interface GitCommandRunner {
  /** Run a git command and return stdout. */
  run(args: string[], cwd: string): Promise<string>;
}
