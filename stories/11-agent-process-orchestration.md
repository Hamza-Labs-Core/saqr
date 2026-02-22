# Story 11: Agent Process Orchestration

## Overview

Agent Process Orchestration is the **Paseo-derived agent management layer** integrated into the AgentContext daemon. It provides a unified interface to spawn, manage, stream, interrupt, and persist multiple coding agent processes (Claude Code, OpenCode, Codex) running in parallel on the same machine. Each agent operates in its own git worktree with full lifecycle state tracking, permission routing, and real-time output streaming.

This is the core of what transforms GlobalContext from a passive event recorder into an active agent orchestration platform. Where Stories 01-05 capture events from externally-running agents, this story enables the daemon itself to own and control the agent processes -- spawning them on demand, routing permissions from remote clients, streaming output to any connected device, and resuming sessions across restarts.

**Guiding principle**: The daemon is the control plane. Agents are the data plane. The daemon never interprets agent output beyond what is needed for lifecycle management and event routing. All intelligence stays in the agents.

---

## Scope

### In Scope

- Provider abstraction layer (AgentClient/AgentSession interfaces)
- Agent lifecycle state machine with event emissions
- Multi-agent parallel execution in isolated worktrees
- Git worktree creation, cleanup, and branch management
- Permission queue, routing, approval/denial from any client
- Real-time AsyncGenerator streaming with backpressure
- Agent interruption (graceful and forced)
- Session persistence and resume across daemon restarts
- MCP server exposing agent management as tools
- Model listing and selection per provider

### Out of Scope (Non-Goals)

- Hook installation or configuration (Story 02)
- Event capture pipeline (Story 01)
- Projection engine (Stories 03-05)
- Dashboard UI for agent management (Story F4)
- Mobile/desktop app rendering (Stories F6, F7, F13)
- Session attach mode / PTY proxy (Story F12)
- Encrypted sync of agent state (Story F5)
- GitHub integration (Story F8)
- Cross-machine agent orchestration (Phase 5)
- Voice input / dictation

---

## Requirements

### 1. Provider Abstraction (F3.1)

The provider abstraction defines a unified interface for interacting with any supported coding agent. Each provider implements the same contract, allowing the daemon to manage Claude Code, OpenCode, and Codex agents interchangeably.

#### TypeScript Interfaces

```typescript
/**
 * Registry of all available agent providers.
 * Providers register themselves at daemon startup.
 */
interface ProviderRegistry {
  register(provider: AgentClient): void;
  get(providerId: string): AgentClient | undefined;
  list(): ProviderInfo[];
}

interface ProviderInfo {
  id: string;               // "claude-code" | "opencode" | "codex"
  name: string;             // Human-readable: "Claude Code"
  version: string;          // Provider implementation version
  installed: boolean;       // Whether the agent binary is available on this machine
  capabilities: ProviderCapabilities;
}

interface ProviderCapabilities {
  streaming: boolean;       // Can stream output in real time
  resume: boolean;          // Can resume from a saved session
  interruption: boolean;    // Can be interrupted without killing
  permissions: boolean;     // Emits permission requests
  modelSelection: boolean;  // Supports choosing a model
  worktree: boolean;        // Can operate in a worktree directory
}

/**
 * AgentClient is the factory interface for a provider.
 * Each provider (Claude Code, OpenCode, Codex) implements this once.
 */
interface AgentClient {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Create a new agent session.
   * Returns an AgentSession handle for interacting with the agent.
   */
  createSession(options: CreateSessionOptions): Promise<AgentSession>;

  /**
   * Resume a previously persisted session.
   */
  resumeSession(handle: PersistenceHandle): Promise<AgentSession>;

  /**
   * List available models for this provider.
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Check if the provider binary is installed and reachable.
   */
  healthCheck(): Promise<HealthCheckResult>;
}

interface CreateSessionOptions {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
  permissions?: PermissionPolicy;
  environment?: Record<string, string>;
  maxTurns?: number;
  sessionId?: string;        // Optionally specify an ID (for resume)
}

/**
 * AgentSession represents a single running (or idle) agent instance.
 * This is the primary interaction surface for the daemon.
 */
interface AgentSession {
  readonly sessionId: string;
  readonly providerId: string;
  readonly state: AgentState;
  readonly createdAt: Date;
  readonly workingDirectory: string;
  readonly model: string;

  /**
   * Send a prompt to the agent and receive a streaming response.
   * Throws if agent is not in 'idle' state.
   */
  sendPrompt(prompt: string): AsyncGenerator<AgentStreamEvent>;

  /**
   * Respond to a permission request.
   */
  respondToPermission(
    permissionId: string,
    decision: PermissionDecision
  ): Promise<void>;

  /**
   * Interrupt the currently running turn.
   * If graceful=true, waits for current tool call to complete.
   * If graceful=false, kills immediately.
   */
  interrupt(options?: { graceful?: boolean }): Promise<void>;

  /**
   * Get the persistence handle for resuming this session later.
   */
  getPersistenceHandle(): Promise<PersistenceHandle>;

  /**
   * Terminate the session permanently.
   */
  close(): Promise<void>;

  /**
   * Subscribe to state change events.
   */
  onStateChange(callback: (event: StateChangeEvent) => void): () => void;
}
```

#### Provider-to-Interface Mapping

| Interface Method | Claude Code (SDK) | OpenCode (HTTP) | Codex (JSONL) |
|------------------|-------------------|-----------------|---------------|
| `createSession` | `import { query } from '@anthropic-ai/claude-code'` | `POST /api/sessions` | `spawn("codex", [...args])` |
| `sendPrompt` | `query({ prompt, ... })` → AsyncGenerator | `POST /api/sessions/{id}/messages` → SSE | Write to stdin, read stdout JSONL |
| `respondToPermission` | SDK permission callback | `POST /api/sessions/{id}/permissions/{pid}` | Write permission response to stdin |
| `interrupt` | `AbortController.abort()` | `POST /api/sessions/{id}/cancel` | `SIGINT` to process |
| `resumeSession` | `query({ resume: sessionId })` | `POST /api/sessions` with `resume_id` | Not supported (capability=false) |
| `listModels` | `import { models } from '@anthropic-ai/claude-code'` | `GET /api/models` | Hardcoded list |
| `close` | Let query generator complete | `DELETE /api/sessions/{id}` | `SIGTERM` to process |

#### Provider Registry Pattern

```typescript
class DefaultProviderRegistry implements ProviderRegistry {
  private providers = new Map<string, AgentClient>();

  register(provider: AgentClient): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(
        `Provider "${provider.providerId}" is already registered`
      );
    }
    this.providers.set(provider.providerId, provider);
  }

  get(providerId: string): AgentClient | undefined {
    return this.providers.get(providerId);
  }

  list(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.providerId,
      name: PROVIDER_NAMES[p.providerId],
      version: PROVIDER_VERSIONS[p.providerId],
      installed: true, // Only registered if binary was found
      capabilities: p.capabilities,
    }));
  }
}
```

#### Acceptance Criteria

- [ ] `ProviderRegistry` supports register, get, and list operations.
- [ ] `AgentClient` interface is implemented for Claude Code provider.
- [ ] `AgentClient` interface is implemented for OpenCode provider (stub if `opencode serve` is not yet available).
- [ ] `AgentClient` interface is implemented for Codex provider (stub).
- [ ] `ProviderCapabilities` accurately reflects each provider's actual capabilities.
- [ ] `healthCheck()` detects whether the provider binary is installed.
- [ ] Registry prevents duplicate provider registration.
- [ ] All interfaces are exported as TypeScript types for external consumers (MCP clients, dashboard).

---

### 2. Agent Lifecycle (F3.2)

Each agent session follows a strict state machine. State transitions emit events that the daemon uses for UI updates, logging, and coordination.

