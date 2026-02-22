# Implementation Plan: Story 05 -- Agent Process Orchestration

**Date**: 2026-02-22
**Story**: 11-agent-process-orchestration
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (96-128 hours)
**Prerequisites**: Daemon HTTP/WS server infrastructure (from Phase 1 integration). Node.js 18+. TypeScript project scaffolding. Claude Code SDK (`@anthropic-ai/claude-code`).
**References**: `docs/PRODUCT-SPEC.md` (F3.1-F3.10), `docs/PLATFORM-EVALUATION.md`, `stories/11-agent-process-orchestration.md`.

### Relationship to Other Stories

This is the **agent control plane** story. It transforms the daemon from a passive event recorder into an active agent orchestration platform. It depends on and coordinates with:

- **Stories 01-05** (Event Capture, Hooks, Storage, Projections, Recovery): The existing GlobalContext write/read side. Agent stream events are fed into the event store via the same capture pipeline.
- **Story 00** (Installation): The daemon binary and CLI (`agentctx`) must be installable. This story adds `agentctx agent start`, `agentctx agent list`, etc.
- **Story F4** (Local Dashboard): Dashboard consumes agent state change events and stream events via WebSocket. Task 10 in this plan exposes the REST/WS endpoints the dashboard needs.
- **Story F12** (Session Attach Mode): Session attach builds on the AgentSession and StreamMultiplexer from this story. Managed sessions (PTY proxy) are a layer above agent orchestration.
- **Story F5** (Encrypted Cloud Sync): Agent events can be synced via the same encryption pipeline as hook-captured events.

### Amendment Impacts on This Plan

- This story is pure TypeScript (Node.js daemon). No bash scripts are created.
- The `~/.claude-context/sessions/{session-id}/handle.json` persistence path aligns with the existing event store directory structure from Amendment 3 (project-id layer).
- Agent worktrees are placed outside the event store (`{project}/../.agent-worktrees/`), keeping the event store append-only per Amendment 4.

---

## Task Dependency Graph

```
Task 1: TypeScript Interfaces & Types
  |
  +---> Task 2: Agent State Machine
  |       |
  |       +---> Task 5: Agent Streaming & Multiplexer (needs 2)
  |       |       |
  |       |       +---> Task 10: REST/WS API Endpoints (needs 5, 7, 8)
  |       |
  |       +---> Task 7: Agent Interruption (needs 2, 5)
  |
  +---> Task 3: Provider Registry & Claude Code Provider
  |       |
  |       +---> Task 9: Model Selection (needs 3)
  |       |
  |       +---> Task 6: Agent Manager (needs 2, 3, 4, 5)
  |       |       |
  |       |       +---> Task 8: Session Persistence (needs 6)
  |       |       |       |
  |       |       |       +---> Task 11: MCP Server (needs 6, 7, 8, 10)
  |       |       |
  |       |       +---> Task 10: REST/WS API Endpoints (needs 5, 7, 8)
  |       |
  |       +---> Task 12: Integration Tests (needs all)
  |
  +---> Task 4: Worktree Manager (needs 1)
```

---

## Tasks

### Task 1: TypeScript Interfaces & Types

**Description**

Define all shared TypeScript interfaces, types, enums, and error classes used across the agent orchestration system. This is a pure types module with no runtime logic -- it establishes the contracts that all other tasks implement against.

**Prerequisites/Inputs**

- Node.js 18+ with TypeScript 5.x configured
- Story 05 spec interfaces (copied verbatim as the starting point, then refined)

**Implementation Details**

Create the following files under `src/daemon/agents/`:

| File | Contents |
|------|----------|
| `src/daemon/agents/types.ts` | All interfaces: `AgentState`, `AgentSession`, `AgentClient`, `ProviderRegistry`, `ProviderInfo`, `ProviderCapabilities`, `CreateSessionOptions`, `CreateAgentOptions`, `AgentFilter`, `AgentSummary`, `TokenUsage`, `ResourceLimits`, `SystemResourceUsage`, `AgentError`, `StateChangeEvent`, `RecoveryPolicy`, `HealthCheckResult`, `ModelInfo`, `ModelCapabilities`, `ModelPricing` |
| `src/daemon/agents/stream-types.ts` | All stream event types: `AgentStreamEvent` union type, `TimelineEvent`, `TextDeltaEvent`, `ThinkingEvent`, `ToolUseStartEvent`, `ToolUseCompleteEvent`, `TurnCompletedEvent`, `TurnFailedEvent`, `TurnCanceledEvent`, `PermissionRequestedEvent`, `UsageUpdateEvent` |
| `src/daemon/agents/permission-types.ts` | Permission interfaces: `PermissionRequest`, `PermissionStatus`, `PermissionRisk`, `PermissionDecision`, `PermissionRouter`, `PermissionEvent`, `PermissionPolicy` |
| `src/daemon/agents/errors.ts` | Error classes: `InvalidStateTransitionError`, `ProviderNotInstalledError`, `ProviderNotRegisteredError`, `MaxAgentsReachedError`, `ResourceExhaustedError`, `AgentNotFoundError`, `PermissionTimeoutError`, `SpawnFailedError`, `WorktreeFailedError`, `ResumeFailedError`, `BranchNameExhaustedError`, `InvalidStateError` |
| `src/daemon/agents/index.ts` | Re-exports all types for external consumers |

**Key Type Definitions**

```typescript
// errors.ts
export class AgentOrchestrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 500
  ) {
    super(message);
    this.name = 'AgentOrchestrationError';
  }
}

export class InvalidStateTransitionError extends AgentOrchestrationError {
  constructor(from: string, to: string, reason?: string) {
    super('INVALID_STATE', `Invalid transition from "${from}" to "${to}"${reason ? `: ${reason}` : ''}`, 409);
  }
}

// ... one class per error code from the spec
```

**Acceptance Criteria**

- [ ] All interfaces from the story spec are defined with JSDoc comments.
- [ ] All error classes extend a common `AgentOrchestrationError` base with `code` and `httpStatus`.
- [ ] Error codes match the spec table: `PROVIDER_NOT_INSTALLED`, `INVALID_STATE`, etc.
- [ ] All types are exported from `index.ts`.
- [ ] TypeScript strict mode compiles with zero errors.
- [ ] No runtime code -- pure type definitions and error class constructors.

**Edge Cases**

- Ensure `AgentState` is a string literal union, not an enum, for JSON serialization compatibility.
- `TokenUsage` fields default to 0 (enforced by factory functions in Task 6, not here).

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 2: Agent State Machine

**Description**

Implement the agent lifecycle state machine as a standalone class. The state machine enforces valid transitions, emits `StateChangeEvent` on every transition, and is the single source of truth for an agent's current state. It also implements error recovery with exponential backoff.

**Prerequisites/Inputs**

- Task 1 (types: `AgentState`, `StateChangeEvent`, `AgentError`, `RecoveryPolicy`, `InvalidStateTransitionError`)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/state-machine.ts` | `AgentStateMachine` class |
| `src/daemon/agents/__tests__/state-machine.test.ts` | Unit tests (T-3 through T-6 from spec) |

```typescript
// state-machine.ts

import { EventEmitter } from 'node:events';

type StateChangeCallback = (event: StateChangeEvent) => void;

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  initializing: ['idle', 'error', 'closed'],
  idle:         ['running', 'closed'],
  running:      ['idle', 'error'],
  error:        ['idle', 'closed'],
  closed:       [],  // terminal state
};

export class AgentStateMachine {
  private _state: AgentState = 'initializing';
  private _listeners: Set<StateChangeCallback> = new Set();
  private _retryCount: number = 0;
  private _retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly recoveryPolicy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY
  ) {}

  get state(): AgentState { return this._state; }

  transition(to: AgentState, reason?: string, error?: AgentError): void {
    const from = this._state;
    if (from === 'closed') {
      throw new InvalidStateTransitionError(from, to, 'closed is a terminal state');
    }
    // Special case: close() can be called from any state
    if (to === 'closed') {
      this._applyTransition(from, to, reason, error);
      return;
    }
    if (!VALID_TRANSITIONS[from].includes(to)) {
      throw new InvalidStateTransitionError(from, to);
    }
    this._applyTransition(from, to, reason, error);
  }

  onStateChange(callback: StateChangeCallback): () => void {
    this._listeners.add(callback);
    return () => { this._listeners.delete(callback); };
  }

  async attemptRecovery(error: AgentError, retryFn: () => Promise<void>): Promise<boolean> {
    // Returns true if recovery succeeded, false if exhausted
    // Implements exponential backoff per RecoveryPolicy
  }

  destroy(): void {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._listeners.clear();
  }

  private _applyTransition(from: AgentState, to: AgentState, reason?: string, error?: AgentError): void {
    this._state = to;
    const event: StateChangeEvent = {
      sessionId: this.sessionId,
      previousState: from,
      currentState: to,
      timestamp: new Date(),
      reason,
      error,
    };
    for (const listener of this._listeners) {
      try { listener(event); } catch (_) { /* swallow listener errors */ }
    }
  }
}
```

**Recovery Logic**

```typescript
async attemptRecovery(error: AgentError, retryFn: () => Promise<void>): Promise<boolean> {
  if (!error.recoverable) return false;
  if (!this.recoveryPolicy.recoverableErrors.includes(error.code)) return false;
  if (this._retryCount >= this.recoveryPolicy.maxRetries) return false;

  this._retryCount++;
  const delay = Math.min(
    this.recoveryPolicy.backoffMs * Math.pow(2, this._retryCount - 1),
    this.recoveryPolicy.maxBackoffMs
  );

  await new Promise(resolve => {
    this._retryTimer = setTimeout(resolve, delay);
  });

  try {
    await retryFn();
    this.transition('idle', `Recovery succeeded after ${this._retryCount} retries`);
    this._retryCount = 0;
    return true;
  } catch {
    if (this._retryCount >= this.recoveryPolicy.maxRetries) {
      return false;
    }
    return this.attemptRecovery(error, retryFn);
  }
}
```

**Acceptance Criteria**

- [ ] State machine enforces valid transitions only; invalid transitions throw `InvalidStateTransitionError`.
- [ ] Every state transition emits a `StateChangeEvent` to all registered listeners.
- [ ] `StateChangeEvent` includes `previousState`, `currentState`, `timestamp`, and optional `reason`.
- [ ] Error state distinguishes between recoverable and fatal errors.
- [ ] Auto-retry with exponential backoff is implemented for recoverable errors.
- [ ] `close()` equivalent (`transition('closed')`) can be called from any state.
- [ ] No state transitions occur after reaching `closed` (terminal state).
- [ ] State is queryable at any time via `.state`.
- [ ] Listener errors do not propagate to the state machine.
- [ ] `destroy()` clears all timers and listeners.

**Edge Cases**

- Calling `transition('closed')` while a recovery retry timer is pending must cancel the timer.
- Multiple rapid transitions (e.g., `idle -> running -> idle`) must emit events in order.
- Adding a listener during a transition callback must not receive the current event.

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 3: Provider Registry & Claude Code Provider

**Description**

Implement the `ProviderRegistry` and the first concrete provider: `ClaudeCodeProvider` (implementing `AgentClient`). The Claude Code provider uses the `@anthropic-ai/claude-code` SDK to create sessions, send prompts, and receive streaming responses. OpenCode and Codex providers are implemented as stubs with correct capability flags.

**Prerequisites/Inputs**

- Task 1 (types)
- `@anthropic-ai/claude-code` npm package installed
- Claude Code binary on PATH (for `healthCheck()`)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/provider-registry.ts` | `DefaultProviderRegistry` class |
| `src/daemon/agents/providers/claude-code.ts` | `ClaudeCodeProvider` implements `AgentClient` |
| `src/daemon/agents/providers/opencode-stub.ts` | `OpenCodeProvider` stub |
| `src/daemon/agents/providers/codex-stub.ts` | `CodexProvider` stub |
| `src/daemon/agents/__tests__/provider-registry.test.ts` | Unit tests (T-1, T-2) |
| `src/daemon/agents/__tests__/claude-code-provider.test.ts` | Provider tests |

