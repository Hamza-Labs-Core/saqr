# Implementation Plan: Story 22 -- OpenCode & Codex Agent Providers

**Date**: 2026-02-25
**Story**: 22-opencode-codex-providers
**Status**: Planning
**Estimated Total Effort**: ~10-14 days (80-112 hours)
**Prerequisites**: Story 3 (Hook System) unified event types. Story 5 (Agent Orchestration) provider registry, agent lifecycle, state machine. `@saqr/shared` event types. `@saqr/daemon` agent-manager, hook-manager, event-bus modules. Node.js 18+. TypeScript 5.x strict mode.
**References**: `stories/22-opencode-codex-providers.md`, `packages/daemon/src/agents/agent-manager.ts`, `packages/daemon/src/agents/providers/opencode-provider.ts`, `packages/daemon/src/agents/providers/codex-provider.ts`, `packages/daemon/src/hooks/integrations/opencode.ts`, `packages/daemon/src/hooks/integrations/codex.ts`, `packages/shared/src/events/types.ts`.

### Relationship to Other Stories

This story transforms the **stub provider implementations** from Story 5 into production-quality adapters that communicate with real OpenCode and Codex processes. It builds on top of the existing infrastructure:

- **Story 3** (Multi-Agent Hook System): Provides the 12 unified event types and the `EventEnvelope` format. The hook integrations (`OpenCodeIntegration`, `CodexIntegration`) already define event mappings -- this story wires them into the provider layer with real I/O.
- **Story 5** (Agent Process Orchestration): Provides `AgentProvider` interface, `AgentManager`, `AgentStateMachine`, `PermissionQueue`, `SessionStore`, error classes. The three providers (Claude Code, OpenCode, Codex) are registered stubs -- this story replaces the OpenCode and Codex stubs with full implementations.
- **Stories 6, 8, 9** (Dashboard, Mobile, Desktop): Downstream consumers of unified events. Once providers emit real events, these consumers display OpenCode and Codex agents identically to Claude Code with zero changes.
- **Story 7** (Encrypted Cloud Sync): Agent events from OpenCode/Codex flow through the same sync pipeline as Claude Code events.

### Existing Code Inventory

| File | Current State | This Story |
|------|--------------|------------|
| `packages/daemon/src/agents/providers/opencode-provider.ts` | Stub: returns fake `ManagedSession`, `healthCheck` returns `false` | Full HTTP client, SSE streaming, process spawn/restart |
| `packages/daemon/src/agents/providers/codex-provider.ts` | Stub: returns fake `ManagedSession`, `healthCheck` returns `false` | JSONL file tailer, process management, event parsing |
| `packages/daemon/src/hooks/integrations/opencode.ts` | Complete: install, healthCheck, normalizeEvent, handleIncomingEvent | Reuse event mapping; provider calls `normalizeEvent` internally |
| `packages/daemon/src/hooks/integrations/codex.ts` | Complete: install, healthCheck, parseJsonlLine, normalizeEvent | Reuse JSONL parsing; provider calls `parseJsonlLine` internally |
| `packages/daemon/src/agents/agent-manager.ts` | Complete: provider registry, session CRUD, state machine wiring | Extend with `sendPrompt()`, `streamEvents()`, provider health aggregation |
| `packages/daemon/src/agents/state-machine.ts` | Complete: transitions, recovery, backoff | No changes needed -- providers use it as-is |
| `packages/daemon/src/agents/errors.ts` | Complete: 8 error classes | Add `SSEConnectionError`, `JsonlParseError`, `ProcessCrashError` |

---

## Implementation Lanes

Two parallel lanes minimize blocking. Lane A handles HTTP/SSE (OpenCode). Lane B handles JSONL/process (Codex). They converge at Tasks 5-6 (registry wiring) and Tasks 7-8 (CLI + integration tests).

```
Lane A (OpenCode / HTTP+SSE)          Lane B (Codex / JSONL+Process)
================================       ================================
Task 1: SSE Parser + HTTP Client       Task 3: JSONL File Tailer
         |                                      |
         v                                      v
Task 2: OpenCode Provider               Task 4: Codex Provider
         |                                      |
         v                                      v
         +------ Task 5: Registry ------+
                 Wiring + AgentManager
                 Extensions
                        |
              +---------+---------+
              |                   |
              v                   v
Task 7: CLI Commands          Task 6: Health Check System
(install, doctor, providers)        |
              |                     |
              v                     v
              +------ Task 8: -----+
              Integration Tests (30+)
```

---

## Tasks

### Task 1: SSE Parser + HTTP Client Utilities

**Description**

Build a reusable SSE (Server-Sent Events) parser and a typed HTTP client wrapper for communicating with `opencode serve`. The SSE parser handles reconnection with exponential backoff, event ID tracking for resumption, and robust error handling. The HTTP client wraps `fetch()` with timeouts, retries for transient errors (503, network failures), and typed request/response helpers.

These are general-purpose utilities that the OpenCode provider (Task 2) consumes. Keeping them separate enables unit testing without mocking the full OpenCode API.

**Prerequisites/Inputs**

- Node.js 18+ built-in `fetch()` (no external HTTP library needed)
- `EventEnvelope` type from `packages/shared/src/events/envelope.ts`
- `AgentError` type from `packages/daemon/src/agents/state-machine.ts`

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/daemon/src/agents/providers/sse-parser.ts` | `SSEParser` class: parses SSE text stream, emits typed events |
| `packages/daemon/src/agents/providers/http-client.ts` | `ProviderHttpClient` class: typed fetch wrapper with retry/timeout |
| `packages/daemon/src/agents/providers/__tests__/sse-parser.test.ts` | Unit tests for SSE parser |
| `packages/daemon/src/agents/providers/__tests__/http-client.test.ts` | Unit tests for HTTP client |

**Key Interfaces**

```typescript
// sse-parser.ts

export interface SSEEvent {
  id?: string;
  event: string;       // SSE event type (e.g., "session.created")
  data: string;        // Raw data string (JSON-encoded)
  retry?: number;       // Server-suggested reconnect delay
}

