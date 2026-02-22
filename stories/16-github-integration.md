# Story 16: GitHub Integration

## Overview

GitHub Integration provides first-class GitHub support for repository management and PR workflows within the AgentContext platform. It registers as a GitHub App for fine-grained permissions, exposes repository browsing from mobile/desktop clients, enables worktree-based parallel agent work from branches, automates PR creation from agent output, routes webhook-driven review notifications, converts GitHub issues into agent tasks, manages multiple worktree instances of the same repo, and triggers agent workflows from GitHub Actions CI events.

This story sits at the intersection of the daemon (F3), the event store (F2), and the mobile/desktop clients (F6/F7). The daemon is the GitHub API consumer and webhook receiver. Clients are the user-facing surfaces for browsing repos, selecting branches, and kicking off agent-from-issue workflows. The event store captures all GitHub-related activity as events for auditability and replay.

**Guiding principle**: GitHub is a first-class integration, not an afterthought. Every interaction a developer has with GitHub repositories, issues, and PRs should be orchestrable from any connected client (phone, desktop, dashboard) through the daemon -- with full event-sourced traceability.

---

## Scope

### In Scope

- GitHub App registration and manifest-based setup (F8.1)
- Installation token management and OAuth device flow
- Repository browser with search and pagination (F8.2)
- Worktree creation from any branch (F8.3)
- PR creation from agent worktree work (F8.4)
- Webhook-driven PR review notifications (F8.5)
- Agent-from-issue full workflow (F8.6)
- Multiple worktree instances with conflict detection (F8.7)
- GitHub Actions trigger for agent workflows (F8.8)
- GitHub API integration (REST v3 + GraphQL v4)
- Event capture for all GitHub-related operations

### Out of Scope (Non-Goals)

- GitLab, Bitbucket, or other forge integrations (future stories)
- Git operations beyond worktree management (rebasing, cherry-picking, etc.)
- Code review intelligence (auto-reviewing PRs with AI)
- GitHub Codespaces integration
- GitHub Packages or Container Registry integration
- Self-hosted GitHub Enterprise Server support (only github.com and GitHub Enterprise Cloud)
- Billing or GitHub Marketplace listing

---

## Requirements

### 1. GitHub App Registration (F8.1)

The system registers as a GitHub App to obtain fine-grained, revocable access to user repositories. This replaces personal access tokens with a proper OAuth-based flow that gives users control over exactly which repositories the app can access.

#### GitHub App Manifest

The app is registered using the manifest flow, which allows automated creation of GitHub Apps from a JSON descriptor.

```json
{
  "name": "AgentContext",
  "url": "https://agentcontext.dev",
  "hook_attributes": {
    "url": "https://hooks.agentcontext.dev/github/webhook",
    "active": true
  },
  "redirect_url": "http://localhost:{{DAEMON_PORT}}/github/callback",
  "callback_urls": [
    "http://localhost:{{DAEMON_PORT}}/github/callback"
  ],
  "setup_url": "http://localhost:{{DAEMON_PORT}}/github/setup",
  "public": false,
  "default_permissions": {
    "contents": "write",
    "pull_requests": "write",
    "issues": "read",
    "metadata": "read",
    "checks": "read",
    "actions": "read"
  },
  "default_events": [
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "issues",
    "issue_comment",
    "check_run",
    "check_suite",
    "workflow_run"
  ]
}
```

#### Required Permissions

| Permission | Level | Purpose |
|------------|-------|---------|
| `contents` | read/write | Clone repos, push branches, read file contents |
| `pull_requests` | read/write | Create PRs, read PR data, post comments |
| `issues` | read | Read issue details for agent-from-issue workflow |
| `metadata` | read | List repos, branches, basic repo info |
| `checks` | read | Read CI check status for PR workflows |
| `actions` | read | Read workflow run status, trigger workflow dispatch |

#### OAuth Device Flow

For headless environments (SSH sessions, remote VMs), the system uses the OAuth device flow instead of browser-based OAuth. This is critical because the daemon often runs on machines without a browser.

```bash
# Step 1: Request device and user verification codes
curl -X POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=${GITHUB_APP_CLIENT_ID}&scope=repo"

# Response:
# {
#   "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
#   "user_code": "WDJB-MJHT",
#   "verification_uri": "https://github.com/login/device",
#   "expires_in": 900,
#   "interval": 5
# }

# Step 2: Display user_code to user (via dashboard, mobile notification, or CLI)
# User visits https://github.com/login/device and enters WDJB-MJHT

# Step 3: Poll for access token
curl -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=${GITHUB_APP_CLIENT_ID}&device_code=${DEVICE_CODE}&grant_type=urn:ietf:params:oauth:grant-type:device_code"

# Response (on success):
# {
#   "access_token": "ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
#   "token_type": "bearer",
#   "scope": "repo"
# }
```

#### Installation Token Management

After the app is installed on a user's account/org, the daemon requests short-lived installation tokens for API access.

```javascript
// daemon/src/github/auth.js

const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");

class GitHubTokenManager {
  constructor(appId, privateKey) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.tokenCache = new Map(); // installationId -> { token, expiresAt }
  }

  /**
   * Get a valid installation token, refreshing if expired.
   * Installation tokens expire after 1 hour.
   */
  async getInstallationToken(installationId) {
    const cached = this.tokenCache.get(installationId);
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minute buffer before expiry

    if (cached && cached.expiresAt - bufferMs > now) {
      return cached.token;
    }

    const auth = createAppAuth({
      appId: this.appId,
      privateKey: this.privateKey,
      installationId,
    });

    const { token, expiresAt } = await auth({ type: "installation" });
    this.tokenCache.set(installationId, {
      token,
      expiresAt: new Date(expiresAt).getTime(),
    });

    return token;
  }

  /**
   * Create an authenticated Octokit instance for an installation.
   */
  async getOctokit(installationId) {
    const token = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  /**
   * Invalidate cached token (e.g., on 401 response).
   */
  invalidate(installationId) {
    this.tokenCache.delete(installationId);
  }
}
```

#### App Configuration Storage

GitHub App credentials are stored in the daemon's encrypted configuration, never in plaintext on disk.

```json
{
  "github": {
    "app_id": 123456,
    "client_id": "Iv1.xxxxxxxxxxxxxxxx",
    "private_key_path": "~/.agentcontext/github-app.pem",
    "webhook_secret": "whsec_xxxxxxxxxxxx",
    "installations": [
      {
        "id": 78901234,
        "account": "myorg",
        "account_type": "Organization",
        "repos": ["myorg/api", "myorg/frontend"],
        "added_at": "2026-02-21T10:00:00Z"
      }
    ]
  }
}
```

#### Event Capture

All GitHub authentication events are captured in the event store:

```json
{
  "event_type": "GitHubAppInstalled",
  "data": {
    "installation_id": 78901234,
    "account": "myorg",
    "account_type": "Organization",
    "repositories": ["myorg/api", "myorg/frontend"],
    "permissions": { "contents": "write", "pull_requests": "write", "issues": "read" }
  }
}
```

#### Acceptance Criteria

- [ ] GitHub App manifest is defined with all required permissions and webhook events
- [ ] OAuth device flow works for headless environments (no browser required)
- [ ] Installation tokens are cached with automatic refresh before expiry (1-hour lifetime, 5-minute buffer)
- [ ] Token refresh handles 401 responses by invalidating cache and retrying
- [ ] App credentials (private key, webhook secret) are stored securely, not in plaintext config
- [ ] GitHub App installation event is captured in the event store
- [ ] Multiple installations (personal + org) are supported simultaneously
- [ ] Uninstalling the GitHub App from GitHub triggers cleanup of cached tokens

---

### 2. Repository Browser (F8.2)

Users can browse their accessible repositories, branches, and recent PRs from any connected client (mobile, desktop, dashboard). The daemon serves as the API gateway, caching responses to minimize GitHub API rate limit consumption.

#### GitHub API Integration

The repository browser uses both REST v3 and GraphQL v4 APIs, choosing the most efficient for each query.

**List repositories (GraphQL -- fewer round trips for paginated data):**

```graphql
query ListRepos($cursor: String) {
  viewer {
    repositories(
      first: 50
      after: $cursor
      orderBy: { field: PUSHED_AT, direction: DESC }
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        nameWithOwner
        description
        defaultBranchRef {
          name
        }
        pushedAt
        isPrivate
        isArchived
        primaryLanguage {
          name
          color
        }
        pullRequests(states: OPEN, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount
          nodes {
            number
            title
            author { login }
            updatedAt
            isDraft
          }
        }
      }
    }
  }
}
```

