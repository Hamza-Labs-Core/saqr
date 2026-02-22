# Implementation Plan: Story 10 -- GitHub Integration

**Date**: 2026-02-22
**Story**: 16-github-integration
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (96-128 hours)
**Prerequisites**: Story 05 (Agent Process Orchestration) must be implementation-ready for agent spawning. Story 04 (Event Store & Projections) must be operational for event capture. The daemon HTTP/WS server (Story 06, Local Dashboard) must expose a route registration mechanism.
**Product Spec References**: F8.1-F8.8. See `docs/PRODUCT-SPEC.md` section F8: GitHub Integration.

### Relationship to Other Stories

This story is a **consumer of core platform services** and an **orchestrator of cross-cutting workflows**. It touches agent management, the event store, the daemon's HTTP server, and client notification channels.

- **Story 04** (Event Store): All GitHub operations emit events (10 custom event types). The event store's `append()` interface is the write target.
- **Story 05** (Agent Process Orchestration): `AgentFromIssueWorkflow` and `ActionsIntegration` spawn agents via the `AgentManager` interface. Worktrees provide the `workingDirectory` for spawned agents.
- **Story 06** (Local Dashboard): The daemon's HTTP/WS server hosts the 14 GitHub API endpoints and the webhook receiver. WebSocket broadcast is used for notification routing.
- **Story 07** (Encrypted Cloud Sync): GitHub events follow the same sync pipeline as other events -- cleartext metadata (event_type, repo, pr_number) + encrypted payload.
- **Story 08** (Mobile App): Mobile triggers the agent-from-issue workflow via the daemon API. Push notifications for PR reviews and CI failures flow through the notification router.
- **Story 09** (Desktop App): Desktop receives the same WebSocket notifications as the dashboard.
- **Story 12** (Security & Encryption): GitHub App private key and webhook secret are stored via the secure credential storage mechanism (Keychain/DPAPI/Secret Service).

### Amendment Impacts on This Plan

None. This story was defined after all design amendments were incorporated.

---

## Task Dependency Graph

```
Task 1: GitHub Module Scaffolding
  |
  +---> Task 2: GitHub App Auth & Token Manager
  |       |
  |       +---> Task 3: OAuth Device Flow
  |       |
  |       +---> Task 4: Repository Browser & Cache (needs 2)
  |       |       |
  |       |       +---> Task 5: Worktree Manager (needs 2)
  |       |       |       |
  |       |       |       +---> Task 7: PR Creation (needs 5)
  |       |       |       |       |
  |       |       |       |       +---> Task 9: Agent-from-Issue Workflow (needs 5, 7, 8)
  |       |       |       |
  |       |       |       +---> Task 10: Multiple Repo Instances & Conflict Detection (needs 5)
  |       |       |
  |       |       +---> Task 11: GitHub Actions Trigger (needs 4, 5, 6)
  |       |
  |       +---> Task 6: Webhook Handler & Signature Verification (needs 2)
  |               |
  |               +---> Task 8: Notification Router (needs 6)
  |
  +---> Task 12: Daemon API Route Registration (needs 2-11)
  |
  +---> Task 13: Event Type Definitions (needs 1)
  |
  +---> Task 14: Integration Tests (needs all)
```

---

## Tasks

### Task 1: GitHub Module Scaffolding

**Description**

Create the directory structure, shared constants, error types, and configuration schema for the GitHub integration module. This establishes the foundation that all subsequent tasks build upon. The module lives within the daemon's source tree at `daemon/src/github/`.

**Prerequisites/Inputs**

- The daemon project structure must exist (at minimum `daemon/src/` and `daemon/package.json`).
- Node.js 18+ (native `fetch`, `crypto`, `fs/promises`).

**Implementation Details**

Create the following directory and files:

```
daemon/src/github/
  index.js              # Module entry point, exports all public classes
  constants.js          # Shared constants (URLs, limits, defaults)
  errors.js             # Custom error types for GitHub operations
  config.js             # Configuration schema, defaults, validation
```

`constants.js`:

```javascript
// daemon/src/github/constants.js

module.exports = {
  GITHUB_API_BASE: "https://api.github.com",
  GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
  GITHUB_DEVICE_CODE_URL: "https://github.com/login/device/code",
  GITHUB_OAUTH_TOKEN_URL: "https://github.com/login/oauth/access_token",
  GITHUB_DEVICE_VERIFY_URL: "https://github.com/login/device",

  // Token management
  TOKEN_EXPIRY_BUFFER_MS: 5 * 60 * 1000,   // 5 minutes before expiry
  TOKEN_LIFETIME_MS: 60 * 60 * 1000,        // 1 hour

  // Cache TTLs (seconds)
  CACHE_TTL_REPOS: 300,       // 5 minutes
  CACHE_TTL_BRANCHES: 120,    // 2 minutes
  CACHE_TTL_PULL_REQUESTS: 60, // 1 minute
  CACHE_TTL_SEARCH: 60,       // 1 minute

  // Worktree limits
  MAX_WORKTREES_PER_REPO: 10,
  RECOMMENDED_WORKTREES: 5,
  MAX_BRANCH_SLUG_LENGTH: 100,

  // Git operations
  GIT_TIMEOUT_MS: 30000,      // 30 seconds

  // Webhook
  WEBHOOK_RESPONSE_TIMEOUT_MS: 10000, // 10 seconds (GitHub timeout)

  // Issue context
  MAX_ISSUE_BODY_CHARS: 5000,
  MAX_COMMENT_CHARS: 500,
  MAX_COMMENTS_IN_PROMPT: 5,

  // PR defaults
  DEFAULT_PR_LABELS: ["agent-created"],
};
```

`errors.js`:

```javascript
// daemon/src/github/errors.js

class GitHubError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.details = details;
  }
}

class GitHubAuthError extends GitHubError {
  constructor(message, details) {
    super(message, "AUTH_ERROR", details);
    this.name = "GitHubAuthError";
  }
}

class GitHubRateLimitError extends GitHubError {
  constructor(resetAt, remaining, details) {
    super(`GitHub API rate limit exceeded. Resets at ${resetAt}`, "RATE_LIMIT", details);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
    this.remaining = remaining;
  }
}

class WorktreeError extends GitHubError {
  constructor(message, details) {
    super(message, "WORKTREE_ERROR", details);
    this.name = "WorktreeError";
  }
}

class WorktreeConflictError extends WorktreeError {
  constructor(branch, existingPath) {
    super(
      `Worktree already exists for branch "${branch}" at ${existingPath}`,
      { branch, existingPath }
    );
    this.name = "WorktreeConflictError";
    this.code = "WORKTREE_CONFLICT";
  }
}

class WebhookVerificationError extends GitHubError {
  constructor() {
    super("Invalid webhook signature", "WEBHOOK_INVALID_SIGNATURE");
    this.name = "WebhookVerificationError";
  }
}

module.exports = {
  GitHubError,
  GitHubAuthError,
  GitHubRateLimitError,
  WorktreeError,
  WorktreeConflictError,
  WebhookVerificationError,
};
```

`config.js`:

```javascript
// daemon/src/github/config.js

const path = require("path");
const fs = require("fs/promises");

const DEFAULT_CONFIG = {
  enabled: false,
  app_id: null,
  client_id: null,
  private_key_path: null,
  webhook_secret: null,
  worktree_base: path.join(process.env.HOME, ".agentcontext", "worktrees"),
  max_worktrees_per_repo: 10,
  recommended_worktrees: 5,
  pr_defaults: {
    draft: true,
    auto_assign: true,
    labels: ["agent-created"],
  },
  cache_ttl: {
    repos: 300,
    branches: 120,
    pull_requests: 60,
  },
  automations: [],
};

async function loadGitHubConfig(configPath) {
  // Loads from daemon config file, merges with defaults
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const full = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...(full.github || {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function validateConfig(config) {
  const errors = [];
  if (config.enabled) {
    if (!config.app_id) errors.push("github.app_id is required when enabled");
    if (!config.client_id) errors.push("github.client_id is required when enabled");
    if (!config.private_key_path) errors.push("github.private_key_path is required when enabled");
    if (!config.webhook_secret) errors.push("github.webhook_secret is required when enabled");
  }
  return errors;
}

module.exports = { DEFAULT_CONFIG, loadGitHubConfig, validateConfig };
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/index.js` | Module entry point |
| `daemon/src/github/constants.js` | Shared constants |
| `daemon/src/github/errors.js` | Custom error classes |
| `daemon/src/github/config.js` | Configuration schema and validation |

**Acceptance Criteria**

- [ ] `daemon/src/github/` directory exists with `index.js`, `constants.js`, `errors.js`, `config.js`
- [ ] All error classes extend `GitHubError` and include a `code` property for programmatic handling
- [ ] `loadGitHubConfig()` returns defaults when no config file exists
- [ ] `loadGitHubConfig()` merges user config over defaults (user values take precedence)
- [ ] `validateConfig()` returns errors when `enabled: true` but required fields are missing
- [ ] `validateConfig()` returns no errors when `enabled: false` (disabled is always valid)
- [ ] Constants are exported and usable by all downstream modules

**Edge Cases**

- Config file does not exist: return defaults silently.
- Config file is malformed JSON: return defaults, log a warning.
- Config has unknown keys: ignore them (forward-compatible).

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 2: GitHub App Auth & Token Manager

**Description**

Implement the `GitHubTokenManager` class that handles GitHub App authentication, installation token caching with automatic refresh, and authenticated Octokit-equivalent HTTP client creation. This uses Node.js built-in `crypto` for JWT generation (no `@octokit/auth-app` dependency -- we avoid npm packages per project convention).

Since the project uses Node.js without npm, we implement JWT generation for GitHub App authentication using the built-in `crypto` module, and GitHub API calls using the built-in `fetch` API (Node 18+).

**Prerequisites/Inputs**

- Task 1 (constants, errors, config).
- GitHub App credentials: `app_id`, `private_key_path`, `webhook_secret`.
- `git` >= 2.15 on the system.

**Implementation Details**

File: `daemon/src/github/auth.js`

Key classes and functions:

```javascript
// daemon/src/github/auth.js

const crypto = require("crypto");
const fs = require("fs/promises");
const { GITHUB_API_BASE, TOKEN_EXPIRY_BUFFER_MS } = require("./constants");
const { GitHubAuthError, GitHubRateLimitError } = require("./errors");

/**
 * Generate a JWT for GitHub App authentication.
 * GitHub requires RS256 JWT signed with the app's private key.
 */
function generateAppJWT(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,        // Issued 60s ago (clock skew buffer)
    exp: now + 10 * 60,   // Expires in 10 minutes (max allowed)
    iss: appId,
  };

  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = base64url(sign.sign(privateKeyPem));

  return `${signingInput}.${signature}`;
}

function base64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

class GitHubTokenManager {
  constructor(appId, privateKeyPem, config = {}) { ... }
  async getInstallationToken(installationId) { ... }
  async createAuthenticatedFetch(installationId) { ... }
  invalidate(installationId) { ... }
  async _requestInstallationToken(installationId) { ... }
  async _githubFetch(url, options) { ... }
  _trackRateLimit(headers) { ... }
  getRateLimitStatus() { ... }
}
```

