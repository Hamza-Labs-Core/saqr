/**
 * GitHubIntegration - Main entry point for GitHub App integration.
 *
 * Provides a unified facade over all GitHub integration modules:
 * auth, repository browsing, worktree management, PR management,
 * webhook handling, issue workflows, and notification routing.
 *
 * @module github-integration
 */

import type { GitHubAppConfig, GitHubApiClient, TokenStorage } from "./types.js";
import { GitHubAuth } from "./auth.js";
import { RepositoryBrowser } from "./repository-browser.js";
import { WorktreeManager } from "./worktree-manager.js";
import { PRManager } from "./pr-manager.js";
import { WebhookHandler } from "./webhook-handler.js";
import { IssueWorkflow } from "./issue-workflow.js";
import { NotificationRouter } from "./notification-router.js";

/**
 * Configuration options for GitHubIntegration.
 */
export interface GitHubIntegrationConfig {
  appConfig: GitHubAppConfig;
  apiClient: GitHubApiClient;
  tokenStorage?: TokenStorage;
  cacheTtlMs?: number;
  maxNotificationHistory?: number;
}

/**
 * Unified facade for all GitHub integration features.
 *
 * Initializes and wires together all sub-modules, providing
 * a single entry point for the Saqr agent platform.
 */
export class GitHubIntegration {
  readonly auth: GitHubAuth;
  readonly repositories: RepositoryBrowser;
  readonly worktrees: WorktreeManager;
  readonly pullRequests: PRManager;
  readonly webhooks: WebhookHandler;
  readonly issueWorkflows: IssueWorkflow;
  readonly notifications: NotificationRouter;

  constructor(config: GitHubIntegrationConfig) {
    this.auth = new GitHubAuth(
      config.appConfig,
      config.apiClient,
      config.tokenStorage,
    );

    this.repositories = new RepositoryBrowser(
      config.apiClient,
      config.cacheTtlMs,
    );

    this.worktrees = new WorktreeManager();

    this.pullRequests = new PRManager(config.apiClient);

    this.webhooks = new WebhookHandler(
      config.appConfig.webhookSecret ?? "",
    );

    this.issueWorkflows = new IssueWorkflow(
      config.apiClient,
      this.worktrees,
      this.pullRequests,
    );

    this.notifications = new NotificationRouter(
      config.maxNotificationHistory,
    );
  }
}