**List branches for a repository (REST v3 -- simpler for single-resource queries):**

```bash
# GET /repos/{owner}/{repo}/branches
curl -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/myorg/api/branches?per_page=100&page=1"

# Response:
# [
#   {
#     "name": "main",
#     "commit": { "sha": "abc123...", "url": "..." },
#     "protected": true
#   },
#   {
#     "name": "feature/dark-mode",
#     "commit": { "sha": "def456..." },
#     "protected": false
#   }
# ]
```

**Search repositories:**

```bash
# GET /search/repositories
curl -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/search/repositories?q=dark-mode+user:myorg&sort=updated&per_page=20"
```

#### Response Caching

The daemon caches repository list responses to avoid hitting GitHub's API rate limits (5,000 requests/hour for authenticated requests, 30 requests/hour for GraphQL).

```javascript
// daemon/src/github/repo_cache.js

class RepoCacheEntry {
  constructor(data, ttlSeconds) {
    this.data = data;
    this.expiresAt = Date.now() + ttlSeconds * 1000;
    this.etag = null; // For conditional requests
  }

  isExpired() {
    return Date.now() > this.expiresAt;
  }
}

class RepoCache {
  constructor() {
    this.cache = new Map();
    this.TTL = {
      repoList: 300,       // 5 minutes for repo listing
      branches: 120,       // 2 minutes for branch listing
      pullRequests: 60,    // 1 minute for PR listing (changes frequently)
      repoSearch: 60,      // 1 minute for search results
    };
  }

  getCacheKey(installationId, resource, params) {
    return `${installationId}:${resource}:${JSON.stringify(params)}`;
  }

  get(installationId, resource, params) {
    const key = this.getCacheKey(installationId, resource, params);
    const entry = this.cache.get(key);
    if (!entry || entry.isExpired()) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(installationId, resource, params, data) {
    const key = this.getCacheKey(installationId, resource, params);
    const ttl = this.TTL[resource] || 60;
    this.cache.set(key, new RepoCacheEntry(data, ttl));
  }

  invalidate(installationId, resource) {
    for (const [key] of this.cache) {
      if (key.startsWith(`${installationId}:${resource}`)) {
        this.cache.delete(key);
      }
    }
  }
}
```

#### Pagination

Both GraphQL cursor-based pagination and REST link-header pagination are supported. The daemon exposes a unified pagination interface to clients.

```javascript
// Daemon API endpoint: GET /api/github/repos
// Query params: ?page=1&per_page=20&search=dark-mode

// Response:
{
  "repos": [
    {
      "full_name": "myorg/api",
      "description": "REST API backend",
      "default_branch": "main",
      "language": "TypeScript",
      "private": true,
      "archived": false,
      "pushed_at": "2026-02-20T15:30:00Z",
      "open_prs": 3
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 47,
    "has_next": true
  }
}
```

#### Acceptance Criteria

- [ ] Daemon exposes `/api/github/repos` endpoint listing accessible repositories
- [ ] Daemon exposes `/api/github/repos/:owner/:repo/branches` endpoint listing branches
- [ ] Daemon exposes `/api/github/repos/:owner/:repo/pulls` endpoint listing open PRs
- [ ] Repository search filters by name, language, and visibility
- [ ] Responses are cached with appropriate TTLs (5 min repos, 2 min branches, 1 min PRs)
- [ ] Cache is invalidated on webhook push events for affected repos
- [ ] Pagination works correctly for users with 100+ repositories
- [ ] GraphQL is used for aggregate queries, REST for single-resource queries
- [ ] API rate limit remaining is tracked and exposed via `/api/github/rate-limit`
- [ ] Private and public repositories are both listed with correct visibility indicators

---

### 3. Worktree from Branch (F8.3)

The daemon creates isolated git worktrees from any branch, enabling multiple agents to work on different branches of the same repository simultaneously without interference.

#### Worktree Creation

```bash
# Base command: create a worktree from an existing remote branch
git worktree add ../agent-worktrees/myorg-api/issue-42 -b agent/issue-42 origin/main

# Directory naming convention:
# {WORKTREE_BASE}/{owner}-{repo}/{branch-slug}
#
# Examples:
#   ../agent-worktrees/myorg-api/issue-42
#   ../agent-worktrees/myorg-api/feature-dark-mode
#   ../agent-worktrees/myorg-api/pr-review-87
```

#### Worktree Management Module

```javascript
// daemon/src/github/worktree.js

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs/promises");

class WorktreeManager {
  constructor(baseDir) {
    // Base directory for all worktrees: ~/.agentcontext/worktrees/
    this.baseDir = baseDir || path.join(
      process.env.HOME, ".agentcontext", "worktrees"
    );
  }

  /**
   * Derive a filesystem-safe slug from a branch name.
   * "feature/dark-mode" -> "feature-dark-mode"
   * "agent/issue-42"    -> "agent-issue-42"
   */
  slugify(branchName) {
    return branchName
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .substring(0, 100);
  }

  /**
   * Get the worktree directory path for a given repo and branch.
   */
  worktreePath(owner, repo, branchName) {
    const slug = this.slugify(branchName);
    return path.join(this.baseDir, `${owner}-${repo}`, slug);
  }

  /**
   * Create a worktree from a branch. If the branch does not exist
   * on the remote, create it from the specified base branch.
   */
  async create(repoPath, owner, repo, branchName, baseBranch = "main") {
    const wtPath = this.worktreePath(owner, repo, branchName);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(wtPath), { recursive: true });

    // Fetch latest from remote
    await this._git(repoPath, ["fetch", "origin"]);

    // Check if branch exists on remote
    const remoteBranches = await this._git(repoPath, [
      "ls-remote", "--heads", "origin", branchName,
    ]);

    if (remoteBranches.trim()) {
      // Branch exists on remote -- create worktree tracking it
      await this._git(repoPath, [
        "worktree", "add", wtPath, "-b", branchName,
        `origin/${branchName}`, "--track",
      ]);
    } else {
      // Branch does not exist -- create from base branch
      await this._git(repoPath, [
        "worktree", "add", wtPath, "-b", branchName,
        `origin/${baseBranch}`,
      ]);
    }

    return {
      path: wtPath,
      branch: branchName,
      baseBranch,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * List all worktrees for a repository.
   */
  async list(repoPath) {
    const output = await this._git(repoPath, [
      "worktree", "list", "--porcelain",
    ]);
    return this._parsePorcelainOutput(output);
  }

  /**
   * Remove a worktree and its branch (if safe to delete).
   */
  async remove(repoPath, wtPath, force = false) {
    const args = ["worktree", "remove", wtPath];
    if (force) args.push("--force");
    await this._git(repoPath, args);
  }

  /**
   * Execute a git command in the given directory.
   */
  _git(cwd, args) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Parse `git worktree list --porcelain` output.
   */
  _parsePorcelainOutput(output) {
    const worktrees = [];
    let current = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current);
        current = { path: line.substring(9) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.substring(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.substring(7).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      }
    }
    if (current.path) worktrees.push(current);
    return worktrees;
  }
}
```

#### Worktree Directory Convention

```
~/.agentcontext/worktrees/
  {owner}-{repo}/
    {branch-slug}/           # Each worktree is a full working copy
      .git                   # Linked back to main repo's .git
      src/
      package.json
      ...
```

#### Event Capture

```json
{
  "event_type": "WorktreeCreated",
  "data": {
    "owner": "myorg",
    "repo": "api",
    "branch": "agent/issue-42",
    "base_branch": "main",
    "worktree_path": "/home/user/.agentcontext/worktrees/myorg-api/agent-issue-42",
    "trigger": "agent-from-issue",
    "issue_number": 42
  }
}
```

#### Acceptance Criteria

- [ ] `WorktreeManager.create()` creates a git worktree from any specified branch
- [ ] If the target branch does not exist on the remote, it is created from the specified base branch
- [ ] Worktree directory follows the naming convention `{owner}-{repo}/{branch-slug}`
- [ ] Branch names are slugified for filesystem safety (slashes to hyphens, lowercase, max 100 chars)
- [ ] `WorktreeManager.list()` returns all active worktrees for a repository
- [ ] `WorktreeManager.remove()` cleans up the worktree and optionally the branch
- [ ] Remote is fetched before worktree creation to ensure up-to-date branches
- [ ] Git operations have a 30-second timeout to prevent hanging on network issues
- [ ] `WorktreeCreated` event is captured in the event store with full metadata
- [ ] Worktree creation fails gracefully if the directory already exists (idempotency)