`tokenCache` is a `Map<installationId, { token, expiresAt }>`.

`createAuthenticatedFetch(installationId)` returns a function that:
1. Gets a valid token (from cache or fresh).
2. Makes the fetch with `Authorization: token ${token}`.
3. On 401 response: invalidates cache, gets new token, retries once.
4. On 403 with rate limit headers: throws `GitHubRateLimitError`.
5. Tracks `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers.

`_githubFetch(url, options)` is the base fetch wrapper that adds standard headers:
```
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

Rate limit tracking stores: `{ remaining, limit, reset, resource }` per API type (core, graphql, search).

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/auth.js` | Token manager, JWT generation, authenticated fetch |
| `daemon/tests/github/auth.test.js` | Unit tests for token management |

**Acceptance Criteria**

- [ ] `generateAppJWT()` produces a valid RS256 JWT that GitHub accepts
- [ ] `getInstallationToken()` returns a cached token if it has not expired (minus 5-min buffer)
- [ ] `getInstallationToken()` requests a new token if the cached one is expired or missing
- [ ] `invalidate()` removes the cached token, forcing a fresh request on next call
- [ ] `createAuthenticatedFetch()` returns a function that automatically adds auth headers
- [ ] Authenticated fetch retries once on 401 after invalidating and refreshing the token
- [ ] Authenticated fetch throws `GitHubRateLimitError` on 403 with rate limit headers
- [ ] Rate limit status (remaining, limit, reset) is tracked per API resource type
- [ ] Multiple installations (personal + org) maintain separate token caches
- [ ] No npm dependencies -- uses only Node.js built-in `crypto` and `fetch`

**Edge Cases**

- E-1 (Token expires mid-operation): Retry logic with token refresh handles this transparently.
- Private key file not found: Throw `GitHubAuthError` with descriptive message.
- Malformed private key: Throw `GitHubAuthError` with "Invalid private key" message.
- Network timeout on token request: Let the fetch timeout propagate; callers handle retries.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 3: OAuth Device Flow

**Description**

Implement the OAuth device flow for headless environments where the user cannot open a browser. The flow requests a device code from GitHub, displays a user code for the user to enter at `github.com/login/device`, and polls until the user completes authorization.

**Prerequisites/Inputs**

- Task 1 (constants, errors).
- Task 2 (token manager for storing the resulting access token).
- GitHub App `client_id`.

**Implementation Details**

File: `daemon/src/github/device_flow.js`

```javascript
// daemon/src/github/device_flow.js

const { GITHUB_DEVICE_CODE_URL, GITHUB_OAUTH_TOKEN_URL, GITHUB_DEVICE_VERIFY_URL } = require("./constants");
const { GitHubAuthError } = require("./errors");

class DeviceFlowAuth {
  constructor(clientId) {
    this.clientId = clientId;
  }

  /**
   * Step 1: Request device and user verification codes.
   * Returns: { device_code, user_code, verification_uri, expires_in, interval }
   */
  async requestCodes() { ... }

  /**
   * Step 2: Poll for access token.
   * Returns a promise that resolves when the user authorizes.
   * Throws if the flow expires or is denied.
   *
   * Emits progress via callback:
   *   onProgress("pending")      -- waiting for user
   *   onProgress("slow_down")    -- GitHub asked us to slow down, increasing interval
   *   onProgress("authorized")   -- user authorized, token received
   *   onProgress("expired")      -- flow expired
   */
  async pollForToken(deviceCode, interval, expiresIn, onProgress) { ... }

  /**
   * Full flow: request codes + poll.
   * Returns: { access_token, token_type, scope }
   */
  async authenticate(onUserCode, onProgress) {
    const codes = await this.requestCodes();

    // Notify caller of the user code to display
    onUserCode({
      user_code: codes.user_code,
      verification_uri: codes.verification_uri || GITHUB_DEVICE_VERIFY_URL,
      expires_in: codes.expires_in,
    });

    return this.pollForToken(
      codes.device_code,
      codes.interval || 5,
      codes.expires_in || 900,
      onProgress
    );
  }
}
```

Polling logic:
1. POST to `GITHUB_OAUTH_TOKEN_URL` with `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
2. On response `error: "authorization_pending"`: wait `interval` seconds, retry.
3. On response `error: "slow_down"`: increase interval by 5 seconds, wait, retry.
4. On response `error: "expired_token"`: throw `GitHubAuthError`.
5. On response `error: "access_denied"`: throw `GitHubAuthError`.
6. On response with `access_token`: return the token object.
7. Total poll duration capped at `expires_in` seconds.

**Daemon API Endpoints**

```
POST /api/github/auth/device    -> Start device flow, returns user_code + verification_uri
GET  /api/github/auth/status    -> Check if device flow completed (polling by client)
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/device_flow.js` | OAuth device flow implementation |
| `daemon/tests/github/device_flow.test.js` | Unit tests with mocked GitHub responses |

**Acceptance Criteria**

- [ ] `requestCodes()` returns `user_code`, `verification_uri`, `device_code`, `interval`, `expires_in`
- [ ] `pollForToken()` waits the correct interval between poll attempts
- [ ] `pollForToken()` increases interval by 5s on `slow_down` response
- [ ] `pollForToken()` throws `GitHubAuthError` on `expired_token` and `access_denied`
- [ ] `pollForToken()` resolves with `access_token` on successful authorization
- [ ] `onUserCode` callback is called with display data before polling starts
- [ ] `onProgress` callback is called with status updates during polling
- [ ] Total poll time does not exceed `expires_in` seconds
- [ ] `POST /api/github/auth/device` starts the flow and returns user code to the client
- [ ] `GET /api/github/auth/status` returns the current flow state (pending, completed, expired)

**Edge Cases**

- GitHub returns unexpected error during code request: throw with the raw error message.
- Network drops during polling: retry on next interval tick (transient failure).
- User takes longer than `expires_in`: flow expires, client is notified.
- Multiple concurrent device flow requests: only one active flow at a time per daemon instance; second request returns error "Device flow already in progress".

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 4: Repository Browser & Cache

**Description**

Implement the repository browser that lists repos, branches, and open PRs from GitHub. The daemon acts as an API gateway, caching responses to minimize GitHub API rate limit consumption. Uses GraphQL for aggregate queries (repo list with nested PR counts) and REST for single-resource queries (branches for a specific repo).

**Prerequisites/Inputs**

- Task 2 (authenticated fetch for GitHub API calls).
- Task 1 (cache TTL constants).

**Implementation Details**

File: `daemon/src/github/repo_browser.js`

```javascript
// daemon/src/github/repo_browser.js

class RepoBrowser {
  constructor(tokenManager, cache) {
    this.tokens = tokenManager;
    this.cache = cache;
  }

  /**
   * List repositories via GraphQL.
   * Supports pagination (cursor-based) and search filtering.
   */
  async listRepos(installationId, { page, perPage, search, cursor } = {}) { ... }

  /**
   * List branches for a repository via REST.
   */
  async listBranches(installationId, owner, repo, { page, perPage } = {}) { ... }

  /**
   * List open pull requests for a repository via REST.
   */
  async listPullRequests(installationId, owner, repo, { page, perPage, state } = {}) { ... }

  /**
   * Search repositories via REST.
   */
  async searchRepos(installationId, query, { page, perPage } = {}) { ... }
}
```

File: `daemon/src/github/repo_cache.js`

```javascript
// daemon/src/github/repo_cache.js

class RepoCacheEntry {
  constructor(data, ttlSeconds) {
    this.data = data;
    this.expiresAt = Date.now() + ttlSeconds * 1000;
    this.etag = null;
  }

  isExpired() {
    return Date.now() > this.expiresAt;
  }
}

class RepoCache {
  constructor(ttlConfig = {}) {
    this.cache = new Map();
    this.TTL = {
      repoList: ttlConfig.repos || 300,
      branches: ttlConfig.branches || 120,
      pullRequests: ttlConfig.pull_requests || 60,
      repoSearch: 60,
    };
    this.maxEntries = 1000; // Prevent unbounded growth
  }

  getCacheKey(installationId, resource, params) { ... }
  get(installationId, resource, params) { ... }
  set(installationId, resource, params, data) { ... }
  invalidate(installationId, resource) { ... }
  invalidateRepo(installationId, owner, repo) { ... }
  prune() { ... } // Remove expired entries, called periodically
}
```

GraphQL query for listing repos (as specified in the story):
- Uses viewer.repositories with cursor-based pagination.
- Fetches `nameWithOwner`, `description`, `defaultBranchRef.name`, `pushedAt`, `isPrivate`, `isArchived`, `primaryLanguage`, and nested `pullRequests(states: OPEN, first: 5)`.
- Returns a unified response with `repos[]` and `pagination { page, per_page, total, has_next }`.

REST calls for branches and PRs use standard pagination via `page` and `per_page` query params.

Cache strategy:
- Cache key: `${installationId}:${resource}:${JSON.stringify(sortedParams)}`
- On cache hit (not expired): return cached data.
- On cache miss or expired: fetch from GitHub, store in cache, return.
- On webhook push event: invalidate affected repo's cache entries.
- Stale data is served when rate-limited (with a `stale: true` flag in the response).

**Daemon API Endpoints**

```
GET /api/github/repos                           -> List repos
GET /api/github/repos/:owner/:repo/branches     -> List branches
GET /api/github/repos/:owner/:repo/pulls        -> List open PRs
GET /api/github/rate-limit                       -> Rate limit status
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/repo_browser.js` | Repository, branch, PR listing |
| `daemon/src/github/repo_cache.js` | Response caching with TTL |
| `daemon/tests/github/repo_browser.test.js` | Unit tests |
| `daemon/tests/github/repo_cache.test.js` | Cache unit tests |

**Acceptance Criteria**

- [ ] `listRepos()` returns paginated repository list via GraphQL with cursor pagination
- [ ] `listBranches()` returns branches for a specific repo via REST
- [ ] `listPullRequests()` returns open PRs for a specific repo via REST
- [ ] `searchRepos()` filters by name, language, and visibility
- [ ] Cache returns data within TTL; fetches fresh data after TTL expires
- [ ] Cache is invalidated on webhook push events for affected repos
- [ ] Pagination works correctly for users with 100+ repositories (GraphQL cursor chaining)
- [ ] Rate limit remaining is tracked and exposed via `/api/github/rate-limit`
- [ ] Stale cached data is served with `stale: true` flag when API is rate limited
- [ ] Cache has a maximum entry count (1000) with LRU eviction on overflow
- [ ] Private and public repositories both listed with correct `private` flag

**Edge Cases**

- E-5 (Rate limiting): Serve stale cached data with a `stale: true` indicator.
- User with zero repos: Return empty array, no error.
- Repo with 500+ branches: Pagination handles it (REST link-header pagination or explicit page iteration).
- GraphQL query fails (server error): Fall back to REST `GET /user/repos` endpoint.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 5: Worktree Manager