**Provider Registry**

```typescript
// provider-registry.ts
export class DefaultProviderRegistry implements ProviderRegistry {
  private providers = new Map<string, AgentClient>();

  register(provider: AgentClient): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`Provider "${provider.providerId}" is already registered`);
    }
    this.providers.set(provider.providerId, provider);
  }

  get(providerId: string): AgentClient | undefined {
    return this.providers.get(providerId);
  }

  list(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.providerId,
      name: PROVIDER_DISPLAY_NAMES[p.providerId] ?? p.providerId,
      version: '1.0.0',
      installed: true,
      capabilities: p.capabilities,
    }));
  }
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'opencode': 'OpenCode',
  'codex': 'Codex',
};
```

**Claude Code Provider**

```typescript
// providers/claude-code.ts
import { query, type Message } from '@anthropic-ai/claude-code';

export class ClaudeCodeProvider implements AgentClient {
  readonly providerId = 'claude-code';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    resume: true,
    interruption: true,
    permissions: true,
    modelSelection: true,
    worktree: true,
  };

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    return new ClaudeCodeSession(options, this.providerId);
  }

  async resumeSession(handle: PersistenceHandle): Promise<AgentSession> {
    const options: CreateSessionOptions = {
      workingDirectory: handle.worktreePath ?? handle.workingDirectory,
      model: handle.model,
      sessionId: handle.sessionId,
      permissions: { alwaysAllow: handle.permissionAllowList, alwaysDeny: [], timeoutMs: 300000, timeoutAction: 'deny' },
    };
    const session = new ClaudeCodeSession(options, this.providerId);
    // Store resume data for the next sendPrompt call
    session._resumeSessionId = handle.providerState?.claudeSessionId as string;
    return session;
  }

  async listModels(): Promise<ModelInfo[]> {
    // Return known Claude models with pricing info
    return CLAUDE_MODELS;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('claude', ['--version']);
      return { installed: true, version: 'detected' };
    } catch {
      return {
        installed: false,
        error: 'Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code',
      };
    }
  }
}
```

**ClaudeCodeSession (inner class)**

```typescript
class ClaudeCodeSession implements AgentSession {
  readonly sessionId: string;
  readonly providerId: string;
  readonly createdAt: Date;
  readonly workingDirectory: string;
  model: string;
  _resumeSessionId?: string;

  private stateMachine: AgentStateMachine;
  private abortController: AbortController | null = null;
  private turnCount: number = 0;
  private _tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 };
  private permissionAllowList: Set<string> = new Set();

  get state(): AgentState { return this.stateMachine.state; }

  async *sendPrompt(prompt: string): AsyncGenerator<AgentStreamEvent> {
    if (this.state !== 'idle') {
      throw new InvalidStateError(`Cannot send prompt: agent is in "${this.state}" state`);
    }
    this.stateMachine.transition('running', 'Prompt received');
    this.abortController = new AbortController();

    try {
      const sdkOptions: any = {
        prompt,
        model: this.model,
        cwd: this.workingDirectory,
        abortController: this.abortController,
        // Permission callback bridges to the PermissionRouter
        permissionCallback: this._handlePermission.bind(this),
      };

      if (this._resumeSessionId) {
        sdkOptions.resume = this._resumeSessionId;
        this._resumeSessionId = undefined;
      }

      const stream = query(sdkOptions);
      for await (const message of stream) {
        yield* this._mapSdkMessage(message);
      }

      this.turnCount++;
      this.stateMachine.transition('idle', 'Turn completed');
      yield { type: 'turn_completed', timestamp: new Date(), usage: this._tokenUsage, turnIndex: this.turnCount };
    } catch (err: any) {
      if (this.abortController?.signal.aborted) {
        this.stateMachine.transition('idle', 'Interrupted');
        yield { type: 'turn_canceled', timestamp: new Date(), reason: 'user_interrupt', turnIndex: this.turnCount };
      } else {
        const agentError: AgentError = {
          code: 'EXECUTION_ERROR',
          message: err.message ?? String(err),
          recoverable: false,
        };
        this.stateMachine.transition('error', 'Execution failed', agentError);
        yield { type: 'turn_failed', timestamp: new Date(), error: agentError, turnIndex: this.turnCount };
      }
    } finally {
      this.abortController = null;
    }
  }

  async interrupt(options?: { graceful?: boolean }): Promise<void> {
    if (this.state !== 'running') {
      throw new InvalidStateError('Cannot interrupt: agent is not running');
    }
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async close(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.stateMachine.transition('closed', 'Session closed');
    this.stateMachine.destroy();
  }

  // Maps SDK messages to our AgentStreamEvent types
  private *_mapSdkMessage(message: any): Generator<AgentStreamEvent> {
    // Map assistant text -> TextDeltaEvent
    // Map tool_use -> ToolUseStartEvent
    // Map tool_result -> ToolUseCompleteEvent
    // Map usage -> UsageUpdateEvent
    // etc.
  }
}
```

**Stub Providers (OpenCode, Codex)**

```typescript
// providers/opencode-stub.ts
export class OpenCodeProvider implements AgentClient {
  readonly providerId = 'opencode';
  readonly capabilities: ProviderCapabilities = {
    streaming: true, resume: true, interruption: true,
    permissions: true, modelSelection: true, worktree: true,
  };

  async createSession(): Promise<AgentSession> {
    throw new ProviderNotInstalledError('opencode', 'go install github.com/opencode-ai/opencode@latest');
  }
  async resumeSession(): Promise<AgentSession> {
    throw new ProviderNotInstalledError('opencode', 'go install github.com/opencode-ai/opencode@latest');
  }
  async listModels(): Promise<ModelInfo[]> { return []; }
  async healthCheck(): Promise<HealthCheckResult> { return { installed: false, error: 'Stub provider' }; }
}
```

**Acceptance Criteria**

- [ ] `ProviderRegistry` supports register, get, and list operations.
- [ ] `AgentClient` interface is implemented for Claude Code provider (fully functional with SDK).
- [ ] `AgentClient` interface is implemented for OpenCode provider (stub).
- [ ] `AgentClient` interface is implemented for Codex provider (stub).
- [ ] `ProviderCapabilities` accurately reflects each provider's actual capabilities.
- [ ] `healthCheck()` detects whether the Claude Code binary is installed.
- [ ] Registry prevents duplicate provider registration.
- [ ] All interfaces are exported as TypeScript types.
- [ ] SDK message types are mapped to `AgentStreamEvent` types correctly.

**Edge Cases**

- E-1: `healthCheck()` must not throw; returns `{ installed: false }` with install instructions.
- Claude Code SDK may change its message format across versions -- the mapper should log unknown message types rather than crashing.
- `AbortController.abort()` must be called before `close()` transitions to `closed` to avoid orphaned SDK processes.

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 4: Worktree Manager

**Description**

Implement the `WorktreeManager` that creates, lists, and removes git worktrees for agent sessions. Each agent gets its own isolated worktree with a dedicated branch, enabling parallel work on the same repository without conflicts.

**Prerequisites/Inputs**

- Task 1 (types: `WorktreeManager`, `WorktreeOptions`, `WorktreeInfo`, `RemoveOptions`)
- `git` binary on PATH

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/worktree-manager.ts` | `DefaultWorktreeManager` class |
| `src/daemon/agents/__tests__/worktree-manager.test.ts` | Unit tests (T-14, T-15) |

```typescript
// worktree-manager.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

export class DefaultWorktreeManager implements WorktreeManager {

  async isGitRepo(dirPath: string): Promise<boolean> {
    try {
      await exec('git', ['rev-parse', '--git-dir'], { cwd: dirPath });
      return true;
    } catch {
      return false;
    }
  }

  async create(options: WorktreeOptions): Promise<WorktreeInfo> {
    const { projectPath, branchName, baseBranch } = options;

    // 1. Verify projectPath is a git repo
    if (!(await this.isGitRepo(projectPath))) {
      throw new WorktreeFailedError(`${projectPath} is not a git repository`);
    }

    // 2. Determine worktree location
    const worktreeBase = path.resolve(projectPath, '..', '.agent-worktrees');
    await mkdir(worktreeBase, { recursive: true });
    const worktreePath = path.join(worktreeBase, branchName.replace(/\//g, '-'));

    // 3. Handle branch name collisions
    const finalBranch = await this._resolveBranchName(projectPath, branchName);

    // 4. Create worktree
    const base = baseBranch ?? 'HEAD';
    try {
      await exec('git', ['worktree', 'add', '-b', finalBranch, worktreePath, base], { cwd: projectPath });
    } catch (err: any) {
      // Branch may already exist (from a previous session)
      if (err.stderr?.includes('already exists')) {
        await exec('git', ['worktree', 'add', worktreePath, finalBranch], { cwd: projectPath });
      } else {
        throw new WorktreeFailedError(`git worktree add failed: ${err.stderr ?? err.message}`);
      }
    }

    // 5. Copy environment files (.env, .claude/settings.json)
    await this._copyEnvFiles(projectPath, worktreePath);

    // 6. Get HEAD commit
    const { stdout: commitHash } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });

    return {
      path: worktreePath,
      branchName: finalBranch,
      projectPath,
      createdAt: new Date(),
      commitHash: commitHash.trim(),
    };
  }