---

### 4. PR Creation (F8.4)

When an agent completes work in a worktree, the daemon creates a pull request on GitHub. The PR includes an agent-generated summary, links to the originating issue (if applicable), and can be created as a draft.

#### PR Creation Flow

```
Agent completes work in worktree
  │
  ├─ Commit changes (agent has already done this)
  ├─ Push branch to remote
  │     git push -u origin agent/issue-42
  │
  ├─ Create PR via GitHub API
  │     POST /repos/{owner}/{repo}/pulls
  │
  ├─ Link to issue (if agent-from-issue)
  │     PR body contains "Closes #42"
  │
  ├─ Push notification: "PR ready for review"
  │
  └─ Capture PullRequestCreated event
```

#### GitHub API Call

```bash
# POST /repos/{owner}/{repo}/pulls
curl -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/myorg/api/pulls" \
  -d '{
    "title": "Add dark mode support",
    "body": "## Summary\n\nThis PR adds dark mode support as requested in #42.\n\n### Changes\n- Added `ThemeProvider` with dark/light mode toggle\n- Updated all color tokens to use CSS custom properties\n- Added dark mode preference detection via `prefers-color-scheme`\n- Updated 23 component files to use theme tokens\n\n### Agent Context\n- **Agent**: Claude Code (claude-opus-4-6)\n- **Session**: abc123-def456\n- **Duration**: 12 minutes\n- **Tool calls**: 47\n- **Files modified**: 24\n\n---\n*This PR was created by an AI agent via AgentContext. Review carefully before merging.*\n\nCloses #42",
    "head": "agent/issue-42",
    "base": "main",
    "draft": false
  }'
```

#### PR Template

```javascript
// daemon/src/github/pr_template.js

function buildPRBody({ summary, changes, agent, session, issue }) {
  const lines = [];

  lines.push("## Summary");
  lines.push("");
  lines.push(summary);
  lines.push("");

  if (changes && changes.length > 0) {
    lines.push("### Changes");
    lines.push("");
    for (const change of changes) {
      lines.push(`- ${change}`);
    }
    lines.push("");
  }

  lines.push("### Agent Context");
  lines.push("");
  lines.push(`- **Agent**: ${agent.provider} (${agent.model})`);
  lines.push(`- **Session**: ${session.id}`);
  lines.push(`- **Duration**: ${session.duration}`);
  lines.push(`- **Tool calls**: ${session.toolCallCount}`);
  lines.push(`- **Files modified**: ${session.filesModified}`);
  lines.push("");

  lines.push("---");
  lines.push(
    "*This PR was created by an AI agent via AgentContext. " +
    "Review carefully before merging.*"
  );

  if (issue) {
    lines.push("");
    lines.push(`Closes #${issue.number}`);
  }

  return lines.join("\n");
}
```

#### PR Options

| Option | Default | Description |
|--------|---------|-------------|
| `draft` | `true` | Create as draft PR (user must mark ready-for-review) |
| `link_issue` | `true` | Add "Closes #N" to body if originating from an issue |
| `auto_assign` | `true` | Assign the PR to the user who started the agent |
| `labels` | `["agent-created"]` | Labels to apply to the PR |
| `reviewers` | `[]` | Requested reviewers (from repo settings or user config) |

#### Event Capture

```json
{
  "event_type": "PullRequestCreated",
  "data": {
    "owner": "myorg",
    "repo": "api",
    "pr_number": 87,
    "pr_url": "https://github.com/myorg/api/pull/87",
    "title": "Add dark mode support",
    "head_branch": "agent/issue-42",
    "base_branch": "main",
    "draft": true,
    "linked_issue": 42,
    "agent_session_id": "abc123-def456",
    "files_changed": 24,
    "additions": 340,
    "deletions": 45
  }
}
```

#### Acceptance Criteria

- [ ] Agent worktree branch is pushed to remote before PR creation
- [ ] PR is created via the GitHub API with title, body, head, and base
- [ ] PR body includes agent summary, list of changes, and agent context metadata
- [ ] Draft PR option is supported and defaults to `true`
- [ ] Issue linking works via "Closes #N" syntax in PR body
- [ ] PR is auto-assigned to the user who initiated the agent
- [ ] Labels are applied to the PR (configurable, defaults to `["agent-created"]`)
- [ ] Push notification is sent to connected clients when PR is created
- [ ] `PullRequestCreated` event is captured in the event store
- [ ] PR creation fails gracefully if the branch has no new commits (nothing to PR)
- [ ] PR creation fails gracefully if a PR already exists for the branch

---

### 5. PR Review Notifications (F8.5)

When a PR created by an agent receives comments, reviews, or status check updates, the daemon receives webhooks from GitHub and routes notifications to connected clients.

#### Webhook Endpoint

The daemon exposes an HTTP endpoint that GitHub sends webhook payloads to. In local-only mode, this requires a tunnel (e.g., ngrok, cloudflared) or runs through the sync server relay.

```javascript
// daemon/src/github/webhook_handler.js

const crypto = require("crypto");

class WebhookHandler {
  constructor(webhookSecret, notificationRouter) {
    this.secret = webhookSecret;
    this.router = notificationRouter;
  }

  /**
   * Verify GitHub webhook signature (HMAC-SHA256).
   */
  verifySignature(payload, signature) {
    const expected = "sha256=" + crypto
      .createHmac("sha256", this.secret)
      .update(payload, "utf8")
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  }

  /**
   * Handle incoming webhook event.
   */
  async handleEvent(headers, body) {
    const event = headers["x-github-event"];
    const signature = headers["x-hub-signature-256"];
    const deliveryId = headers["x-github-delivery"];

    // Verify signature
    if (!this.verifySignature(body, signature)) {
      throw new Error("Invalid webhook signature");
    }

    const payload = JSON.parse(body);

    switch (event) {
      case "pull_request_review":
        return this._handlePRReview(payload, deliveryId);
      case "pull_request_review_comment":
        return this._handlePRReviewComment(payload, deliveryId);
      case "issue_comment":
        return this._handleIssueComment(payload, deliveryId);
      case "check_run":
        return this._handleCheckRun(payload, deliveryId);
      case "pull_request":
        return this._handlePRUpdate(payload, deliveryId);
      case "issues":
        return this._handleIssueUpdate(payload, deliveryId);
      case "workflow_run":
        return this._handleWorkflowRun(payload, deliveryId);
      default:
        // Unknown event type -- log and ignore
        return { handled: false, event };
    }
  }

  async _handlePRReview(payload, deliveryId) {
    const { action, review, pull_request, repository } = payload;
    if (action !== "submitted") return;

    const notification = {
      type: "pr_review",
      title: `Review on PR #${pull_request.number}`,
      body: `${review.user.login} ${review.state}: ${review.body || "(no comment)"}`,
      repo: repository.full_name,
      pr_number: pull_request.number,
      reviewer: review.user.login,
      state: review.state, // "approved", "changes_requested", "commented"
      url: review.html_url,
      delivery_id: deliveryId,
    };

    await this.router.send(notification);
    return { handled: true, notification };
  }

  async _handlePRReviewComment(payload, deliveryId) {
    const { action, comment, pull_request, repository } = payload;
    if (action !== "created") return;

    const notification = {
      type: "pr_review_comment",
      title: `Comment on PR #${pull_request.number}`,
      body: `${comment.user.login}: ${comment.body.substring(0, 200)}`,
      repo: repository.full_name,
      pr_number: pull_request.number,
      commenter: comment.user.login,
      file: comment.path,
      line: comment.line,
      url: comment.html_url,
      delivery_id: deliveryId,
    };

    await this.router.send(notification);
    return { handled: true, notification };
  }