**Description**

Implement the `WorktreeManager` class that creates, lists, and removes git worktrees. Worktrees are the mechanism for running multiple agents on different branches of the same repository simultaneously. Each worktree is a full working copy with its own branch, linked to the main repository's `.git` directory.

**Prerequisites/Inputs**

- Task 1 (constants for limits and timeouts, errors).
- Task 13 (event type definitions for `WorktreeCreated`, `WorktreeRemoved`).
- `git` >= 2.15 on the system.
- Event store `append()` interface.

**Implementation Details**

File: `daemon/src/github/worktree.js`

```javascript
// daemon/src/github/worktree.js

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs/promises");
const {
  GIT_TIMEOUT_MS,
  MAX_BRANCH_SLUG_LENGTH,
  MAX_WORKTREES_PER_REPO,
  RECOMMENDED_WORKTREES,
} = require("./constants");
const { WorktreeError, WorktreeConflictError } = require("./errors");

class WorktreeManager {
  constructor(baseDir, eventStore) {
    this.baseDir = baseDir || path.join(
      process.env.HOME, ".agentcontext", "worktrees"
    );
    this.eventStore = eventStore;
  }

  slugify(branchName) { ... }
  worktreePath(owner, repo, branchName) { ... }

  async create(repoPath, owner, repo, branchName, baseBranch = "main", metadata = {}) {
    // 1. Check existing worktrees -- enforce limits
    // 2. Check for existing worktree with same branch (conflict)
    // 3. Ensure parent directory exists
    // 4. Fetch latest from remote
    // 5. Check if branch exists on remote
    // 6. Create worktree (tracking remote branch or new from base)
    // 7. Emit WorktreeCreated event
    // 8. Return worktree info
  }

  async list(repoPath) { ... }
  async listForRepo(owner, repo) { ... }
  async remove(repoPath, wtPath, force = false) { ... }
  async getStatus(wtPath) { ... }

  _git(cwd, args) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) reject(new WorktreeError(`git ${args[0]} failed: ${stderr || err.message}`, { args, cwd }));
        else resolve(stdout);
      });
    });
  }

  _parsePorcelainOutput(output) { ... }
}
```

Directory naming convention:
```
{baseDir}/{owner}-{repo}/{branch-slug}/
```

Example:
```
~/.agentcontext/worktrees/myorg-api/agent-issue-42/
```

`slugify()` rules:
1. Replace non-alphanumeric characters (except hyphens) with hyphens.
2. Collapse consecutive hyphens.
3. Remove leading/trailing hyphens.
4. Lowercase.
5. Truncate to `MAX_BRANCH_SLUG_LENGTH` (100) characters.

Limit enforcement in `create()`:
- If worktree count for this repo >= `MAX_WORKTREES_PER_REPO` (10): throw `WorktreeError` with "Maximum worktree limit (10) reached".
- If worktree count >= `RECOMMENDED_WORKTREES` (5): include a warning in the return value but allow creation.

Conflict detection in `create()`:
- Check if a worktree with the same branch name already exists.
- If it does, throw `WorktreeConflictError` with the existing path.
- This handles edge cases E-3 (branch already exists) and E-9 (concurrent agent-from-issue).

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/worktree.js` | Git worktree operations |
| `daemon/tests/github/worktree.test.js` | Unit tests with mocked git commands |

**Acceptance Criteria**

- [ ] `create()` creates a git worktree from an existing remote branch when it exists
- [ ] `create()` creates a new branch from the base branch when the target branch does not exist on remote
- [ ] `create()` throws `WorktreeConflictError` if a worktree for the branch already exists
- [ ] `create()` throws `WorktreeError` when the hard limit (10) is exceeded
- [ ] `create()` includes a `warning` field when the recommended limit (5) is exceeded
- [ ] `slugify()` handles slashes (`feature/dark-mode` -> `feature-dark-mode`)
- [ ] `slugify()` handles dots, unicode, and long names (truncated to 100 chars)
- [ ] `list()` parses `git worktree list --porcelain` output correctly for normal, detached, and bare worktrees
- [ ] `remove()` cleans up the worktree directory and git metadata
- [ ] `remove()` with `force=true` uses `--force` flag for locked worktrees
- [ ] Remote is fetched before worktree creation to ensure up-to-date branches
- [ ] Git operations have a 30-second timeout
- [ ] `WorktreeCreated` event is emitted with full metadata (owner, repo, branch, base_branch, path, trigger)
- [ ] `WorktreeRemoved` event is emitted on successful removal
- [ ] If the worktree directory already exists but is not in git's worktree list (orphaned): clean up and recreate

**Edge Cases**

- E-3 (Branch already exists): `WorktreeConflictError` thrown with existing path details.
- E-10 (Worktree corruption): `getStatus()` detects broken `.git` link file, returns `corrupted` status.
- Disk full during worktree creation: git error propagates as `WorktreeError`.
- Repo path does not exist: throw descriptive error before attempting git commands.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 6: Webhook Handler & Signature Verification

**Description**

Implement the webhook receiver that GitHub sends events to. The handler verifies webhook signatures using HMAC-SHA256, routes events to the appropriate handler functions, deduplicates deliveries, and responds within GitHub's 10-second timeout.

**Prerequisites/Inputs**

- Task 1 (constants, errors).
- Task 2 (token manager for webhook secret).
- Node.js built-in `crypto` module.

**Implementation Details**

File: `daemon/src/github/webhook_handler.js`

```javascript
// daemon/src/github/webhook_handler.js

const crypto = require("crypto");
const { WebhookVerificationError } = require("./errors");
const { WEBHOOK_RESPONSE_TIMEOUT_MS } = require("./constants");

class WebhookHandler {
  constructor(webhookSecret) {
    this.secret = webhookSecret;
    this.handlers = new Map();          // event type -> handler function
    this.processedDeliveries = new Set(); // delivery IDs for dedup
    this.maxDeliveryHistory = 10000;     // Max stored delivery IDs
  }

  verifySignature(payload, signature) {
    if (!signature) return false;
    const expected = "sha256=" + crypto
      .createHmac("sha256", this.secret)
      .update(payload, "utf8")
      .digest("hex");

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature)
      );
    } catch {
      return false; // Length mismatch
    }
  }

  registerHandler(eventType, handler) {
    this.handlers.set(eventType, handler);
  }

  async handleEvent(headers, body) {
    const event = headers["x-github-event"];
    const signature = headers["x-hub-signature-256"];
    const deliveryId = headers["x-github-delivery"];

    // 1. Verify signature
    if (!this.verifySignature(body, signature)) {
      throw new WebhookVerificationError();
    }

    // 2. Deduplicate
    if (this.processedDeliveries.has(deliveryId)) {
      return { handled: false, reason: "duplicate", deliveryId };
    }
    this.processedDeliveries.add(deliveryId);
    this._pruneDeliveryHistory();

    // 3. Route to handler
    const handler = this.handlers.get(event);
    if (!handler) {
      return { handled: false, reason: "no_handler", event };
    }

    const payload = JSON.parse(body);
    return handler(payload, deliveryId);
  }

  _pruneDeliveryHistory() {
    if (this.processedDeliveries.size > this.maxDeliveryHistory) {
      const iterator = this.processedDeliveries.values();
      // Remove oldest 20%
      const removeCount = Math.floor(this.maxDeliveryHistory * 0.2);
      for (let i = 0; i < removeCount; i++) {
        this.processedDeliveries.delete(iterator.next().value);
      }
    }
  }
}
```

Event handler functions (registered by other tasks):

| GitHub Event | Handler | Registered By |
|---|---|---|
| `pull_request_review` | `_handlePRReview` | Task 8 |
| `pull_request_review_comment` | `_handlePRReviewComment` | Task 8 |
| `issue_comment` | `_handleIssueComment` | Task 8 |
| `check_run` | `_handleCheckRun` | Task 8 |
| `pull_request` | `_handlePRUpdate` | Task 8 |
| `issues` | `_handleIssueUpdate` | Task 8 |
| `workflow_run` | `_handleWorkflowRun` | Task 11 |
| `installation` | `_handleInstallation` | Task 2 (app install/uninstall) |

**Daemon API Endpoint**

```
POST /github/webhook    -> GitHub webhook receiver
```

The endpoint must:
1. Read the raw body as a string (not parsed JSON) for signature verification.
2. Verify signature before any JSON parsing.
3. Return 200 on success, 401 on invalid signature, 202 on accepted but not actionable.
4. Complete within 10 seconds (GitHub's timeout).

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/webhook_handler.js` | Webhook verification and routing |
| `daemon/tests/github/webhook_handler.test.js` | Unit tests for signature and routing |

**Acceptance Criteria**

- [ ] `verifySignature()` accepts valid HMAC-SHA256 signatures
- [ ] `verifySignature()` rejects invalid signatures
- [ ] `verifySignature()` uses `crypto.timingSafeEqual` to prevent timing attacks
- [ ] `verifySignature()` handles missing signature header (returns false)
- [ ] `verifySignature()` handles length-mismatch signatures (returns false, no exception)
- [ ] Duplicate webhook deliveries (same `x-github-delivery`) are detected and ignored
- [ ] Delivery history is pruned when it exceeds 10,000 entries (oldest 20% removed)
- [ ] `registerHandler()` allows downstream tasks to register event-specific handlers
- [ ] `handleEvent()` routes to the correct handler based on `x-github-event` header
- [ ] Unhandled event types return `{ handled: false, reason: "no_handler" }` without error
- [ ] Webhook endpoint responds within 10 seconds
- [ ] Raw body string is used for signature verification (not re-serialized JSON)

**Edge Cases**

- E-7 (Forged webhook): `WebhookVerificationError` thrown, logged for security auditing.
- E-2 (Daemon downtime): GitHub retries; delivery dedup prevents double-processing.
- Very large payload (>1MB): Accept if valid, but log a warning.
- Missing `x-github-event` header: Return 400 Bad Request.

**Estimated Effort**: M (Medium) -- 5-6 hours

---

### Task 7: PR Creation

**Description**

Implement the PR creation module that pushes a worktree's branch to the remote and creates a pull request via the GitHub API. The PR body includes an agent-generated summary, change list, agent context metadata, and optional issue linking.

**Prerequisites/Inputs**

- Task 2 (authenticated fetch for GitHub API).
- Task 5 (worktree manager for git push).
- Task 13 (event types for `PullRequestCreated`).

**Implementation Details**

File: `daemon/src/github/pr_template.js`

```javascript
// daemon/src/github/pr_template.js

const { MAX_ISSUE_BODY_CHARS } = require("./constants");

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

File: `daemon/src/github/pr_creator.js`

```javascript
// daemon/src/github/pr_creator.js

class PRCreator {
  constructor(tokenManager, worktreeManager, eventStore, config) {
    this.tokens = tokenManager;
    this.worktrees = worktreeManager;
    this.events = eventStore;
    this.config = config; // pr_defaults from config
  }