#### State Machine

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
  ┌──────────────────────┐                                │
  │    initializing       │                                │
  │                      │                                │
  │  - Provider spawning │                                │
  │  - Worktree setup    │                                │
  │  - Environment config│                                │
  └──────────┬───────────┘                                │
             │ spawn success                              │
             ▼                                            │
  ┌──────────────────────┐    sendPrompt()     ┌─────────────────┐
  │       idle            │───────────────────►│    running        │
  │                      │                    │                  │
  │  - Awaiting input    │◄───────────────────│  - Processing    │
  │  - Ready for prompt  │    turn complete    │  - Tool calls    │
  │                      │◄───────────────────│  - Streaming     │
  └──────────┬───────────┘    interrupt        └────────┬────────┘
             │                                          │
             │ close()                                  │ unrecoverable
             │                                          │ error
             ▼                                          ▼
  ┌──────────────────────┐                   ┌──────────────────────┐
  │       closed          │                   │       error          │
  │                      │                   │                      │
  │  - Session ended     │                   │  - Recoverable:      │
  │  - Resources freed   │                   │    → retry → idle    │
  │  - Worktree cleaned  │                   │  - Fatal:            │
  │                      │                   │    → close → closed  │
  └──────────────────────┘                   └──────────────────────┘
```

#### State Definitions

```typescript
type AgentState =
  | "initializing"
  | "idle"
  | "running"
  | "error"
  | "closed";

interface StateChangeEvent {
  sessionId: string;
  previousState: AgentState;
  currentState: AgentState;
  timestamp: Date;
  reason?: string;          // Human-readable reason for the transition
  error?: AgentError;       // Present only when transitioning to "error"
}

interface AgentError {
  code: string;             // Machine-readable: "SPAWN_FAILED", "TIMEOUT", etc.
  message: string;          // Human-readable description
  recoverable: boolean;     // Can the agent recover without restart?
  retryAfterMs?: number;    // Suggested retry delay for recoverable errors
}
```

#### Valid State Transitions

| From | To | Trigger | Notes |
|------|----|---------|-------|
| `initializing` | `idle` | Provider spawn succeeds | Agent is ready to accept prompts |
| `initializing` | `error` | Spawn fails (binary not found, env error) | May be retried |
| `initializing` | `closed` | Close called during init | Cancels spawn, cleans up |
| `idle` | `running` | `sendPrompt()` called | Agent begins processing |
| `idle` | `closed` | `close()` called | Normal shutdown |
| `running` | `idle` | Turn completes successfully | Ready for next prompt |
| `running` | `idle` | `interrupt()` succeeds | Agent stops current turn |
| `running` | `error` | Unrecoverable error during execution | Check `error.recoverable` |
| `error` | `idle` | Recovery succeeds (auto-retry or manual) | Agent is ready again |
| `error` | `closed` | Recovery fails or `close()` called | Final state |

#### Event Emissions

Every state transition emits a `StateChangeEvent` to all registered listeners. The daemon uses these events to:

1. Update the agent status panel in the dashboard (F4.8)
2. Push notifications to mobile clients (F6.7)
3. Log state transitions for debugging
4. Trigger worktree cleanup on `closed` transition

#### Error Recovery Strategy

```typescript
interface RecoveryPolicy {
  maxRetries: number;           // Default: 3
  backoffMs: number;            // Default: 1000 (doubles each retry)
  maxBackoffMs: number;         // Default: 30000
  recoverableErrors: string[];  // Error codes that trigger auto-retry
}

const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  maxBackoffMs: 30000,
  recoverableErrors: [
    "RATE_LIMITED",
    "NETWORK_ERROR",
    "PROVIDER_TIMEOUT",
    "TRANSIENT_SPAWN_FAILURE",
  ],
};
```

When an error occurs:
1. Check if `error.code` is in `recoverableErrors`.
2. If recoverable and retries remain: transition to `error`, wait `backoffMs`, attempt recovery, transition to `idle` on success.
3. If not recoverable or retries exhausted: transition to `error` with `recoverable: false`, require manual intervention or `close()`.

#### Acceptance Criteria

- [ ] State machine enforces valid transitions only; invalid transitions throw `InvalidStateTransitionError`.
- [ ] Every state transition emits a `StateChangeEvent` to all registered listeners.
- [ ] `StateChangeEvent` includes `previousState`, `currentState`, `timestamp`, and optional `reason`.
- [ ] Error state distinguishes between recoverable and fatal errors.
- [ ] Auto-retry with exponential backoff is implemented for recoverable errors.
- [ ] `close()` can be called from any state and always transitions to `closed`.
- [ ] No state transitions occur after reaching `closed` (terminal state).
- [ ] State is queryable at any time via `session.state`.

---

### 3. Multi-Agent Parallel Execution (F3.3)

The daemon can manage multiple agent sessions simultaneously, each in its own isolated environment. This enables workflows like "spawn 3 agents: one for feature, one for tests, one for docs."

#### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    AgentContext Daemon                      │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                  Agent Manager                       │  │
│  │                                                     │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │  │
│  │  │ Agent #1 │  │ Agent #2 │  │ Agent #3 │  ...     │  │
│  │  │ claude   │  │ claude   │  │ opencode │         │  │
│  │  │ feature/ │  │ tests/   │  │ docs/    │         │  │
│  │  │ idle     │  │ running  │  │ running  │         │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘         │  │
│  │       │              │              │               │  │
│  │       ▼              ▼              ▼               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │  │
│  │  │ Worktree │  │ Worktree │  │ Worktree │         │  │
│  │  │ agent/f1 │  │ agent/t1 │  │ agent/d1 │         │  │
│  │  └──────────┘  └──────────┘  └──────────┘         │  │
│  │                                                     │  │
│  │  Resource Monitor:                                  │  │
│  │    Total CPU budget: 80% of available cores         │  │
│  │    Per-agent memory: configurable soft limit         │  │
│  │    Max concurrent agents: configurable (default: 5) │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
└──────────────────────────────────────────────────────────┘
```

#### Agent Manager Interface

```typescript
interface AgentManager {
  /**
   * Create and start a new agent.
   * Automatically provisions a worktree if the project is a git repo.
   */
  createAgent(options: CreateAgentOptions): Promise<AgentSession>;

  /**
   * Get a running agent by its session ID.
   */
  getAgent(sessionId: string): AgentSession | undefined;

  /**
   * List all agents (any state).
   */
  listAgents(filter?: AgentFilter): AgentSummary[];

  /**
   * Shut down a specific agent and clean up resources.
   */
  destroyAgent(sessionId: string): Promise<void>;

  /**
   * Shut down all agents (daemon shutdown).
   */
  destroyAll(): Promise<void>;

  /**
   * Subscribe to agent lifecycle events across all agents.
   */
  onAgentEvent(callback: (event: AgentManagerEvent) => void): () => void;
}

interface CreateAgentOptions {
  providerId: string;           // "claude-code" | "opencode" | "codex"
  projectPath: string;          // Absolute path to the git repository
  prompt?: string;              // Initial prompt to send after spawn
  model?: string;               // Model override
  branchName?: string;          // Custom branch name (default: auto-generated)
  useWorktree?: boolean;        // Default: true if git repo
  environment?: Record<string, string>;
  resourceLimits?: ResourceLimits;
}

interface AgentFilter {
  state?: AgentState[];
  providerId?: string;
  projectPath?: string;
}

interface AgentSummary {
  sessionId: string;
  providerId: string;
  state: AgentState;
  model: string;
  projectPath: string;
  worktreePath?: string;
  branchName?: string;
  createdAt: Date;
  lastActivityAt: Date;
  turnCount: number;
  tokenUsage: TokenUsage;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;         // Estimated USD cost
}
```

#### Resource Management