export interface SSEParserOptions {
  /** Initial reconnect delay in ms (default: 1000) */
  initialReconnectMs?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectMs?: number;
  /** Maximum consecutive reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
  /** Callback invoked on each parsed SSE event */
  onEvent: (event: SSEEvent) => void;
  /** Callback invoked on connection errors */
  onError: (error: Error) => void;
  /** Callback invoked when connection is established */
  onOpen?: () => void;
  /** Callback invoked when max reconnect attempts exhausted */
  onGiveUp?: (attempts: number) => void;
}

export class SSEParser {
  private lastEventId: string | undefined;
  private reconnectMs: number;
  private reconnectAttempts: number;
  private abortController: AbortController | null;

  constructor(private readonly url: string, private readonly options: SSEParserOptions);

  /** Start consuming the SSE stream. Reconnects automatically on failure. */
  async connect(): Promise<void>;

  /** Gracefully close the SSE connection. */
  disconnect(): void;

  /** Parse a raw SSE text chunk into events (handles multi-line data fields). */
  private parseChunk(chunk: string): SSEEvent[];
}
```

```typescript
// http-client.ts

export interface HttpClientOptions {
  baseUrl: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Max retries for transient errors (default: 3) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 1000) */
  retryDelayMs?: number;
}

export class ProviderHttpClient {
  constructor(private readonly options: HttpClientOptions);

  async get<T>(path: string): Promise<T>;
  async post<T>(path: string, body?: unknown): Promise<T>;
  async delete<T>(path: string): Promise<T>;

  /** Low-level fetch with timeout + retry logic */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response>;
}
```

**SSE Parsing Rules**

1. Lines starting with `:` are comments -- ignore.
2. Lines of the form `field: value` set the field (`event`, `data`, `id`, `retry`).
3. Empty line dispatches the accumulated event.
4. Multiple `data:` lines are concatenated with `\n`.
5. If `id` is set, store as `lastEventId` for reconnection (`Last-Event-ID` header).
6. If `retry` is set, update `reconnectMs`.

**Retry Logic**

- HTTP 503 / network error: retry with exponential backoff (1s, 2s, 4s, ... max 30s).
- HTTP 4xx (except 408, 429): do not retry -- propagate error.
- HTTP 408 / 429: retry with `Retry-After` header if present, else exponential backoff.
- SSE stream drops: reconnect with `Last-Event-ID` header for resumption.

**Acceptance Criteria**

- [ ] SSE parser correctly splits multi-line `data:` fields into single events.
- [ ] SSE parser handles comment lines (`:` prefix) without emitting events.
- [ ] SSE parser tracks `Last-Event-ID` for reconnection.
- [ ] SSE parser reconnects with exponential backoff on stream drop.
- [ ] SSE parser calls `onGiveUp` after `maxReconnectAttempts` exhausted.
- [ ] HTTP client retries on 503 with exponential backoff.
- [ ] HTTP client respects timeout and aborts long requests.
- [ ] HTTP client does not retry on 4xx (except 408/429).
- [ ] All methods are fully typed with generics.
- [ ] 8+ unit tests covering parse, reconnect, retry, and timeout scenarios.

**Edge Cases**

- SSE stream with no `event:` field defaults event type to `"message"`.
- Server sends `retry: 5000` -- parser updates its reconnect delay.
- Rapid disconnect/reconnect does not leak `AbortController` instances.
- HTTP response with empty body does not throw on JSON parse (return `undefined`).

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 2: OpenCode Provider (HTTP API + SSE)

**Description**

Replace the stub `OpenCodeProvider` with a full implementation that communicates with `opencode serve` via HTTP REST + SSE. The provider spawns `opencode serve` as a child process, manages its lifecycle, creates sessions via HTTP, sends prompts, streams events via SSE, and maps them to unified event types using the existing `OpenCodeIntegration.normalizeEvent()` method.

**Prerequisites/Inputs**

- Task 1 (SSE parser + HTTP client)
- `OpenCodeIntegration` from `packages/daemon/src/hooks/integrations/opencode.ts` (event normalization)
- `AgentProvider` interface from `agent-manager.ts`
- `AgentStateMachine` for lifecycle tracking
- `child_process.spawn` for managing `opencode serve`

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/daemon/src/agents/providers/opencode-provider.ts` | Full `OpenCodeProvider` implementation (replaces stub) |
| `packages/daemon/src/agents/providers/opencode-event-mapper.ts` | Maps raw SSE events to unified `EventEnvelope` via `OpenCodeIntegration` |
| `packages/daemon/src/agents/providers/__tests__/opencode-provider.test.ts` | Unit tests with mock HTTP server |
| `packages/daemon/src/agents/providers/__tests__/opencode-event-mapper.test.ts` | Event mapping tests |

**Key Implementation**