  async remove(worktreePath: string, options?: RemoveOptions): Promise<void> {
    const { deleteBranch = false, force = true, commitChanges = true } = options ?? {};

    // 1. Commit uncommitted changes if requested
    if (commitChanges) {
      await this._commitUncommittedChanges(worktreePath);
    }

    // 2. Determine the branch name before removal
    let branchName: string | null = null;
    if (deleteBranch) {
      try {
        const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
        branchName = stdout.trim();
      } catch { /* ignore -- worktree may already be gone */ }
    }

    // 3. Remove worktree
    const args = ['worktree', 'remove', worktreePath];
    if (force) args.push('--force');
    try {
      // Find the main repo from the worktree
      const { stdout: gitDir } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
      const mainRepo = path.resolve(worktreePath, gitDir.trim(), '..');
      await exec('git', args, { cwd: mainRepo });
    } catch (err: any) {
      // Log but don't throw -- mark as orphaned
      console.warn(`[worktree-manager] Failed to remove worktree: ${err.message}. Marked as orphaned.`);
    }

    // 4. Optionally delete the branch
    if (deleteBranch && branchName) {
      try {
        const { stdout: gitDir } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
        const mainRepo = path.resolve(worktreePath, gitDir.trim(), '..');
        await exec('git', ['branch', '-d', branchName], { cwd: mainRepo });
      } catch { /* branch deletion is best-effort */ }
    }
  }

  async list(projectPath: string): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: projectPath });
      return this._parseWorktreeList(stdout, projectPath);
    } catch {
      return [];
    }
  }

  private async _resolveBranchName(projectPath: string, requested: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = attempt === 0 ? requested : `${requested}-${attempt + 1}`;
      try {
        await exec('git', ['rev-parse', '--verify', candidate], { cwd: projectPath });
        // Branch exists, try next
        continue;
      } catch {
        // Branch does not exist, safe to use
        return candidate;
      }
    }
    throw new BranchNameExhaustedError(requested);
  }

  private async _commitUncommittedChanges(worktreePath: string): Promise<void> {
    try {
      const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath });
      if (stdout.trim().length === 0) return; // Nothing to commit

      await exec('git', ['add', '-A'], { cwd: worktreePath });
      await exec('git', ['commit', '-m', 'agent: auto-commit on session close', '--no-verify'], {
        cwd: worktreePath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'AgentContext Bot',
          GIT_AUTHOR_EMAIL: 'agent@agentctx.local',
          GIT_COMMITTER_NAME: 'AgentContext Bot',
          GIT_COMMITTER_EMAIL: 'agent@agentctx.local',
        },
      });
    } catch { /* best-effort commit */ }
  }

  private async _copyEnvFiles(from: string, to: string): Promise<void> {
    const filesToCopy = ['.env', '.claude/settings.json'];
    for (const file of filesToCopy) {
      const src = path.join(from, file);
      const dst = path.join(to, file);
      try {
        await mkdir(path.dirname(dst), { recursive: true });
        const { copyFile } = await import('node:fs/promises');
        await copyFile(src, dst);
      } catch { /* file may not exist -- that is fine */ }
    }
  }

  private _parseWorktreeList(output: string, projectPath: string): WorktreeInfo[] {
    // Parse `git worktree list --porcelain` output into WorktreeInfo[]
    // Filter to only agent/* branches
    const entries: WorktreeInfo[] = [];
    // ... parsing logic ...
    return entries;
  }
}

export function generateBranchName(sessionId: string, custom?: string): string {
  if (custom) {
    return `agent/${custom.replace(/[^a-zA-Z0-9_\-\/]/g, '-')}`;
  }
  const shortId = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `agent/${shortId}`;
}
```

**Acceptance Criteria**

- [ ] Worktree is automatically created when given a git repo path.
- [ ] Worktree is placed at `{projectPath}/../.agent-worktrees/{branch-name}`.
- [ ] Branch naming follows `agent/{id}` convention.
- [ ] If the project is not a git repo, `isGitRepo()` returns false (caller skips worktree).
- [ ] Worktree is cleaned up via `remove()`.
- [ ] Uncommitted changes are auto-committed before worktree removal.
- [ ] The branch is preserved after worktree removal (default `deleteBranch: false`).
- [ ] Multiple worktrees can coexist for the same project.
- [ ] `list()` returns all active agent worktrees for a project.
- [ ] Branch name collisions are handled (append numeric suffix up to 10 attempts).

**Edge Cases**

- E-2: Non-git directory returns `false` from `isGitRepo()`.
- E-6: Branch name collision appends `-2`, `-3`, etc.
- E-8: `remove()` with locked files logs warning but does not throw.
- E-9: Re-creating a worktree from an existing branch (branch exists but worktree was deleted).
- Slashes in branch names are converted to dashes in the filesystem path.

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 5: Agent Streaming & Multiplexer

**Description**

Implement the `StreamMultiplexer` that fans out `AgentStreamEvent`s from a single source (the agent's output generator) to multiple consumers (WebSocket clients, SSE clients, MCP clients, event store). Supports late-join replay and backpressure via bounded buffers.

**Prerequisites/Inputs**

- Task 1 (stream event types)
- Task 2 (state machine -- multiplexer closes on session close)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/stream-multiplexer.ts` | `StreamMultiplexer<T>` generic class |
| `src/daemon/agents/__tests__/stream-multiplexer.test.ts` | Unit tests (T-11, T-12, T-13) |

```typescript
// stream-multiplexer.ts

interface ConsumerState<T> {
  buffer: T[];
  maxBufferSize: number;
  resolve: ((value: IteratorResult<T>) => void) | null;
  closed: boolean;
}

export class StreamMultiplexer<T> {
  private consumers = new Map<string, ConsumerState<T>>();
  private replayBuffer: T[] = [];
  private replayBufferSize: number;
  private sourceExhausted = false;
  private _closed = false;

  constructor(options?: { replayBufferSize?: number }) {
    this.replayBufferSize = options?.replayBufferSize ?? 100;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  /**
   * Feed events from the source. Called internally by the session
   * when sendPrompt() yields events.
   */
  push(event: T): void {
    if (this._closed) return;

    // Add to replay buffer (ring buffer)
    this.replayBuffer.push(event);
    if (this.replayBuffer.length > this.replayBufferSize) {
      this.replayBuffer.shift();
    }

    // Fan out to all consumers
    for (const [id, consumer] of this.consumers) {
      if (consumer.closed) continue;

      if (consumer.resolve) {
        // Consumer is waiting -- deliver immediately
        const resolve = consumer.resolve;
        consumer.resolve = null;
        resolve({ value: event, done: false });
      } else {
        // Consumer is not waiting -- buffer
        consumer.buffer.push(event);
        if (consumer.buffer.length > consumer.maxBufferSize) {
          // Backpressure: drop oldest
          consumer.buffer.shift();
        }
      }
    }
  }

  /**
   * Create a new consumer that receives all future events
   * plus a replay of recent events.
   */
  subscribe(options?: { replayCount?: number; maxBufferSize?: number }): AsyncGenerator<T> {
    const consumerId = crypto.randomUUID();
    const replayCount = options?.replayCount ?? this.replayBufferSize;
    const maxBufferSize = options?.maxBufferSize ?? 1000;

    const state: ConsumerState<T> = {
      buffer: [],
      maxBufferSize,
      resolve: null,
      closed: false,
    };

    // Pre-fill buffer with replay events
    const replayStart = Math.max(0, this.replayBuffer.length - replayCount);
    state.buffer.push(...this.replayBuffer.slice(replayStart));

    this.consumers.set(consumerId, state);

    const self = this;
    const generator: AsyncGenerator<T> = {
      [Symbol.asyncIterator]() { return this; },

      next(): Promise<IteratorResult<T>> {
        if (state.closed) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        if (state.buffer.length > 0) {
          return Promise.resolve({ value: state.buffer.shift()!, done: false });
        }
        if (self.sourceExhausted || self._closed) {
          state.closed = true;
          return Promise.resolve({ value: undefined as any, done: true });
        }
        // Wait for next event
        return new Promise(resolve => {
          state.resolve = resolve;
        });
      },

      return(): Promise<IteratorResult<T>> {
        state.closed = true;
        self.consumers.delete(consumerId);
        if (state.resolve) {
          state.resolve({ value: undefined as any, done: true });
          state.resolve = null;
        }
        return Promise.resolve({ value: undefined as any, done: true });
      },

      throw(err: any): Promise<IteratorResult<T>> {
        return this.return!();
      },
    };

    return generator;
  }

  /**
   * Signal that the source has finished producing events.
   */
  complete(): void {
    this.sourceExhausted = true;
    for (const [, consumer] of this.consumers) {
      if (consumer.resolve) {
        consumer.resolve({ value: undefined as any, done: true });
        consumer.resolve = null;
      }
      consumer.closed = true;
    }
  }

  /**
   * Close the multiplexer and all consumers.
   */
  close(): void {
    this._closed = true;
    this.complete();
    this.consumers.clear();
    this.replayBuffer = [];
  }
}
```

**Acceptance Criteria**

- [ ] `sendPrompt()` events are fanned out to all consumers in real time.
- [ ] All defined event types are pushed through the multiplexer.
- [ ] `TextDeltaEvent` enables word-by-word streaming of agent responses.
- [ ] `StreamMultiplexer` supports multiple simultaneous consumers per session.
- [ ] Late-joining consumers receive recent event replay (configurable count).
- [ ] Backpressure drops old events for slow consumers without blocking the source.
- [ ] Consumer count is queryable via `.consumerCount`.
- [ ] All consumers are cleaned up when the session ends (`.close()`).
- [ ] Events include timestamps for ordering and latency measurement.
- [ ] `ToolUseStartEvent` and `ToolUseCompleteEvent` can be correlated by `toolUseId`.

**Edge Cases**