  async _handleCheckRun(payload, deliveryId) {
    const { action, check_run, repository } = payload;
    if (action !== "completed") return;

    // Only notify on failures -- successes are expected
    if (check_run.conclusion === "success") return;

    const notification = {
      type: "check_failed",
      title: `CI failed: ${check_run.name}`,
      body: `${check_run.name} ${check_run.conclusion} on ${check_run.head_sha.substring(0, 7)}`,
      repo: repository.full_name,
      check_name: check_run.name,
      conclusion: check_run.conclusion,
      url: check_run.html_url,
      delivery_id: deliveryId,
    };

    await this.router.send(notification);
    return { handled: true, notification };
  }
}
```

#### Webhook Payload Example (pull_request_review)

```json
{
  "action": "submitted",
  "review": {
    "id": 1234567,
    "user": { "login": "reviewer-jane" },
    "body": "Looks good overall, but the ThemeProvider needs memoization to avoid unnecessary re-renders.",
    "state": "changes_requested",
    "html_url": "https://github.com/myorg/api/pull/87#pullrequestreview-1234567",
    "submitted_at": "2026-02-21T14:30:00Z"
  },
  "pull_request": {
    "number": 87,
    "title": "Add dark mode support",
    "user": { "login": "agentcontext[bot]" },
    "head": { "ref": "agent/issue-42" },
    "base": { "ref": "main" }
  },
  "repository": {
    "full_name": "myorg/api"
  }
}
```

#### Notification Routing

Notifications are routed to all connected clients via WebSocket (local dashboard, mobile via relay, desktop):

```javascript
// daemon/src/github/notification_router.js

class NotificationRouter {
  constructor(wsServer, pushService) {
    this.wsServer = wsServer;     // Local WebSocket connections
    this.pushService = pushService; // Push notification service (mobile/desktop)
  }

  async send(notification) {
    // 1. Send to all connected WebSocket clients (dashboard, desktop)
    this.wsServer.broadcast({
      type: "github_notification",
      payload: notification,
      timestamp: new Date().toISOString(),
    });

    // 2. Send push notification to mobile (via sync server relay)
    if (this.pushService) {
      await this.pushService.send({
        title: notification.title,
        body: notification.body,
        data: {
          type: notification.type,
          url: notification.url,
          repo: notification.repo,
        },
      });
    }

    // 3. Capture as event in the event store
    return notification;
  }
}
```

#### Event Capture

```json
{
  "event_type": "GitHubWebhookReceived",
  "data": {
    "github_event": "pull_request_review",
    "action": "submitted",
    "delivery_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "repo": "myorg/api",
    "pr_number": 87,
    "reviewer": "reviewer-jane",
    "review_state": "changes_requested"
  }
}
```

#### Acceptance Criteria

- [ ] Daemon exposes `POST /github/webhook` endpoint for receiving GitHub webhooks
- [ ] Webhook signatures are verified using HMAC-SHA256 with the configured secret
- [ ] Invalid signatures are rejected with HTTP 401
- [ ] `pull_request_review` events generate notifications with reviewer, state, and body
- [ ] `pull_request_review_comment` events generate notifications with file, line, and comment
- [ ] `check_run` completed events generate notifications only for non-success conclusions
- [ ] Notifications are broadcast to all connected WebSocket clients
- [ ] Notifications are forwarded to mobile via push notification service
- [ ] `GitHubWebhookReceived` event is captured in the event store for every handled webhook
- [ ] Duplicate webhook deliveries (same `x-github-delivery` header) are detected and ignored
- [ ] Webhook endpoint responds within 10 seconds (GitHub timeout is 10s)

---

### 6. Agent-from-Issue (F8.6)

The flagship workflow: a user sees a GitHub issue, taps "Start Agent" on their phone, and an agent is spawned in a dedicated worktree to work on that issue. This is the full data flow from the product spec.

#### Complete Data Flow

```
GitHub Issue #42: "Add dark mode support"
  │
  ├─ Webhook fires → Sync server → Push notification to mobile
  ├─ User opens app → taps "Start Agent"
  │
  ▼
Mobile App
  │
  ├─ Selects target machine (Linux VM)
  ├─ Selects provider (Claude Code)
  ├─ Agent created with worktree "agent/issue-42"
  ├─ Initial prompt: issue title + body + linked files
  │
  ▼
Daemon (Linux VM)
  │
  ├─ Creates worktree: git worktree add ../issue-42 -b agent/issue-42
  ├─ Spawns Claude Code in worktree directory
  ├─ Streams progress to mobile app via relay
  │
  ▼
Agent completes
  │
  ├─ Creates PR from worktree branch
  ├─ Links PR to issue #42
  ├─ Push notification: "PR ready for review"
```

#### Issue Context Extraction

When creating an agent from an issue, the daemon fetches the full issue context from GitHub and constructs an initial prompt.

```javascript
// daemon/src/github/issue_context.js

class IssueContextExtractor {
  constructor(octokit) {
    this.octokit = octokit;
  }

  /**
   * Extract full context from a GitHub issue for agent prompt construction.
   */
  async extract(owner, repo, issueNumber) {
    // Fetch the issue
    const { data: issue } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    // Fetch issue comments for additional context
    const { data: comments } = await this.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 20, // Last 20 comments
    });

    // Fetch linked PRs (if any) for prior work context
    const linkedPRs = await this._fetchLinkedPRs(owner, repo, issueNumber);

    // Extract file references from issue body and comments
    const referencedFiles = this._extractFileReferences(
      issue.body,
      comments.map((c) => c.body)
    );

    return {
      number: issue.number,
      title: issue.title,
      body: issue.body || "",
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.map((a) => a.login),
      author: issue.user.login,
      created_at: issue.created_at,
      comments: comments.map((c) => ({
        author: c.user.login,
        body: c.body,
        created_at: c.created_at,
      })),
      linked_prs: linkedPRs,
      referenced_files: referencedFiles,
      url: issue.html_url,
    };
  }

  /**
   * Extract file paths referenced in issue text.
   * Looks for patterns like `src/foo/bar.ts`, backtick-quoted paths,
   * and GitHub file links.
   */
  _extractFileReferences(...textArrays) {
    const files = new Set();
    const patterns = [
      // Backtick-quoted paths: `src/foo/bar.ts`
      /`([a-zA-Z0-9_/.-]+\.[a-zA-Z0-9]+)`/g,
      // GitHub blob links: github.com/owner/repo/blob/branch/path
      /github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/([^\s)]+)/g,
      // Common file path patterns: src/..., lib/..., etc.
      /(?:^|\s)((?:src|lib|app|pages|components|test|tests|spec)\/[a-zA-Z0-9_/.-]+\.[a-zA-Z0-9]+)/gm,
    ];

    const allTexts = textArrays.flat().filter(Boolean);
    for (const text of allTexts) {
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          files.add(match[1]);
        }
      }
    }

    return Array.from(files);
  }

  /**
   * Fetch PRs that reference this issue.
   */
  async _fetchLinkedPRs(owner, repo, issueNumber) {
    // Use the timeline API to find cross-references
    try {
      const { data: timeline } = await this.octokit.rest.issues.listEventsForTimeline({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });

      return timeline
        .filter((e) => e.event === "cross-referenced" && e.source?.issue?.pull_request)
        .map((e) => ({
          number: e.source.issue.number,
          title: e.source.issue.title,
          state: e.source.issue.state,
          url: e.source.issue.html_url,
        }));
    } catch {
      return [];
    }
  }
}
```

#### Initial Prompt Generation

The extracted issue context is formatted into an initial prompt for the agent:

```javascript
// daemon/src/github/prompt_builder.js