```typescript
// opencode-provider.ts

import { ChildProcess, spawn } from "node:child_process";
import { ProviderHttpClient } from "./http-client.js";
import { SSEParser } from "./sse-parser.js";
import { OpenCodeIntegration } from "../../hooks/integrations/opencode.js";
import type { AgentProvider, ProviderInfo, ModelInfo, CreateSessionOptions, ManagedSession } from "../agent-manager.js";
import type { EventEnvelope } from "../../event-bus/event-bus.js";

export interface OpenCodeProviderOptions {
  /** Base URL for opencode serve (default: http://127.0.0.1:3200) */
  apiBaseUrl?: string;
  /** Port to start opencode serve on (default: 3200) */
  port?: number;
  /** Path to opencode binary (default: "opencode") */
  binaryPath?: string;
  /** Maximum process restart attempts (default: 3) */
  maxRestarts?: number;
  /** Stale session timeout in ms (default: 300000 = 5 min) */
  staleSessionTimeoutMs?: number;
  /** Event callback for unified events */
  onEvent?: (event: EventEnvelope) => void;
}

export class OpenCodeProvider implements AgentProvider {
  readonly providerId = "opencode";

  private httpClient: ProviderHttpClient;
  private process: ChildProcess | null = null;
  private restartCount = 0;
  private sseConnections = new Map<string, SSEParser>();
  private integration = new OpenCodeIntegration();

  constructor(private readonly options: OpenCodeProviderOptions = {}) {
    this.httpClient = new ProviderHttpClient({
      baseUrl: options.apiBaseUrl ?? "http://127.0.0.1:3200",
    });
  }

  // --- Provider Interface ---

  async getInfo(): Promise<ProviderInfo>;
  async listModels(): Promise<ModelInfo[]>;
  async healthCheck(): Promise<{ healthy: boolean; message: string }>;
  async createSession(options: CreateSessionOptions): Promise<ManagedSession>;
  async resumeSession(sessionId: string): Promise<ManagedSession>;

  // --- OpenCode-Specific ---

  /** Spawn `opencode serve` as a child process. */
  async spawnServer(): Promise<void>;

  /** Stop the opencode serve process. */
  async stopServer(): Promise<void>;

  /** Send a prompt to a session. */
  async sendPrompt(sessionId: string, prompt: string): Promise<void>;

  /** Subscribe to SSE events for a session. */
  async subscribeEvents(sessionId: string, callback: (event: EventEnvelope) => void): Promise<void>;

  /** Unsubscribe from SSE events for a session. */
  unsubscribeEvents(sessionId: string): void;

  /** Cancel the current operation in a session. */
  async cancelSession(sessionId: string): Promise<void>;

  /** Handle opencode serve process crash with restart logic. */
  private handleProcessCrash(exitCode: number | null): Promise<void>;
}
```

**HTTP API Mapping (to `opencode serve`)**

| Operation | HTTP Method | Path | Request Body | Response |
|-----------|-------------|------|-------------|----------|
| Health check | `GET` | `/health` | -- | `{ status: "ok" }` |
| List sessions | `GET` | `/sessions` | -- | `Session[]` |
| Create session | `POST` | `/sessions` | `{ model, project }` | `Session` |
| Send prompt | `POST` | `/sessions/:id/messages` | `{ content }` | `Message` |
| Stream events | `GET (SSE)` | `/sessions/:id/events` | -- | SSE stream |
| Cancel | `POST` | `/sessions/:id/cancel` | -- | `{ ok: true }` |

**Event Flow**

1. SSE stream delivers raw OpenCode events (e.g., `event: session.created`, `data: {...}`).
2. `SSEParser.onEvent` receives parsed `SSEEvent`.
3. `OpenCodeEventMapper` extracts `nativeEventType` and `payload` from `SSEEvent.data`.
4. `OpenCodeIntegration.normalizeEvent(nativeEventType, payload)` returns `EventEnvelope | null`.
5. Non-null envelopes are emitted to the `onEvent` callback.

**Process Management**

- `spawnServer()`: runs `opencode serve --port <port>`, waits for health check to pass (polling every 500ms, timeout 15s).
- Process crash: `handleProcessCrash()` increments `restartCount`, respawns if under `maxRestarts` (default 3), else marks agent as error state.
- `stopServer()`: sends `SIGTERM`, waits 5s, sends `SIGKILL` if still alive.

**Acceptance Criteria**

- [ ] Provider spawns `opencode serve` and waits for health check.
- [ ] `createSession()` calls `POST /sessions` and returns valid `ManagedSession`.
- [ ] `sendPrompt()` calls `POST /sessions/:id/messages`.
- [ ] `subscribeEvents()` opens SSE connection and emits unified events.
- [ ] All 10 OpenCode event types correctly mapped to unified events (per story table).
- [ ] `message.updated` with `role=user` maps to `UserPromptReceived`; other roles return null.
- [ ] `tool.execute.after` with error field maps to `ToolCallFailed`; without maps to `ToolCallCompleted`.
- [ ] Process crash triggers restart up to 3 times.
- [ ] After 3 restarts, provider reports error state.
- [ ] SSE reconnect works after connection drop.
- [ ] Stale session detection after 5 min inactivity + health check pass.
- [ ] 10+ unit tests with mock HTTP server.

**Edge Cases**

- `opencode serve` not installed: `spawnServer` throws `ProviderNotInstalledError`.
- Port already in use: detect via stderr, try next port or fail with `SpawnFailedError`.
- SSE stream delivers events for a session the provider doesn't know about -- ignore.
- `cancelSession` on an idle session is a no-op (no error).

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 3: JSONL File Tailer

**Description**

Build a reusable JSONL file tailer that watches a directory for new `.jsonl` files and tails each file as new lines are appended. The tailer tracks read positions per file, handles file rotation/truncation, and emits parsed JSON objects. This is the core I/O primitive that the Codex provider (Task 4) builds on.

**Prerequisites/Inputs**

- Node.js `fs.watch()` and `fs.read()` APIs
- `EventEnvelope` type from shared package

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/daemon/src/agents/providers/jsonl-tailer.ts` | `JsonlTailer` class: directory watcher + file tailer |
| `packages/daemon/src/agents/providers/__tests__/jsonl-tailer.test.ts` | Unit tests with temp directory and real files |

**Key Interfaces**

```typescript
// jsonl-tailer.ts

export interface JsonlLine {
  /** The parsed JSON object from the line */
  data: Record<string, unknown>;
  /** The source file path */
  filePath: string;
  /** Line number within the file (1-based) */
  lineNumber: number;
  /** Byte offset of this line in the file */
  byteOffset: number;
}

export interface JsonlTailerOptions {
  /** Directory to watch for .jsonl files */
  watchDir: string;
  /** Callback for each parsed JSONL line */
  onLine: (line: JsonlLine) => void;
  /** Callback for parse errors (malformed lines) */
  onError?: (error: Error, rawLine: string, filePath: string) => void;
  /** Maximum single line size in bytes before truncation (default: 1MB) */
  maxLineSizeBytes?: number;
  /** Polling interval fallback in ms if fs.watch is unreliable (default: 1000) */
  pollIntervalMs?: number;
  /** File glob pattern to match (default: "*.jsonl") */
  filePattern?: string;
}