- E-11: Consumer disconnects mid-stream -- `return()` is called, consumer is removed, other consumers unaffected.
- Consumer that never reads: buffer grows to `maxBufferSize` then drops oldest events.
- Subscribing after `complete()` returns an immediately-done generator with replay.

**Estimated Effort**: M (Medium) -- 5-7 hours

---

### Task 6: Agent Manager

**Description**

Implement the central `AgentManager` class that coordinates provider registry, worktree manager, state machines, stream multiplexers, and resource monitoring to create, track, and destroy agent sessions. This is the primary orchestration component.

**Prerequisites/Inputs**

- Task 2 (state machine)
- Task 3 (provider registry, Claude Code provider)
- Task 4 (worktree manager)
- Task 5 (stream multiplexer)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/agent-manager.ts` | `DefaultAgentManager` class |
| `src/daemon/agents/resource-monitor.ts` | `ResourceMonitor` class |
| `src/daemon/agents/permission-router.ts` | `DefaultPermissionRouter` class |
| `src/daemon/agents/__tests__/agent-manager.test.ts` | Unit tests |
| `src/daemon/agents/__tests__/permission-router.test.ts` | Unit tests (T-7 through T-10) |

**Agent Manager**

```typescript
// agent-manager.ts
import { readFile } from 'node:fs/promises';
import os from 'node:os';

interface ManagedAgent {
  session: AgentSession;
  multiplexer: StreamMultiplexer<AgentStreamEvent>;
  worktreeInfo?: WorktreeInfo;
  summary: AgentSummary;
  stateUnsubscribe: () => void;
}

export class DefaultAgentManager implements AgentManager {
  private agents = new Map<string, ManagedAgent>();
  private eventListeners = new Set<(event: AgentManagerEvent) => void>();

  constructor(
    private registry: ProviderRegistry,
    private worktreeManager: WorktreeManager,
    private permissionRouter: PermissionRouter,
    private resourceMonitor: ResourceMonitor,
    private config: AgentManagerConfig,
  ) {}

  async createAgent(options: CreateAgentOptions): Promise<AgentSession> {
    // 1. Check resource limits
    if (!this.resourceMonitor.canSpawn()) {
      throw new ResourceExhaustedError();
    }
    if (this.agents.size >= this.config.maxConcurrentAgents) {
      throw new MaxAgentsReachedError(this.config.maxConcurrentAgents);
    }

    // 2. Get provider
    const provider = this.registry.get(options.providerId);
    if (!provider) {
      throw new ProviderNotRegisteredError(options.providerId);
    }

    // 3. Health check
    const health = await provider.healthCheck();
    if (!health.installed) {
      throw new ProviderNotInstalledError(options.providerId, health.error ?? '');
    }

    // 4. Create worktree if applicable
    let worktreeInfo: WorktreeInfo | undefined;
    let workingDirectory = options.projectPath;

    if (options.useWorktree !== false && await this.worktreeManager.isGitRepo(options.projectPath)) {
      const sessionId = crypto.randomUUID();
      const branchName = generateBranchName(sessionId, options.branchName);
      worktreeInfo = await this.worktreeManager.create({
        projectPath: options.projectPath,
        branchName,
        baseBranch: undefined,
      });
      workingDirectory = worktreeInfo.path;
    } else if (options.useWorktree !== false) {
      console.warn(`[agent-manager] WARN: ${options.projectPath} is not a git repo. Agent will run without a worktree (no branch isolation).`);
    }

    // 5. Create session via provider
    const session = await provider.createSession({
      workingDirectory,
      model: options.model ?? this.config.defaultModel,
      environment: options.environment,
      sessionId: undefined, // let provider assign
    });

    // 6. Create multiplexer
    const multiplexer = new StreamMultiplexer<AgentStreamEvent>({
      replayBufferSize: this.config.streaming.replayBufferSize,
    });

    // 7. Subscribe to state changes
    const stateUnsubscribe = session.onStateChange((event) => {
      this._emitEvent({ type: 'state_change', sessionId: session.sessionId, event });
    });

    // 8. Store managed agent
    const summary: AgentSummary = {
      sessionId: session.sessionId,
      providerId: options.providerId,
      state: session.state,
      model: session.model,
      projectPath: options.projectPath,
      worktreePath: worktreeInfo?.path,
      branchName: worktreeInfo?.branchName,
      createdAt: session.createdAt,
      lastActivityAt: new Date(),
      turnCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 },
    };

    this.agents.set(session.sessionId, {
      session,
      multiplexer,
      worktreeInfo,
      summary,
      stateUnsubscribe,
    });

    this._emitEvent({ type: 'agent_created', sessionId: session.sessionId, summary });

    // 9. Send initial prompt if provided
    if (options.prompt) {
      // Fire-and-forget -- the caller can subscribe to the multiplexer
      this._runPrompt(session.sessionId, options.prompt);
    }

    return session;
  }

  getAgent(sessionId: string): AgentSession | undefined {
    return this.agents.get(sessionId)?.session;
  }

  getMultiplexer(sessionId: string): StreamMultiplexer<AgentStreamEvent> | undefined {
    return this.agents.get(sessionId)?.multiplexer;
  }

  listAgents(filter?: AgentFilter): AgentSummary[] {
    let results = Array.from(this.agents.values()).map(a => ({
      ...a.summary,
      state: a.session.state, // Always fresh
    }));

    if (filter?.state) results = results.filter(a => filter.state!.includes(a.state));
    if (filter?.providerId) results = results.filter(a => a.providerId === filter.providerId);
    if (filter?.projectPath) results = results.filter(a => a.projectPath === filter.projectPath);

    return results;
  }

  async destroyAgent(sessionId: string): Promise<void> {
    const managed = this.agents.get(sessionId);
    if (!managed) throw new AgentNotFoundError(sessionId);

    // 1. Close the session
    await managed.session.close();

    // 2. Close the multiplexer
    managed.multiplexer.close();

    // 3. Unsubscribe from state changes
    managed.stateUnsubscribe();

    // 4. Clean up worktree
    if (managed.worktreeInfo) {
      await this.worktreeManager.remove(managed.worktreeInfo.path, {
        commitChanges: true,
        deleteBranch: false,
        force: true,
      });
    }

    // 5. Remove from map
    this.agents.delete(sessionId);
    this._emitEvent({ type: 'agent_destroyed', sessionId });
  }

  async destroyAll(): Promise<void> {
    const sessionIds = Array.from(this.agents.keys());
    await Promise.allSettled(sessionIds.map(id => this.destroyAgent(id)));
  }

  onAgentEvent(callback: (event: AgentManagerEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => { this.eventListeners.delete(callback); };
  }

  private async _runPrompt(sessionId: string, prompt: string): Promise<void> {
    const managed = this.agents.get(sessionId);
    if (!managed) return;

    try {
      const stream = managed.session.sendPrompt(prompt);
      for await (const event of stream) {
        managed.multiplexer.push(event);
        // Update summary on usage events
        if (event.type === 'turn_completed') {
          managed.summary.turnCount++;
          managed.summary.tokenUsage = event.usage;
          managed.summary.lastActivityAt = new Date();
        }
      }
    } catch (err) {
      console.error(`[agent-manager] Prompt failed for ${sessionId}:`, err);
    }
  }

  private _emitEvent(event: AgentManagerEvent): void {
    for (const listener of this.eventListeners) {
      try { listener(event); } catch { /* swallow */ }
    }
  }
}
```

**Resource Monitor**

```typescript
// resource-monitor.ts
export class ResourceMonitor {
  constructor(private config: ResourceConfig) {}

  canSpawn(): boolean {
    const usage = this.getUsage();
    return usage.systemMemoryAvailableMb > this.config.minFreeMemoryMb;
  }

  getUsage(): SystemResourceUsage {
    const totalMem = os.totalmem() / (1024 * 1024);
    const freeMem = os.freemem() / (1024 * 1024);
    const cpuLoad = os.loadavg()[0] / os.cpus().length * 100;

    return {
      activeAgents: 0, // Set by caller
      maxAgents: this.config.maxConcurrentAgents,
      totalMemoryUsedMb: totalMem - freeMem,
      systemMemoryTotalMb: totalMem,
      systemMemoryAvailableMb: freeMem,
      cpuLoadPercent: cpuLoad,
    };
  }
}
```

**Permission Router**

```typescript
// permission-router.ts
export class DefaultPermissionRouter implements PermissionRouter {
  private pending = new Map<string, {
    request: PermissionRequest;
    resolve: (decision: PermissionDecision) => void;
    timer: NodeJS.Timeout;
  }>();
  private listeners = new Set<(event: PermissionEvent) => void>();
  private sessionAllowLists = new Map<string, Set<string>>();