  /**
   * Push worktree branch to remote and create a PR.
   */
  async createPR(installationId, {
    owner, repo, worktreePath, branchName, baseBranch,
    title, summary, changes, agent, session,
    issue, draft, labels, reviewers, autoAssign,
  }) {
    // 1. Push branch to remote
    await this.worktrees._git(worktreePath, [
      "push", "-u", "origin", branchName,
    ]);

    // 2. Build PR body
    const body = buildPRBody({ summary, changes, agent, session, issue });

    // 3. Create PR via GitHub API
    const fetch = await this.tokens.createAuthenticatedFetch(installationId);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          head: branchName,
          base: baseBranch || "main",
          draft: draft !== undefined ? draft : this.config.draft,
        }),
      }
    );

    // 4. Handle error responses
    if (response.status === 422) {
      const error = await response.json();
      if (error.errors?.some(e => e.message?.includes("No commits"))) {
        throw new GitHubError("No new commits on branch -- nothing to PR", "NO_COMMITS");
      }
      if (error.errors?.some(e => e.message?.includes("already exists"))) {
        // PR already exists -- fetch it
        return this._getExistingPR(fetch, owner, repo, branchName);
      }
      throw new GitHubError(`PR creation failed: ${JSON.stringify(error)}`, "PR_CREATE_FAILED");
    }

    const pr = await response.json();

    // 5. Apply labels
    const prLabels = labels || this.config.labels || ["agent-created"];
    if (prLabels.length > 0) {
      await this._addLabels(fetch, owner, repo, pr.number, prLabels);
    }

    // 6. Auto-assign
    if (autoAssign !== false && this.config.auto_assign !== false) {
      await this._autoAssign(fetch, owner, repo, pr.number, session.userId);
    }

    // 7. Request reviewers
    if (reviewers && reviewers.length > 0) {
      await this._requestReviewers(fetch, owner, repo, pr.number, reviewers);
    }

    // 8. Emit PullRequestCreated event
    await this.events.append({
      event_type: "PullRequestCreated",
      data: {
        owner, repo,
        pr_number: pr.number,
        pr_url: pr.html_url,
        title,
        head_branch: branchName,
        base_branch: baseBranch,
        draft: pr.draft,
        linked_issue: issue?.number || null,
        agent_session_id: session.id,
        files_changed: session.filesModified,
        additions: pr.additions,
        deletions: pr.deletions,
      },
    });

    return pr;
  }

  async _getExistingPR(fetch, owner, repo, head) { ... }
  async _addLabels(fetch, owner, repo, prNumber, labels) { ... }
  async _autoAssign(fetch, owner, repo, prNumber, userId) { ... }
  async _requestReviewers(fetch, owner, repo, prNumber, reviewers) { ... }
}
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/pr_template.js` | PR body generation |
| `daemon/src/github/pr_creator.js` | PR creation orchestration |
| `daemon/tests/github/pr_creator.test.js` | Unit tests |

**Acceptance Criteria**

- [ ] Branch is pushed to remote before PR creation
- [ ] PR is created via `POST /repos/{owner}/{repo}/pulls` with title, body, head, base, draft
- [ ] PR body includes summary, changes list, agent context metadata, and "review carefully" footer
- [ ] Draft PR option is supported and defaults to `true` (from config)
- [ ] Issue linking works via "Closes #N" in PR body when `issue` is provided
- [ ] Labels are applied via `POST /repos/{owner}/{repo}/issues/{number}/labels`
- [ ] PR is auto-assigned to the initiating user when `auto_assign` is true
- [ ] Reviewers are requested via `POST /repos/{owner}/{repo}/pulls/{number}/requested_reviewers`
- [ ] `PullRequestCreated` event is emitted with full metadata
- [ ] When PR already exists for the branch, the existing PR is returned instead of an error
- [ ] When branch has no new commits, a descriptive `NO_COMMITS` error is thrown
- [ ] Push notification is sent to connected clients (delegated to notification router)

**Edge Cases**

- Branch has no new commits: Throw `GitHubError` with code `NO_COMMITS`.
- PR already exists for branch: Return the existing PR (HTTP 422 with specific error message).
- Push fails (force push needed, auth error): `WorktreeError` propagates from `_git`.
- Label does not exist on repo: GitHub API creates it automatically.

**Estimated Effort**: M (Medium) -- 5-7 hours

---

### Task 8: Notification Router

**Description**

Implement the notification router that distributes GitHub webhook notifications to all connected clients (local dashboard via WebSocket, mobile via push notification service, desktop via WebSocket). Also implement the specific webhook event handlers that generate structured notifications from raw webhook payloads.

**Prerequisites/Inputs**

- Task 6 (webhook handler for registering event handlers).
- Task 13 (event types for `GitHubWebhookReceived`).
- Daemon's WebSocket server (from Story 06).

**Implementation Details**

File: `daemon/src/github/notification_router.js`

```javascript
// daemon/src/github/notification_router.js

class NotificationRouter {
  constructor(wsServer, pushService, eventStore) {
    this.wsServer = wsServer;
    this.pushService = pushService;
    this.eventStore = eventStore;
  }

  async send(notification) {
    // 1. Broadcast to local WebSocket clients (dashboard, desktop)
    this.wsServer.broadcast({
      type: "github_notification",
      payload: notification,
      timestamp: new Date().toISOString(),
    });

    // 2. Send push notification to mobile (if service available)
    if (this.pushService) {
      try {
        await this.pushService.send({
          title: notification.title,
          body: notification.body,
          data: {
            type: notification.type,
            url: notification.url,
            repo: notification.repo,
          },
        });
      } catch (err) {
        // Push failure is non-critical; log and continue
        console.error("Push notification failed:", err.message);
      }
    }

    // 3. Emit GitHubWebhookReceived event
    await this.eventStore.append({
      event_type: "GitHubWebhookReceived",
      data: {
        github_event: notification.github_event,
        action: notification.action,
        delivery_id: notification.delivery_id,
        repo: notification.repo,
        ...notification.eventMeta,
      },
    });

    return notification;
  }
}
```

File: `daemon/src/github/webhook_events.js`

Implements the individual webhook event handlers and registers them with the `WebhookHandler`:

```javascript
// daemon/src/github/webhook_events.js

function registerWebhookHandlers(webhookHandler, notificationRouter, repoCache) {

  webhookHandler.registerHandler("pull_request_review", async (payload, deliveryId) => {
    const { action, review, pull_request, repository } = payload;
    if (action !== "submitted") return { handled: false };

    const notification = {
      type: "pr_review",
      github_event: "pull_request_review",
      action,
      title: `Review on PR #${pull_request.number}`,
      body: `${review.user.login} ${review.state}: ${review.body?.substring(0, 200) || "(no comment)"}`,
      repo: repository.full_name,
      pr_number: pull_request.number,
      reviewer: review.user.login,
      state: review.state,
      url: review.html_url,
      delivery_id: deliveryId,
      eventMeta: {
        pr_number: pull_request.number,
        reviewer: review.user.login,
        review_state: review.state,
      },
    };

    await notificationRouter.send(notification);
    return { handled: true, notification };
  });

  webhookHandler.registerHandler("pull_request_review_comment", async (payload, deliveryId) => { ... });
  webhookHandler.registerHandler("issue_comment", async (payload, deliveryId) => { ... });

  webhookHandler.registerHandler("check_run", async (payload, deliveryId) => {
    const { action, check_run, repository } = payload;
    if (action !== "completed") return { handled: false };
    if (check_run.conclusion === "success") return { handled: false };
    // ... build notification for non-success conclusions
  });

  webhookHandler.registerHandler("pull_request", async (payload, deliveryId) => {
    // Invalidate cache on PR open/close/merge
    if (["opened", "closed", "reopened"].includes(payload.action)) {
      repoCache.invalidate(/* installationId */, "pullRequests");
    }
    // ... build notification
  });

  webhookHandler.registerHandler("push", async (payload, deliveryId) => {
    // Invalidate branch and repo caches on push
    repoCache.invalidateRepo(/* installationId */, payload.repository.owner.login, payload.repository.name);
    return { handled: true };
  });

  webhookHandler.registerHandler("installation", async (payload, deliveryId) => {
    // Handle app installed/uninstalled events
    // E-6 (App uninstalled): capture GitHubAppUninstalled event, notify clients
  });
}
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/notification_router.js` | Notification distribution to clients |
| `daemon/src/github/webhook_events.js` | Specific webhook event handlers |
| `daemon/tests/github/notification_router.test.js` | Unit tests |
| `daemon/tests/github/webhook_events.test.js` | Unit tests for each event handler |

**Acceptance Criteria**

- [ ] `NotificationRouter.send()` broadcasts to all connected WebSocket clients
- [ ] `NotificationRouter.send()` sends push notifications to mobile (non-blocking on failure)
- [ ] `NotificationRouter.send()` emits `GitHubWebhookReceived` event in event store
- [ ] `pull_request_review` events generate notifications with reviewer, state, and truncated body
- [ ] `pull_request_review_comment` events generate notifications with file, line, commenter, and truncated comment
- [ ] `check_run` completed events generate notifications only for non-success conclusions
- [ ] `issue_comment` events generate notifications for new comments
- [ ] `push` events invalidate repo and branch caches
- [ ] `pull_request` open/close/merge events invalidate PR cache
- [ ] `installation` events handle app install and uninstall (E-6)
- [ ] Push notification failure does not block webhook processing
- [ ] All webhook event handlers complete within 10 seconds

**Edge Cases**

- E-6 (App uninstalled): `installation` handler with `action: "deleted"` emits `GitHubAppUninstalled` event and notifies all clients.
- E-2 (Daemon downtime): GitHub retries; delivery dedup in Task 6 prevents double notifications.
- No connected WebSocket clients: Broadcast is a no-op (no error).
- Push service unavailable: Error is logged, not thrown.

**Estimated Effort**: M (Medium) -- 5-7 hours

---

### Task 9: Agent-from-Issue Workflow

**Description**

Implement the flagship workflow: user sees a GitHub issue, initiates the agent-from-issue flow from any client, and the daemon fetches issue context, creates a worktree, builds an initial prompt, spawns an agent, and on completion creates a PR linked to the issue.

This is an orchestration task that composes modules from Tasks 2, 5, 7, and 8.

**Prerequisites/Inputs**

- Task 2 (authenticated fetch for GitHub API).
- Task 5 (worktree manager).
- Task 7 (PR creator).
- Task 8 (notification router).
- Task 13 (event types: `AgentFromIssueStarted`, `AgentFromIssueCompleted`).
- Story 05 (Agent Manager) for `agentManager.spawn()`.

**Implementation Details**

File: `daemon/src/github/issue_context.js`

```javascript
// daemon/src/github/issue_context.js

const { MAX_ISSUE_BODY_CHARS, MAX_COMMENT_CHARS, MAX_COMMENTS_IN_PROMPT } = require("./constants");