export class JsonlTailer {
  private filePositions = new Map<string, number>();
  private watchers = new Map<string, fs.FSWatcher>();
  private dirWatcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: JsonlTailerOptions);

  /** Start watching the directory and tailing existing files. */
  async start(): Promise<void>;

  /** Stop all watchers and clean up. */
  async stop(): Promise<void>;

  /** Read new lines from a single file starting at the tracked position. */
  private async tailFile(filePath: string): Promise<void>;

  /** Handle a new file appearing in the watched directory. */
  private async handleNewFile(filePath: string): Promise<void>;

  /** Handle file truncation (position > file size). */
  private handleTruncation(filePath: string, currentSize: number): void;

  /** Parse a single line, handling truncation for oversized lines. */
  private parseLine(line: string, filePath: string, lineNumber: number, byteOffset: number): JsonlLine | null;
}
```

**Tailing Algorithm**

1. On `start()`, scan `watchDir` for existing `.jsonl` files. For each file, set position to current file size (only tail new content).
2. Set up `fs.watch()` on `watchDir` for new file notifications.
3. Set up `fs.watch()` on each `.jsonl` file for change notifications.
4. On file change: open file, `read()` from tracked position to EOF, split into lines, parse each as JSON.
5. Update tracked position after successful read.
6. If a new `.jsonl` file appears, start tailing from position 0.
7. Polling fallback: if `fs.watch` is unreliable (e.g., NFS), poll every `pollIntervalMs`.

**Truncation Handling**

- If `stat.size < trackedPosition`, file was truncated or rotated.
- Reset position to 0 and re-tail from the beginning.
- Log a warning via `onError`.

**Line Size Guard**

- If a single line exceeds `maxLineSizeBytes` (default 1MB), truncate the data and set a `_truncated: true` flag on the parsed object.
- Emit via `onError` with a descriptive message.

**Acceptance Criteria**

- [ ] Detects new `.jsonl` files created in the watch directory.
- [ ] Tails new lines appended to existing files.
- [ ] Correctly parses valid JSON lines.
- [ ] Calls `onError` for malformed JSON lines without crashing.
- [ ] Handles file truncation by resetting read position.
- [ ] Truncates lines exceeding 1MB and sets `_truncated` flag.
- [ ] `stop()` cleans up all watchers and timers.
- [ ] Works with rapid append (multiple lines written at once).
- [ ] Polling fallback works when `fs.watch` callback is not invoked.
- [ ] 8+ unit tests using real temp files.

**Edge Cases**

- Empty line in JSONL file (blank line between records): skip without error.
- Partial line at EOF (write in progress): do not emit, wait for complete line (newline terminated).
- Directory does not exist on `start()`: create it and watch.
- File deleted while being tailed: remove from tracking, no error.
- Two files created simultaneously: both picked up by directory watcher.

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 4: Codex Provider (JSONL + Process Management)

**Description**

Replace the stub `CodexProvider` with a full implementation that manages Codex processes and consumes their JSONL output. The provider can spawn new Codex instances, detect/attach to existing ones, watch session files via the JSONL tailer (Task 3), and map events to unified types using the existing `CodexIntegration.parseJsonlLine()` method.

**Prerequisites/Inputs**

- Task 3 (JSONL file tailer)
- `CodexIntegration` from `packages/daemon/src/hooks/integrations/codex.ts` (JSONL parsing + event normalization)
- `AgentProvider` interface from `agent-manager.ts`
- `child_process.spawn` for process management

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/daemon/src/agents/providers/codex-provider.ts` | Full `CodexProvider` implementation (replaces stub) |
| `packages/daemon/src/agents/providers/codex-event-mapper.ts` | Maps parsed JSONL to unified `EventEnvelope` via `CodexIntegration` |
| `packages/daemon/src/agents/providers/__tests__/codex-provider.test.ts` | Unit tests with mock JSONL files |
| `packages/daemon/src/agents/providers/__tests__/codex-event-mapper.test.ts` | Event mapping tests |

**Key Implementation**

```typescript
// codex-provider.ts

import { ChildProcess, spawn } from "node:child_process";
import { JsonlTailer } from "./jsonl-tailer.js";
import { CodexIntegration } from "../../hooks/integrations/codex.ts";
import type { AgentProvider, ProviderInfo, ModelInfo, CreateSessionOptions, ManagedSession } from "../agent-manager.js";
import type { EventEnvelope } from "../../event-bus/event-bus.js";

export interface CodexProviderOptions {
  /** Session directory (default: ~/.codex/sessions/) */
  sessionDir?: string;
  /** Path to codex binary (default: "codex") */
  binaryPath?: string;
  /** Maximum line size before truncation (default: 1MB) */
  maxLineSizeBytes?: number;
  /** Event callback for unified events */
  onEvent?: (event: EventEnvelope) => void;
}

interface CodexProcess {
  process: ChildProcess;
  sessionId: string;
  sessionFile: string;
  pid: number;
}

export class CodexProvider implements AgentProvider {
  readonly providerId = "codex";

  private tailer: JsonlTailer | null = null;
  private processes = new Map<string, CodexProcess>();
  private integration = new CodexIntegration();

  constructor(private readonly options: CodexProviderOptions = {}) {}

  // --- Provider Interface ---

  async getInfo(): Promise<ProviderInfo>;
  async listModels(): Promise<ModelInfo[]>;
  async healthCheck(): Promise<{ healthy: boolean; message: string }>;
  async createSession(options: CreateSessionOptions): Promise<ManagedSession>;
  async resumeSession(sessionId: string): Promise<ManagedSession>;

  // --- Codex-Specific ---

  /** Spawn a new codex process with JSONL output. */
  async spawnProcess(sessionId: string, options: CreateSessionOptions): Promise<CodexProcess>;

  /** Detect running codex processes and match to session files. */
  async detectProcesses(): Promise<CodexProcess[]>;

  /** Attach to an existing codex process's session file. */
  async attachToProcess(pid: number, sessionFile: string): Promise<string>;

  /** Start the JSONL tailer for the session directory. */
  async startTailer(): Promise<void>;

  /** Stop the JSONL tailer. */
  async stopTailer(): Promise<void>;

  /** Send interrupt signal to a codex process. */
  async interruptProcess(sessionId: string): Promise<void>;

  /** Kill a codex process (SIGINT then SIGTERM after 5s). */
  async killProcess(sessionId: string): Promise<void>;

  /** Handle a parsed JSONL line from the tailer. */
  private handleJsonlLine(data: Record<string, unknown>, filePath: string): void;

  /** Handle codex process exit. */
  private handleProcessExit(sessionId: string, exitCode: number | null): void;

  /** Clean up resources for all managed processes. */
  async shutdown(): Promise<void>;
}
```