```typescript
interface ResourceLimits {
  maxMemoryMb?: number;       // Soft limit per agent (default: 2048)
  cpuWeight?: number;         // Relative CPU weight 1-100 (default: 50)
  maxOutputTokens?: number;   // Max tokens per turn
}

interface ResourceMonitor {
  /**
   * Check if the system has capacity for another agent.
   */
  canSpawn(): boolean;

  /**
   * Get current resource usage across all agents.
   */
  getUsage(): SystemResourceUsage;

  /**
   * Get per-agent resource usage.
   */
  getAgentUsage(sessionId: string): AgentResourceUsage;
}

interface SystemResourceUsage {
  activeAgents: number;
  maxAgents: number;
  totalMemoryUsedMb: number;
  systemMemoryTotalMb: number;
  systemMemoryAvailableMb: number;
  cpuLoadPercent: number;
}
```

Resource management is advisory, not enforced at the OS level. The daemon uses `process.memoryUsage()` and system stats from `/proc/meminfo` (Linux) or `sysctl` (macOS) to make spawn decisions. If the system is under memory pressure (available memory < 500MB), new agent spawns are rejected with a `RESOURCE_EXHAUSTED` error.

#### Agent Isolation Guarantees

| Isolation Domain | Mechanism | Guarantee |
|------------------|-----------|-----------|
| Filesystem | Separate git worktrees | Each agent sees its own working directory |
| Process | Separate OS processes | Agent crash does not affect other agents |
| Git state | Separate branches | Commits in one agent do not conflict with others |
| Environment | Per-agent env vars | `CLAUDE_SESSION_ID`, `AGENT_WORKTREE_PATH` injected |
| Stdout/stderr | Per-agent pipe capture | Output streams never cross |

#### Acceptance Criteria

- [ ] `AgentManager` can create, list, get, and destroy agents.
- [ ] Multiple agents can run simultaneously (tested with at least 3 concurrent agents).
- [ ] Each agent runs in its own OS process with isolated stdout/stderr.
- [ ] Resource monitor prevents spawning when system resources are exhausted.
- [ ] `maxAgents` configuration is enforced (default: 5).
- [ ] Agent crash does not affect daemon or other agents.
- [ ] `destroyAll()` cleanly shuts down all agents (used during daemon shutdown).
- [ ] `listAgents()` returns accurate state for all agents.
- [ ] Token usage is tracked per agent.
- [ ] `onAgentEvent` fires for create, state-change, and destroy across all agents.

---

### 4. Worktree Management (F3.4)

When an agent is spawned against a git repository, the daemon automatically creates a git worktree so the agent can make changes without affecting the main working directory or other agents.

#### Worktree Lifecycle

```
Agent created with projectPath=/home/user/my-project
  │
  ├─ 1. Verify projectPath is a git repo (git rev-parse --git-dir)
  │     If not a git repo: skip worktree, use projectPath directly
  │
  ├─ 2. Generate branch name
  │     Default: agent/{session-id-short}
  │     Custom:  user-provided branchName from CreateAgentOptions
  │
  ├─ 3. Determine worktree location
  │     Path: {projectPath}/../.agent-worktrees/{branch-name}
  │     (Sibling directory to the main repo, hidden with dot prefix)
  │
  ├─ 4. Create worktree
  │     git worktree add -b {branch-name} {worktree-path} HEAD
  │     If branch already exists: git worktree add {worktree-path} {branch-name}
  │
  ├─ 5. Configure worktree environment
  │     Copy .env, .claude/settings.json, etc. if present
  │     Set GIT_AUTHOR_NAME="AgentContext Bot"
  │     Set GIT_AUTHOR_EMAIL="agent@agentctx.local"
  │
  ├─ 6. Spawn agent in worktree directory
  │     cwd = worktree-path
  │
  └─ Agent session ends (close() or error)
      │
      ├─ 7. Commit any uncommitted changes in worktree
      │     git add -A && git commit -m "agent/{session-id}: final state"
      │     (Only if there are uncommitted changes)
      │
      ├─ 8. Clean up worktree
      │     git worktree remove {worktree-path} --force
      │     (Removes the worktree directory)
      │
      └─ 9. Branch is preserved for merge/review
            The branch agent/{session-id-short} remains in the repo
            User can: git merge agent/{session-id-short}
            Or:       git branch -d agent/{session-id-short}
```

#### Branch Naming Convention

```typescript
function generateBranchName(sessionId: string, custom?: string): string {
  if (custom) {
    // Sanitize user-provided name
    return `agent/${custom.replace(/[^a-zA-Z0-9_\-\/]/g, "-")}`;
  }
  // Use first 8 chars of session ID for brevity
  const shortId = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `agent/${shortId}`;
}

// Examples:
// generateBranchName("abc123-def456")        → "agent/abc123de"
// generateBranchName("x", "feature-auth")    → "agent/feature-auth"
// generateBranchName("x", "fix/login bug")   → "agent/fix/login-bug"
```

#### Worktree Manager Interface

```typescript
interface WorktreeManager {
  /**
   * Create a worktree for an agent session.
   * Returns the absolute path to the worktree directory.
   */
  create(options: WorktreeOptions): Promise<WorktreeInfo>;

  /**
   * Remove a worktree and optionally delete the branch.
   */
  remove(worktreePath: string, options?: RemoveOptions): Promise<void>;

  /**
   * List all agent worktrees for a project.
   */
  list(projectPath: string): Promise<WorktreeInfo[]>;

  /**
   * Check if a project path is a git repository.
   */
  isGitRepo(path: string): Promise<boolean>;
}

interface WorktreeOptions {
  projectPath: string;      // Main repo path
  branchName: string;       // Branch to create/use
  baseBranch?: string;      // Branch to fork from (default: HEAD)
}

interface WorktreeInfo {
  path: string;             // Absolute worktree directory
  branchName: string;       // Branch name in the worktree
  projectPath: string;      // Main repo path
  createdAt: Date;
  commitHash: string;       // HEAD commit at creation
}

interface RemoveOptions {
  deleteBranch?: boolean;   // Also delete the branch (default: false)
  force?: boolean;          // Force removal even if dirty (default: true)
  commitChanges?: boolean;  // Commit uncommitted changes before removal (default: true)
}
```

#### Acceptance Criteria

- [ ] Worktree is automatically created when an agent is spawned against a git repo.
- [ ] Worktree is placed at `{projectPath}/../.agent-worktrees/{branch-name}`.
- [ ] Branch naming follows `agent/{id}` convention.
- [ ] If the project is not a git repo, the agent runs directly in the project directory (no worktree).
- [ ] Worktree is cleaned up when the agent session ends.
- [ ] Uncommitted changes are auto-committed before worktree removal.
- [ ] The branch is preserved after worktree removal (for review/merge).
- [ ] Multiple worktrees can coexist for the same project.
- [ ] `list()` returns all active agent worktrees for a project.
- [ ] Branch name collisions are handled (append numeric suffix: `agent/abc-2`).

---

### 5. Permission Handling (F3.5)

When an agent requests permission to perform a potentially destructive action (file write, bash execution, etc.), the daemon captures the request and routes it to any connected client for approval. This enables workflows like approving agent actions from a phone.

#### Permission Flow

```
Agent (running in worktree)
  │
  ├─ Claude Code SDK emits: permission_requested event
  │   { tool_name: "Write", file_path: "/src/main.ts", ... }
  │
  ▼
Permission Router (in daemon)
  │
  ├─ 1. Create PermissionRequest with unique ID
  ├─ 2. Add to permission queue
  ├─ 3. Broadcast to all connected clients via WebSocket
  ├─ 4. Start timeout timer (default: 5 minutes)
  │
  ▼
Connected Clients (any number, any device)
  │
  ├─ Dashboard: shows amber alert card with approve/deny buttons
  ├─ Mobile app: push notification + action sheet
  ├─ Terminal: inline prompt with [y/n/a] options
  ├─ MCP client: tool call returns permission request as pending
  │
  ▼
First client to respond wins
  │
  ├─ Decision: allow | deny | always_allow
  │
  ▼
Permission Router
  │
  ├─ 5. Remove from queue
  ├─ 6. Cancel timeout timer
  ├─ 7. Forward decision to agent SDK
  ├─ 8. If "always_allow": persist to allow-list for this session
  ├─ 9. Broadcast resolution to all clients
  │
  ▼
Agent continues (or aborts if denied)
```