class IssueContextExtractor {
  constructor(authenticatedFetch) {
    this.fetch = authenticatedFetch;
  }

  async extract(owner, repo, issueNumber) {
    // 1. Fetch issue via REST: GET /repos/{owner}/{repo}/issues/{issueNumber}
    // 2. Fetch comments: GET /repos/{owner}/{repo}/issues/{issueNumber}/comments?per_page=20
    // 3. Fetch linked PRs via timeline: GET /repos/{owner}/{repo}/issues/{issueNumber}/timeline?per_page=100
    // 4. Extract file references from body + comments
    // 5. Return structured context
  }

  _extractFileReferences(...textArrays) {
    // Patterns:
    //   Backtick-quoted: `src/foo/bar.ts`
    //   GitHub blob links: github.com/owner/repo/blob/branch/path
    //   Common paths: src/..., lib/..., app/..., etc.
  }

  async _fetchLinkedPRs(owner, repo, issueNumber) {
    // Use timeline API for cross-references
  }
}
```

File: `daemon/src/github/prompt_builder.js`

```javascript
// daemon/src/github/prompt_builder.js

const { MAX_ISSUE_BODY_CHARS, MAX_COMMENT_CHARS, MAX_COMMENTS_IN_PROMPT } = require("./constants");

function buildAgentPrompt(issueContext, config = {}) {
  const lines = [];

  lines.push(`# Task: ${issueContext.title}`);
  lines.push("");
  lines.push(`GitHub Issue: ${issueContext.url}`);
  lines.push("");

  // Issue description (truncated)
  lines.push("## Issue Description");
  lines.push("");
  let body = issueContext.body || "(no description)";
  if (body.length > MAX_ISSUE_BODY_CHARS) {
    body = body.substring(0, MAX_ISSUE_BODY_CHARS) +
      `\n\n[truncated -- see full issue at ${issueContext.url}]`;
  }
  lines.push(body);
  lines.push("");

  // Labels, referenced files, comments (max 5, truncated), linked PRs, instructions
  // ... (as specified in story)

  if (config.additionalInstructions) {
    lines.push("## Additional Instructions");
    lines.push("");
    lines.push(config.additionalInstructions);
    lines.push("");
  }

  return lines.join("\n");
}
```

File: `daemon/src/github/agent_from_issue.js`

```javascript
// daemon/src/github/agent_from_issue.js

class AgentFromIssueWorkflow {
  constructor({ tokenManager, worktreeManager, agentManager, prCreator, notificationRouter, eventStore }) {
    this.tokens = tokenManager;
    this.worktrees = worktreeManager;
    this.agents = agentManager;
    this.prCreator = prCreator;
    this.notifications = notificationRouter;
    this.events = eventStore;
    this.activeWorkflows = new Map(); // issueKey -> workflow state (for E-9 dedup)
  }

  async execute({
    installationId, owner, repo, issueNumber, repoPath,
    provider = "claude-code", baseBranch = "main",
    draft = true, additionalInstructions = "",
  }) {
    // E-9: Prevent concurrent workflows for same issue
    const issueKey = `${owner}/${repo}#${issueNumber}`;
    if (this.activeWorkflows.has(issueKey)) {
      const existing = this.activeWorkflows.get(issueKey);
      throw new GitHubError(
        `Agent already running for issue #${issueNumber} on branch ${existing.branch}`,
        "AGENT_ALREADY_RUNNING",
        { agent_id: existing.agentId, branch: existing.branch }
      );
    }

    const branchName = `agent/issue-${issueNumber}`;
    const fetch = await this.tokens.createAuthenticatedFetch(installationId);

    // 1. Extract issue context
    const extractor = new IssueContextExtractor(fetch);
    const issueContext = await extractor.extract(owner, repo, issueNumber);

    // 2. Create worktree
    const worktree = await this.worktrees.create(
      repoPath, owner, repo, branchName, baseBranch,
      { trigger: "agent-from-issue", issue_number: issueNumber }
    );

    // 3. Build prompt
    const prompt = buildAgentPrompt(issueContext, { additionalInstructions });

    // 4. Emit start event
    await this.events.append({
      event_type: "AgentFromIssueStarted",
      data: {
        owner, repo,
        issue_number: issueNumber,
        issue_title: issueContext.title,
        branch: branchName,
        worktree_path: worktree.path,
        provider,
      },
    });

    // 5. Register active workflow (E-9 guard)
    this.activeWorkflows.set(issueKey, { branch: branchName, startedAt: new Date().toISOString() });

    // 6. Spawn agent
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

    // Update active workflow with agent ID
    this.activeWorkflows.get(issueKey).agentId = agent.id;

    // 7. Register completion handler
    agent.on("completed", async () => {
      try {
        await this._onAgentCompleted(
          installationId, owner, repo, issueNumber,
          issueContext, branchName, baseBranch, agent, draft
        );
      } finally {
        this.activeWorkflows.delete(issueKey);
      }
    });

    agent.on("error", () => {
      this.activeWorkflows.delete(issueKey);
    });

    return {
      agent_id: agent.id,
      worktree_path: worktree.path,
      branch: branchName,
      issue: {
        number: issueContext.number,
        title: issueContext.title,
        labels: issueContext.labels,
        referenced_files: issueContext.referenced_files,
      },
      status: "running",
    };
  }

  async _onAgentCompleted(installationId, owner, repo, issueNumber, issueContext, branchName, baseBranch, agent, draft) {
    // 1. Create PR
    const pr = await this.prCreator.createPR(installationId, {
      owner, repo,
      worktreePath: agent.workingDirectory,
      branchName, baseBranch,
      title: issueContext.title,
      summary: `Implements ${issueContext.title} as described in #${issueNumber}.`,
      changes: agent.getChangeSummary ? agent.getChangeSummary() : [],
      agent: { provider: agent.provider, model: agent.model },
      session: {
        id: agent.sessionId,
        duration: agent.duration,
        toolCallCount: agent.toolCallCount || 0,
        filesModified: agent.filesModified || 0,
        userId: agent.userId,
      },
      issue: { number: issueNumber },
      draft,
    });

    // 2. Emit completion event
    await this.events.append({
      event_type: "AgentFromIssueCompleted",
      data: {
        owner, repo,
        issue_number: issueNumber,
        pr_number: pr.number,
        pr_url: pr.html_url,
        agent_id: agent.id,
        branch: branchName,
        duration: agent.duration,
        files_changed: agent.filesModified || 0,
      },
    });

    // 3. Push notification
    await this.notifications.send({
      type: "agent_from_issue_completed",
      title: `Agent completed: ${issueContext.title}`,
      body: `PR #${pr.number} created for issue #${issueNumber}`,
      repo: `${owner}/${repo}`,
      url: pr.html_url,
      delivery_id: `agent-complete-${agent.id}`,
    });
  }
}
```

**Daemon API Endpoint**

```
POST /api/github/agent-from-issue
```

Request body:
```json
{
  "owner": "myorg",
  "repo": "api",
  "issue_number": 42,
  "provider": "claude-code",
  "base_branch": "main",
  "draft": true,
  "additional_instructions": ""
}
```

Response:
```json
{
  "agent_id": "agent-abc123",
  "worktree_path": "/home/user/.agentcontext/worktrees/myorg-api/agent-issue-42",
  "branch": "agent/issue-42",
  "issue": {
    "number": 42,
    "title": "Add dark mode support",
    "labels": ["enhancement", "frontend"],
    "referenced_files": ["src/theme/provider.tsx"]
  },
  "status": "running"
}
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/issue_context.js` | Issue data extraction |
| `daemon/src/github/prompt_builder.js` | Agent prompt construction |
| `daemon/src/github/agent_from_issue.js` | Workflow orchestration |
| `daemon/tests/github/issue_context.test.js` | Unit tests for context extraction |
| `daemon/tests/github/prompt_builder.test.js` | Unit tests for prompt building |
| `daemon/tests/github/agent_from_issue.test.js` | Workflow integration tests |

**Acceptance Criteria**

- [ ] Full workflow executes end-to-end: issue fetch -> worktree creation -> agent spawn -> PR creation
- [ ] `IssueContextExtractor.extract()` fetches issue title, body, labels, comments, and linked PRs
- [ ] `_extractFileReferences()` finds backtick-quoted paths, GitHub blob links, and common path patterns
- [ ] `buildAgentPrompt()` includes title, body, labels, referenced files, discussion context, instructions
- [ ] `buildAgentPrompt()` truncates issue body at 5,000 characters with "[truncated]" notice
- [ ] `buildAgentPrompt()` limits to 5 most recent comments, each truncated to 500 characters
- [ ] Agent is spawned in the worktree directory with the constructed prompt
- [ ] On agent completion, branch is pushed and PR is created automatically
- [ ] PR body links to the originating issue with "Closes #N"
- [ ] `AgentFromIssueStarted` and `AgentFromIssueCompleted` events are captured
- [ ] E-9: Concurrent requests for the same issue are blocked with a descriptive error
- [ ] Active workflow tracking is cleaned up on both completion and error
- [ ] Workflow can be initiated from any connected client (mobile, desktop, dashboard)
- [ ] Daemon exposes `POST /api/github/agent-from-issue` endpoint

**Edge Cases**

- E-3 (Branch already exists): `WorktreeConflictError` from worktree manager propagates; client can offer resume or fresh start.
- E-8 (Large issue body): Truncated to 5,000 chars.
- E-9 (Concurrent requests): Second request blocked with descriptive error including existing agent ID.
- E-1 (Token expires mid-workflow): Retry logic in authenticated fetch handles this transparently.
- Issue does not exist (404): `IssueContextExtractor` throws a descriptive error.
- Agent fails midway: `error` event cleans up active workflow tracking; worktree is preserved for debugging.

**Estimated Effort**: XL (Extra Large) -- 10-14 hours

---

### Task 10: Multiple Repo Instances & Conflict Detection

**Description**

Implement the worktree listing endpoint and conflict detection system. Multiple agents can work on different branches of the same repository simultaneously via git worktrees. The conflict detector identifies overlapping file modifications across active worktrees to warn about potential merge conflicts.

**Prerequisites/Inputs**

- Task 5 (worktree manager).
- Story 05 (agent manager for querying agent status per worktree).

**Implementation Details**

File: `daemon/src/github/conflict_detector.js`

```javascript
// daemon/src/github/conflict_detector.js

class ConflictDetector {
  constructor(worktreeManager) {
    this.worktrees = worktreeManager;
  }