function buildAgentPrompt(issueContext, config = {}) {
  const lines = [];

  lines.push(`# Task: ${issueContext.title}`);
  lines.push("");
  lines.push(`GitHub Issue: ${issueContext.url}`);
  lines.push("");

  // Issue description
  lines.push("## Issue Description");
  lines.push("");
  lines.push(issueContext.body);
  lines.push("");

  // Labels as context hints
  if (issueContext.labels.length > 0) {
    lines.push(`**Labels**: ${issueContext.labels.join(", ")}`);
    lines.push("");
  }

  // Referenced files
  if (issueContext.referenced_files.length > 0) {
    lines.push("## Files Referenced in Issue");
    lines.push("");
    for (const file of issueContext.referenced_files) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  // Key comments (max 5 most recent)
  const recentComments = issueContext.comments.slice(-5);
  if (recentComments.length > 0) {
    lines.push("## Discussion Context");
    lines.push("");
    for (const comment of recentComments) {
      lines.push(`**${comment.author}** (${comment.created_at}):`);
      lines.push(comment.body.substring(0, 500));
      lines.push("");
    }
  }

  // Prior PR attempts
  if (issueContext.linked_prs.length > 0) {
    lines.push("## Prior PR Attempts");
    lines.push("");
    for (const pr of issueContext.linked_prs) {
      lines.push(`- PR #${pr.number}: ${pr.title} (${pr.state})`);
    }
    lines.push("");
  }

  // Instructions
  lines.push("## Instructions");
  lines.push("");
  lines.push("1. Read the referenced files (if any) to understand the current code.");
  lines.push("2. Implement the changes described in the issue.");
  lines.push("3. Write tests for your changes if the project has a test suite.");
  lines.push("4. Ensure existing tests still pass.");
  lines.push("5. Commit your changes with clear, descriptive commit messages.");
  lines.push("");

  if (config.additionalInstructions) {
    lines.push("## Additional Instructions");
    lines.push("");
    lines.push(config.additionalInstructions);
    lines.push("");
  }

  return lines.join("\n");
}
```

#### Agent-from-Issue Orchestration

```javascript
// daemon/src/github/agent_from_issue.js

class AgentFromIssueWorkflow {
  constructor(worktreeManager, agentManager, tokenManager, eventStore) {
    this.worktrees = worktreeManager;
    this.agents = agentManager;
    this.tokens = tokenManager;
    this.events = eventStore;
  }

  /**
   * Full workflow: issue -> worktree -> agent -> work -> PR
   */
  async execute({
    installationId,
    owner,
    repo,
    issueNumber,
    repoPath,
    provider = "claude-code",
    baseBranch = "main",
    draft = true,
  }) {
    const octokit = await this.tokens.getOctokit(installationId);
    const branchName = `agent/issue-${issueNumber}`;

    // 1. Extract issue context
    const extractor = new IssueContextExtractor(octokit);
    const issueContext = await extractor.extract(owner, repo, issueNumber);

    // 2. Create worktree
    const worktree = await this.worktrees.create(
      repoPath, owner, repo, branchName, baseBranch
    );

    // 3. Build initial prompt
    const prompt = buildAgentPrompt(issueContext);

    // 4. Capture workflow start event
    await this.events.append({
      event_type: "AgentFromIssueStarted",
      data: {
        owner,
        repo,
        issue_number: issueNumber,
        issue_title: issueContext.title,
        branch: branchName,
        worktree_path: worktree.path,
        provider,
      },
    });

    // 5. Spawn agent in worktree
    const agent = await this.agents.spawn({
      provider,
      workingDirectory: worktree.path,
      initialPrompt: prompt,
      metadata: {
        source: "github-issue",
        issue: issueNumber,
        repo: `${owner}/${repo}`,
      },
    });

    // 6. Wait for agent completion (async -- returns agent handle)
    // The agent will stream progress via WebSocket. On completion:
    agent.on("completed", async () => {
      await this._onAgentCompleted(
        octokit, owner, repo, issueNumber,
        issueContext, branchName, baseBranch, agent, draft
      );
    });

    return {
      agent_id: agent.id,
      worktree_path: worktree.path,
      branch: branchName,
      issue: issueContext,
    };
  }

  /**
   * Called when the agent finishes work. Creates a PR.
   */
  async _onAgentCompleted(
    octokit, owner, repo, issueNumber,
    issueContext, branchName, baseBranch, agent, draft
  ) {
    // Push the branch
    await this.worktrees._git(agent.workingDirectory, [
      "push", "-u", "origin", branchName,
    ]);

    // Create PR
    const prBody = buildPRBody({
      summary: `Implements ${issueContext.title} as described in #${issueNumber}.`,
      changes: agent.getChangeSummary(),
      agent: { provider: agent.provider, model: agent.model },
      session: {
        id: agent.sessionId,
        duration: agent.duration,
        toolCallCount: agent.toolCallCount,
        filesModified: agent.filesModified,
      },
      issue: { number: issueNumber },
    });

    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: issueContext.title,
      body: prBody,
      head: branchName,
      base: baseBranch,
      draft,
    });

    // Capture PR creation event
    await this.events.append({
      event_type: "AgentFromIssueCompleted",
      data: {
        owner,
        repo,
        issue_number: issueNumber,
        pr_number: pr.number,
        pr_url: pr.html_url,
        agent_id: agent.id,
        branch: branchName,
        duration: agent.duration,
        files_changed: agent.filesModified,
      },
    });
  }
}
```

#### Daemon API Endpoint

```javascript
// POST /api/github/agent-from-issue
// Request body:
{
  "owner": "myorg",
  "repo": "api",
  "issue_number": 42,
  "provider": "claude-code",
  "base_branch": "main",
  "draft": true,
  "additional_instructions": ""
}

// Response:
{
  "agent_id": "agent-abc123",
  "worktree_path": "/home/user/.agentcontext/worktrees/myorg-api/agent-issue-42",
  "branch": "agent/issue-42",
  "issue": {
    "number": 42,
    "title": "Add dark mode support",
    "labels": ["enhancement", "frontend"],
    "referenced_files": ["src/theme/provider.tsx", "src/styles/colors.ts"]
  },
  "status": "running"
}
```

#### Acceptance Criteria

- [ ] Full workflow executes end-to-end: issue fetch, worktree creation, agent spawn, PR creation
- [ ] Issue context extraction fetches title, body, labels, comments, linked PRs, and referenced files
- [ ] File references are extracted from backtick-quoted paths, GitHub blob links, and common path patterns
- [ ] Initial prompt includes issue title, body, labels, referenced files, discussion context, and instructions
- [ ] Agent is spawned in the worktree directory with the initial prompt
- [ ] Agent progress is streamed to connected clients via WebSocket
- [ ] On agent completion, branch is pushed and PR is created automatically
- [ ] PR body links to the originating issue with "Closes #N"
- [ ] `AgentFromIssueStarted` and `AgentFromIssueCompleted` events are captured
- [ ] Daemon exposes `POST /api/github/agent-from-issue` endpoint
- [ ] Workflow can be initiated from mobile, desktop, or dashboard

---

### 7. Multiple Repo Instances (F8.7)

The same repository can exist in multiple worktrees simultaneously, each on a different branch. This enables the branch-per-agent model where multiple agents work on different features of the same codebase without interfering with each other.

#### Branch-Per-Agent Model

```
Main repository: ~/projects/myorg-api/.git/
  │
  ├── Worktree 1: ~/.agentcontext/worktrees/myorg-api/agent-issue-42/
  │     Branch: agent/issue-42 (dark mode)
  │     Agent: Claude Code (running)
  │
  ├── Worktree 2: ~/.agentcontext/worktrees/myorg-api/agent-issue-55/
  │     Branch: agent/issue-55 (auth refactor)
  │     Agent: Claude Code (running)
  │
  └── Worktree 3: ~/.agentcontext/worktrees/myorg-api/pr-review-87/
        Branch: pr-review-87 (PR review fixes)
        Agent: Claude Code (idle)
```

#### Worktree Listing Endpoint

```javascript
// GET /api/github/repos/:owner/:repo/worktrees
// Response:
{
  "repo": "myorg/api",
  "main_path": "/home/user/projects/myorg-api",
  "worktrees": [
    {
      "path": "/home/user/.agentcontext/worktrees/myorg-api/agent-issue-42",
      "branch": "agent/issue-42",
      "head": "abc123...",
      "agent_id": "agent-abc123",
      "agent_status": "running",
      "created_at": "2026-02-21T10:00:00Z",
      "last_activity": "2026-02-21T10:15:00Z"
    },
    {
      "path": "/home/user/.agentcontext/worktrees/myorg-api/agent-issue-55",
      "branch": "agent/issue-55",
      "head": "def456...",
      "agent_id": "agent-def456",
      "agent_status": "running",
      "created_at": "2026-02-21T09:30:00Z",
      "last_activity": "2026-02-21T10:12:00Z"
    }
  ],
  "total": 2,
  "max_recommended": 5
}
```

#### Conflict Detection

When multiple agents modify files in different worktrees of the same repo, there is a risk of merge conflicts when their branches are merged into the base branch. The daemon performs lightweight conflict detection before creating new worktrees and on-demand.

```javascript
// daemon/src/github/conflict_detector.js

class ConflictDetector {
  constructor(worktreeManager) {
    this.worktrees = worktreeManager;
  }