#### Permission Interfaces

```typescript
interface PermissionRequest {
  permissionId: string;          // Unique ID for this request
  sessionId: string;             // Agent session that generated the request
  toolName: string;              // "Write", "Bash", "Edit", etc.
  toolInput: Record<string, unknown>; // Tool arguments
  description: string;           // Human-readable description
  risk: PermissionRisk;          // "low" | "medium" | "high"
  requestedAt: Date;
  timeoutAt: Date;               // When auto-deny kicks in
  status: PermissionStatus;
}

type PermissionStatus =
  | "pending"
  | "allowed"
  | "denied"
  | "always_allowed"
  | "timed_out";

type PermissionRisk = "low" | "medium" | "high";

type PermissionDecision = "allow" | "deny" | "always_allow";

interface PermissionRouter {
  /**
   * Enqueue a permission request from an agent.
   * Returns a promise that resolves when the permission is decided.
   */
  requestPermission(request: Omit<PermissionRequest, "permissionId" | "status">):
    Promise<PermissionDecision>;

  /**
   * Respond to a pending permission request from any client.
   */
  respond(permissionId: string, decision: PermissionDecision, respondedBy: string):
    Promise<void>;

  /**
   * Get all pending permissions (for UI rendering).
   */
  getPending(): PermissionRequest[];

  /**
   * Get permissions for a specific agent session.
   */
  getForSession(sessionId: string): PermissionRequest[];

  /**
   * Subscribe to permission events.
   */
  onPermissionEvent(callback: (event: PermissionEvent) => void): () => void;
}

interface PermissionEvent {
  type: "requested" | "responded" | "timed_out";
  request: PermissionRequest;
  decision?: PermissionDecision;
  respondedBy?: string;      // Client ID that responded
}

interface PermissionPolicy {
  /**
   * Tools that are always allowed without prompting.
   */
  alwaysAllow: string[];     // e.g., ["Read", "Glob", "Grep"]

  /**
   * Tools that are always denied.
   */
  alwaysDeny: string[];      // e.g., ["Bash(rm -rf)"]

  /**
   * Timeout in milliseconds before auto-deny.
   */
  timeoutMs: number;         // Default: 300000 (5 minutes)

  /**
   * What to do on timeout: "deny" | "allow"
   */
  timeoutAction: "deny" | "allow"; // Default: "deny"
}
```

#### Risk Classification

| Tool | Default Risk | Rationale |
|------|-------------|-----------|
| `Read`, `Glob`, `Grep` | low | Read-only operations |
| `WebFetch`, `WebSearch` | low | Read-only, no local changes |
| `Edit` | medium | Modifies existing files |
| `Write` | medium | Creates new files |
| `Bash` | high | Arbitrary command execution |
| `NotebookEdit` | medium | Modifies notebook cells |

#### "Always Allow" Persistence

When a client responds with `always_allow`, the tool is added to the session's allow-list. For the remainder of that session, permissions for that tool are auto-approved without routing to clients.

The allow-list is:
- Scoped to a single agent session (not global).
- Stored in memory (lost on daemon restart).
- Optionally persisted to the session's persistence handle for resume.

#### Acceptance Criteria

- [ ] Permission requests from agents are captured and routed to all connected clients.
- [ ] The first client to respond decides the outcome; subsequent responses are ignored.
- [ ] Permission timeout triggers auto-deny (configurable) after 5 minutes.
- [ ] "Always allow" adds the tool to the session allow-list for future requests.
- [ ] Permission status is queryable via `getPending()` and `getForSession()`.
- [ ] Permission events are broadcast to all clients (requested, responded, timed_out).
- [ ] Risk classification is applied based on tool name.
- [ ] `PermissionPolicy.alwaysAllow` bypasses the permission queue for listed tools.
- [ ] Denied permissions result in the agent receiving a tool error (not a crash).
- [ ] Multiple concurrent permission requests from different agents are handled independently.

---

### 6. Agent Streaming (F3.6)

Agent output is streamed in real time to all connected clients using the `AsyncGenerator` pattern. This is the primary data channel between agents and the daemon's WebSocket/SSE layer.

#### Stream Event Types

```typescript
type AgentStreamEvent =
  | TimelineEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCanceledEvent
  | PermissionRequestedEvent
  | UsageUpdateEvent
  | ThinkingEvent
  | ToolUseStartEvent
  | ToolUseCompleteEvent
  | TextDeltaEvent;

interface TimelineEvent {
  type: "timeline";
  timestamp: Date;
  content: string;           // Markdown text from the agent
  role: "assistant" | "system";
}

interface TextDeltaEvent {
  type: "text_delta";
  timestamp: Date;
  delta: string;             // Incremental text chunk
  accumulatedText: string;   // Full text so far in this turn
}

interface ThinkingEvent {
  type: "thinking";
  timestamp: Date;
  thinking: string;          // Thinking/reasoning text (if model supports)
}

interface ToolUseStartEvent {
  type: "tool_use_start";
  timestamp: Date;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface ToolUseCompleteEvent {
  type: "tool_use_complete";
  timestamp: Date;
  toolUseId: string;
  toolName: string;
  result: string;
  isError: boolean;
}

interface TurnCompletedEvent {
  type: "turn_completed";
  timestamp: Date;
  usage: TokenUsage;
  turnIndex: number;
}

interface TurnFailedEvent {
  type: "turn_failed";
  timestamp: Date;
  error: AgentError;
  turnIndex: number;
}

interface TurnCanceledEvent {
  type: "turn_canceled";
  timestamp: Date;
  reason: string;            // "user_interrupt" | "timeout" | "resource_limit"
  turnIndex: number;
}

interface PermissionRequestedEvent {
  type: "permission_requested";
  timestamp: Date;
  permissionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  risk: PermissionRisk;
}

interface UsageUpdateEvent {
  type: "usage_update";
  timestamp: Date;
  usage: TokenUsage;
  contextWindowPercent: number; // 0-100
}
```

#### Streaming Architecture

```
Agent Process (Claude Code SDK)
  │
  │ AsyncGenerator<AgentStreamEvent>
  │
  ▼
Stream Multiplexer (in daemon)
  │
  ├─ Maintains list of consumers per session
  ├─ Each consumer gets its own AsyncGenerator
  ├─ Events are fanned out to all consumers
  │
  ├─────► Consumer 1: WebSocket client (dashboard)
  ├─────► Consumer 2: WebSocket client (mobile via relay)
  ├─────► Consumer 3: SSE client (fallback)
  ├─────► Consumer 4: Event store capture (GC hooks)
  └─────► Consumer 5: MCP client (wait_for_agent)
```

#### Multiplexer Implementation

```typescript
interface StreamMultiplexer<T> {
  /**
   * Feed events from the source generator.
   * Call this with the agent's output stream.
   */
  setSource(source: AsyncGenerator<T>): void;

  /**
   * Create a new consumer that receives all future events.
   * Also receives buffered recent events (for late joiners).
   */
  subscribe(options?: SubscribeOptions): AsyncGenerator<T>;

  /**
   * Number of active consumers.
   */
  readonly consumerCount: number;

  /**
   * Close all consumers and the source.
   */
  close(): void;
}

interface SubscribeOptions {
  /**
   * How many recent events to replay for late-joining consumers.
   * Default: 100
   */
  replayCount?: number;

  /**
   * If the consumer falls behind by more than this many events,
   * older events are dropped (backpressure).
   * Default: 1000
   */
  maxBufferSize?: number;
}
```

#### Backpressure Handling