**Process Management**

- `spawnProcess()`: runs `codex --session-dir <dir> --jsonl`, captures PID, stores in `processes` map.
- `detectProcesses()`: scans process list (via `ps aux | grep codex` or `/proc` scanning) for running codex instances, matches to `.jsonl` files in session directory.
- `attachToProcess()`: given a PID and session file, starts tailing the file and tracking the process.
- `interruptProcess()`: sends `SIGINT` for graceful interruption of current operation.
- `killProcess()`: sends `SIGINT`, waits 5s, sends `SIGTERM` if still alive, waits 2s, sends `SIGKILL`.

**Event Flow**

1. JSONL tailer detects a new line in a session file.
2. `handleJsonlLine()` receives parsed JSON + file path.
3. Session ID is derived from file name (e.g., `abc123.jsonl` -> session `abc123`).
4. `CodexIntegration.parseJsonlLine(JSON.stringify(data), sessionId)` returns `EventEnvelope | null`.
5. Non-null envelopes are emitted to the `onEvent` callback.
6. Process exit triggers `handleProcessExit()` which emits `SessionEnded` via `CodexIntegration.emitSessionEnded()`.

**Session File Convention**

- New session: `~/.codex/sessions/{session-id}.jsonl`
- Each line is a JSON object with at minimum a `type` field.
- Session start: first line written when process starts (or file creation triggers `SessionStarted`).
- Session end: process exit detected via `child_process` event.

**Acceptance Criteria**

- [ ] Provider spawns `codex` process with correct flags.
- [ ] JSONL tailer picks up new lines from session files.
- [ ] All 8 Codex JSONL event types correctly mapped to unified events.
- [ ] `user_message` (role=user) maps to `UserPromptReceived`.
- [ ] Process exit emits `SessionEnded` with exit code.
- [ ] Process crash (non-zero exit) emits `SessionEnded` with error reason.
- [ ] `detectProcesses()` finds running codex instances.
- [ ] `attachToProcess()` starts tailing an existing session file.
- [ ] `interruptProcess()` sends SIGINT to the codex process.
- [ ] `killProcess()` escalates from SIGINT to SIGTERM to SIGKILL.
- [ ] Malformed JSONL lines are skipped with warning (not crash).
- [ ] Lines exceeding 1MB are truncated.
- [ ] 10+ unit tests with mock processes and temp JSONL files.

**Edge Cases**

- Codex binary not found: throw `ProviderNotInstalledError` with install hint `npm i -g @openai/codex`.
- Session file already exists when creating a new session: append, do not overwrite.
- Process exits while a JSONL line is partially written: tailer waits for newline.
- `detectProcesses()` on macOS vs Linux: use `ps` with platform-appropriate flags.
- Multiple codex processes writing to the same session dir: each gets its own file.

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 5: Provider Registry Wiring + AgentManager Extensions

**Description**

Wire the completed OpenCode and Codex providers into the daemon's provider registry and extend `AgentManager` with methods needed by the new providers: `sendPrompt()` for forwarding prompts to the correct provider, `streamEvents()` for subscribing to a session's unified event stream, and provider health aggregation. Update the daemon's bootstrap sequence to register all three providers at startup.

**Prerequisites/Inputs**

- Task 2 (OpenCode provider)
- Task 4 (Codex provider)
- Existing `AgentManager` from `agent-manager.ts`
- Existing `ClaudeCodeProvider` from `claude-code-provider.ts`

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/daemon/src/agents/agent-manager.ts` | Extend with `sendPrompt()`, `streamEvents()`, `getProviderHealth()` |
| `packages/daemon/src/agents/providers/index.ts` | New: provider registry constant + factory |
| `packages/daemon/src/agents/index.ts` | Update re-exports |
| `packages/daemon/src/agents/__tests__/agent-manager-providers.test.ts` | Integration tests for multi-provider AgentManager |

**Registry Constant**

```typescript
// providers/index.ts

import { ClaudeCodeProvider } from "./claude-code-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { CodexProvider } from "./codex-provider.js";
import type { AgentProvider } from "../agent-manager.js";

export const PROVIDER_FACTORIES: Record<string, () => AgentProvider> = {
  "claude-code": () => new ClaudeCodeProvider(),
  "opencode":    () => new OpenCodeProvider(),
  "codex":       () => new CodexProvider(),
} as const;

export type ProviderId = keyof typeof PROVIDER_FACTORIES;

/** Register all built-in providers with an AgentManager. */
export function registerBuiltinProviders(manager: AgentManager): void {
  for (const [id, factory] of Object.entries(PROVIDER_FACTORIES)) {
    try {
      manager.registerProvider(factory());
    } catch {
      // Already registered -- skip
    }
  }
}
```

**AgentManager Extensions**

```typescript
// New methods on AgentManager