  async requestPermission(
    partial: Omit<PermissionRequest, 'permissionId' | 'status'>
  ): Promise<PermissionDecision> {
    // Check always-allow list for this session
    const allowList = this.sessionAllowLists.get(partial.sessionId);
    if (allowList?.has(partial.toolName)) {
      return 'allow';
    }

    const request: PermissionRequest = {
      ...partial,
      permissionId: crypto.randomUUID(),
      status: 'pending',
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.permissionId);
        request.status = 'timed_out';
        this._emit({ type: 'timed_out', request });
        resolve('deny');
      }, partial.timeoutAt.getTime() - Date.now());

      this.pending.set(request.permissionId, { request, resolve, timer });
      this._emit({ type: 'requested', request });
    });
  }

  async respond(permissionId: string, decision: PermissionDecision, respondedBy: string): Promise<void> {
    const entry = this.pending.get(permissionId);
    if (!entry) {
      throw new Error(`Permission already resolved or not found: ${permissionId}`);
    }

    clearTimeout(entry.timer);
    this.pending.delete(permissionId);

    entry.request.status = decision === 'allow' ? 'allowed'
      : decision === 'always_allow' ? 'always_allowed'
      : 'denied';

    if (decision === 'always_allow') {
      let allowList = this.sessionAllowLists.get(entry.request.sessionId);
      if (!allowList) {
        allowList = new Set();
        this.sessionAllowLists.set(entry.request.sessionId, allowList);
      }
      allowList.add(entry.request.toolName);
    }

    this._emit({ type: 'responded', request: entry.request, decision, respondedBy });
    entry.resolve(decision === 'always_allow' ? 'allow' : decision);
  }

  getPending(): PermissionRequest[] {
    return Array.from(this.pending.values()).map(e => e.request);
  }

  getForSession(sessionId: string): PermissionRequest[] {
    return this.getPending().filter(r => r.sessionId === sessionId);
  }

  onPermissionEvent(callback: (event: PermissionEvent) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  clearSession(sessionId: string): void {
    this.sessionAllowLists.delete(sessionId);
    for (const [id, entry] of this.pending) {
      if (entry.request.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }
    }
  }

  private _emit(event: PermissionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* swallow */ }
    }
  }
}
```

**Acceptance Criteria**

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
- [ ] Permission requests are captured, queued, and resolved with first-responder-wins semantics.
- [ ] Permission timeout triggers auto-deny after configured period.
- [ ] "Always allow" adds tool to session allow-list.
- [ ] Concurrent permission responses are handled atomically (first wins).

**Edge Cases**

- E-1: Provider binary not found -- `healthCheck()` rejects before worktree creation.
- E-2: Non-git project path -- agent runs in project directory directly.
- E-3: Permission timeout with no connected clients -- auto-deny after 5 minutes.
- E-5: Concurrent permission responses -- Map delete is atomic in JS event loop, so first `respond()` call wins.
- Agent process crash: the `sendPrompt()` generator throws, caught by `_runPrompt()`, state machine transitions to `error`.

**Estimated Effort**: XL (Extra Large) -- 14-18 hours

---

### Task 7: Agent Interruption

**Description**

Implement graceful and forced interrupt logic as part of the `AgentSession` and `AgentManager`. Graceful interrupt waits for the current tool call to complete (up to a timeout), then escalates to forced. Forced interrupt aborts immediately via provider-specific mechanism.

**Prerequisites/Inputs**

- Task 2 (state machine transitions)
- Task 5 (multiplexer to push `TurnCanceledEvent`)
- Task 3 (provider-specific abort mechanisms)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/interrupt.ts` | `InterruptController` helper class |
| `src/daemon/agents/__tests__/interrupt.test.ts` | Unit tests (T-19, T-20) |

```typescript
// interrupt.ts
export class InterruptController {
  private _interrupting = false;
  private _escalationTimer: NodeJS.Timeout | null = null;

  constructor(
    private session: AgentSession,
    private options: InterruptOptions = { graceful: true, gracefulTimeoutMs: 10000 }
  ) {}

  async execute(): Promise<void> {
    if (this.session.state !== 'running') {
      throw new InvalidStateError('Cannot interrupt: agent is not running');
    }

    // Prevent double-interrupt
    if (this._interrupting) return;
    this._interrupting = true;

    try {
      if (this.options.graceful) {
        await this._gracefulInterrupt();
      } else {
        await this._forcedInterrupt();
      }
    } finally {
      this._interrupting = false;
      if (this._escalationTimer) {
        clearTimeout(this._escalationTimer);
        this._escalationTimer = null;
      }
    }
  }

  private async _gracefulInterrupt(): Promise<void> {
    // Set a timer to escalate to forced interrupt
    const escalationPromise = new Promise<void>((resolve) => {
      this._escalationTimer = setTimeout(async () => {
        console.warn('[interrupt] Graceful timeout exceeded, escalating to forced interrupt');
        await this._forcedInterrupt();
        resolve();
      }, this.options.gracefulTimeoutMs);
    });

    // Attempt graceful interrupt via provider
    const interruptPromise = this.session.interrupt({ graceful: true });

    // Race: either graceful succeeds or timeout escalates
    await Promise.race([interruptPromise, escalationPromise]);
  }

  private async _forcedInterrupt(): Promise<void> {
    await this.session.interrupt({ graceful: false });
  }
}
```

The actual `interrupt()` method on each provider session:

- **Claude Code**: `this.abortController.abort()` (already in Task 3).
- **OpenCode (stub)**: Would be `POST /api/sessions/{id}/cancel`.
- **Codex (stub)**: Would be `process.kill(pid, 'SIGINT')`.

**Acceptance Criteria**

- [ ] Graceful interrupt waits for current tool call to complete before stopping.
- [ ] Forced interrupt stops the agent immediately via provider-specific mechanism.
- [ ] Graceful interrupt escalates to forced after timeout (default 10s).
- [ ] Session state is preserved after interrupt (agent is reusable).
- [ ] `TurnCanceledEvent` is emitted to all consumers with the interrupt reason.
- [ ] State transitions to `idle` after successful interrupt.
- [ ] Interrupting a non-running agent throws `InvalidStateError`.
- [ ] Multiple concurrent interrupt calls do not cause errors (second is no-op).
- [ ] Provider-specific abort mechanisms are tested for Claude Code provider.

**Edge Cases**

- Agent crashes during interrupt: state transitions to `error`, not `idle`.
- Interrupt called during `initializing` state: should `close()` instead.
- `gracefulTimeoutMs: 0` should immediately force.

**Estimated Effort**: S (Small) -- 3-4 hours

---

### Task 8: Session Persistence

**Description**

Implement the persistence layer that saves agent session state to disk (as `handle.json`) and restores sessions on daemon restart. Persistence handles are written on every state change and turn completion.

**Prerequisites/Inputs**

- Task 6 (agent manager -- provides session data to persist)
- Task 1 (types: `PersistenceHandle`)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/persistence-manager.ts` | `PersistenceManager` class |
| `src/daemon/agents/__tests__/persistence-manager.test.ts` | Unit tests (T-16) |

```typescript
// persistence-manager.ts
import { writeFile, readFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export class PersistenceManager {
  private sessionsDir: string;
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private basePath: string,  // ~/.claude-context
    private config: PersistenceConfig = { enabled: true, saveIntervalMs: 5000, resumeOnStartup: true }
  ) {
    this.sessionsDir = path.join(basePath, 'sessions');
  }

  async saveHandle(handle: PersistenceHandle): Promise<void> {
    if (!this.config.enabled) return;

    const dir = path.join(this.sessionsDir, handle.sessionId);
    await mkdir(dir, { recursive: true });

    const filePath = path.join(dir, 'handle.json');
    const json = JSON.stringify(handle, null, 2);
    // Atomic write: write to temp, then rename
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, json, 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, filePath);
  }

  async loadAllHandles(): Promise<PersistenceHandle[]> {
    const handles: PersistenceHandle[] = [];
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const handlePath = path.join(this.sessionsDir, entry.name, 'handle.json');
        try {
          const json = await readFile(handlePath, 'utf-8');
          const handle = JSON.parse(json) as PersistenceHandle;
          // Restore Date objects
          handle.createdAt = new Date(handle.createdAt);
          handle.lastActivityAt = new Date(handle.lastActivityAt);
          handles.push(handle);
        } catch {
          console.warn(`[persistence] Failed to load handle: ${handlePath}`);
        }
      }
    } catch {
      // sessions/ directory may not exist yet
    }
    return handles;
  }

  async deleteHandle(sessionId: string): Promise<void> {
    const dir = path.join(this.sessionsDir, sessionId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  /**
   * Schedule a debounced save. Multiple rapid state changes
   * within saveIntervalMs result in a single disk write.
   */
  scheduleSave(handle: PersistenceHandle): void {
    const existing = this.saveTimers.get(handle.sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.saveTimers.delete(handle.sessionId);
      await this.saveHandle(handle);
    }, this.config.saveIntervalMs);

    this.saveTimers.set(handle.sessionId, timer);
  }

  /**
   * Flush all pending saves immediately (for daemon shutdown).
   */
  async flushAll(agentManager: AgentManager): Promise<void> {
    for (const [sessionId, timer] of this.saveTimers) {
      clearTimeout(timer);
    }
    this.saveTimers.clear();
    // Save all active sessions
    for (const summary of agentManager.listAgents()) {
      const session = agentManager.getAgent(summary.sessionId);
      if (session && session.state !== 'closed') {
        const handle = await session.getPersistenceHandle();
        await this.saveHandle(handle);
      }
    }
  }

  /**
   * Verify worktree integrity for a handle.
   */
  async verifyHandle(handle: PersistenceHandle): Promise<{ valid: boolean; reason?: string }> {
    // Check worktree exists
    if (handle.worktreePath) {
      try {
        await stat(handle.worktreePath);
      } catch {
        return { valid: false, reason: 'Worktree directory does not exist' };
      }
    }
    return { valid: true };
  }
}
```

**Resume Flow on Daemon Startup**

```typescript
// In daemon startup code:
async function resumeSessions(
  persistenceManager: PersistenceManager,
  agentManager: AgentManager,
  registry: ProviderRegistry,
  worktreeManager: WorktreeManager
): Promise<void> {
  const handles = await persistenceManager.loadAllHandles();

  for (const handle of handles) {
    // 1. Verify handle
    const { valid, reason } = await persistenceManager.verifyHandle(handle);
    if (!valid) {
      console.warn(`[resume] Stale session ${handle.sessionId}: ${reason}`);
      continue;
    }

    // 2. Get provider
    const provider = registry.get(handle.providerId);
    if (!provider) {
      console.warn(`[resume] Provider ${handle.providerId} not registered for session ${handle.sessionId}`);
      continue;
    }

    // 3. Health check
    const health = await provider.healthCheck();
    if (!health.installed) {
      console.warn(`[resume] Provider ${handle.providerId} not installed for session ${handle.sessionId}`);
      continue;
    }

    // 4. Resume
    try {
      const session = await provider.resumeSession(handle);
      // Register in agent manager (internal method)
      // ... register with multiplexer, state listener, etc.
      console.log(`[resume] Session ${handle.sessionId} resumed successfully`);
    } catch (err) {
      console.warn(`[resume] Failed to resume ${handle.sessionId}: ${err}`);
    }
  }
}
```

**Acceptance Criteria**

- [ ] `PersistenceHandle` is written to disk on every turn completion and state change (debounced).
- [ ] Handle file is valid JSON and contains all fields required for resume.
- [ ] On daemon restart, all persisted sessions are discovered and resume is attempted.
- [ ] Claude Code sessions resume via the SDK's `resume` parameter.
- [ ] Resumed sessions preserve their `sessionId` (no ID change).
- [ ] Token usage accumulates across restarts (not reset).
- [ ] Permission allow-list is restored on resume.
- [ ] Stale sessions are detected and reported (not silently dropped).
- [ ] Handle files are cleaned up when a session is explicitly closed.
- [ ] Worktree integrity is verified before resume attempt.
- [ ] Atomic write (write-then-rename) prevents corrupt handle files.
- [ ] `flushAll()` saves all sessions immediately for daemon shutdown.

**Edge Cases**

- E-4: Daemon crash -- handle was last saved on previous state change, some recent state may be lost.
- E-9: Worktree deleted while daemon was stopped -- attempt re-creation from branch.
- Corrupt handle.json -- log warning, skip session.
- `sessions/` directory does not exist on first run -- `loadAllHandles()` returns empty array.

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 9: Model Selection

**Description**

Implement the `ModelSelector` that provides a unified interface for listing and selecting models across all registered providers. Includes model validation, default selection, and pricing information.

**Prerequisites/Inputs**

- Task 3 (provider registry with `listModels()`)
- Task 1 (types: `ModelInfo`, `ModelCapabilities`, `ModelPricing`)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/model-selector.ts` | `DefaultModelSelector` class |
| `src/daemon/agents/models/claude-models.ts` | Claude Code model catalog |
| `src/daemon/agents/models/opencode-models.ts` | OpenCode model catalog (stub) |
| `src/daemon/agents/models/codex-models.ts` | Codex model catalog (stub) |
| `src/daemon/agents/__tests__/model-selector.test.ts` | Unit tests (T-17, T-18) |