When a consumer cannot keep up with the event stream (slow WebSocket connection, paused mobile app), the multiplexer applies backpressure:

1. Events are buffered up to `maxBufferSize` per consumer.
2. When the buffer is full, the oldest events are dropped.
3. A `buffer_overflow` warning is sent to the consumer so it knows events were lost.
4. The source generator is never blocked -- fast consumers are not penalized by slow ones.

#### Acceptance Criteria

- [ ] `sendPrompt()` returns an `AsyncGenerator<AgentStreamEvent>` that yields events in real time.
- [ ] All defined event types are emitted at the appropriate moments.
- [ ] `TextDeltaEvent` enables word-by-word streaming of agent responses.
- [ ] `StreamMultiplexer` supports multiple simultaneous consumers per session.
- [ ] Late-joining consumers receive recent event replay.
- [ ] Backpressure drops old events for slow consumers without blocking the source.
- [ ] Consumer count is queryable (for dashboard display).
- [ ] All consumers are cleaned up when the session ends.
- [ ] Events include timestamps for ordering and latency measurement.
- [ ] `ToolUseStartEvent` and `ToolUseCompleteEvent` can be correlated by `toolUseId`.

---

### 7. Agent Interruption (F3.7)

A running agent can be interrupted without killing the session. This allows a user to stop an agent that is going in the wrong direction, without losing session state.

#### Interrupt Chain

```
Client (dashboard/mobile/terminal/MCP)
  │
  │ interrupt(sessionId, { graceful: true })
  │
  ▼
Daemon (AgentManager)
  │
  ├─ 1. Validate agent is in "running" state
  ├─ 2. If graceful: set interrupt flag, wait for current tool to complete
  ├─ 3. If forced:  signal abort immediately
  │
  ▼
Provider-Specific Handler
  │
  ├─ Claude Code: AbortController.abort()
  │   The SDK catches this and cleanly stops generation
  │
  ├─ OpenCode: POST /api/sessions/{id}/cancel
  │   The HTTP API acknowledges and stops
  │
  ├─ Codex: process.kill(pid, 'SIGINT')
  │   SIGINT triggers Codex's graceful shutdown handler
  │
  ▼
Agent responds to interrupt
  │
  ├─ Current turn is marked as canceled (TurnCanceledEvent)
  ├─ State transitions: running → idle
  ├─ Session context is preserved (conversation so far is intact)
  ├─ Agent is ready for the next prompt
  │
  ▼
All connected clients receive:
  - TurnCanceledEvent
  - StateChangeEvent (running → idle)
```

#### Graceful vs Forced Interrupt

| Aspect | Graceful | Forced |
|--------|----------|--------|
| Mechanism | Wait for current tool call to finish, then stop | Abort immediately |
| Data safety | Current tool result is captured | Partial tool output may be lost |
| Timeout | Waits up to 10 seconds for tool completion | Immediate (< 100ms) |
| State after | `idle` (clean) | `idle` (may have incomplete context) |
| When to use | Agent is going wrong direction | Agent is stuck or unresponsive |
| Fallback | Escalates to forced after timeout | N/A |

```typescript
interface InterruptOptions {
  graceful?: boolean;           // Default: true
  gracefulTimeoutMs?: number;   // Default: 10000
  reason?: string;              // Human-readable (included in TurnCanceledEvent)
}
```

#### Interrupt Error Handling

| Scenario | Behavior |
|----------|----------|
| Agent not in `running` state | Throw `InvalidStateError("Cannot interrupt: agent is not running")` |
| Graceful timeout exceeded | Escalate to forced interrupt automatically |
| Provider does not support interrupt | Forced: send SIGTERM. Graceful: not possible, fall back to forced. |
| Multiple interrupt calls | Second call is a no-op if first is still in progress |
| Agent crashes during interrupt | Transition to `error` state, not `idle` |

#### Acceptance Criteria

- [ ] Graceful interrupt waits for current tool call to complete before stopping.
- [ ] Forced interrupt stops the agent immediately via provider-specific mechanism.
- [ ] Graceful interrupt escalates to forced after timeout (default 10s).
- [ ] Session state is preserved after interrupt (agent is reusable).
- [ ] `TurnCanceledEvent` is emitted to all consumers with the interrupt reason.
- [ ] State transitions to `idle` after successful interrupt.
- [ ] Interrupting a non-running agent throws a clear error.
- [ ] Multiple concurrent interrupt calls do not cause errors.
- [ ] Provider-specific abort mechanisms are tested for each provider.

---

### 8. Session Persistence (F3.8)

Agent sessions can be saved and resumed across daemon restarts. This enables "resume yesterday's agent session" workflows.

#### Persistence Handle

```typescript
interface PersistenceHandle {
  sessionId: string;
  providerId: string;
  model: string;
  workingDirectory: string;
  worktreePath?: string;
  branchName?: string;
  createdAt: Date;
  lastActivityAt: Date;
  turnCount: number;
  tokenUsage: TokenUsage;
  permissionAllowList: string[];
  providerState: Record<string, unknown>; // Provider-specific resume data
}
```

#### Persistence Flow

```
Session running (or idle)
  │
  ├─ Daemon writes persistence handle to disk on:
  │   - Every state change
  │   - Every turn completion
  │   - Explicit save request
  │   - Daemon shutdown (graceful)
  │
  ├─ Handle location:
  │   ~/.claude-context/sessions/{session-id}/handle.json
  │
  ▼
Daemon restarts
  │
  ├─ Scan ~/.claude-context/sessions/ for handle files
  ├─ For each handle:
  │   ├─ Check if worktree still exists
  │   ├─ Check if provider binary is still installed
  │   ├─ Attempt resume via provider.resumeSession(handle)
  │   ├─ On success: session transitions to idle
  │   └─ On failure: session marked as "stale" (manual intervention needed)
  │
  ▼
Session resumed, ready for next prompt
```

#### Provider-Specific Resume Data

| Provider | `providerState` Contents | Resume Mechanism |
|----------|-------------------------|------------------|
| Claude Code | `{ claudeSessionId: string, projectPath: string }` | `query({ resume: claudeSessionId })` |
| OpenCode | `{ httpSessionId: string, serverUrl: string }` | `POST /api/sessions` with `resume_id` |
| Codex | Not supported | New session with context from event store |

#### Session Directory Layout

```
~/.claude-context/sessions/
├── {session-id-1}/
│   └── handle.json
├── {session-id-2}/
│   └── handle.json
└── ...
```

#### Stale Session Handling

A session is "stale" when it cannot be resumed:
- Worktree was manually deleted.
- Provider binary was uninstalled.
- Provider's internal session expired.
- The `providerState` is corrupt.

Stale sessions are listed in the dashboard with a "stale" badge. The user can:
1. Retry resume (if the issue was transient).
2. Delete the handle (acknowledge data loss).
3. Start a new session in the same worktree (if it exists).

#### Acceptance Criteria

- [ ] `PersistenceHandle` is written to disk on every turn completion and state change.
- [ ] Handle file is valid JSON and contains all fields required for resume.
- [ ] On daemon restart, all persisted sessions are discovered and resume is attempted.
- [ ] Claude Code sessions resume via the SDK's `resume` parameter.
- [ ] Resumed sessions preserve their `sessionId` (no ID change).
- [ ] Token usage accumulates across restarts (not reset).
- [ ] Permission allow-list is restored on resume.
- [ ] Stale sessions are detected and reported (not silently dropped).
- [ ] Handle files are cleaned up when a session is explicitly closed.
- [ ] Worktree integrity is verified before resume attempt.

---

### 9. MCP Server (F3.9)

The daemon exposes agent management as MCP (Model Context Protocol) tools. This enables a parent agent to orchestrate child agents via standard tool calls.

#### MCP Tool Definitions