/** Send a prompt to a session's provider. */
async sendPrompt(sessionId: string, prompt: string): Promise<void> {
  const session = this.getSession(sessionId);
  if (!session) throw new AgentNotFoundError(sessionId);
  const provider = this.getProvider(session.providerId);
  if (!provider) throw new ProviderNotRegisteredError(session.providerId);

  const sm = this.getStateMachine(sessionId);
  if (sm) sm.transition("running", "Prompt sent");

  // Provider-specific dispatch
  if ("sendPrompt" in provider && typeof provider.sendPrompt === "function") {
    await provider.sendPrompt(sessionId, prompt);
  }
}

/** Subscribe to unified event stream for a session. */
streamEvents(sessionId: string, callback: (event: EventEnvelope) => void): () => void {
  const session = this.getSession(sessionId);
  if (!session) throw new AgentNotFoundError(sessionId);
  const provider = this.getProvider(session.providerId);

  if ("subscribeEvents" in provider && typeof provider.subscribeEvents === "function") {
    provider.subscribeEvents(sessionId, callback);
    return () => {
      if ("unsubscribeEvents" in provider && typeof provider.unsubscribeEvents === "function") {
        provider.unsubscribeEvents(sessionId);
      }
    };
  }
  return () => {};
}

/** Get aggregated health status for all providers. */
async getProviderHealth(): Promise<Map<string, { healthy: boolean; message: string }>> {
  const results = new Map();
  for (const [id, provider] of this.providers) {
    const health = await provider.healthCheck();
    results.set(id, health);
  }
  return results;
}
```

**Acceptance Criteria**

- [ ] `PROVIDER_FACTORIES` contains all 3 providers.
- [ ] `registerBuiltinProviders()` registers all providers without error.
- [ ] `sendPrompt()` dispatches to correct provider and transitions state to `running`.
- [ ] `sendPrompt()` throws `AgentNotFoundError` for unknown session.
- [ ] `streamEvents()` subscribes to provider-specific event stream.
- [ ] `streamEvents()` returns unsubscribe function that cleans up.
- [ ] `getProviderHealth()` returns health for all registered providers.
- [ ] Agent creation with `provider: "opencode"` uses `OpenCodeProvider`.
- [ ] Agent creation with `provider: "codex"` uses `CodexProvider`.
- [ ] Agent creation with invalid provider returns `ProviderNotRegisteredError`.
- [ ] 6+ tests covering registry, dispatch, and health aggregation.

**Edge Cases**

- Provider that does not implement `sendPrompt` (e.g., future read-only provider): no-op, no error.
- Calling `sendPrompt` on a session in `error` state: state machine throws `InvalidStateTransitionError`.
- Registering the same provider twice: idempotent (skip, no error).

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 6: Health Check System

**Description**

Implement a comprehensive health check system that aggregates checks from both the provider layer (`AgentProvider.healthCheck()`) and the hook integration layer (`HookIntegration.healthCheck()`). Each provider reports: binary availability, hook installation status, and runtime connectivity. The health system is consumed by the `saqr doctor` CLI command (Task 7) and the dashboard API.

**Prerequisites/Inputs**

- Task 2 (OpenCode provider with real `healthCheck()`)
- Task 4 (Codex provider with real `healthCheck()`)
- Existing `OpenCodeIntegration.healthCheck()` and `CodexIntegration.healthCheck()`
- `which` / `execFile` for binary detection

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/daemon/src/agents/health-checker.ts` | `HealthChecker` class: aggregates provider + hook health |
| `packages/daemon/src/agents/__tests__/health-checker.test.ts` | Unit tests with mock providers |

**Key Interfaces**

```typescript
// health-checker.ts

export interface ProviderHealthReport {
  providerId: string;
  providerName: string;
  binaryInstalled: boolean;
  binaryPath: string | null;
  binaryVersion: string | null;
  hooksInstalled: boolean;
  hookDetails: HealthCheck[];
  runtimeHealthy: boolean;
  runtimeMessage: string;
  overall: "healthy" | "degraded" | "unavailable";
}

export interface SystemHealthReport {
  timestamp: string;
  providers: ProviderHealthReport[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unavailable: number;
  };
}

export class HealthChecker {
  constructor(
    private readonly agentManager: AgentManager,
    private readonly hookIntegrations: Map<string, HookIntegration>,
  );

  /** Run health checks for all registered providers. */
  async checkAll(): Promise<SystemHealthReport>;

  /** Run health check for a single provider. */
  async checkProvider(providerId: string): Promise<ProviderHealthReport>;

  /** Detect binary path and version for a provider. */
  private async detectBinary(command: string): Promise<{ path: string; version: string } | null>;
}
```

**Provider-Specific Checks**

| Provider | Binary Check | Hook Check | Runtime Check |
|----------|-------------|------------|---------------|
| Claude Code | `which claude` | `~/.claude/settings.json` has hooks | N/A (SDK-based) |
| OpenCode | `which opencode` | `.opencode/plugins/saqr/plugin.json` exists + valid | `GET /health` returns 200 |
| Codex | `which codex` | `~/.agentctx/integrations/codex/watcher.json` exists + enabled | Session directory writable |

**Health Status Logic**

- `healthy`: binary installed + hooks installed + runtime check passes.
- `degraded`: binary installed but hooks missing OR runtime check fails.
- `unavailable`: binary not installed.

**Acceptance Criteria**

- [ ] `checkAll()` returns `SystemHealthReport` with all registered providers.
- [ ] Binary detection works for all three providers.
- [ ] Hook installation status correctly detected per provider.
- [ ] Runtime connectivity check (OpenCode `GET /health`) succeeds when server is running.
- [ ] `overall` status correctly computed from component checks.
- [ ] `summary` counts match individual provider statuses.
- [ ] Handles binary not on PATH gracefully (unavailable, no crash).
- [ ] Handles hook files missing gracefully (degraded, no crash).
- [ ] 6+ unit tests with mock providers and file system.

**Edge Cases**

- Binary on PATH but wrong version (e.g., `opencode` returns non-zero on `--version`): mark binary as installed but note version issue.
- Health check timeout: individual provider check capped at 5s, does not block others.
- Provider registered but binary removed between checks: status transitions to unavailable.

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 7: CLI Commands (install, doctor, providers)