```typescript
// model-selector.ts
export class DefaultModelSelector implements ModelSelector {
  constructor(private registry: ProviderRegistry) {}

  listAll(): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const providerInfo of this.registry.list()) {
      const provider = this.registry.get(providerInfo.id);
      if (provider) {
        // Use cached model lists (populated at registration)
        models.push(...(PROVIDER_MODELS[providerInfo.id] ?? []));
      }
    }
    return models;
  }

  listForProvider(providerId: string): ModelInfo[] {
    return PROVIDER_MODELS[providerId] ?? [];
  }

  getDefault(providerId: string): ModelInfo {
    const models = this.listForProvider(providerId);
    const defaultModel = models.find(m => m.id === DEFAULT_MODELS[providerId]);
    if (!defaultModel) throw new Error(`No default model for provider "${providerId}"`);
    return defaultModel;
  }

  validate(providerId: string, modelId: string): boolean {
    return this.listForProvider(providerId).some(m => m.id === modelId);
  }
}

const DEFAULT_MODELS: Record<string, string> = {
  'claude-code': 'claude-sonnet-4-5',
  'opencode': 'claude-sonnet-4-5',
  'codex': 'o4-mini',
};
```

**Claude Models Catalog**

```typescript
// models/claude-models.ts
export const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    providerId: 'claude-code',
    capabilities: { thinking: true, vision: true, caching: true, streaming: true, toolUse: true },
    contextWindow: 200000,
    maxOutputTokens: 32000,
    pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.5, cacheWritePerMillion: 18.75 },
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    providerId: 'claude-code',
    capabilities: { thinking: true, vision: true, caching: true, streaming: true, toolUse: true },
    contextWindow: 200000,
    maxOutputTokens: 16000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
  },
  {
    id: 'claude-haiku-3-5',
    name: 'Claude Haiku 3.5',
    providerId: 'claude-code',
    capabilities: { thinking: false, vision: true, caching: true, streaming: true, toolUse: true },
    contextWindow: 200000,
    maxOutputTokens: 8192,
    pricing: { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 },
  },
];
```

**Acceptance Criteria**

- [ ] `listAll()` returns models from all registered providers.
- [ ] `listForProvider()` returns only models for the specified provider.
- [ ] `getDefault()` returns a sensible default for each provider.
- [ ] `validate()` confirms a model ID is valid for a provider.
- [ ] `ModelInfo` includes context window size, pricing, and capability flags.
- [ ] Model pricing enables accurate cost estimation per turn.
- [ ] Invalid model IDs produce clear error messages.

**Edge Cases**

- Provider with no models (stub) returns empty array.
- `validate()` for an unregistered provider returns false.
- Model pricing values may change -- they are constants in code, updated with releases.

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 10: REST/WS API Endpoints

**Description**

Implement the HTTP REST API and WebSocket endpoints that expose agent management to external clients (dashboard, mobile app, CLI). These endpoints are added to the existing daemon HTTP server.

**Prerequisites/Inputs**

- Task 5 (stream multiplexer for WebSocket streaming)
- Task 6 (agent manager)
- Task 7 (interrupt)
- Task 8 (persistence for session state)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/routes/agents.ts` | REST API route handlers |
| `src/daemon/routes/agents-ws.ts` | WebSocket stream handler |
| `src/daemon/routes/__tests__/agents-api.test.ts` | API tests |

**REST Endpoints**

| Endpoint | Method | Handler | Description |
|----------|--------|---------|-------------|
| `/api/agents` | GET | `listAgents` | List all agents with optional state filter |
| `/api/agents` | POST | `createAgent` | Create a new agent |
| `/api/agents/:id` | GET | `getAgent` | Get agent details |
| `/api/agents/:id` | DELETE | `destroyAgent` | Destroy an agent |
| `/api/agents/:id/prompt` | POST | `sendPrompt` | Send prompt to idle agent |
| `/api/agents/:id/interrupt` | POST | `interruptAgent` | Interrupt running agent |
| `/api/agents/:id/model` | PUT | `setModel` | Change agent model |
| `/api/agents/:id/permissions` | GET | `getPermissions` | Get pending permissions for agent |
| `/api/agents/:id/permissions/:pid` | POST | `respondToPermission` | Respond to permission request |
| `/ws/agents/:id/stream` | WS | `streamAgent` | Real-time event stream |

```typescript
// routes/agents.ts
import type { IncomingMessage, ServerResponse } from 'node:http';

export function createAgentRoutes(
  agentManager: AgentManager,
  permissionRouter: PermissionRouter,
  modelSelector: ModelSelector,
) {
  return {
    async handleRequest(req: IncomingMessage, res: ServerResponse, pathParts: string[]): Promise<boolean> {
      // pathParts[0] = 'api', pathParts[1] = 'agents', etc.
      const method = req.method;

      if (pathParts.length === 2 && method === 'GET') {
        return this.listAgents(req, res);
      }
      if (pathParts.length === 2 && method === 'POST') {
        return this.createAgent(req, res);
      }
      // ... route matching for all endpoints
      return false; // not handled
    },

    async listAgents(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const stateFilter = url.searchParams.get('state');
      const filter: AgentFilter = stateFilter
        ? { state: stateFilter.split(',') as AgentState[] }
        : {};
      const agents = agentManager.listAgents(filter);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents }));
      return true;
    },

    async createAgent(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const body = await readBody(req);
      try {
        const session = await agentManager.createAgent({
          providerId: body.provider,
          projectPath: body.project_path,
          prompt: body.prompt,
          model: body.model,
          branchName: body.branch_name,
          useWorktree: body.use_worktree,
          environment: body.environment,
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          session_id: session.sessionId,
          state: session.state,
          model: session.model,
          working_directory: session.workingDirectory,
        }));
      } catch (err: any) {
        const status = err instanceof AgentOrchestrationError ? err.httpStatus : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: err.code ?? 'UNKNOWN', message: err.message } }));
      }
      return true;
    },

    async sendPrompt(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<boolean> {
      const body = await readBody(req);
      const session = agentManager.getAgent(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'AGENT_NOT_FOUND', message: `No agent with ID ${sessionId}` } }));
        return true;
      }
      if (session.state !== 'idle') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { code: 'INVALID_STATE', message: `Agent is in "${session.state}" state. Wait for "idle".` }
        }));
        return true;
      }

      // Start the prompt (non-blocking), client subscribes via WebSocket for streaming
      // The multiplexer in AgentManager handles the stream
      const multiplexer = agentManager.getMultiplexer(sessionId);
      // _runPrompt is called internally
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', session_id: sessionId }));
      return true;
    },

    // ... other handlers follow same pattern
  };
}
```

**WebSocket Stream Handler**

```typescript
// routes/agents-ws.ts
import { WebSocket } from 'ws'; // or native

export function handleAgentStream(
  ws: WebSocket,
  sessionId: string,
  agentManager: AgentManager
): void {
  const multiplexer = agentManager.getMultiplexer(sessionId);
  if (!multiplexer) {
    ws.close(4404, 'Agent not found');
    return;
  }

  const consumer = multiplexer.subscribe({ replayCount: 100 });
  let closed = false;

  // Pump events to WebSocket
  (async () => {
    try {
      for await (const event of consumer) {
        if (closed) break;
        ws.send(JSON.stringify(event));
      }
    } catch {
      // Generator closed
    }
  })();

  ws.on('close', () => {
    closed = true;
    consumer.return(undefined);
  });

  ws.on('error', () => {
    closed = true;
    consumer.return(undefined);
  });
}
```

**Acceptance Criteria**

- [ ] All REST endpoints return correct HTTP status codes and JSON responses.
- [ ] Error responses include `code` and `message` fields matching the spec error table.
- [ ] WebSocket stream delivers events in real time with < 50ms latency (daemon-side).
- [ ] WebSocket late-joiners receive replay of recent events.
- [ ] WebSocket disconnection cleans up the consumer from the multiplexer.
- [ ] `POST /api/agents` validates required fields (`provider`, `project_path`).
- [ ] `POST /api/agents/:id/prompt` returns 409 if agent is not idle.
- [ ] `DELETE /api/agents/:id` cleans up worktree and session.
- [ ] Permission endpoints work end-to-end (GET pending, POST respond).

**Edge Cases**

- E-10: Sending prompt to running agent returns 409 with actionable message.
- E-11: WebSocket disconnect mid-stream does not affect other connections.
- Large JSON bodies on `POST /api/agents/:id/prompt` -- enforce body size limit (1MB).
- CORS headers for dashboard access from different origin.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 11: MCP Server

**Description**

Implement the MCP (Model Context Protocol) server that exposes agent management as tools. This enables a parent Claude Code agent to orchestrate child agents via standard MCP tool calls. The server is mounted at `/mcp/agents` on the daemon's HTTP port.

**Prerequisites/Inputs**

- Task 6 (agent manager)
- Task 7 (interrupt)
- Task 8 (persistence)
- Task 10 (shared infrastructure with REST endpoints)

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/mcp/agent-tools.ts` | MCP tool definitions and handlers |
| `src/daemon/mcp/server.ts` | MCP server setup (Streamable HTTP transport) |
| `src/daemon/mcp/__tests__/agent-tools.test.ts` | Unit tests (T-27, T-28) |

**MCP Tools**