```typescript
// Tool: create_agent
{
  name: "create_agent",
  description: "Spawn a new coding agent in its own worktree. Returns the agent session ID.",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["claude-code", "opencode", "codex"],
        description: "Which agent provider to use"
      },
      project_path: {
        type: "string",
        description: "Absolute path to the git repository"
      },
      prompt: {
        type: "string",
        description: "Initial prompt to send to the agent"
      },
      model: {
        type: "string",
        description: "Model to use (provider-specific)"
      },
      branch_name: {
        type: "string",
        description: "Custom branch name for the worktree"
      }
    },
    required: ["provider", "project_path"]
  }
}

// Tool: list_agents
{
  name: "list_agents",
  description: "List all running agents with their current state, model, and resource usage.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: ["initializing", "idle", "running", "error", "closed"],
        description: "Filter by agent state"
      }
    }
  }
}

// Tool: send_prompt
{
  name: "send_prompt",
  description: "Send a prompt to an idle agent. The agent must be in 'idle' state.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Agent session ID"
      },
      prompt: {
        type: "string",
        description: "The prompt to send"
      }
    },
    required: ["session_id", "prompt"]
  }
}

// Tool: wait_for_agent
{
  name: "wait_for_agent",
  description: "Block until the specified agent reaches 'idle' or 'error' state. Returns the final turn result.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Agent session ID"
      },
      timeout_ms: {
        type: "number",
        description: "Maximum wait time in milliseconds (default: 300000 = 5 min)"
      }
    },
    required: ["session_id"]
  }
}

// Tool: cancel_agent
{
  name: "cancel_agent",
  description: "Interrupt a running agent. Use graceful=true to wait for current tool to finish.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Agent session ID"
      },
      graceful: {
        type: "boolean",
        description: "Wait for current tool to complete (default: true)"
      }
    },
    required: ["session_id"]
  }
}

// Tool: get_agent_output
{
  name: "get_agent_output",
  description: "Get the accumulated output from an agent's most recent turn.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Agent session ID"
      }
    },
    required: ["session_id"]
  }
}
```

#### MCP Server Integration

```
┌───────────────────────────────────────────────────────┐
│                  AgentContext Daemon                     │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           MCP Server (/mcp/agents)               │   │
│  │                                                   │   │
│  │  Implements: MCP Streamable HTTP Transport        │   │
│  │  Endpoint:   http://localhost:{port}/mcp/agents   │   │
│  │                                                   │   │
│  │  Tools:                                           │   │
│  │    create_agent  → AgentManager.createAgent()     │   │
│  │    list_agents   → AgentManager.listAgents()      │   │
│  │    send_prompt   → session.sendPrompt()           │   │
│  │    wait_for_agent→ poll session.state              │   │
│  │    cancel_agent  → session.interrupt()             │   │
│  │    get_agent_output → read turn accumulator       │   │
│  │                                                   │   │
│  │  Resources:                                       │   │
│  │    agent://{sessionId}/status                     │   │
│  │    agent://{sessionId}/output                     │   │
│  │    agent://{sessionId}/permissions                │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└───────────────────────────────────────────────────────┘
```

#### MCP Protocol Compliance