**Description**

Implement three CLI commands for provider management: `saqr install --opencode/--codex` for hook installation, `saqr doctor` for health diagnostics, and `saqr providers` for listing available providers with their installation status. These commands are thin wrappers around the health checker (Task 6), hook integrations (existing), and provider registry (Task 5).

**Prerequisites/Inputs**

- Task 5 (provider registry with `registerBuiltinProviders`)
- Task 6 (health checker with `checkAll()`)
- Existing `OpenCodeIntegration.install()` and `CodexIntegration.install()` from hooks module
- CLI framework from `packages/cli/`

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/cli/src/commands/install.ts` | `saqr install --opencode / --codex / --claude-code` command |
| `packages/cli/src/commands/doctor.ts` | `saqr doctor` command |
| `packages/cli/src/commands/providers.ts` | `saqr providers` command |
| `packages/cli/src/commands/__tests__/install.test.ts` | Tests for install command |
| `packages/cli/src/commands/__tests__/doctor.test.ts` | Tests for doctor command |
| `packages/cli/src/commands/__tests__/providers.test.ts` | Tests for providers command |

**Command: `saqr install`**

```
Usage: saqr install [--opencode] [--codex] [--claude-code] [--force] [--base-dir <path>]

Options:
  --opencode     Install OpenCode plugin hooks
  --codex        Install Codex session watcher hooks
  --claude-code  Install Claude Code hooks (existing)
  --force        Overwrite existing hook configuration
  --base-dir     Base directory for hook installation (default: $HOME)

Output:
  ✓ OpenCode plugin installed (9 event subscriptions)
    Modified: ~/.opencode/plugins/agentctx/plugin.json
    Modified: ~/.opencode/plugins/agentctx/index.ts
    Modified: ~/.opencode/plugins/agentctx/event-handler.ts
```

**Command: `saqr doctor`**

```
Usage: saqr doctor [--json] [--provider <id>]

Options:
  --json         Output as JSON instead of formatted table
  --provider     Check a specific provider only

Output:
  Saqr Provider Health Check
  ──────────────────────────

  claude-code  Claude Code (Anthropic)
    ✓ Binary:   /usr/local/bin/claude (v1.2.3)
    ✓ Hooks:    ~/.claude/settings.json configured
    • Runtime:  N/A (SDK-based)
    Status: healthy

  opencode     OpenCode (open-source)
    ✓ Binary:   /usr/local/bin/opencode (v0.5.1)
    ✓ Hooks:    ~/.opencode/plugins/agentctx/ installed
    ✗ Runtime:  opencode serve not running
    Status: degraded

  codex        Codex CLI (OpenAI)
    ✗ Binary:   not found (install: npm i -g @openai/codex)
    ✗ Hooks:    not configured
    • Runtime:  N/A
    Status: unavailable

  Summary: 1 healthy, 1 degraded, 1 unavailable
```

**Command: `saqr providers`**

```
Usage: saqr providers [--json]

Output:
  Available Providers
  ───────────────────

  ID            Name                    Status        Models
  claude-code   Claude Code (Anthropic) ✓ installed   claude-opus-4-6, claude-sonnet-4-5, claude-haiku-3-5
  opencode      OpenCode (open-source)  ✓ installed   gpt-4.1, claude-sonnet-4-6
  codex         Codex CLI (OpenAI)      ✗ not found   o4-mini, codex-mini