  async detectConflicts(repoPath, owner, repo) {
    const worktrees = await this.worktrees.list(repoPath);
    const worktreeFiles = new Map();

    // 1. Get modified files for each active worktree
    for (const wt of worktrees) {
      if (wt.branch && !wt.bare) {
        try {
          const output = await this.worktrees._git(wt.path, [
            "diff", "--name-only", "HEAD...origin/main",
          ]);
          const files = output.trim().split("\n").filter(Boolean);
          worktreeFiles.set(wt.branch, {
            path: wt.path,
            files: new Set(files),
          });
        } catch {
          // Skip broken worktrees
        }
      }
    }

    // 2. Compare all pairs for overlapping files
    const conflicts = [];
    const branches = Array.from(worktreeFiles.keys());
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        const a = worktreeFiles.get(branches[i]);
        const b = worktreeFiles.get(branches[j]);
        const overlap = new Set([...a.files].filter(f => b.files.has(f)));

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
}
```

The `GET /api/github/repos/:owner/:repo/worktrees` endpoint enriches worktree data with agent status:

```javascript
// Response shape:
{
  repo: "myorg/api",
  main_path: "/home/user/projects/myorg-api",
  worktrees: [
    {
      path: "...",
      branch: "agent/issue-42",
      head: "abc123...",
      agent_id: "agent-abc123",     // from agent manager
      agent_status: "running",       // from agent manager
      created_at: "...",
      last_activity: "...",
    },
  ],
  total: 2,
  max_recommended: 5,
}
```

**Daemon API Endpoints**

```
GET    /api/github/repos/:owner/:repo/worktrees     -> List active worktrees with agent status
POST   /api/github/repos/:owner/:repo/worktrees     -> Create a new worktree
DELETE /api/github/repos/:owner/:repo/worktrees/:branch -> Remove a worktree
GET    /api/github/repos/:owner/:repo/conflicts      -> Detect conflicts across worktrees
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/conflict_detector.js` | Cross-worktree conflict detection |
| `daemon/tests/github/conflict_detector.test.js` | Unit tests |

**Acceptance Criteria**

- [ ] Multiple worktrees can coexist for the same repository, each on a different branch
- [ ] `GET /api/github/repos/:owner/:repo/worktrees` lists all active worktrees with agent status
- [ ] `POST /api/github/repos/:owner/:repo/worktrees` creates a new worktree and returns the result
- [ ] `DELETE /api/github/repos/:owner/:repo/worktrees/:branch` removes a worktree
- [ ] `GET /api/github/repos/:owner/:repo/conflicts` returns overlapping file modifications
- [ ] Conflicts are classified by severity (low: 1-5 files, high: 5+ files)
- [ ] Creating a new worktree includes conflict check results in the response
- [ ] Creating a new worktree warns if it would exceed the recommended limit (5)
- [ ] Creating a new worktree is blocked if it would exceed the hard limit (10)
- [ ] Worktree removal cleans up the directory and prunes git's worktree list
- [ ] Each worktree is associated with at most one agent at a time
- [ ] Broken/corrupted worktrees are reported with a `corrupted` status in the listing

**Edge Cases**

- E-4 (Conflicting modifications): Conflict detector returns overlapping files and severity; UI surfaces this.
- E-10 (Worktree corruption): List endpoint reports corrupted worktrees; delete endpoint forces cleanup.
- No active worktrees: Return empty arrays.
- Agent completed but worktree still exists: `agent_status` is `completed` or `idle`.

**Estimated Effort**: M (Medium) -- 5-7 hours

---

### Task 11: GitHub Actions Trigger

**Description**

Implement the GitHub Actions integration that triggers agent workflows from CI events. When a `workflow_run` webhook indicates a CI failure, the daemon matches it against user-configured automation rules and spawns an agent to fix the failing tests.

**Prerequisites/Inputs**

- Task 2 (authenticated fetch).
- Task 5 (worktree manager).
- Task 6 (webhook handler for registering the `workflow_run` handler).
- Task 13 (event types for `GitHubActionsAgentTriggered`).
- Story 05 (agent manager).

**Implementation Details**

File: `daemon/src/github/actions_trigger.js`

```javascript
// daemon/src/github/actions_trigger.js

class ActionsIntegration {
  constructor({ webhookHandler, agentManager, worktreeManager, tokenManager, eventStore, config }) {
    this.agents = agentManager;
    this.worktrees = worktreeManager;
    this.tokens = tokenManager;
    this.events = eventStore;
    this.rules = config.automations || [];
    this.triggeredRuns = new Set(); // run IDs already processed (dedup)

    // Register webhook handler
    webhookHandler.registerHandler("workflow_run", this._handleWorkflowRun.bind(this));
  }

  async _handleWorkflowRun(payload, deliveryId) {
    const { action, workflow_run, repository } = payload;
    if (action !== "completed") return { handled: false };

    // Dedup: same run ID should not spawn multiple agents
    if (this.triggeredRuns.has(workflow_run.id)) {
      return { handled: false, reason: "duplicate_run" };
    }

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.repo !== repository.full_name) continue;
      if (!this._matchesRule(rule, workflow_run)) continue;

      this.triggeredRuns.add(workflow_run.id);
      return this._executeRule(rule, workflow_run, repository, deliveryId);
    }

