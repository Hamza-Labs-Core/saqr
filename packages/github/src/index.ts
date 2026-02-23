/**
 * @saqr/github - GitHub integration for the Saqr Agent Management Platform.
 *
 * Provides:
 * - GitHub App authentication (JWT, installation tokens, OAuth)
 * - Repository browsing with caching
 * - Git worktree management for parallel agent work
 * - Pull request lifecycle management
 * - Webhook handling with signature verification
 * - Agent-from-issue workflow automation
 * - Notification routing for PR reviews and CI failures
 *
 * @packageDocumentation
 */

// -- Main Facade -------------------------------------------------------------
export { GitHubIntegration } from "./github-integration.js";
export type { GitHubIntegrationConfig } from "./github-integration.js";

// -- Auth --------------------------------------------------------------------
export { GitHubAuth, createAppJWT, requestInstallationToken, InMemoryTokenStorage } from "./auth.js";

// -- Repository Browser ------------------------------------------------------
export { RepositoryBrowser } from "./repository-browser.js";
export type { FileTreeEntry } from "./repository-browser.js";

// -- Worktree Manager --------------------------------------------------------
export { WorktreeManager } from "./worktree-manager.js";

// -- PR Manager --------------------------------------------------------------
export { PRManager, DEFAULT_PR_TEMPLATE } from "./pr-manager.js";
export type { PRTemplate } from "./pr-manager.js";

// -- Webhook Handler ---------------------------------------------------------
export { WebhookHandler, verifyWebhookSignature } from "./webhook-handler.js";
export type {
  WebhookEventType,
  WebhookEventHandler,
  PRReviewNotification,
  CIFailureInfo,
} from "./webhook-handler.js";

// -- Issue Workflow ----------------------------------------------------------
export { IssueWorkflow } from "./issue-workflow.js";
export type {
  ParsedTask,
  IssueWorkflowStatus,
  IssueWorkflowResult,
  AgentSpawnFn,
} from "./issue-workflow.js";

// -- Notification Router -----------------------------------------------------
export { NotificationRouter } from "./notification-router.js";
export type {
  NotificationHandler,
  NotificationFilter,
} from "./notification-router.js";

// -- Types -------------------------------------------------------------------
export type {
  Repository,
  Branch,
  PRStatus,
  PullRequest,
  Issue,
  CheckRunConclusion,
  CheckRun,
  WebhookEvent,
  PushEventPayload,
  PullRequestEventPayload,
  IssuesEventPayload,
  CheckRunEventPayload,
  PullRequestReviewEventPayload,
  PullRequestReviewCommentEventPayload,
  PaginatedResponse,
  PRCreateOptions,
  InstallationToken,
  GitHubAppConfig,
  DeviceCodeResponse,
  OAuthTokenResponse,
  TokenStorage,
  GitHubApiClient,
  Worktree,
  WorktreeConflict,
  Notification,
  NotificationPriority,
  IssueWorkflowOptions,
  GitCommandRunner,
} from "./types.js";