```

**Acceptance Criteria**

- [ ] `saqr install --opencode` creates plugin directory with all required files.
- [ ] `saqr install --codex` creates watcher configuration.
- [ ] `saqr install --force` overwrites existing configuration.
- [ ] `saqr doctor` shows health status for all providers.
- [ ] `saqr doctor --json` outputs machine-readable JSON.
- [ ] `saqr doctor --provider opencode` checks only OpenCode.
- [ ] `saqr providers` lists all registered providers with models.
- [ ] `saqr providers --json` outputs machine-readable JSON.
- [ ] All commands handle errors gracefully (missing binary, permissions, etc.).
- [ ] 6+ tests covering command output and error paths.

**Edge Cases**

- `saqr install --opencode --codex`: install both in one invocation.
- `saqr install` with no flags: error with usage message.
- `saqr doctor` when daemon is not running: still checks binary + hooks, skips runtime.
- Provider binary exists but is not executable: report as degraded with permission warning.

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 8: Integration Tests (30+)

**Description**

Comprehensive integration test suite that exercises both providers end-to-end with mock servers and files. Tests cover the full event flow from raw provider output (SSE events / JSONL lines) through normalization to unified `EventEnvelope` emission, as well as process lifecycle, error recovery, and CLI commands.

**Prerequisites/Inputs**

- All previous tasks (1-7) completed
- Test infrastructure: `vitest`, temp directories, mock HTTP servers
- Existing test patterns from daemon package

**Implementation Details**

| File | Purpose |
|------|---------|
| `packages/daemon/src/agents/providers/__tests__/opencode-integration.test.ts` | OpenCode end-to-end tests |
| `packages/daemon/src/agents/providers/__tests__/codex-integration.test.ts` | Codex end-to-end tests |
| `packages/daemon/src/agents/__tests__/provider-registry-integration.test.ts` | Multi-provider registry tests |
| `packages/daemon/src/agents/__tests__/health-checker-integration.test.ts` | Health check integration tests |
| `packages/cli/src/commands/__tests__/provider-commands-integration.test.ts` | CLI command integration tests |

**Test Cases (mapped to story TC numbers)**

**OpenCode Provider (TC22.1 - TC22.12)**

| # | Test Case | Type |
|---|-----------|------|
| TC22.1 | Spawn mock `opencode serve` and verify health check passes | Integration |
| TC22.2 | Create session via mock HTTP API and receive valid session ID | Integration |
| TC22.3 | Send prompt and receive SSE events through full pipeline | Integration |
| TC22.4 | Map `session.created` SSE event to `SessionStarted` with correct fields | Unit |
| TC22.5 | Map `tool.execute.before` to `ToolCallRequested` with tool name + input | Unit |
| TC22.6 | Map `tool.execute.after` (success) to `ToolCallCompleted` | Unit |
| TC22.7 | Map `tool.execute.after` (error) to `ToolCallFailed` | Unit |
| TC22.8 | Map `permission.asked` to `PermissionRequested` | Unit |
| TC22.9 | SSE reconnect after connection drop with exponential backoff | Integration |
| TC22.10 | OpenCode process crash triggers restart (up to 3 times, then error) | Integration |
| TC22.11 | Hook installer creates plugin directory with all required files | Integration |
| TC22.12 | Health check detects missing `opencode` binary | Unit |

**Codex Provider (TC22.13 - TC22.22)**

| # | Test Case | Type |
|---|-----------|------|
| TC22.13 | Watch session directory for new JSONL files | Integration |
| TC22.14 | Parse JSONL line and emit unified event | Unit |
| TC22.15 | Map `tool_use` to `ToolCallRequested` | Unit |
| TC22.16 | Map `tool_result` to `ToolCallCompleted` | Unit |
| TC22.17 | Map `tool_error` to `ToolCallFailed` | Unit |
| TC22.18 | Handle malformed JSONL line gracefully (skip + warn, no crash) | Unit |
| TC22.19 | Detect process exit and emit `SessionEnded` | Integration |
| TC22.20 | Process crash (non-zero exit) emits `SessionEnded` with error | Integration |
| TC22.21 | Large JSONL output (>1MB line) truncated with warning | Unit |
| TC22.22 | Hook installer sets up session directory and watcher config | Integration |

**Provider Registry (TC22.23 - TC22.26)**

| # | Test Case | Type |
|---|-----------|------|
| TC22.23 | Registry lists all 3 providers with correct info | Unit |
| TC22.24 | Agent creation with `provider: "opencode"` uses OpenCodeProvider | Integration |
| TC22.25 | Agent creation with `provider: "codex"` uses CodexProvider | Integration |
| TC22.26 | Agent creation with invalid provider returns `ProviderNotRegisteredError` | Unit |

**CLI Commands (TC22.27 - TC22.30)**

| # | Test Case | Type |
|---|-----------|------|
| TC22.27 | `saqr install --opencode` creates plugin directory and files | Integration |
| TC22.28 | `saqr install --codex` verifies codex binary exists or warns | Integration |
| TC22.29 | `saqr doctor` reports correct status per provider | Integration |
| TC22.30 | `saqr providers` lists all providers with install status and models | Integration |

**Additional Edge-Case Tests**

| # | Test Case | Type |
|---|-----------|------|
| TC22.31 | SSE parser handles multi-line `data:` fields correctly | Unit |
| TC22.32 | SSE parser ignores comment lines (`:` prefix) | Unit |
| TC22.33 | HTTP client retries on 503 but not on 400 | Unit |
| TC22.34 | JSONL tailer handles file truncation/rotation | Integration |
| TC22.35 | Concurrent sessions on different providers emit independent events | Integration |

**Mock Server Setup**

```typescript
// test-helpers/mock-opencode-server.ts

import { createServer, type Server } from "node:http";

export function createMockOpenCodeServer(port: number): {
  server: Server;
  sessions: Map<string, unknown>;
  sseClients: Map<string, Set<ServerResponse>>;
  emitSSE: (sessionId: string, event: string, data: unknown) => void;
} {
  // GET  /health -> { status: "ok" }
  // POST /sessions -> create session, return { id, model, project }
  // POST /sessions/:id/messages -> accept prompt, return 200
  // GET  /sessions/:id/events -> SSE stream
  // POST /sessions/:id/cancel -> return { ok: true }
}
```

**Acceptance Criteria**

- [ ] 30+ tests passing (TC22.1 through TC22.30 minimum, plus edge cases).
- [ ] All 12 unified event types tested for both OpenCode and Codex mappings.
- [ ] Integration tests use real HTTP servers (not fetch mocks) for OpenCode.
- [ ] Integration tests use real temp files (not fs mocks) for Codex JSONL.
- [ ] Process lifecycle tests verify state machine transitions.
- [ ] Error recovery tests verify exponential backoff behavior.
- [ ] CLI command tests verify formatted output.
- [ ] No test relies on external `opencode` or `codex` binaries being installed.
- [ ] Tests clean up all temp files, servers, and child processes.
- [ ] Total test runtime under 30 seconds (use `vi.useFakeTimers()` for backoff tests).

**Estimated Effort**: L (Large) -- 12-16 hours

---

## Summary

| Task | Description | Lane | Dependencies | Size | Est. Hours |
|------|------------|------|-------------|------|-----------|
| 1 | SSE Parser + HTTP Client Utilities | A | None | M | 6-8 |
| 2 | OpenCode Provider (HTTP API + SSE) | A | Task 1 | L | 10-14 |
| 3 | JSONL File Tailer | B | None | M | 6-8 |
| 4 | Codex Provider (JSONL + Process Mgmt) | B | Task 3 | L | 10-14 |
| 5 | Provider Registry Wiring + AgentManager | A+B | Tasks 2, 4 | M | 4-6 |
| 6 | Health Check System | B | Tasks 2, 4 | M | 4-6 |
| 7 | CLI Commands (install, doctor, providers) | A | Tasks 5, 6 | M | 6-8 |
| 8 | Integration Tests (30+) | A+B | All | L | 12-16 |
| **Total** | | | | | **58-80** |

**Critical Path**: Task 1 -> Task 2 -> Task 5 -> Task 7 -> Task 8 (Lane A, longest path ~38-46 hours).

**Parallel Opportunity**: Tasks 1+3 can start simultaneously. Tasks 2+4 can proceed in parallel after their respective prerequisites. Tasks 6+7 can overlap since 6 does not depend on 7.