    return { handled: false, reason: "no_matching_rule" };
  }

  _matchesRule(rule, workflowRun) {
    if (rule.workflow && rule.workflow !== workflowRun.name) return false;
    if (rule.on_conclusion && rule.on_conclusion !== workflowRun.conclusion) return false;
    if (rule.branch_pattern) {
      const regex = new RegExp(rule.branch_pattern);
      if (!regex.test(workflowRun.head_branch)) return false;
    }
    return true;
  }

  async _executeRule(rule, workflowRun, repository, deliveryId) {
    const [owner, repo] = repository.full_name.split("/");

    // 1. Fetch failed job details
    const failedJobs = await this._getFailedJobs(rule.installationId, owner, repo, workflowRun.id);

    // 2. Build branch name
    const branchName = `agent/fix-${workflowRun.head_branch}-${workflowRun.run_number}`;

    // 3. Build CI fix prompt
    const prompt = this._buildCIFixPrompt(workflowRun, failedJobs);

    // 4. Create worktree
    const worktree = await this.worktrees.create(
      rule.repo_path, owner, repo, branchName, workflowRun.head_branch,
      { trigger: "github-actions", run_id: workflowRun.id }
    );

    // 5. Spawn agent
    const agent = await this.agents.spawn({
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

    // 6. Emit event
    await this.events.append({
      event_type: "GitHubActionsAgentTriggered",
      data: {
        owner, repo,
        workflow: workflowRun.name,
        run_id: workflowRun.id,
        conclusion: workflowRun.conclusion,
        branch: workflowRun.head_branch,
        agent_id: agent.id,
        automation_rule: rule.id,
        worktree_branch: branchName,
      },
    });

    return {
      handled: true,
      agent_id: agent.id,
      worktree_path: worktree.path,
      branch: branchName,
      trigger: "workflow_run",
    };
  }

  async _getFailedJobs(installationId, owner, repo, runId) { ... }
  _buildCIFixPrompt(workflowRun, failedJobs) { ... }
}
```

Automation rules schema (stored in daemon config):

```json
{
  "id": "auto-fix-tests",
  "name": "Auto-fix failing tests",
  "repo": "myorg/api",
  "repo_path": "/home/user/projects/myorg-api",
  "installationId": 78901234,
  "workflow": "CI",
  "on_conclusion": "failure",
  "branch_pattern": "^(main|develop)$",
  "provider": "claude-code",
  "enabled": true
}
```

Rule validation at configuration time:
- `repo` must be in the format `owner/repo`.
- `repo_path` must be an existing directory with a `.git` folder.
- `branch_pattern` must be a valid regex.
- `provider` must be a known provider.

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/actions_trigger.js` | CI event handling and agent spawning |
| `daemon/tests/github/actions_trigger.test.js` | Unit tests with mocked webhooks |

**Acceptance Criteria**

- [ ] `workflow_run` webhook events are processed for completed runs
- [ ] Automation rules filter by workflow name, conclusion, and branch pattern
- [ ] Matching rules trigger worktree creation and agent spawn automatically
- [ ] Failed job details (names and failing steps) are fetched from the GitHub API
- [ ] Agent prompt includes workflow name, run URL, branch, commit SHA, and failed step details
- [ ] `GitHubActionsAgentTriggered` event is captured in the event store
- [ ] Automation rules can be enabled/disabled individually (only `enabled: true` rules are evaluated)
- [ ] Duplicate triggers are prevented (same run ID does not spawn multiple agents)
- [ ] Rules are validated at configuration time (regex, repo path existence)
- [ ] The daemon can trigger workflow dispatches via `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches`

**Edge Cases**

- Same `workflow_run` delivered twice: `triggeredRuns` set prevents double execution.
- Rule's `branch_pattern` is invalid regex: Validation catches this at config load time.
- Rule's `repo_path` does not exist: Error at rule execution time, logged and skipped.
- No matching rules: Webhook returns `{ handled: false }` without error.

**Estimated Effort**: M (Medium) -- 5-7 hours

---

### Task 12: Daemon API Route Registration

**Description**

Register all 14 GitHub API endpoints with the daemon's HTTP server. This task wires up the handler functions from Tasks 2-11 to their respective HTTP routes, handles request parsing, error responses, and status codes.

**Prerequisites/Inputs**

- All Tasks 2-11 (handler implementations).
- Story 06 (daemon HTTP server with route registration mechanism).

**Implementation Details**

File: `daemon/src/github/routes.js`

```javascript
// daemon/src/github/routes.js

function registerGitHubRoutes(server, github) {
  const {
    tokenManager, deviceFlow, repoBrowser, worktreeManager,
    prCreator, webhookHandler, agentFromIssue, conflictDetector,
    actionsIntegration, config,
  } = github;

  // === Auth ===

  server.post("/api/github/auth/device", async (req, res) => {
    // Start OAuth device flow
    // Returns: { user_code, verification_uri, expires_in }
  });

  server.get("/api/github/auth/status", async (req, res) => {
    // Check device flow status
    // Returns: { status: "pending" | "completed" | "expired" }
  });

  // === Status ===

  server.get("/api/github/status", async (req, res) => {
    // GitHub App connection status
    // Returns: { connected, app_id, installations, rate_limit }
  });

  server.get("/api/github/rate-limit", async (req, res) => {
    // Returns: { core: { remaining, limit, reset }, graphql: {...}, search: {...} }
  });

  // === Repository Browser ===

  server.get("/api/github/repos", async (req, res) => {
    // Query: ?page=1&per_page=20&search=dark-mode
  });

  server.get("/api/github/repos/:owner/:repo/branches", async (req, res) => {
    // Query: ?page=1&per_page=100
  });

  server.get("/api/github/repos/:owner/:repo/pulls", async (req, res) => {
    // Query: ?page=1&per_page=20&state=open
  });

  // === Worktrees ===

  server.get("/api/github/repos/:owner/:repo/worktrees", async (req, res) => {
    // List active worktrees with agent status
  });

  server.post("/api/github/repos/:owner/:repo/worktrees", async (req, res) => {
    // Body: { branch, base_branch }
    // Returns: worktree info + conflict warnings
  });

  server.delete("/api/github/repos/:owner/:repo/worktrees/:branch", async (req, res) => {
    // Remove worktree
  });

  // === Conflicts ===

  server.get("/api/github/repos/:owner/:repo/conflicts", async (req, res) => {
    // Returns: { conflicts: [...], checked_at }
  });

  // === Pull Requests ===

  server.post("/api/github/repos/:owner/:repo/pulls", async (req, res) => {
    // Body: { worktree_path, branch, base_branch, title, summary, ... }
  });

  // === Agent-from-Issue ===

  server.post("/api/github/agent-from-issue", async (req, res) => {
    // Body: { owner, repo, issue_number, provider, base_branch, draft, additional_instructions }
  });

  // === Webhook ===

  server.post("/github/webhook", async (req, res) => {
    // IMPORTANT: Read raw body for signature verification
    // Headers: x-github-event, x-hub-signature-256, x-github-delivery
  });
}
```

Error response format:

```json
{
  "error": {
    "code": "RATE_LIMIT",
    "message": "GitHub API rate limit exceeded. Resets at 2026-02-22T15:30:00Z",
    "details": { "remaining": 0, "resetAt": "2026-02-22T15:30:00Z" }
  }
}
```

HTTP status code mapping:

| Error Code | HTTP Status |
|---|---|
| `AUTH_ERROR` | 401 |
| `RATE_LIMIT` | 429 |
| `WEBHOOK_INVALID_SIGNATURE` | 401 |
| `WORKTREE_CONFLICT` | 409 |
| `AGENT_ALREADY_RUNNING` | 409 |
| `NO_COMMITS` | 400 |
| `PR_CREATE_FAILED` | 422 |
| `*` (unknown) | 500 |
| (validation error) | 400 |
| (not found) | 404 |

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/routes.js` | HTTP route registration for all 14 endpoints |
| `daemon/tests/github/routes.test.js` | API endpoint tests |

**Acceptance Criteria**

- [ ] All 14 API endpoints are registered and respond to the correct HTTP method and path
- [ ] `POST /github/webhook` reads raw body for signature verification (not parsed JSON)
- [ ] Error responses use structured format with `code`, `message`, and `details`
- [ ] HTTP status codes match the error-to-status mapping table
- [ ] Pagination query params (`page`, `per_page`) are parsed and passed to handlers
- [ ] Route params (`:owner`, `:repo`, `:branch`) are extracted correctly
- [ ] Request body is validated for required fields before passing to handlers
- [ ] All endpoints return JSON with `Content-Type: application/json`
- [ ] GitHub-disabled state (config `enabled: false`): all endpoints return 501 "GitHub integration not configured"

**Edge Cases**

- GitHub not configured: All endpoints return 501 with "GitHub integration not configured".
- Missing required body fields: Return 400 with specific field names.
- Invalid `:owner/:repo` format: Return 400.

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 13: Event Type Definitions

**Description**

Define and document all 10 custom event types for the GitHub integration. These event types follow the existing event store schema and are captured by the event store's `append()` interface.

**Prerequisites/Inputs**

- Task 1 (module scaffolding).
- Story 04 (event store schema and `append()` interface).

**Implementation Details**

File: `daemon/src/github/event_types.js`

```javascript
// daemon/src/github/event_types.js

/**
 * Event type definitions for GitHub integration.
 * Each event type has a name, required data fields, and a description.
 */

const EVENT_TYPES = {
  GitHubAppInstalled: {
    description: "GitHub App installed on user/org account",
    requiredFields: ["installation_id", "account", "account_type", "repositories", "permissions"],
  },
  GitHubAppUninstalled: {
    description: "GitHub App removed from user/org account",
    requiredFields: ["installation_id", "account", "account_type"],
  },
  WorktreeCreated: {
    description: "New worktree created from branch",
    requiredFields: ["owner", "repo", "branch", "base_branch", "worktree_path", "trigger"],
  },
  WorktreeRemoved: {
    description: "Worktree cleaned up",
    requiredFields: ["owner", "repo", "branch", "worktree_path"],
  },
  PullRequestCreated: {
    description: "Agent created a PR",
    requiredFields: ["owner", "repo", "pr_number", "pr_url", "title", "head_branch", "base_branch"],
  },
  AgentFromIssueStarted: {
    description: "Agent-from-issue workflow initiated",
    requiredFields: ["owner", "repo", "issue_number", "issue_title", "branch", "worktree_path", "provider"],
  },
  AgentFromIssueCompleted: {
    description: "Agent finished and PR created",
    requiredFields: ["owner", "repo", "issue_number", "pr_number", "pr_url", "agent_id", "branch"],
  },
  GitHubWebhookReceived: {
    description: "Webhook event processed",
    requiredFields: ["github_event", "action", "delivery_id", "repo"],
  },
  GitHubActionsAgentTriggered: {
    description: "CI event triggered agent creation",
    requiredFields: ["owner", "repo", "workflow", "run_id", "conclusion", "agent_id", "automation_rule", "worktree_branch"],
  },
  GitHubRateLimitHit: {
    description: "API rate limit reached",
    requiredFields: ["resource", "limit", "remaining", "reset_at"],
  },
};

function validateEventData(eventType, data) {
  const definition = EVENT_TYPES[eventType];
  if (!definition) return { valid: false, error: `Unknown event type: ${eventType}` };

  const missing = definition.requiredFields.filter(f => !(f in data));
  if (missing.length > 0) {
    return { valid: false, error: `Missing fields for ${eventType}: ${missing.join(", ")}` };
  }
  return { valid: true };
}

module.exports = { EVENT_TYPES, validateEventData };
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/src/github/event_types.js` | Event type definitions and validation |
| `daemon/tests/github/event_types.test.js` | Unit tests for validation |

**Acceptance Criteria**

- [ ] All 10 event types are defined with descriptions and required fields
- [ ] `validateEventData()` returns `{ valid: true }` for events with all required fields
- [ ] `validateEventData()` returns `{ valid: false, error }` listing missing fields
- [ ] Unknown event types are rejected with descriptive error
- [ ] Event types align with the event store's existing schema pattern

**Edge Cases**

- Extra fields beyond required: Allowed (forward-compatible).
- Null values for required fields: Treated as present (the field exists, even if null).

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 14: Integration Tests

**Description**

Create a comprehensive integration test suite that exercises the full GitHub integration lifecycle. Tests use mocked GitHub API responses (no real GitHub account needed) and verify end-to-end flows across all modules.

**Prerequisites/Inputs**

- All Tasks 1-13.
- A test harness for mocking HTTP requests (intercept `fetch`).

**Implementation Details**

Test files:

```
daemon/tests/github/
  integration/
    auth_flow.test.js       # Token management + device flow
    repo_browser.test.js    # Repo listing + caching + pagination
    worktree_lifecycle.test.js # Create, list, conflicts, remove
    pr_workflow.test.js     # Agent work -> PR creation
    agent_from_issue.test.js # Full workflow: issue -> worktree -> agent -> PR
    webhook_roundtrip.test.js # Webhook receive -> verify -> notify
    actions_trigger.test.js # CI failure -> automation rule -> agent spawn
    multi_worktree.test.js  # Multiple worktrees, conflict detection
    error_handling.test.js  # Edge cases E-1 through E-10
    event_capture.test.js   # All 10 event types are emitted correctly
```

**Test Cases**

| # | Test File | Test | Story Requirement |
|---|---|---|---|
| T-1 | auth_flow | Token cached and refreshed before expiry | F8.1 |
| T-2 | auth_flow | Token invalidated on 401 and retry succeeds | F8.1, E-1 |
| T-3 | auth_flow | Multiple installations maintain separate caches | F8.1 |
| T-4 | auth_flow | Device flow polls at correct interval, handles slow_down | F8.1 |
| T-5 | repo_browser | Cache returns data within TTL | F8.2 |
| T-6 | repo_browser | Cache returns null after TTL expires | F8.2 |
| T-7 | repo_browser | GraphQL pagination through 200+ repos | F8.2 |
| T-8 | repo_browser | REST branch listing with 500+ branches | F8.2 |
| T-9 | worktree_lifecycle | Create worktree from existing remote branch | F8.3 |
| T-10 | worktree_lifecycle | Create new branch from base when not on remote | F8.3 |
| T-11 | worktree_lifecycle | Slugify handles slashes, dots, unicode, long names | F8.3 |
| T-12 | worktree_lifecycle | Parse porcelain output (normal, detached, bare) | F8.3 |
| T-13 | worktree_lifecycle | Remove worktree cleans up directory and metadata | F8.3 |
| T-14 | pr_workflow | PR includes all required fields | F8.4 |
| T-15 | pr_workflow | PR body template includes agent context and issue link | F8.4 |
| T-16 | pr_workflow | PR creation with no new commits returns descriptive error | F8.4 |
| T-17 | pr_workflow | PR already exists returns existing PR URL | F8.4 |
| T-18 | webhook_roundtrip | Valid signature accepted | F8.5 |
| T-19 | webhook_roundtrip | Invalid signature rejected | F8.5 |
| T-20 | webhook_roundtrip | Timing-safe comparison used | F8.5 |
| T-21 | webhook_roundtrip | PR review generates correct notification | F8.5 |
| T-22 | webhook_roundtrip | Check run only notifies on non-success | F8.5 |
| T-23 | webhook_roundtrip | Duplicate deliveries ignored | F8.5 |
| T-24 | agent_from_issue | Full workflow: issue -> worktree -> agent -> PR | F8.6 |
| T-25 | agent_from_issue | File references extracted from issue text | F8.6 |
| T-26 | agent_from_issue | Prompt includes all sections | F8.6 |
| T-27 | agent_from_issue | Large issue body truncated at 5000 chars | F8.6 |
| T-28 | multi_worktree | Conflict detection finds overlapping files | F8.7 |
| T-29 | multi_worktree | Severity classification (low/high) | F8.7 |
| T-30 | actions_trigger | Rule matching by workflow, conclusion, branch | F8.8 |
| T-31 | actions_trigger | Failed job extraction from workflow run | F8.8 |
| T-32 | actions_trigger | CI fix prompt includes context | F8.8 |
| T-33 | auth_flow | Full app setup: manifest -> OAuth -> first token | F8.1 |
| T-34 | agent_from_issue | End-to-end: fetch -> worktree -> spawn -> PR | F8.6 |
| T-35 | webhook_roundtrip | Webhook -> notification on dashboard WebSocket | F8.5 |
| T-36 | multi_worktree | Create 3 worktrees, list, detect conflicts, remove | F8.7 |
| T-37 | error_handling | Token expiry during long operation: push after 50+ min | E-1 |
| T-38 | error_handling | Rate limit: cached data served with stale indicator | E-5 |
| T-39 | error_handling | Worktree conflict returns existing path | E-3 |
| T-40 | actions_trigger | Workflow_run webhook spawns agent from rule | F8.8 |
| T-41 | pr_workflow | PR from worktree with no new commits | F8.4 |
| T-42 | error_handling | Concurrent agent-from-issue blocked | E-9 |

**Test Infrastructure**

Mock GitHub API:
```javascript
// daemon/tests/github/helpers/mock_github.js

class MockGitHubAPI {
  constructor() {
    this.responses = new Map(); // URL pattern -> response
    this.requests = [];          // Captured requests for assertions
  }

  register(method, urlPattern, response) { ... }
  async fetch(url, options) { ... }
  assertCalled(method, urlPattern) { ... }
  assertCalledTimes(method, urlPattern, times) { ... }
}
```

Mock Git:
```javascript
// daemon/tests/github/helpers/mock_git.js

class MockGit {
  constructor() {
    this.commands = [];
    this.responses = new Map(); // "command args" -> stdout
  }

  register(args, response) { ... }
  exec(args) { ... } // Returns registered response or default
}
```

**Files to Create**

| File | Purpose |
|---|---|
| `daemon/tests/github/helpers/mock_github.js` | GitHub API mock |
| `daemon/tests/github/helpers/mock_git.js` | Git command mock |
| `daemon/tests/github/integration/*.test.js` | 10 integration test files |

**Acceptance Criteria**

- [ ] All 42 test cases pass
- [ ] Tests use mocked GitHub API responses (no real API calls)
- [ ] Tests use mocked git commands (no real git operations)
- [ ] Mock infrastructure captures request details for assertion
- [ ] Each test is independent (no shared mutable state between tests)
- [ ] Test suite completes within 60 seconds
- [ ] All 10 edge cases (E-1 through E-10) have at least one test

**Edge Cases**

All 10 edge cases from the story are covered:
- E-1: Token expires mid-operation (T-37)
- E-2: Webhook during downtime (T-23 -- dedup on retry)
- E-3: Worktree branch already exists (T-39)
- E-4: Conflicting modifications (T-28, T-29)
- E-5: Rate limiting (T-38)
- E-6: App uninstalled (in error_handling)
- E-7: Forged webhook (T-19)
- E-8: Large issue body (T-27)
- E-9: Concurrent agent-from-issue (T-42)
- E-10: Worktree corruption (in error_handling)

**Estimated Effort**: XL (Extra Large) -- 12-16 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/`.

| File | Action | Task(s) |
|---|---|---|
| `daemon/src/github/index.js` | Create | 1 |
| `daemon/src/github/constants.js` | Create | 1 |
| `daemon/src/github/errors.js` | Create | 1 |
| `daemon/src/github/config.js` | Create | 1 |
| `daemon/src/github/auth.js` | Create | 2 |
| `daemon/src/github/device_flow.js` | Create | 3 |
| `daemon/src/github/repo_browser.js` | Create | 4 |
| `daemon/src/github/repo_cache.js` | Create | 4 |
| `daemon/src/github/worktree.js` | Create | 5 |
| `daemon/src/github/webhook_handler.js` | Create | 6 |
| `daemon/src/github/pr_template.js` | Create | 7 |
| `daemon/src/github/pr_creator.js` | Create | 7 |
| `daemon/src/github/notification_router.js` | Create | 8 |
| `daemon/src/github/webhook_events.js` | Create | 8 |
| `daemon/src/github/issue_context.js` | Create | 9 |
| `daemon/src/github/prompt_builder.js` | Create | 9 |
| `daemon/src/github/agent_from_issue.js` | Create | 9 |
| `daemon/src/github/conflict_detector.js` | Create | 10 |
| `daemon/src/github/actions_trigger.js` | Create | 11 |
| `daemon/src/github/routes.js` | Create | 12 |
| `daemon/src/github/event_types.js` | Create | 13 |
| `daemon/tests/github/auth.test.js` | Create | 2 |
| `daemon/tests/github/device_flow.test.js` | Create | 3 |
| `daemon/tests/github/repo_browser.test.js` | Create | 4 |
| `daemon/tests/github/repo_cache.test.js` | Create | 4 |
| `daemon/tests/github/worktree.test.js` | Create | 5 |
| `daemon/tests/github/webhook_handler.test.js` | Create | 6 |
| `daemon/tests/github/pr_creator.test.js` | Create | 7 |
| `daemon/tests/github/notification_router.test.js` | Create | 8 |
| `daemon/tests/github/webhook_events.test.js` | Create | 8 |
| `daemon/tests/github/issue_context.test.js` | Create | 9 |
| `daemon/tests/github/prompt_builder.test.js` | Create | 9 |
| `daemon/tests/github/agent_from_issue.test.js` | Create | 9 |
| `daemon/tests/github/conflict_detector.test.js` | Create | 10 |
| `daemon/tests/github/actions_trigger.test.js` | Create | 11 |
| `daemon/tests/github/routes.test.js` | Create | 12 |
| `daemon/tests/github/event_types.test.js` | Create | 13 |
| `daemon/tests/github/helpers/mock_github.js` | Create | 14 |
| `daemon/tests/github/helpers/mock_git.js` | Create | 14 |
| `daemon/tests/github/integration/*.test.js` | Create | 14 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone |
|-------|-------|-----------|
| **Phase 1: Foundation** | Task 1 (Scaffolding), Task 13 (Event Types) | Module structure established, event types defined |
| **Phase 2: Authentication** | Task 2 (Token Manager), Task 3 (Device Flow) | GitHub API access working |
| **Phase 3: Core Operations** | Task 5 (Worktree Manager), Task 4 (Repo Browser & Cache) | Can browse repos and create worktrees |
| **Phase 4: Webhooks & Notifications** | Task 6 (Webhook Handler), Task 8 (Notification Router) | Webhook pipeline working |
| **Phase 5: PR & Issue Workflows** | Task 7 (PR Creation), Task 9 (Agent-from-Issue) | Full agent-from-issue workflow operational |
| **Phase 6: Advanced Features** | Task 10 (Multi-Instance), Task 11 (Actions Trigger) | Conflict detection, CI-triggered agents |
| **Phase 7: Integration** | Task 12 (Route Registration) | All endpoints wired up |
| **Phase 8: Validation** | Task 14 (Integration Tests) | All 42 test cases pass |

Tasks within each phase can be partially parallelized:
- Phase 1: Tasks 1 and 13 are independent.
- Phase 2: Task 3 depends on Task 2 for `clientId`, but can be developed concurrently.
- Phase 3: Tasks 4 and 5 both depend on Task 2 but are independent of each other.
- Phase 4: Task 8 depends on Task 6 but can be developed concurrently with Phase 3.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| No npm for Octokit: raw GitHub API calls are verbose | High | Medium (more code) | Utility functions for common patterns (paginate, graphql). Built-in `fetch` in Node 18+ eliminates HTTP client dep. |
| GitHub App setup requires user interaction on github.com | Certain | Low (one-time) | Clear CLI instructions. Device flow for headless. Setup guide in docs. |
| Webhook delivery requires public URL or tunnel | High | Medium (local-only limitation) | Document ngrok/cloudflared setup. Sync server relay as alternative for synced mode. |
| Git worktree operations can be slow on large repos | Medium | Medium (user experience) | 30-second timeout. Fetch only when needed. Shallow clones for worktrees (future optimization). |
| Rate limiting blocks repo browsing for heavy users | Medium | Low (cached fallback) | Aggressive caching. Stale data served on rate limit. ETags for conditional requests. |
| Agent-from-issue creates PRs with agent bugs | Certain | Medium (noisy PRs) | Default to draft PRs. Agent context metadata in PR body for transparency. |
| Concurrent worktree creation race conditions | Low | Medium (corrupt state) | Branch-level locking via `activeWorkflows` map. Worktree conflict check before creation. |
| Webhook signature verification bypass via timing attack | Very Low | High (security) | `crypto.timingSafeEqual` used explicitly. Tested for timing safety. |
| Large repo with many worktrees exhausts disk | Low | Medium (disk full) | Hard limit of 10 worktrees per repo. Dashboard shows disk usage. |
| GitHub API changes break our raw fetch calls | Low | Medium (breakage) | Pin `X-GitHub-Api-Version: 2022-11-28` header. Integration tests catch regressions. |

---

## Notes for Implementation

1. **No npm dependencies**. This project uses Node.js without npm. All GitHub API interactions use the built-in `fetch` API (Node 18+). JWT generation uses built-in `crypto`. There is no `@octokit/rest` or `@octokit/auth-app` -- we implement the equivalent functionality directly.

2. **The daemon must exist first**. This plan assumes `daemon/src/` exists with an HTTP server, WebSocket server, and event store integration. If the daemon has not been scaffolded yet (Stories 05-06), Task 12 (route registration) blocks on that.

3. **Worktree base directory** is `~/.agentcontext/worktrees/` by default, configurable via `github.worktree_base` in the daemon config. This directory is created lazily on first worktree creation.

4. **Event store integration** uses the `eventStore.append({ event_type, data })` interface from Story 04. Events are validated via `validateEventData()` (Task 13) before appending.

5. **Webhook tunnel for local mode**. In local-only mode (no sync server), webhooks require a tunnel (ngrok, cloudflared) to expose the daemon's `POST /github/webhook` endpoint to the internet. In synced mode, the sync server relay can forward webhooks. This plan does not implement the tunnel setup -- it is a manual user configuration step documented in setup guides.

6. **GraphQL vs REST**: Use GraphQL for aggregate queries (repo list with nested PR counts, reducing round trips). Use REST for single-resource operations (branches for one repo, creating a PR). The authenticated fetch wrapper from Task 2 supports both.

7. **Agent Manager interface**. Tasks 9 and 11 call `agentManager.spawn()` which returns an agent handle with `.on("completed", fn)` and `.on("error", fn)`. The agent handle also exposes `.id`, `.provider`, `.model`, `.sessionId`, `.duration`, `.toolCallCount`, `.filesModified`, and `.getChangeSummary()`. This interface is defined by Story 05.

8. **Idempotency**. Worktree creation checks for existing worktrees before creating. PR creation checks for existing PRs before creating. Agent-from-issue checks for active workflows before spawning. All operations are safe to retry.

---

## Effort Estimates

| Task | Complexity | Estimate |
|---|---|---|
| Task 1: GitHub Module Scaffolding | S | 2-3 hours |
| Task 2: GitHub App Auth & Token Manager | L | 8-10 hours |
| Task 3: OAuth Device Flow | M | 4-6 hours |
| Task 4: Repository Browser & Cache | L | 8-10 hours |
| Task 5: Worktree Manager | L | 8-10 hours |
| Task 6: Webhook Handler & Signature Verification | M | 5-6 hours |
| Task 7: PR Creation | M | 5-7 hours |
| Task 8: Notification Router | M | 5-7 hours |
| Task 9: Agent-from-Issue Workflow | XL | 10-14 hours |
| Task 10: Multiple Repo Instances & Conflict Detection | M | 5-7 hours |
| Task 11: GitHub Actions Trigger | M | 5-7 hours |
| Task 12: Daemon API Route Registration | M | 4-6 hours |
| Task 13: Event Type Definitions | S | 2-3 hours |
| Task 14: Integration Tests | XL | 12-16 hours |
| **Total** | | **~83-112 hours (~10.5-14 working days)** |