The MCP server follows the [Model Context Protocol specification](https://modelcontextprotocol.io/):

- Transport: Streamable HTTP (SSE for server-to-client notifications)
- Endpoint: `http://localhost:{daemon-port}/mcp/agents`
- Authentication: Local-only (no auth required when bound to localhost)
- Tool discovery: Standard `tools/list` method
- Resource discovery: Standard `resources/list` method

#### Parent-Agent Orchestration Example

A parent Claude Code agent can orchestrate child agents via MCP:

```
Parent Agent (Claude Code):
  "I need to implement feature X. Let me spawn agents for different parts."

  → Tool call: create_agent { provider: "claude-code", project_path: "/repo",
      prompt: "Implement the auth module in src/auth/", branch_name: "feature-x-auth" }
  ← { session_id: "agent-1", state: "running" }

  → Tool call: create_agent { provider: "claude-code", project_path: "/repo",
      prompt: "Write tests for the auth module", branch_name: "feature-x-tests" }
  ← { session_id: "agent-2", state: "running" }

  → Tool call: wait_for_agent { session_id: "agent-1" }
  ← { state: "idle", last_turn: { ... }, token_usage: { ... } }

  → Tool call: wait_for_agent { session_id: "agent-2" }
  ← { state: "idle", last_turn: { ... }, token_usage: { ... } }

  → Tool call: get_agent_output { session_id: "agent-1" }
  ← { output: "Implemented auth module with JWT...", files_changed: [...] }

  "Both agents finished. Let me review and merge their work."
```

#### Acceptance Criteria

- [ ] MCP server is accessible at `/mcp/agents` on the daemon port.
- [ ] All 6 tools are discoverable via `tools/list`.
- [ ] `create_agent` spawns a new agent and returns its session ID.
- [ ] `list_agents` returns all agents with current state and metadata.
- [ ] `send_prompt` sends a prompt to an idle agent and returns immediately.
- [ ] `wait_for_agent` blocks until the agent reaches idle/error and returns the result.
- [ ] `cancel_agent` interrupts a running agent.
- [ ] `get_agent_output` returns the accumulated output from the last turn.
- [ ] MCP protocol compliance: proper JSON-RPC, error codes, tool schemas.
- [ ] A Claude Code agent can use MCP tools to orchestrate child agents (tested end-to-end).

---

### 10. Model Selection (F3.10)

Each provider supports one or more models. The daemon provides a unified interface for listing and selecting models, with normalization across providers.

#### Model Interface

```typescript
interface ModelInfo {
  id: string;                // Provider-specific model ID
  name: string;              // Human-readable name
  providerId: string;        // Which provider this model belongs to
  capabilities: ModelCapabilities;
  contextWindow: number;     // Max tokens in context
  maxOutputTokens: number;   // Max tokens per response
  pricing?: ModelPricing;
}

interface ModelCapabilities {
  thinking: boolean;         // Extended thinking / reasoning
  vision: boolean;           // Image input support
  caching: boolean;          // Prompt caching support
  streaming: boolean;        // Streaming output
  toolUse: boolean;          // Function calling / tool use
}

interface ModelPricing {
  inputPerMillion: number;   // USD per million input tokens
  outputPerMillion: number;  // USD per million output tokens
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}
```

#### Model Normalization

Models from different providers are normalized to a consistent schema:

| Claude Code Models | OpenCode Models | Codex Models |
|-------------------|-----------------|--------------|
| `claude-opus-4-6` | `claude-opus-4-6` (via Anthropic) | `o4-mini` |
| `claude-sonnet-4-5` | `gpt-4.1` (via OpenAI) | `codex-mini` |
| `claude-haiku-3-5` | `deepseek-r1` (via DeepSeek) | |

```typescript
interface ModelSelector {
  /**
   * List all available models across all providers.
   */
  listAll(): ModelInfo[];

  /**
   * List models for a specific provider.
   */
  listForProvider(providerId: string): ModelInfo[];

  /**
   * Get the default model for a provider.
   */
  getDefault(providerId: string): ModelInfo;

  /**
   * Validate that a model ID is available for a provider.
   */
  validate(providerId: string, modelId: string): boolean;
}
```

#### Dynamic Model Switching

An agent's model can be changed between turns (when the agent is in `idle` state). This does not affect the session -- the next prompt uses the new model.

```typescript
interface AgentSession {
  // ... (existing methods)

  /**
   * Change the model for subsequent prompts.
   * Only valid when agent is in 'idle' state.
   */
  setModel(modelId: string): Promise<void>;
}
```

Model switching is provider-dependent:
- **Claude Code**: The SDK accepts a `model` parameter per `query()` call.
- **OpenCode**: Model is set via `PATCH /api/sessions/{id}/config`.
- **Codex**: Model is set as a CLI flag; requires session restart.

#### Acceptance Criteria

- [ ] `listAll()` returns models from all registered providers.
- [ ] `listForProvider()` returns only models for the specified provider.
- [ ] `getDefault()` returns a sensible default for each provider.
- [ ] `validate()` confirms a model ID is valid for a provider.
- [ ] `setModel()` changes the model between turns without losing session state.
- [ ] `ModelInfo` includes context window size, pricing, and capability flags.
- [ ] Model pricing enables accurate cost estimation per turn.
- [ ] Invalid model IDs produce clear error messages.

---

## Edge Cases

### E-1: Provider Binary Not Found

**Scenario**: User requests `create_agent` with `provider: "opencode"`, but `opencode` is not installed on the machine.

**Expected behavior**: `AgentClient.healthCheck()` returns `{ installed: false }`. The `createAgent()` call fails with a `PROVIDER_NOT_INSTALLED` error that includes installation instructions:

```
Error: Provider "opencode" is not installed.
Install it: go install github.com/opencode-ai/opencode@latest
```

The agent is never created. No worktree is provisioned.

---

### E-2: Worktree on Non-Git Directory

**Scenario**: User requests an agent in `/tmp/scratch/` which is not a git repository.

**Expected behavior**: `WorktreeManager.isGitRepo()` returns false. The agent is spawned directly in `/tmp/scratch/` without creating a worktree. `AgentSummary.worktreePath` is `undefined`. A warning is logged:

```
[agent-manager] WARN: /tmp/scratch is not a git repo. Agent will run without a worktree (no branch isolation).
```

---

### E-3: Permission Timeout With No Connected Clients

**Scenario**: An agent requests permission to write a file, but no clients (dashboard, mobile, terminal) are connected to the daemon.

**Expected behavior**: The permission enters the queue and the timeout timer starts. After 5 minutes (or the configured `timeoutMs`), the permission is auto-denied. The agent receives a tool error:

```
Permission denied (timed out): no client responded within 300s
```

The agent can retry the tool call or proceed with alternative actions.

---

### E-4: Daemon Crash During Agent Execution

**Scenario**: The daemon process crashes (OOM, SIGSEGV, power loss) while an agent is in `running` state.

**Expected behavior**: On daemon restart:
1. Persistence handles are read from `~/.claude-context/sessions/`.
2. Agent processes may still be running (orphaned) or may have exited.
3. For Claude Code: The SDK session is still valid if the claude process is alive. Resume is attempted.
4. For orphaned processes: The daemon attempts to adopt them by checking PIDs from the persistence handle. If the PID is no longer valid, the session is marked stale.
5. Worktrees are preserved (they are regular directories and survive daemon crashes).

---

### E-5: Concurrent Permission Responses

**Scenario**: Two clients (dashboard and mobile) both tap "Allow" on the same permission request within milliseconds of each other.

**Expected behavior**: The `PermissionRouter` uses an atomic compare-and-swap on the permission status. The first response that transitions from `pending` to a decision wins. The second response receives an error:

```
Permission already resolved: allowed by dashboard-client-1
```

Both clients receive the `PermissionEvent` with the winning decision.

---

### E-6: Worktree Branch Name Collision

**Scenario**: Two agents are created for the same project, and both auto-generate the branch name `agent/abc123de` (collision on the first 8 chars of their session IDs).

**Expected behavior**: The `WorktreeManager` detects the collision when `git worktree add` fails (branch already exists). It appends a numeric suffix:
- First agent: `agent/abc123de`
- Second agent: `agent/abc123de-2`

The collision detection loop caps at 10 attempts before failing with `BRANCH_NAME_EXHAUSTED`.

---

### E-7: Agent Exceeds Max Output Tokens

**Scenario**: An agent produces output that exceeds the model's `maxOutputTokens` limit during a single turn.

**Expected behavior**: The provider SDK handles this internally by truncating the response. The daemon receives a `TurnCompletedEvent` with a `truncated: true` flag. The turn's `usage.outputTokens` reflects the actual tokens generated. The agent transitions to `idle` normally.

---

### E-8: Git Worktree Cleanup Fails

**Scenario**: The worktree directory has files locked by another process (antivirus, IDE, etc.) when the daemon attempts cleanup.

**Expected behavior**: `git worktree remove --force` is attempted. If it fails:
1. Log the error with the specific file that could not be removed.
2. Mark the worktree as "orphaned" in the daemon's internal state.
3. Do not block the agent session from being marked as `closed`.
4. The orphaned worktree is retried on next daemon startup.
5. The user can manually clean up with `git worktree prune`.

---

### E-9: Resume Session With Deleted Worktree

**Scenario**: User manually deletes the worktree directory while the daemon is stopped, then restarts the daemon which tries to resume the session.

**Expected behavior**: The persistence handle contains `worktreePath`. On resume:
1. Check if `worktreePath` exists -- it does not.
2. Attempt to re-create the worktree from the branch (which should still exist in the repo).
3. If the branch exists: re-create worktree and resume. Log a warning.
4. If the branch was also deleted: mark session as stale. The user must start a new session.

---

### E-10: MCP Client Sends Prompt to Running Agent

**Scenario**: A parent agent calls `send_prompt` on a child agent that is already in `running` state (processing a previous prompt).

**Expected behavior**: The MCP tool returns an error:

```json
{
  "error": {
    "code": -32600,
    "message": "Agent agent-1 is in 'running' state. Wait for it to reach 'idle' state before sending a new prompt. Use wait_for_agent to block until idle."
  }
}
```

The parent agent should call `wait_for_agent` first.

---

### E-11: Stream Consumer Disconnects Mid-Stream

**Scenario**: A mobile client is receiving streaming output via WebSocket. The phone loses network connectivity.

**Expected behavior**: The `StreamMultiplexer` detects the dead consumer when the WebSocket `send()` fails. The consumer's `AsyncGenerator` is closed. Other consumers continue receiving events unaffected. When the mobile client reconnects, it creates a new consumer and receives replay of recent events (up to `replayCount`).

---

### E-12: Model Switch on Provider That Requires Restart

**Scenario**: User calls `setModel("codex-mini")` on a Codex agent. Codex does not support mid-session model switching.

**Expected behavior**: The `setModel()` call internally:
1. Persists the current session state.
2. Closes the current Codex process.
3. Spawns a new Codex process with the new model.
4. The session ID is preserved.
5. A `StateChangeEvent` is emitted: `idle` -> `initializing` -> `idle`.
6. The user experiences a brief interruption but the session context is maintained.

---

## Technical Specifications

### Process Architecture

```
AgentContext Daemon (Node.js)
  │
  ├─ Main Process
  │   ├─ HTTP/WS Server
  │   ├─ MCP Server
  │   ├─ Agent Manager
  │   ├─ Permission Router
  │   ├─ Stream Multiplexer (per session)
  │   ├─ Resource Monitor
  │   └─ Persistence Manager
  │
  ├─ Child Process: Claude Code Agent #1
  │   └─ claude --session-id=xxx --model=claude-opus-4-6
  │
  ├─ Child Process: Claude Code Agent #2
  │   └─ claude --session-id=yyy --model=claude-sonnet-4-5
  │
  └─ Child Process: OpenCode Agent #1
      └─ opencode serve --port=XXXXX
```

### File Locations

| File | Path | Purpose |
|------|------|---------|
| Persistence handles | `~/.claude-context/sessions/{session-id}/handle.json` | Session resume data |
| Agent worktrees | `{project}/../.agent-worktrees/{branch-name}/` | Isolated working directories |
| Daemon config | `~/.claude-context/config.json` | Agent manager settings |
| Provider config | `~/.claude-context/providers/{provider-id}.json` | Per-provider settings |

### Configuration

```json
{
  "agentManager": {
    "maxConcurrentAgents": 5,
    "defaultProvider": "claude-code",
    "defaultModel": "claude-sonnet-4-5",
    "worktree": {
      "enabled": true,
      "baseDir": "../.agent-worktrees",
      "autoCommitOnClose": true,
      "autoCleanup": true,
      "preserveBranch": true
    },
    "permissions": {
      "alwaysAllow": ["Read", "Glob", "Grep", "WebSearch"],
      "alwaysDeny": [],
      "timeoutMs": 300000,
      "timeoutAction": "deny"
    },
    "resources": {
      "maxMemoryPerAgentMb": 2048,
      "minFreeMemoryMb": 500,
      "cpuBudgetPercent": 80
    },
    "persistence": {
      "enabled": true,
      "saveIntervalMs": 5000,
      "resumeOnStartup": true
    },
    "streaming": {
      "replayBufferSize": 100,
      "maxConsumerBufferSize": 1000,
      "backpressureStrategy": "drop_oldest"
    }
  }
}
```

### Port and Endpoint Layout

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/agents` | GET | List all agents |
| `/api/agents` | POST | Create a new agent |
| `/api/agents/:id` | GET | Get agent details |
| `/api/agents/:id` | DELETE | Destroy an agent |
| `/api/agents/:id/prompt` | POST | Send prompt to agent |
| `/api/agents/:id/interrupt` | POST | Interrupt running agent |
| `/api/agents/:id/model` | PUT | Change agent model |
| `/api/agents/:id/permissions` | GET | Get pending permissions |
| `/api/agents/:id/permissions/:pid` | POST | Respond to permission |
| `/ws/agents/:id/stream` | WS | Real-time event stream |
| `/mcp/agents` | POST | MCP JSON-RPC endpoint |

### Error Codes

| Code | Name | HTTP Status | Description |
|------|------|-------------|-------------|
| `PROVIDER_NOT_INSTALLED` | Provider binary missing | 400 | The requested provider is not installed |
| `PROVIDER_NOT_REGISTERED` | Unknown provider ID | 400 | No provider with this ID exists |
| `MAX_AGENTS_REACHED` | Concurrent limit hit | 429 | Cannot create another agent |
| `RESOURCE_EXHAUSTED` | System resource pressure | 503 | Not enough memory/CPU for new agent |
| `INVALID_STATE` | Wrong agent state | 409 | Operation not valid in current state |
| `AGENT_NOT_FOUND` | No such session ID | 404 | Agent with this ID does not exist |
| `PERMISSION_TIMEOUT` | Permission not answered | 408 | No client responded in time |
| `SPAWN_FAILED` | Agent process failed to start | 500 | Check provider logs |
| `WORKTREE_FAILED` | Git worktree creation failed | 500 | Check git status |
| `RESUME_FAILED` | Could not resume session | 500 | Session may be stale |
| `BRANCH_NAME_EXHAUSTED` | Too many branch collisions | 500 | Choose a custom branch name |

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | `ProviderRegistry` registers, retrieves, and lists providers correctly |
| T-2 | `ProviderRegistry` prevents duplicate registration |
| T-3 | State machine enforces valid transitions and rejects invalid ones |
| T-4 | State machine emits `StateChangeEvent` on every transition |
| T-5 | `closed` is a terminal state (no transitions allowed from it) |
| T-6 | Error recovery with exponential backoff retries correct number of times |
| T-7 | `PermissionRouter` queues requests and resolves on response |
| T-8 | `PermissionRouter` auto-denies after timeout |
| T-9 | `PermissionRouter` rejects second response to already-resolved permission |
| T-10 | `PermissionPolicy.alwaysAllow` bypasses the queue |
| T-11 | `StreamMultiplexer` fans out events to multiple consumers |
| T-12 | `StreamMultiplexer` replays recent events for late-joining consumers |
| T-13 | `StreamMultiplexer` applies backpressure (drops old events) for slow consumers |
| T-14 | Branch name generation sanitizes special characters |
| T-15 | Branch name collision appends numeric suffix |
| T-16 | `PersistenceHandle` serializes to and deserializes from JSON correctly |
| T-17 | `ModelSelector` lists models across all providers |
| T-18 | `ModelSelector.validate()` rejects invalid model IDs |
| T-19 | Graceful interrupt waits for current tool, forced does not |
| T-20 | Graceful interrupt escalates to forced after timeout |

### Integration Tests

| Test | Description |
|------|-------------|
| T-21 | Create a Claude Code agent, send a prompt, receive streaming events, verify turn completion |
| T-22 | Create two agents in parallel worktrees, both complete successfully, branches exist |
| T-23 | Create agent, close it, verify worktree is cleaned up and branch is preserved |
| T-24 | Create agent, trigger permission request, respond from test client, verify agent continues |
| T-25 | Create agent, interrupt while running, verify state transitions to idle |
| T-26 | Create agent, persist handle, simulate daemon restart, resume session |
| T-27 | MCP tool `create_agent` spawns agent, `wait_for_agent` blocks until idle |
| T-28 | MCP tool `send_prompt` on running agent returns error |
| T-29 | Resource monitor rejects agent creation when `maxConcurrentAgents` is reached |
| T-30 | Agent crash transitions state to error, daemon remains stable |
| T-31 | Permission timeout after 5 minutes auto-denies |
| T-32 | Stream consumer disconnect does not affect other consumers |
| T-33 | Multiple consumers receive identical event sequences |
| T-34 | Worktree creation on non-git directory runs agent directly |
| T-35 | Model switch on idle agent changes model for next turn |

### End-to-End Tests

| Test | Description |
|------|-------------|
| T-36 | Full workflow: create 3 agents, send prompts, wait for all, read outputs, destroy all |
| T-37 | Parent Claude Code agent uses MCP tools to orchestrate 2 child agents |
| T-38 | Agent requests permission, mobile client (simulated) approves, agent completes |
| T-39 | Daemon restart with 2 persisted sessions, both resume and return to idle |
| T-40 | Dashboard connects mid-session, receives replay of recent events via stream |

### Performance Tests

| Test | Description |
|------|-------------|
| T-41 | 5 concurrent agents do not cause daemon OOM or excessive CPU |
| T-42 | Stream multiplexer with 10 consumers delivers events within 50ms |
| T-43 | Permission routing round-trip < 100ms (daemon-side, excluding network) |
| T-44 | Agent creation (including worktree) completes within 5 seconds |
| T-45 | Persistence handle write does not block the agent event loop |

---

## Definition of Done

- [ ] `ProviderRegistry` with register/get/list is implemented and tested
- [ ] `AgentClient` interface implemented for Claude Code (fully functional) and OpenCode/Codex (stubs with correct capability flags)
- [ ] Agent state machine enforces valid transitions with event emissions on every change
- [ ] Error recovery with configurable exponential backoff is implemented
- [ ] `AgentManager` creates, lists, gets, and destroys agents
- [ ] Multiple agents run in parallel with isolated processes and worktrees
- [ ] `WorktreeManager` creates and cleans up git worktrees with `agent/{id}` branches
- [ ] `PermissionRouter` queues, routes, and resolves permissions with timeout support
- [ ] "Always allow" persistence is scoped per session
- [ ] `StreamMultiplexer` fans out events to multiple consumers with backpressure
- [ ] Graceful and forced interrupt work correctly with provider-specific mechanisms
- [ ] `PersistenceHandle` is saved on state changes and sessions resume on daemon restart
- [ ] MCP server exposes all 6 tools and is accessible at `/mcp/agents`
- [ ] A parent Claude Code agent can orchestrate child agents via MCP (end-to-end tested)
- [ ] `ModelSelector` lists models per provider with pricing and capability information
- [ ] `setModel()` changes model between turns without losing session state
- [ ] Resource monitor prevents over-provisioning (max agents, memory threshold)
- [ ] All 12 edge cases are handled as specified
- [ ] All 45 test cases from the testing plan pass
- [ ] REST API endpoints are implemented and documented
- [ ] Error codes are consistent and include actionable messages
- [ ] Configuration is loaded from `config.json` with sensible defaults
- [ ] No agent crash or stream error can bring down the daemon process