```typescript
// mcp/agent-tools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerAgentTools(
  server: McpServer,
  agentManager: AgentManager,
  permissionRouter: PermissionRouter,
): void {

  // Tool: create_agent
  server.tool(
    'create_agent',
    'Spawn a new coding agent in its own worktree. Returns the agent session ID.',
    {
      provider: z.enum(['claude-code', 'opencode', 'codex']).describe('Which agent provider to use'),
      project_path: z.string().describe('Absolute path to the git repository'),
      prompt: z.string().optional().describe('Initial prompt to send to the agent'),
      model: z.string().optional().describe('Model to use (provider-specific)'),
      branch_name: z.string().optional().describe('Custom branch name for the worktree'),
    },
    async ({ provider, project_path, prompt, model, branch_name }) => {
      try {
        const session = await agentManager.createAgent({
          providerId: provider,
          projectPath: project_path,
          prompt,
          model,
          branchName: branch_name,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              session_id: session.sessionId,
              state: session.state,
              model: session.model,
              working_directory: session.workingDirectory,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: list_agents
  server.tool(
    'list_agents',
    'List all running agents with their current state, model, and resource usage.',
    {
      state: z.enum(['initializing', 'idle', 'running', 'error', 'closed']).optional()
        .describe('Filter by agent state'),
    },
    async ({ state }) => {
      const filter: AgentFilter = state ? { state: [state] } : {};
      const agents = agentManager.listAgents(filter);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ agents }, null, 2),
        }],
      };
    }
  );

  // Tool: send_prompt
  server.tool(
    'send_prompt',
    "Send a prompt to an idle agent. The agent must be in 'idle' state.",
    {
      session_id: z.string().describe('Agent session ID'),
      prompt: z.string().describe('The prompt to send'),
    },
    async ({ session_id, prompt }) => {
      const session = agentManager.getAgent(session_id);
      if (!session) {
        return {
          content: [{ type: 'text', text: `Error: Agent ${session_id} not found` }],
          isError: true,
        };
      }
      if (session.state !== 'idle') {
        return {
          content: [{
            type: 'text',
            text: `Error: Agent ${session_id} is in '${session.state}' state. Wait for 'idle' state. Use wait_for_agent to block until idle.`,
          }],
          isError: true,
        };
      }

      // Start prompt processing via agent manager (non-blocking)
      // The caller should use wait_for_agent to wait for completion
      agentManager._runPrompt(session_id, prompt);
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', session_id }) }],
      };
    }
  );

  // Tool: wait_for_agent
  server.tool(
    'wait_for_agent',
    "Block until the specified agent reaches 'idle' or 'error' state. Returns the final turn result.",
    {
      session_id: z.string().describe('Agent session ID'),
      timeout_ms: z.number().optional().describe('Maximum wait time in milliseconds (default: 300000 = 5 min)'),
    },
    async ({ session_id, timeout_ms }) => {
      const timeout = timeout_ms ?? 300000;
      const session = agentManager.getAgent(session_id);
      if (!session) {
        return { content: [{ type: 'text', text: `Error: Agent ${session_id} not found` }], isError: true };
      }

      // If already idle or error, return immediately
      if (session.state === 'idle' || session.state === 'error' || session.state === 'closed') {
        const summary = agentManager.listAgents({ state: [session.state] })
          .find(a => a.sessionId === session_id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ state: session.state, summary }, null, 2) }],
        };
      }

      // Wait for state change
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          resolve({
            content: [{ type: 'text', text: `Timeout: agent still in '${session.state}' after ${timeout}ms` }],
            isError: true,
          });
        }, timeout);

        const unsubscribe = session.onStateChange((event) => {
          if (event.currentState === 'idle' || event.currentState === 'error' || event.currentState === 'closed') {
            clearTimeout(timer);
            unsubscribe();
            const summary = agentManager.listAgents()
              .find(a => a.sessionId === session_id);
            resolve({
              content: [{ type: 'text', text: JSON.stringify({ state: event.currentState, summary }, null, 2) }],
            });
          }
        });
      });
    }
  );

  // Tool: cancel_agent
  server.tool(
    'cancel_agent',
    'Interrupt a running agent. Use graceful=true to wait for current tool to finish.',
    {
      session_id: z.string().describe('Agent session ID'),
      graceful: z.boolean().optional().describe('Wait for current tool to complete (default: true)'),
    },
    async ({ session_id, graceful }) => {
      const session = agentManager.getAgent(session_id);
      if (!session) {
        return { content: [{ type: 'text', text: `Error: Agent ${session_id} not found` }], isError: true };
      }
      try {
        const controller = new InterruptController(session, { graceful: graceful ?? true });
        await controller.execute();
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'interrupted', state: session.state }) }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: get_agent_output
  server.tool(
    'get_agent_output',
    "Get the accumulated output from an agent's most recent turn.",
    {
      session_id: z.string().describe('Agent session ID'),
    },
    async ({ session_id }) => {
      const multiplexer = agentManager.getMultiplexer(session_id);
      if (!multiplexer) {
        return { content: [{ type: 'text', text: `Error: Agent ${session_id} not found` }], isError: true };
      }
      // Read from the multiplexer's replay buffer
      // Reconstruct text output from TextDeltaEvents and TimelineEvents
      const events = multiplexer.getReplayBuffer();
      const textParts: string[] = [];
      for (const event of events) {
        if ((event as any).type === 'timeline') {
          textParts.push((event as any).content);
        }
      }
      return {
        content: [{ type: 'text', text: textParts.join('\n') || '(no output yet)' }],
      };
    }
  );
}
```

**MCP Server Setup**

```typescript
// mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export function createMcpServer(
  agentManager: AgentManager,
  permissionRouter: PermissionRouter,
): McpServer {
  const server = new McpServer({
    name: 'agentctx-agents',
    version: '1.0.0',
  });

  registerAgentTools(server, agentManager, permissionRouter);

  // Also register MCP resources
  server.resource('agent-status', 'agent://{sessionId}/status', async (uri) => {
    // Return agent status as resource
  });

  return server;
}

// Mount on HTTP server at /mcp/agents
export function mountMcpEndpoint(
  httpServer: any, // your HTTP server abstraction
  mcpServer: McpServer,
): void {
  // Handle POST /mcp/agents with StreamableHTTPServerTransport
  httpServer.addRoute('POST', '/mcp/agents', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });
}
```

**Acceptance Criteria**

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

**Edge Cases**

- E-10: `send_prompt` on running agent returns error with guidance to use `wait_for_agent`.
- `wait_for_agent` on already-idle agent returns immediately.
- `wait_for_agent` timeout returns error without crashing.
- `create_agent` with invalid provider returns clear error.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 12: Integration Tests

**Description**

Create integration tests that exercise the full agent orchestration stack end-to-end. Tests cover multi-agent parallel execution, permission flows, session persistence and resume, streaming to multiple consumers, and MCP tool orchestration.

**Prerequisites/Inputs**

- All previous tasks (1-11)
- Claude Code SDK installed (for real provider tests)
- Git repository fixture for worktree tests

**Implementation Details**

| File | Purpose |
|------|---------|
| `src/daemon/agents/__tests__/integration/multi-agent.test.ts` | T-21 through T-23 |
| `src/daemon/agents/__tests__/integration/permissions.test.ts` | T-24, T-31 |
| `src/daemon/agents/__tests__/integration/interrupt.test.ts` | T-25 |
| `src/daemon/agents/__tests__/integration/persistence.test.ts` | T-26 |
| `src/daemon/agents/__tests__/integration/mcp.test.ts` | T-27, T-28 |
| `src/daemon/agents/__tests__/integration/streaming.test.ts` | T-32, T-33 |
| `src/daemon/agents/__tests__/integration/worktree.test.ts` | T-34 |
| `src/daemon/agents/__tests__/integration/model.test.ts` | T-35 |
| `src/daemon/agents/__tests__/integration/resource.test.ts` | T-29 |
| `src/daemon/agents/__tests__/integration/resilience.test.ts` | T-30 |
| `src/daemon/agents/__tests__/e2e/full-workflow.test.ts` | T-36 through T-40 |

**Test Matrix (from story spec)**

| Test ID | Description | Tasks Tested |
|---------|-------------|--------------|
| T-21 | Create Claude Code agent, send prompt, receive streaming events, verify turn completion | 3, 5, 6 |
| T-22 | Create two agents in parallel worktrees, both complete successfully, branches exist | 4, 6 |
| T-23 | Create agent, close it, verify worktree is cleaned up and branch is preserved | 4, 6 |
| T-24 | Create agent, trigger permission request, respond from test client, verify agent continues | 6 |
| T-25 | Create agent, interrupt while running, verify state transitions to idle | 7 |
| T-26 | Create agent, persist handle, simulate daemon restart, resume session | 8 |
| T-27 | MCP tool `create_agent` spawns agent, `wait_for_agent` blocks until idle | 11 |
| T-28 | MCP tool `send_prompt` on running agent returns error | 11 |
| T-29 | Resource monitor rejects agent creation when `maxConcurrentAgents` is reached | 6 |
| T-30 | Agent crash transitions state to error, daemon remains stable | 2, 6 |
| T-31 | Permission timeout after configured time auto-denies | 6 |
| T-32 | Stream consumer disconnect does not affect other consumers | 5 |
| T-33 | Multiple consumers receive identical event sequences | 5 |
| T-34 | Worktree creation on non-git directory runs agent directly | 4, 6 |
| T-35 | Model switch on idle agent changes model for next turn | 9 |
| T-36 | Full workflow: create 3 agents, send prompts, wait for all, read outputs, destroy all | All |
| T-37 | Parent Claude Code agent uses MCP tools to orchestrate 2 child agents | 11 |
| T-38 | Agent requests permission, simulated client approves, agent completes | 6 |
| T-39 | Daemon restart with 2 persisted sessions, both resume and return to idle | 8 |
| T-40 | Dashboard connects mid-session, receives replay of recent events via stream | 5, 10 |

**Test Fixture: Git Repository**

```typescript
// __tests__/fixtures/git-repo.ts
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function createTestRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  const exec = promisify(execFile);
  await exec('git', ['init', dir]);
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), '# Test');
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['commit', '-m', 'initial'], { cwd: dir });
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
```

**Mock Provider for Testing**