  /**
   * Check for potential conflicts between active worktrees.
   * Uses `git diff --name-only` to compare changed files across branches.
   */
  async detectConflicts(repoPath, owner, repo) {
    const worktrees = await this.worktrees.list(repoPath);
    const conflicts = [];

    // Get modified files for each active worktree
    const worktreeFiles = new Map();
    for (const wt of worktrees) {
      if (wt.branch && !wt.bare) {
        try {
          const files = await this._getModifiedFiles(wt.path);
          worktreeFiles.set(wt.branch, {
            path: wt.path,
            files: new Set(files),
          });
        } catch {
          // Worktree may be in a broken state -- skip
        }
      }
    }

    // Compare all pairs for overlapping modified files
    const branches = Array.from(worktreeFiles.keys());
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        const a = worktreeFiles.get(branches[i]);
        const b = worktreeFiles.get(branches[j]);

        const overlap = new Set(
          [...a.files].filter((f) => b.files.has(f))
        );

        if (overlap.size > 0) {
          conflicts.push({
            branch_a: branches[i],
            branch_b: branches[j],
            conflicting_files: Array.from(overlap),
            severity: overlap.size > 5 ? "high" : "low",
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Get list of files modified in a worktree relative to its base.
   */
  async _getModifiedFiles(wtPath) {
    const output = await this.worktrees._git(wtPath, [
      "diff", "--name-only", "HEAD...origin/main",
    ]);
    return output.trim().split("\n").filter(Boolean);
  }
}
```

#### Conflict Detection API

```javascript
// GET /api/github/repos/:owner/:repo/conflicts
// Response:
{
  "repo": "myorg/api",
  "conflicts": [
    {
      "branch_a": "agent/issue-42",
      "branch_b": "agent/issue-55",
      "conflicting_files": ["src/theme/colors.ts", "src/config/theme.ts"],
      "severity": "low"
    }
  ],
  "checked_at": "2026-02-21T10:20:00Z"
}
```

#### Worktree Limits

| Constraint | Limit | Rationale |
|------------|-------|-----------|
| Max worktrees per repo | 10 | Disk space and git performance |
| Recommended worktrees | 5 | Practical parallel work limit |
| Warning threshold | 5 | Notify user when approaching limit |
| Max total disk per repo worktrees | 5 GB | Configurable per repo |

#### Acceptance Criteria

- [ ] Multiple worktrees can coexist for the same repository, each on a different branch
- [ ] `GET /api/github/repos/:owner/:repo/worktrees` lists all active worktrees with agent status
- [ ] Conflict detection identifies overlapping file modifications across worktrees
- [ ] Conflicts are classified by severity (low: 1-5 files, high: 5+ files)
- [ ] Creating a new worktree warns if it would exceed the recommended limit (5)
- [ ] Creating a new worktree is blocked if it would exceed the hard limit (10)
- [ ] Worktree removal cleans up the directory and prunes git's worktree list
- [ ] Each worktree is associated with at most one agent at a time
- [ ] Dashboard shows all active worktrees and their agent status in a unified view
- [ ] Conflict check is run automatically when a new worktree is created and results are returned in the response

---

### 8. GitHub Actions Trigger (F8.8)

Agent workflows can be triggered from GitHub Actions CI events. This enables scenarios like: CI fails on a PR, automatically spawn an agent to fix the failing tests; a nightly workflow creates issues for technical debt, agents pick them up.

#### Workflow Dispatch API

The daemon can trigger GitHub Actions workflows via the workflow dispatch API:

```bash
# POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
curl -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/myorg/api/actions/workflows/agent.yml/dispatches" \
  -d '{
    "ref": "main",
    "inputs": {
      "issue_number": "42",
      "task": "fix-failing-tests",
      "branch": "agent/fix-tests-42"
    }
  }'
```

#### Event-Driven Agent Creation

```javascript
// daemon/src/github/actions_trigger.js

class ActionsIntegration {
  constructor(webhookHandler, agentManager, worktreeManager) {
    this.webhookHandler = webhookHandler;
    this.agentManager = agentManager;
    this.worktrees = worktreeManager;

    // Register workflow_run handler
    this.webhookHandler.registerHandler(
      "workflow_run",
      this._handleWorkflowRun.bind(this)
    );
  }

  /**
   * Handle workflow_run webhook events.
   * Triggers agent creation based on configurable rules.
   */
  async _handleWorkflowRun(payload) {
    const { action, workflow_run, repository } = payload;

    // Only act on completed runs
    if (action !== "completed") return null;

    const rules = await this._getAutomationRules(repository.full_name);

    for (const rule of rules) {
      if (this._matchesRule(rule, workflow_run)) {
        return this._executeRule(rule, workflow_run, repository);
      }
    }

    return null;
  }

  /**
   * Check if a workflow run matches an automation rule.
   */
  _matchesRule(rule, workflowRun) {
    // Match by workflow name
    if (rule.workflow && rule.workflow !== workflowRun.name) return false;

    // Match by conclusion
    if (rule.on_conclusion && rule.on_conclusion !== workflowRun.conclusion) {
      return false;
    }

    // Match by branch pattern
    if (rule.branch_pattern) {
      const regex = new RegExp(rule.branch_pattern);
      if (!regex.test(workflowRun.head_branch)) return false;
    }

    return true;
  }

  /**
   * Execute an automation rule: create agent to address the workflow result.
   */
  async _executeRule(rule, workflowRun, repository) {
    const [owner, repo] = repository.full_name.split("/");

    // Get the failing job details
    const jobDetails = await this._getFailedJobs(
      owner, repo, workflowRun.id
    );

    const branchName = `agent/fix-${workflowRun.head_branch}-${workflowRun.run_number}`;

    const prompt = this._buildCIFixPrompt(workflowRun, jobDetails);

    // Create worktree and spawn agent
    const worktree = await this.worktrees.create(
      rule.repo_path, owner, repo, branchName, workflowRun.head_branch
    );

    const agent = await this.agentManager.spawn({
      provider: rule.provider || "claude-code",
      workingDirectory: worktree.path,
      initialPrompt: prompt,
      metadata: {
        source: "github-actions",
        workflow: workflowRun.name,
        run_id: workflowRun.id,
        conclusion: workflowRun.conclusion,
      },
    });

    return {
      agent_id: agent.id,
      worktree_path: worktree.path,
      branch: branchName,
      trigger: "workflow_run",
    };
  }

  /**
   * Fetch details of failed jobs within a workflow run.
   */
  async _getFailedJobs(owner, repo, runId) {
    const octokit = await this.tokens.getOctokit(this.installationId);
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      filter: "latest",
    });

    return data.jobs
      .filter((j) => j.conclusion === "failure")
      .map((j) => ({
        name: j.name,
        conclusion: j.conclusion,
        steps: j.steps
          .filter((s) => s.conclusion === "failure")
          .map((s) => ({ name: s.name, conclusion: s.conclusion })),
      }));
  }

  /**
   * Build a prompt for an agent to fix CI failures.
   */
  _buildCIFixPrompt(workflowRun, failedJobs) {
    const lines = [];

    lines.push(`# Task: Fix CI Failures`);
    lines.push("");
    lines.push(`The GitHub Actions workflow "${workflowRun.name}" failed.`);
    lines.push(`Run: ${workflowRun.html_url}`);
    lines.push(`Branch: ${workflowRun.head_branch}`);
    lines.push(`Commit: ${workflowRun.head_sha.substring(0, 7)}`);
    lines.push("");

    lines.push("## Failed Jobs");
    lines.push("");
    for (const job of failedJobs) {
      lines.push(`### ${job.name}`);
      for (const step of job.steps) {
        lines.push(`- Step "${step.name}" failed`);
      }
      lines.push("");
    }

    lines.push("## Instructions");
    lines.push("");
    lines.push("1. Run the failing tests locally to reproduce the failures.");
    lines.push("2. Analyze the test output to understand the root cause.");
    lines.push("3. Fix the code or tests as appropriate.");
    lines.push("4. Verify all tests pass locally before committing.");
    lines.push("5. Commit with a clear message explaining the fix.");
    lines.push("");

    return lines.join("\n");
  }
}
```

#### Automation Rules Configuration

Users configure automation rules that map CI events to agent actions:

```json
{
  "github_automations": [
    {
      "id": "auto-fix-tests",
      "name": "Auto-fix failing tests",
      "repo": "myorg/api",
      "repo_path": "/home/user/projects/myorg-api",
      "workflow": "CI",
      "on_conclusion": "failure",
      "branch_pattern": "^(main|develop)$",
      "provider": "claude-code",
      "enabled": true
    },
    {
      "id": "nightly-debt",
      "name": "Address tech debt issues",
      "repo": "myorg/api",
      "repo_path": "/home/user/projects/myorg-api",
      "workflow": "Nightly Audit",
      "on_conclusion": "success",
      "branch_pattern": ".*",
      "provider": "claude-code",
      "enabled": false
    }
  ]
}
```

#### Event Capture

```json
{
  "event_type": "GitHubActionsAgentTriggered",
  "data": {
    "owner": "myorg",
    "repo": "api",
    "workflow": "CI",
    "run_id": 12345678,
    "conclusion": "failure",
    "branch": "main",
    "agent_id": "agent-xyz789",
    "automation_rule": "auto-fix-tests",
    "worktree_branch": "agent/fix-main-42"
  }
}
```

#### Acceptance Criteria

- [ ] Daemon processes `workflow_run` webhook events for completed runs
- [ ] Automation rules are configurable per repository with workflow name, conclusion, and branch pattern filters
- [ ] Matching rules trigger worktree creation and agent spawn automatically
- [ ] Failed job details (names and failing steps) are fetched and included in the agent prompt
- [ ] Agent prompt includes CI context: workflow name, run URL, branch, commit, and failed job details
- [ ] `GitHubActionsAgentTriggered` event is captured in the event store
- [ ] Automation rules can be enabled/disabled individually
- [ ] Duplicate triggers are prevented (same run ID does not spawn multiple agents)
- [ ] The daemon can trigger workflow dispatches via the GitHub API (for manual agent-to-CI triggers)
- [ ] Automation rules are validated at configuration time (repo exists, workflow exists)

---

## Edge Cases

### E-1: GitHub App Token Expires Mid-Operation

**Scenario**: An agent is working on a worktree for 45 minutes. The installation token (1-hour lifetime) expires before the agent pushes its branch and creates a PR.

**Expected behavior**: The `TokenManager` detects the expired token (via 401 response) and transparently refreshes it. The push and PR creation succeed on retry. The agent is unaware of the token refresh.

**Implementation**: The Octokit instance wrapper intercepts 401 responses, calls `tokenManager.invalidate(installationId)`, obtains a new token, and retries the request once.

---

### E-2: Webhook Delivery During Daemon Downtime

**Scenario**: The daemon is restarted for an upgrade. During the 30-second downtime, GitHub sends webhook events for PR reviews and CI results.

**Expected behavior**: GitHub retries failed webhook deliveries for up to 3 days. On daemon restart, the retried webhooks are processed normally. Additionally, the daemon can fetch missed events via the GitHub API on startup by querying recent activity since the last processed webhook timestamp.

**Mitigation**: The daemon records the `x-github-delivery` ID of every processed webhook. On startup, it queries the GitHub API for recent events and processes any that were missed.

---

### E-3: Worktree Branch Already Exists

**Scenario**: User starts an agent from issue #42, creating branch `agent/issue-42`. The agent fails partway through. User tries to start another agent from the same issue.

**Expected behavior**: The `WorktreeManager` detects that the branch already exists (locally or on remote). It offers two options: (1) resume work in the existing worktree, or (2) delete the old worktree/branch and start fresh. The client presents these options to the user.

**Implementation**: `WorktreeManager.create()` checks for existing worktrees with the same branch name before creating a new one. If found, it returns a conflict response with the existing worktree details.

---

### E-4: Conflicting Modifications Across Worktrees

**Scenario**: Agent A (issue-42) and Agent B (issue-55) both modify `src/config/theme.ts`. Agent A creates a PR first. When Agent B's PR is created, it has a merge conflict.

**Expected behavior**: The conflict detector warns when creating worktree B that `src/config/theme.ts` is already being modified in worktree A. The notification is surfaced to the user. If the user proceeds anyway, the resulting PR will show merge conflicts on GitHub, and a notification is sent to the user.

**Note**: The daemon does not resolve merge conflicts. Conflict resolution is a human decision. The daemon's role is early detection and notification.

---

### E-5: GitHub Rate Limiting

**Scenario**: A user with 200+ repositories triggers a full repo list refresh, consuming many API requests. The GitHub API returns 403 with rate limit headers.

**Expected behavior**: The daemon respects the `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers. When rate limited, requests are queued and retried after the reset window. The client is informed of the rate limit status. Cached data is served when available.

**Implementation**: The repo cache serves stale data when the API is rate limited, with a banner indicating the data may be out of date.

---

### E-6: GitHub App Uninstalled from GitHub Side

**Scenario**: The user uninstalls the AgentContext GitHub App from their GitHub organization settings while agents are still running.

**Expected behavior**: API calls from running agents begin failing with 401/403 errors. The daemon detects this, captures a `GitHubAppUninstalled` event, and notifies connected clients. Running agents continue their work locally (git operations still work on the worktree) but cannot push or create PRs. The user is prompted to reinstall the app.

---

### E-7: Webhook Signature Verification Failure

**Scenario**: A malicious actor sends forged webhook payloads to the daemon's webhook endpoint.

**Expected behavior**: The `verifySignature` method rejects the payload with a 401 response. No events are processed, no notifications are sent, and no agents are spawned. The attempt is logged for security auditing.

**Implementation**: The signature check uses `crypto.timingSafeEqual` to prevent timing attacks.

---

### E-8: Large Issue Body Overflows Agent Context

**Scenario**: A GitHub issue has a massive body (50KB+) with embedded images, long stack traces, and verbose reproduction steps. Using the full body as part of the agent prompt would consume too much of the agent's context window.

**Expected behavior**: The `buildAgentPrompt` function truncates the issue body to a configurable maximum (default 5,000 characters) and appends `[truncated -- see full issue at {url}]`. Similarly, comments are capped at 500 characters each, and a maximum of 5 recent comments are included.

---

### E-9: Concurrent Agent-from-Issue for Same Issue

**Scenario**: Two users (or the same user from two clients) both click "Start Agent" for issue #42 at the same time.

**Expected behavior**: The first request creates the worktree and spawns the agent. The second request detects that a worktree for `agent/issue-42` already exists with a running agent and returns an error: `"Agent already running for issue #42 on branch agent/issue-42"`. The client shows the existing agent's status instead.

---

### E-10: Git Worktree Corruption

**Scenario**: A system crash or disk error corrupts a worktree's `.git` link file, making it unusable.

**Expected behavior**: `git worktree list` still shows the worktree but commands within it fail. The daemon's health check detects this and marks the worktree as `corrupted`. The user can remove the corrupted worktree via the API, which uses `git worktree remove --force` followed by manual cleanup of the directory.

---

## Technical Specifications

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github/status` | GitHub App connection status and rate limits |
| `GET` | `/api/github/repos` | List accessible repositories |
| `GET` | `/api/github/repos/:owner/:repo/branches` | List branches |
| `GET` | `/api/github/repos/:owner/:repo/pulls` | List open pull requests |
| `GET` | `/api/github/repos/:owner/:repo/worktrees` | List active worktrees |
| `GET` | `/api/github/repos/:owner/:repo/conflicts` | Detect conflicts across worktrees |
| `POST` | `/api/github/repos/:owner/:repo/worktrees` | Create a new worktree |
| `DELETE` | `/api/github/repos/:owner/:repo/worktrees/:branch` | Remove a worktree |
| `POST` | `/api/github/repos/:owner/:repo/pulls` | Create a PR from worktree |
| `POST` | `/api/github/agent-from-issue` | Start agent-from-issue workflow |
| `POST` | `/github/webhook` | GitHub webhook receiver |
| `POST` | `/api/github/auth/device` | Start OAuth device flow |
| `GET` | `/api/github/auth/status` | Check auth status |
| `GET` | `/api/github/rate-limit` | Current API rate limit status |

### Event Types

| Event | Trigger |
|-------|---------|
| `GitHubAppInstalled` | App installed on user/org account |
| `GitHubAppUninstalled` | App removed from user/org account |
| `WorktreeCreated` | New worktree created from branch |
| `WorktreeRemoved` | Worktree cleaned up |
| `PullRequestCreated` | Agent created a PR |
| `AgentFromIssueStarted` | Agent-from-issue workflow initiated |
| `AgentFromIssueCompleted` | Agent finished and PR created |
| `GitHubWebhookReceived` | Webhook event processed |
| `GitHubActionsAgentTriggered` | CI event triggered agent creation |
| `GitHubRateLimitHit` | API rate limit reached |

### Dependencies

| Dependency | Purpose | Required |
|------------|---------|----------|
| `git` >= 2.15 | Worktree support (`git worktree add --track`) | Hard |
| `@octokit/rest` or equivalent | GitHub REST API client | Hard |
| `@octokit/auth-app` or equivalent | GitHub App authentication | Hard |
| `crypto` (Node.js built-in) | Webhook signature verification | Hard |
| `ngrok` / `cloudflared` | Webhook tunnel for local-only mode | Soft (only for local webhooks) |

### Configuration

```json
{
  "github": {
    "enabled": true,
    "app_id": null,
    "client_id": null,
    "private_key_path": null,
    "webhook_secret": null,
    "worktree_base": "~/.agentcontext/worktrees",
    "max_worktrees_per_repo": 10,
    "recommended_worktrees": 5,
    "pr_defaults": {
      "draft": true,
      "auto_assign": true,
      "labels": ["agent-created"]
    },
    "cache_ttl": {
      "repos": 300,
      "branches": 120,
      "pull_requests": 60
    },
    "automations": []
  }
}
```

### File Locations

| File | Path | Purpose |
|------|------|---------|
| GitHub module | `daemon/src/github/` | All GitHub integration code |
| Auth manager | `daemon/src/github/auth.js` | Token management, OAuth device flow |
| Webhook handler | `daemon/src/github/webhook_handler.js` | Webhook verification and routing |
| Worktree manager | `daemon/src/github/worktree.js` | Git worktree operations |
| Repo cache | `daemon/src/github/repo_cache.js` | API response caching |
| Issue context | `daemon/src/github/issue_context.js` | Issue data extraction |
| Prompt builder | `daemon/src/github/prompt_builder.js` | Agent prompt construction |
| PR template | `daemon/src/github/pr_template.js` | PR body generation |
| Conflict detector | `daemon/src/github/conflict_detector.js` | Cross-worktree conflict detection |
| Actions integration | `daemon/src/github/actions_trigger.js` | CI event handling |
| Notification router | `daemon/src/github/notification_router.js` | Notification distribution |
| App config | `~/.agentcontext/github-app.pem` | GitHub App private key |
| Worktrees | `~/.agentcontext/worktrees/` | All agent worktrees |

### Exit Codes

| Context | Code | Meaning |
|---------|------|---------|
| Webhook endpoint | 200 | Webhook processed successfully |
| Webhook endpoint | 401 | Invalid signature |
| Webhook endpoint | 202 | Webhook accepted but not actionable |
| API endpoints | 200 | Success |
| API endpoints | 400 | Invalid request parameters |
| API endpoints | 401 | GitHub auth not configured |
| API endpoints | 404 | Resource not found |
| API endpoints | 409 | Conflict (worktree already exists, agent already running) |
| API endpoints | 429 | GitHub rate limit exceeded |

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | `TokenManager` caches tokens and refreshes 5 minutes before expiry |
| T-2 | `TokenManager` invalidates cache on 401 and retries successfully |
| T-3 | `TokenManager` handles multiple installations concurrently |
| T-4 | OAuth device flow polls at the correct interval and handles `slow_down` response |
| T-5 | `RepoCache` returns cached data within TTL and null after TTL expires |
| T-6 | `RepoCache` invalidates entries correctly by resource type |
| T-7 | GraphQL repo listing query paginates correctly through 200+ repos |
| T-8 | REST branch listing handles repos with 500+ branches |
| T-9 | `WorktreeManager.create()` creates worktree from existing remote branch |
| T-10 | `WorktreeManager.create()` creates new branch from base when branch does not exist |
| T-11 | `WorktreeManager.slugify()` handles slashes, dots, unicode, and long names |
| T-12 | `WorktreeManager.list()` parses porcelain output correctly (normal, detached, bare) |
| T-13 | `WorktreeManager.remove()` cleans up worktree directory and git metadata |
| T-14 | PR creation includes all required fields (title, body, head, base, draft) |
| T-15 | PR body template includes agent context, change summary, and issue link |
| T-16 | PR creation detects "no new commits" and returns descriptive error |
| T-17 | PR creation detects "PR already exists for branch" and returns existing PR URL |
| T-18 | `WebhookHandler.verifySignature()` accepts valid signatures |
| T-19 | `WebhookHandler.verifySignature()` rejects invalid signatures |
| T-20 | `WebhookHandler.verifySignature()` is timing-safe (uses `timingSafeEqual`) |
| T-21 | `_handlePRReview()` generates correct notification for approved, changes_requested, commented |
| T-22 | `_handleCheckRun()` only notifies on non-success conclusions |
| T-23 | Duplicate webhook deliveries (same delivery ID) are ignored |
| T-24 | `IssueContextExtractor.extract()` fetches issue, comments, and linked PRs |
| T-25 | `_extractFileReferences()` finds backtick paths, GitHub blob links, and common paths |
| T-26 | `buildAgentPrompt()` includes all sections (title, body, labels, files, comments, instructions) |
| T-27 | `buildAgentPrompt()` truncates large issue bodies at 5000 characters |
| T-28 | `ConflictDetector.detectConflicts()` identifies overlapping modified files |
| T-29 | `ConflictDetector` classifies severity correctly (low: 1-5 files, high: 5+) |
| T-30 | Automation rule matching filters by workflow name, conclusion, and branch pattern |
| T-31 | Failed job extraction correctly parses workflow run job details |
| T-32 | CI fix prompt includes workflow name, run URL, and failed step details |

### Integration Tests

| Test | Description |
|------|-------------|
| T-33 | Fresh GitHub App setup: manifest registration, OAuth, first token acquisition |
| T-34 | Full agent-from-issue workflow: issue fetch, worktree, agent spawn, PR creation |
| T-35 | Webhook round-trip: PR review webhook triggers notification on dashboard WebSocket |
| T-36 | Multiple worktrees: create 3 worktrees for same repo, list, detect conflicts, remove |
| T-37 | Token expiry during long-running operation: agent pushes after 50+ minutes |
| T-38 | Rate limit handling: exhaust rate limit, verify cached data is served with stale indicator |
| T-39 | Worktree creation with existing branch name returns conflict response |
| T-40 | GitHub Actions trigger: workflow_run webhook spawns agent based on matching rule |
| T-41 | PR creation from worktree with no new commits returns descriptive error |
| T-42 | Concurrent agent-from-issue requests for same issue: second request blocked |

### Manual Verification

| Test | Description |
|------|-------------|
| M-1 | Register GitHub App via manifest flow on github.com, verify app appears in user settings |
| M-2 | Install app on a test repo, verify installation token grants expected permissions |
| M-3 | Browse repos from dashboard, verify pagination and search work with 50+ repos |
| M-4 | Create worktree from branch, verify git status is clean and tracking remote |
| M-5 | Complete agent work in worktree, create PR, verify PR appears on GitHub with correct body |
| M-6 | Submit review comment on PR, verify notification appears on dashboard within 5 seconds |
| M-7 | Start agent-from-issue from mobile app, watch progress, verify PR is created on completion |
| M-8 | Run 3 agents in parallel worktrees, verify conflict detection catches overlapping file edits |
| M-9 | Configure CI automation rule, trigger workflow failure, verify agent spawns automatically |
| M-10 | Uninstall GitHub App from GitHub, verify daemon detects it and notifies user |

---

## Definition of Done

- [ ] GitHub App manifest is defined and registration flow works end-to-end
- [ ] OAuth device flow authenticates users in headless environments
- [ ] Installation tokens are cached, auto-refreshed, and invalidated on 401
- [ ] Repository browser lists repos, branches, and PRs with caching and pagination
- [ ] Worktree creation works from existing and new branches with proper naming
- [ ] PR creation includes agent summary, change list, agent context metadata, and issue link
- [ ] Webhook endpoint verifies signatures and routes notifications to all connected clients
- [ ] Agent-from-issue workflow executes end-to-end: issue -> worktree -> agent -> PR
- [ ] Issue context extraction fetches title, body, labels, comments, linked PRs, and referenced files
- [ ] Multiple worktrees coexist per repo with conflict detection
- [ ] GitHub Actions automation rules trigger agent creation on CI events
- [ ] All 10 custom event types are captured in the event store
- [ ] All 14 API endpoints are implemented and return correct status codes
- [ ] All 10 edge cases are handled with appropriate error responses and fallbacks
- [ ] All 32 unit tests pass
- [ ] All 10 integration tests pass
- [ ] All 10 manual verification checks pass
- [ ] Webhook endpoint responds within 10 seconds for all event types
- [ ] API rate limits are tracked and respected with cached fallback
- [ ] Code is organized in `daemon/src/github/` with one module per concern