```typescript
// __tests__/fixtures/mock-provider.ts
export class MockAgentClient implements AgentClient {
  readonly providerId = 'mock';
  readonly capabilities: ProviderCapabilities = {
    streaming: true, resume: false, interruption: true,
    permissions: false, modelSelection: true, worktree: true,
  };

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    return new MockAgentSession(options);
  }
  async resumeSession(): Promise<AgentSession> { throw new Error('Not supported'); }
  async listModels(): Promise<ModelInfo[]> { return []; }
  async healthCheck(): Promise<HealthCheckResult> { return { installed: true }; }
}

class MockAgentSession implements AgentSession {
  // Controllable mock: can inject events, errors, delays
  private eventQueue: AgentStreamEvent[] = [];
  private stateMachine: AgentStateMachine;

  queueEvents(events: AgentStreamEvent[]): void { this.eventQueue = events; }
  // ... sendPrompt yields from eventQueue
}
```

**Acceptance Criteria**

- [ ] All 20 unit tests (T-1 through T-20) pass.
- [ ] All 15 integration tests (T-21 through T-35) pass.
- [ ] All 5 end-to-end tests (T-36 through T-40) pass.
- [ ] Tests use isolated temp directories and mock providers (no real API calls in unit tests).
- [ ] Integration tests with Claude Code SDK are gated behind an env flag (`RUN_SDK_TESTS=1`).
- [ ] Test cleanup removes all temp directories, worktrees, and session handles.
- [ ] No test depends on external state or ordering.

**Edge Cases**

- Tests must handle the case where Claude Code SDK is not installed (skip gracefully).
- Worktree tests must clean up even on test failure (use `afterEach` hooks).
- Mock provider enables testing all state transitions without real agent processes.

**Estimated Effort**: XL (Extra Large) -- 12-16 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/`.

| File | Action | Task(s) |
|------|--------|---------|
| `src/daemon/agents/types.ts` | Create | 1 |
| `src/daemon/agents/stream-types.ts` | Create | 1 |
| `src/daemon/agents/permission-types.ts` | Create | 1 |
| `src/daemon/agents/errors.ts` | Create | 1 |
| `src/daemon/agents/index.ts` | Create | 1 |
| `src/daemon/agents/state-machine.ts` | Create | 2 |
| `src/daemon/agents/provider-registry.ts` | Create | 3 |
| `src/daemon/agents/providers/claude-code.ts` | Create | 3 |
| `src/daemon/agents/providers/opencode-stub.ts` | Create | 3 |
| `src/daemon/agents/providers/codex-stub.ts` | Create | 3 |
| `src/daemon/agents/worktree-manager.ts` | Create | 4 |
| `src/daemon/agents/stream-multiplexer.ts` | Create | 5 |
| `src/daemon/agents/agent-manager.ts` | Create | 6 |
| `src/daemon/agents/resource-monitor.ts` | Create | 6 |
| `src/daemon/agents/permission-router.ts` | Create | 6 |
| `src/daemon/agents/interrupt.ts` | Create | 7 |
| `src/daemon/agents/persistence-manager.ts` | Create | 8 |
| `src/daemon/agents/model-selector.ts` | Create | 9 |
| `src/daemon/agents/models/claude-models.ts` | Create | 9 |
| `src/daemon/agents/models/opencode-models.ts` | Create | 9 |
| `src/daemon/agents/models/codex-models.ts` | Create | 9 |
| `src/daemon/routes/agents.ts` | Create | 10 |
| `src/daemon/routes/agents-ws.ts` | Create | 10 |
| `src/daemon/mcp/agent-tools.ts` | Create | 11 |
| `src/daemon/mcp/server.ts` | Create | 11 |
| `src/daemon/agents/__tests__/state-machine.test.ts` | Create | 2 |
| `src/daemon/agents/__tests__/provider-registry.test.ts` | Create | 3 |
| `src/daemon/agents/__tests__/claude-code-provider.test.ts` | Create | 3 |
| `src/daemon/agents/__tests__/worktree-manager.test.ts` | Create | 4 |
| `src/daemon/agents/__tests__/stream-multiplexer.test.ts` | Create | 5 |
| `src/daemon/agents/__tests__/agent-manager.test.ts` | Create | 6 |
| `src/daemon/agents/__tests__/permission-router.test.ts` | Create | 6 |
| `src/daemon/agents/__tests__/interrupt.test.ts` | Create | 7 |
| `src/daemon/agents/__tests__/persistence-manager.test.ts` | Create | 8 |
| `src/daemon/agents/__tests__/model-selector.test.ts` | Create | 9 |
| `src/daemon/routes/__tests__/agents-api.test.ts` | Create | 10 |
| `src/daemon/mcp/__tests__/agent-tools.test.ts` | Create | 11 |
| `src/daemon/agents/__tests__/integration/*.test.ts` | Create | 12 |
| `src/daemon/agents/__tests__/e2e/*.test.ts` | Create | 12 |
| `src/daemon/agents/__tests__/fixtures/git-repo.ts` | Create | 12 |
| `src/daemon/agents/__tests__/fixtures/mock-provider.ts` | Create | 12 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone |
|-------|-------|-----------|
| **Phase 1: Foundation** | Task 1 (Types & Interfaces) | All contracts defined, compiles clean |
| **Phase 2: Core Engine** | Task 2 (State Machine), Task 4 (Worktree Manager) -- parallel | State transitions and git worktrees work in isolation |
| **Phase 3: Provider** | Task 3 (Provider Registry + Claude Code) | Can create a Claude Code session and receive SDK events |
| **Phase 4: Streaming** | Task 5 (Stream Multiplexer) | Events fan out to multiple consumers |
| **Phase 5: Orchestration** | Task 6 (Agent Manager) | Full agent lifecycle: create, prompt, track, destroy |
| **Phase 6: Controls** | Task 7 (Interruption), Task 9 (Model Selection) -- parallel | Agents can be interrupted and models switched |
| **Phase 7: Persistence** | Task 8 (Session Persistence) | Sessions survive daemon restarts |
| **Phase 8: API Layer** | Task 10 (REST/WS), Task 11 (MCP Server) -- parallel | External clients can manage agents |
| **Phase 9: Validation** | Task 12 (Integration Tests) | All 45 test cases pass |

Tasks 2 and 4 can be implemented in parallel (Phase 2). Tasks 7 and 9 can be implemented in parallel (Phase 6). Tasks 10 and 11 can be implemented in parallel (Phase 8).

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Claude Code SDK API changes between versions | Medium | High (provider breaks) | Pin SDK version. Wrap all SDK calls in try/catch. Log unknown message types instead of crashing. |
| Agent process leaks (orphaned processes after daemon crash) | Medium | Medium (resource waste) | Persistence handles store PIDs. On startup, check if PIDs are alive. Kill orphaned processes. |
| Worktree accumulation consumes disk space | Medium | Low (gradual) | `destroyAgent()` always cleans up worktrees. `gc-doctor` can report orphaned worktrees. |
| Stream multiplexer memory growth with many consumers | Low | Medium (OOM) | Bounded buffers per consumer. Backpressure drops oldest events. Monitor consumer count. |
| Permission timeout with no connected clients | Medium | Medium (agent blocked) | Configurable timeout action (deny or allow). Log warning when no clients are connected. |
| Git worktree operations fail on shallow clones | Low | Medium (spawn fails) | Detect shallow clones via `git rev-parse --is-shallow-repository`. Unshallow if needed or warn. |
| MCP SDK breaking changes | Low | Medium (MCP server down) | Pin MCP SDK version. Isolate MCP server -- failure does not affect REST/WS API. |
| Concurrent access to persistence handle files | Low | Low (corrupt JSON) | Atomic write (write-to-temp, rename). Debounced saves prevent rapid writes. |
| macOS vs Linux differences in process management | Medium | Low | Use Node.js APIs (`child_process`, `os`) which abstract platform differences. Avoid `/proc` reads on macOS (use `os.freemem()` instead). |
| `@anthropic-ai/claude-code` SDK not installed | Medium | High (primary provider broken) | Detect at registration time. Fall back to stub. Clear error message with npm install command. |

---

## Notes for Implementation

1. **TypeScript strict mode is mandatory** -- all files must compile with `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`.
2. **No external dependencies beyond the SDK** -- use Node.js built-in modules (`node:child_process`, `node:fs/promises`, `node:crypto`, `node:os`) wherever possible. The only external deps are `@anthropic-ai/claude-code` and `@modelcontextprotocol/sdk`.
3. **Error boundaries everywhere** -- every async operation that touches external processes (git, claude, agents) must be wrapped in try/catch. Agent crashes must never bring down the daemon.
4. **The AgentManager is the single coordination point** -- all external code (REST API, MCP server, WebSocket handlers) talks to `AgentManager`. They never interact with providers, worktrees, or state machines directly.
5. **Stream multiplexer is generic** -- `StreamMultiplexer<T>` works for any event type. This enables reuse for PTY streaming in Story F12.
6. **Persistence is best-effort** -- if a disk write fails, log the error but do not crash the agent or the daemon. The next state change will retry.
7. **Permission router is session-scoped** -- `clearSession()` must be called when an agent is destroyed to clean up pending permissions and allow-lists.
8. **MCP tools return text content** -- all tool responses are JSON-serialized strings inside `text` content blocks. This is the standard MCP pattern for structured data.
9. **Integration tests with real Claude Code SDK are opt-in** -- gate behind `RUN_SDK_TESTS=1` environment variable. CI runs with mock providers only by default.
10. **WebSocket connections are per-agent** -- each WebSocket connects to `/ws/agents/:id/stream` for a specific agent. There is no "all agents" firehose (use `onAgentEvent` via REST polling or SSE instead).

---

## Effort Estimates

| Task | Complexity | Estimate |
|------|------------|----------|
| Task 1: TypeScript Interfaces & Types | S | 2-3 hours |
| Task 2: Agent State Machine | M | 4-6 hours |
| Task 3: Provider Registry & Claude Code Provider | L | 10-14 hours |
| Task 4: Worktree Manager | M | 6-8 hours |
| Task 5: Agent Streaming & Multiplexer | M | 5-7 hours |
| Task 6: Agent Manager | XL | 14-18 hours |
| Task 7: Agent Interruption | S | 3-4 hours |
| Task 8: Session Persistence | M | 6-8 hours |
| Task 9: Model Selection | S | 2-3 hours |
| Task 10: REST/WS API Endpoints | L | 8-10 hours |
| Task 11: MCP Server | L | 8-10 hours |
| Task 12: Integration Tests | XL | 12-16 hours |
| **Total** | | **~80-107 hours (~10-14 working days)** |
