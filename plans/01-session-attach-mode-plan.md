# Implementation Plan: Story 01 -- Session Attach Mode

**Date**: 2026-02-22
**Story**: 07-session-attach-mode
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (60-80 hours)
**Prerequisites**: Story 00 (Installation), Story 01 (Event Capture), Story 02 (Hook Integration), Story 03 (Storage Layer) must be implemented. Daemon infrastructure (HTTP/WS server, process management) from the AgentContext platform must be scaffolded.
**Product Spec**: F12: Session Attach Mode (Hybrid). See `docs/PRODUCT-SPEC.md`.

### Relationship to Other Stories

This is the **daemon-side session management story**. It is the most complex story in the AgentContext product, spanning filesystem watching, process correlation, PTY management, WebSocket streaming, terminal I/O forwarding, and state machine transitions. It depends on and integrates with:

- **Story 01** (Event Capture): GC hook events written to `~/.claude-context/events/` are the primary input for session auto-detection and observed timelines.
- **Story 02** (Hook Integration): `gc-hook` is extended to read status files and output session state indicators to stderr.
- **Story 03** (Storage Layer): Event store directory structure (`events/{project-id}/{session-id}/`) is the filesystem tree being watched.
- **Story 06** (Plugin Packaging): `agentctx` CLI commands (`agent start`, `agent attach`, `agent release`, `agent list`) are added as subcommands.
- **Story 07** (Mobile/Desktop Rendering): Consumes the WebSocket/SSE timeline events and PTY streams produced here (out of scope for this plan).
- **F3** (Agent Process Orchestration): `spawnManagedSession` uses the Claude SDK's `resume` capability (interface defined here, SDK integration is F3).
- **F5** (Encrypted Sync): Cross-machine session attachment requires sync (out of scope, but interfaces are forward-compatible).
- **F10** (Relay): Remote PTY access via E2EE relay (interface defined here, relay is F10).

### Key Technical Dependencies

| Dependency | Purpose | Version |
|------------|---------|---------|
| `chokidar` | Filesystem watching (inotify/FSEvents) | ^4.x |
| `node-pty` | PTY spawning for managed sessions | ^1.x |
| `@xterm/headless` | Server-side terminal emulation | ^5.x |
| `ws` | WebSocket server | ^8.x |
| Node.js built-ins | `crypto`, `fs/promises`, `path`, `os`, `child_process`, `net` | 18+ |

---

## Task Dependency Graph

```
Task 1: SessionWatcher (filesystem watcher)
  |
  +---> Task 2: Process Correlator
  |       |
  |       +---> Task 3: Session Registry & State Machine
  |               |
  |               +---> Task 4: Event Normalizer & Timeline Streaming (needs 1, 3)
  |               |       |
  |               |       +---> Task 11: Integration Tests (needs all)
  |               |
  |               +---> Task 5: Session Takeover Flow (needs 2, 3)
  |               |       |
  |               |       +---> Task 6: Managed Session PTY Proxy (needs 5)
  |               |       |       |
  |               |       |       +---> Task 7: Ring Buffer (needs 6)
  |               |       |       |       |
  |               |       |       |       +---> Task 8: Terminal Client Attachment (needs 6, 7)
  |               |       |       |               |
  |               |       |       |               +---> Task 9: Detach/Reattach Lifecycle (needs 8)
  |               |       |       |
  |               |       |       +---> Task 10: Conflict Prevention / Single-Writer (needs 6)
  |               |       |
  |               |       +---> Task 13: Resume Handback (needs 5, 6)
  |               |
  |               +---> Task 12: Session State Indicator (needs 3, gc-hook from Story 02)
  |
  +---> Task 14: Auto-Detect Running Sessions on Startup (needs 1, 2, 3)
  |
  +---> Task 15: Security & Authentication (needs 3, 6)
  |
  +---> Task 16: Daemon Crash Recovery (needs 3, 6)
```

---

## Tasks

### Task 1: SessionWatcher (Filesystem Watcher)

**Description**

Implement a recursive filesystem watcher over `~/.claude-context/events/` using `chokidar`. The watcher detects new `.json` event files and new session directories, emitting structured events for the rest of the daemon to consume. On Linux, check inotify watch limits on startup and warn if below 16384.

**Prerequisites / Inputs**

- `~/.claude-context/events/` directory structure from Story 03.
- `chokidar` npm dependency.
- The events directory may not exist at daemon startup (must handle gracefully).

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/watchers/session-watcher.ts` | Create | `SessionWatcher` class |
| `src/daemon/watchers/inotify-check.ts` | Create | Linux inotify limit check utility |
| `tests/daemon/watchers/session-watcher.test.ts` | Create | Unit tests |

**Class: `SessionWatcher`**

```typescript
// src/daemon/watchers/session-watcher.ts
import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';

interface WatcherConfig {
  eventsDir: string;          // ~/.claude-context/events/
  debounceMs: number;         // 50ms
  ignorePatterns: string[];   // ['.lock', '.tmp']
}

interface ParsedEventPath {
  projectId: string;
  sessionId: string;
  sequence: number;
  filePath: string;
}

class SessionWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private config: WatcherConfig;
  private started: boolean = false;

  constructor(config: WatcherConfig);
  async start(): Promise<void>;
  stop(): Promise<void>;
  private onFileCreated(filePath: string): Promise<void>;
  private onDirCreated(dirPath: string): void;
  private onWatcherError(error: Error): void;
  parseEventPath(filePath: string): ParsedEventPath | null;
  async readEventFile(filePath: string): Promise<GCEvent | null>;
}
```

Key behaviors:
- `chokidar.watch()` with `ignoreInitial: true`, `depth: 3`, `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }`.
- Ignore patterns: `/(^|[\/\\])\../`, `/\.lock$/`, `/\.tmp$/`.
- Emit `'file:created'` with `ParsedEventPath` and parsed `GCEvent` on new `.json` files.
- Emit `'dir:created'` with `{ projectId, sessionId }` on new directories matching the expected depth.
- If the events directory does not exist at startup, watch the parent directory and wait for it to be created, then start the recursive watch.
- On watcher error, log and attempt restart with exponential backoff (1s, 2s, 4s, max 30s).

**inotify-check.ts:**

```typescript
async function checkInotifyLimit(): Promise<{ limit: number; sufficient: boolean }>;
```

Reads `/proc/sys/fs/inotify/max_user_watches` on Linux, returns `{ limit, sufficient: limit >= 16384 }`. No-op on macOS. Logs a warning with the `echo 65536 | sudo tee ...` suggestion if insufficient.

**Acceptance Criteria**

- [ ] Watcher detects new `.json` files in `events/{project-id}/{session-id}/` and emits `file:created` events
- [ ] Watcher detects new session directories and emits `dir:created` events
- [ ] `.lock` and `.tmp` files are ignored
- [ ] Hidden files (dotfiles) are ignored
- [ ] `awaitWriteFinish` prevents reading partial writes (100ms stability threshold)
- [ ] Watcher handles the events directory not existing at startup (waits for creation)
- [ ] Watcher recovers from errors with exponential backoff restart
- [ ] `parseEventPath` correctly extracts projectId, sessionId, and sequence from valid paths
- [ ] `parseEventPath` returns null for invalid paths (wrong depth, non-numeric filename, wrong extension)
- [ ] On Linux, inotify watch limit is checked on startup; warning logged if below 16384
- [ ] On macOS, inotify check is a no-op (FSEvents does not use inotify)
- [ ] Watcher emits an `error` event when chokidar reports an error
- [ ] Watcher `stop()` cleanly closes the chokidar instance

**Edge Cases**

- Events directory does not exist at daemon startup (the user has not run any claude sessions yet).
- Rapid file creation (many events in a burst) -- debouncing must not lose events.
- inotify watch limit exhaustion on Linux (many projects/sessions) -- graceful degradation.
- File created but immediately deleted before read (race condition) -- `readEventFile` returns null.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 2: Process Correlator

**Description**

Implement the process correlation engine that matches GC `SessionStarted` events to running `claude` OS processes. The correlator scans `/proc` (Linux) or `ps` (macOS) for `claude` processes, then matches them to sessions by working directory (project ID derivation) and process start time proximity.

**Prerequisites / Inputs**

- Story 03: `deriveProjectId(cwd)` function for computing project IDs from working directories.
- Running `claude` processes on the system.
- `SessionStarted` event data with `timestamp` and `cwd` fields.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/correlator/process-finder.ts` | Create | `findClaudeProcesses()` -- OS process discovery |
| `src/daemon/correlator/session-correlator.ts` | Create | `correlateSessionToProcess()` -- matching logic |
| `tests/daemon/correlator/process-finder.test.ts` | Create | Unit tests with mocked `/proc` |
| `tests/daemon/correlator/session-correlator.test.ts` | Create | Unit tests for correlation algorithm |

**Interface: `ProcessInfo`**

```typescript
interface ProcessInfo {
  pid: number;
  command: string;   // Full command line
  cwd: string;       // Working directory
  startTime: Date;   // Process start time
  ppid: number;      // Parent PID
  uid: number;       // Owner user ID
}
```

**Function: `findClaudeProcesses()`**

- Linux: Read `/proc/{pid}/cmdline`, `/proc/{pid}/stat`, `/proc/{pid}/cwd` (symlink), `/proc/{pid}/status` (for UID).
- macOS: Parse `ps -eo pid,ppid,lstart,uid,command`.
- Filter: only processes where `command` contains `claude` (and not `agentctx` or `gc-hook` to avoid matching ourselves).
- Filter: only processes owned by current user (`uid === process.getuid()`).

**Function: `correlateSessionToProcess(projectId, sessionId, event)`**

Algorithm:
1. Filter processes by matching `deriveProjectId(cwd) === projectId`.
2. If exactly 1 candidate: return it.
3. If multiple candidates: sort by `|process.startTime - event.timestamp|`, select closest if within 30 seconds.
4. If multiple candidates have start times within 5 seconds of each other (ambiguous): return null and log warning.
5. If 0 candidates: return null.

**Acceptance Criteria**

- [ ] `findClaudeProcesses()` returns process info for all running `claude` processes on Linux via `/proc`
- [ ] `findClaudeProcesses()` returns process info for all running `claude` processes on macOS via `ps`
- [ ] Processes owned by different users are filtered out
- [ ] `correlateSessionToProcess()` matches by project ID (derived from cwd) first
- [ ] When exactly one process matches, it is returned regardless of time proximity
- [ ] When multiple processes match, the closest by start time (within 30s) is selected
- [ ] When multiple processes have start times within 5s of each other, null is returned (ambiguous)
- [ ] When no processes match, null is returned
- [ ] Process discovery handles `/proc` entries disappearing mid-scan (process exited)
- [ ] The correlator does not match `agentctx`, `gc-hook`, or `capture-event` processes

**Edge Cases**

- Multiple `claude` processes in the same project directory (E-4 from story).
- Process exits between finding it and reading its details.
- `claude` running inside a container (not visible in host `/proc`).
- Node.js processes with `claude` in a different argument position.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 3: Session Registry & State Machine

**Description**

Implement the central session registry that tracks all known sessions (Observed, Managed, Resumed) and manages state transitions between modes. This is the coordination hub that the watcher, correlator, takeover engine, and client connection manager all interact with.

**Prerequisites / Inputs**

- Task 1 (SessionWatcher) emits file and directory events.
- Task 2 (Process Correlator) provides PID correlation.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/sessions/session-registry.ts` | Create | `SessionRegistry` class |
| `src/daemon/sessions/types.ts` | Create | Session type definitions |
| `tests/daemon/sessions/session-registry.test.ts` | Create | State machine tests |

**Type: `SessionMode`**

```typescript
type SessionMode = 'observed' | 'managed' | 'resumed' | 'transitioning' | 'closed';
```

**State Machine Transitions:**

```
                     takeover_started
observed ─────────────────────────────► transitioning
    │                                        │
    │ session_ended                          │ takeover_completed
    ▼                                        ▼
  closed                                  resumed (managed)
                                             │
                                             │ release / session_ended
                                             ▼
                                           closed
```

Valid transitions:
- `observed` -> `transitioning` (takeover initiated)
- `observed` -> `closed` (SessionEnded event received)
- `transitioning` -> `resumed` (takeover completed successfully)
- `transitioning` -> `observed` (takeover failed, rollback)
- `resumed` -> `closed` (session ended or released)
- `managed` -> `closed` (session ended or released)

**Interface: `TrackedSession`**

```typescript
interface TrackedSession {
  id: string;                      // Internal daemon session ID (UUID)
  gcSessionId: string;             // GC event store session ID
  projectId: string;               // GC project ID
  pid: number | null;              // OS process ID (null if not correlated)
  mode: SessionMode;
  startedAt: Date;
  lastEventAt: Date;
  eventCount: number;
  connectedClients: Map<string, ConnectedClient>;
  activeWriter: string | null;     // Client ID with input focus (managed/resumed only)
  metadata: {
    model?: string;
    source?: string;
    cwd?: string;
    recoveredFromCrash?: boolean;
  };
  managedState?: {                 // Only populated for managed/resumed sessions
    ptyProcess: pty.IPty;
    terminalParser: Terminal;
    ringBuffer: RingBuffer;
    ptyPid: number;
  };
}
```

**Class: `SessionRegistry`**

```typescript
class SessionRegistry extends EventEmitter {
  private sessions: Map<string, TrackedSession>;  // key = `${projectId}/${sessionId}`

  registerObservedSession(projectId: string, sessionId: string, event: GCEvent): Promise<TrackedSession>;
  registerManagedSession(config: ManagedSessionConfig): Promise<TrackedSession>;
  transitionTo(sessionKey: string, newMode: SessionMode): void;
  getSession(sessionKey: string): TrackedSession | undefined;
  getSessionById(daemonSessionId: string): TrackedSession | undefined;
  getSessionByPartialId(partialId: string): TrackedSession | undefined;  // first 8 chars match
  getAllSessions(): TrackedSession[];
  getSessionsByMode(mode: SessionMode): TrackedSession[];
  updateEventCount(sessionKey: string, event: GCEvent): void;
  removeSession(sessionKey: string): void;
}
```

Events emitted:
- `session:discovered` -- new observed session registered
- `session:takeover_started` -- takeover initiated
- `session:takeover_completed` -- takeover succeeded
- `session:takeover_failed` -- takeover aborted
- `session:mode_changed` -- any mode transition
- `session:ended` -- session closed
- `session:event_received` -- new GC event for a session

**Acceptance Criteria**

- [ ] `registerObservedSession()` creates a new session with mode `observed` and correlates PID
- [ ] `registerManagedSession()` creates a new session with mode `managed` and PTY state
- [ ] `transitionTo()` validates the transition is legal; throws on invalid transitions
- [ ] Invalid transitions (e.g., `closed` -> `observed`) are rejected with an error
- [ ] `getSessionByPartialId()` matches sessions by first 8 characters of the daemon session ID
- [ ] `getSessionByPartialId()` returns null if multiple sessions match the prefix (ambiguous)
- [ ] All state transitions emit the appropriate event
- [ ] `updateEventCount()` increments the event count and updates `lastEventAt`
- [ ] Concurrent access to the same session is serialized (no race conditions in state transitions)
- [ ] The registry handles registering a session that already exists (idempotent, returns existing)
- [ ] `removeSession()` cleans up all state including client connections

**Edge Cases**

- Two sessions with the same first 8 characters of their UUID (ambiguous partial match).
- Concurrent takeover attempts on the same session (must be serialized).
- Session registry grows unboundedly if sessions are never cleaned up (need a TTL for closed sessions).

**Estimated Effort**: L (Large) -- 4-6 hours

---

### Task 4: Event Normalizer & Timeline Streaming

**Description**

Implement the event normalization pipeline that converts raw GC hook events into `TimelineItem` format and streams them to subscribed WebSocket/SSE clients. This provides the "Observed session timeline" (F12.2) -- read-only real-time event streaming.

**Prerequisites / Inputs**

- Task 1 (SessionWatcher) detects new event files and parses them.
- Task 3 (SessionRegistry) tracks which sessions have subscribed clients.
- WebSocket server infrastructure (assumed to exist from daemon scaffolding).

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/timeline/event-normalizer.ts` | Create | `normalizeGCEvent()` and `extractNormalizedData()` |
| `src/daemon/timeline/timeline-streamer.ts` | Create | `TimelineStreamer` class -- manages subscriptions and broadcasts |
| `src/daemon/timeline/types.ts` | Create | `TimelineItem`, `TimelineItemType`, WS message types |
| `tests/daemon/timeline/event-normalizer.test.ts` | Create | Normalization tests for all 10 event types |
| `tests/daemon/timeline/timeline-streamer.test.ts` | Create | Subscription and broadcast tests |

**Type: `TimelineItem`**

```typescript
type TimelineItemType =
  | 'session_started'
  | 'user_prompt'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'tool_call_failed'
  | 'agent_spawned'
  | 'agent_completed'
  | 'turn_completed'
  | 'compaction_triggered'
  | 'session_ended';

interface TimelineItem {
  id: string;                    // event_id from envelope
  sessionId: string;             // daemon session ID
  gcSessionId: string;           // GC event store session ID
  type: TimelineItemType;
  timestamp: string;             // ISO 8601
  sequence: number;              // from envelope
  data: Record<string, unknown>; // normalized payload
}
```

**WebSocket Message Protocol:**

Server to client:
- `timeline_event` -- a new timeline item
- `session_update` -- session metadata changed (mode, client count, event count)
- `error` -- error message
- `heartbeat` -- connection health (every 30 seconds)

Client to server:
- `subscribe` -- subscribe to a session's timeline
- `unsubscribe` -- unsubscribe from a session's timeline

**Class: `TimelineStreamer`**

```typescript
class TimelineStreamer {
  private subscriptions: Map<string, Set<string>>;  // sessionKey -> Set<clientId>

  subscribe(clientId: string, sessionKey: string): void;
  unsubscribe(clientId: string, sessionKey: string): void;
  unsubscribeAll(clientId: string): void;
  broadcastTimelineEvent(sessionKey: string, item: TimelineItem): void;
  broadcastSessionUpdate(sessionKey: string, update: SessionUpdate): void;
  startHeartbeat(intervalMs: number): void;
  stopHeartbeat(): void;
}
```

**Event Ordering**: Events are ordered by `sequence` number (from the GC event envelope), not by watcher detection order. If an event with a higher sequence is received before a lower one (unlikely but possible with filesystem watcher batching), the streamer holds the higher-sequence event in a reorder buffer for up to 500ms.

**SSE Fallback**: For clients that cannot use WebSocket (e.g., simple HTTP clients), implement an SSE endpoint at `GET /api/sessions/:sessionId/events` that streams `TimelineItem` objects as `text/event-stream`.

**Acceptance Criteria**

- [ ] `normalizeGCEvent()` correctly converts all 10 GC event types to `TimelineItem` format
- [ ] `extractNormalizedData()` extracts the correct fields for each event type (prompt, toolName, etc.)
- [ ] Unknown event types are passed through with the raw data
- [ ] Clients subscribe to specific sessions and only receive events for subscribed sessions
- [ ] Multiple clients can subscribe to the same session simultaneously
- [ ] Heartbeat messages are sent every 30 seconds to all connected clients
- [ ] SSE fallback endpoint streams timeline events in `text/event-stream` format
- [ ] Events are ordered by sequence number before sending to clients
- [ ] End-to-end latency from event file creation to client receipt is under 200ms (target)
- [ ] `unsubscribeAll()` cleans up when a client disconnects
- [ ] Session updates (mode changes, client count changes) are broadcast to all subscribed clients

**Edge Cases**

- Client disconnects mid-stream (WebSocket close) -- subscription must be cleaned up.
- Burst of events (e.g., rapid tool calls) -- all must be delivered, in order.
- Event file is malformed JSON -- skip and log warning, do not crash.
- Client subscribes to a session that does not exist -- return error.

**Estimated Effort**: M (Medium) -- 4-5 hours

---

### Task 5: Session Takeover Flow

**Description**

Implement the session takeover state machine that transitions an Observed session to a Resumed/Managed session. The takeover flow sends SIGINT to the original `claude` process, waits for it to exit, reads the session state for resume, and spawns a new managed session.

**Prerequisites / Inputs**

- Task 2 (Process Correlator) provides the PID of the `claude` process.
- Task 3 (SessionRegistry) manages state transitions.
- The `~/.claude/projects/{project-dir-hash}/.session.json` file from Claude Code.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/takeover/takeover-engine.ts` | Create | `TakeoverEngine` class |
| `src/daemon/takeover/claude-session-reader.ts` | Create | Read Claude's `.session.json` files |
| `tests/daemon/takeover/takeover-engine.test.ts` | Create | Takeover flow tests |
| `tests/daemon/takeover/claude-session-reader.test.ts` | Create | Session file reader tests |

**Class: `TakeoverEngine`**

```typescript
class TakeoverEngine {
  constructor(
    private registry: SessionRegistry,
    private ptyManager: PtyManager,    // Task 6
    private config: TakeoverConfig,
  );

  async takeover(req: TakeoverRequest): Promise<TakeoverResult>;
  private async verifyClaudeProcess(pid: number): Promise<boolean>;
  private async waitForSessionEnd(session: TrackedSession, timeoutMs: number): Promise<boolean>;
  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
  private async readClaudeSessionState(session: TrackedSession): Promise<ClaudeSessionState | null>;
}

interface TakeoverRequest {
  sessionId: string;       // Daemon session ID
  requestedBy: string;     // Client ID
  timeout?: number;        // Max wait for graceful stop (default: 5000ms)
}

interface TakeoverResult {
  success: boolean;
  managedSessionId?: string;
  error?: string;
}

interface TakeoverConfig {
  sigintTimeoutMs: number;    // 5000
  sigtermTimeoutMs: number;   // 3000
  maxAttemptsPerMinute: number;  // 3
}
```

**Takeover Flow (detailed steps):**

1. Validate session exists and is in `observed` mode.
2. Validate session has a correlated PID.
3. Check takeover rate limit (max 3 per session per minute).
4. Verify PID is still a `claude` process (read `/proc/{pid}/cmdline` or `ps`).
5. Transition session to `transitioning` mode (prevents concurrent takeover attempts).
6. Send `SIGINT` to the process.
7. Wait up to 5 seconds for a `SessionEnded` event from the watcher.
8. If timeout: send `SIGTERM`, wait 3 more seconds for process exit.
9. If still running: abort takeover, revert to `observed` mode.
10. Read Claude session state from `~/.claude/projects/` for the `--resume` session ID.
11. Spawn a managed session with `resume: sessionId` (delegates to Task 6).
12. Transition session to `resumed` mode.
13. Emit `session:takeover_completed` event.

**Claude Session State Reader:**

```typescript
interface ClaudeSessionState {
  sessionId: string;
  cwd: string;
  model: string;
  lastUpdated: string;
}

async function readClaudeSessionState(
  session: TrackedSession
): Promise<ClaudeSessionState | null>;
```

Scans `~/.claude/projects/` for `.session.json` files, matches by session ID in the file content against `session.gcSessionId`.

**Acceptance Criteria**

- [ ] Takeover transitions an Observed session to Resumed/Managed
- [ ] SIGINT is sent to the correlated PID to gracefully stop the CLI session
- [ ] The daemon waits up to 5 seconds for a `SessionEnded` event after SIGINT
- [ ] If SIGINT times out, SIGTERM is sent with an additional 3-second timeout
- [ ] If both signals fail, the takeover is aborted and the session reverts to Observed
- [ ] Before sending signals, the daemon verifies the PID is still a `claude` process
- [ ] The session state file is read from `~/.claude/projects/` for resume
- [ ] Concurrent takeover attempts on the same session are blocked (transitioning state)
- [ ] Takeover cannot be initiated if the session PID is unknown (`pid: null`)
- [ ] All takeover transitions emit events for connected clients
- [ ] The takeover flow completes within 10 seconds (5s SIGINT + 3s SIGTERM + 2s spawn)
- [ ] Rate limiting: max 3 takeover attempts per session per minute
- [ ] SIGKILL is NOT used during takeover (would prevent session state save)

**Edge Cases**

- PID reuse: between detection and signal, the PID was reassigned to a different process (E-3).
- Claude session state file does not exist or is corrupted.
- Multiple `.session.json` files in `~/.claude/projects/` match the session ID.
- User manually runs `claude --resume` after takeover starts but before managed session spawns (E-5).
- Process is in an uninterruptible sleep state (SIGINT has no effect).

**Estimated Effort**: L (Large) -- 5-6 hours

---

### Task 6: Managed Session PTY Proxy

**Description**

Implement the PTY management layer that spawns `claude` inside a daemon-owned PTY using `node-pty`, wires up `@xterm/headless` for server-side terminal emulation, and broadcasts PTY output to all connected clients. This is the core of the "Managed session" mode (F12.4).

**Prerequisites / Inputs**

- Task 3 (SessionRegistry) for session state management.
- `node-pty` and `@xterm/headless` npm dependencies.
- Task 7 (Ring Buffer) for reconnection replay (can be developed in parallel).

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/pty/pty-manager.ts` | Create | `PtyManager` class -- spawns and manages PTY sessions |
| `src/daemon/pty/screen-snapshot.ts` | Create | `getScreenSnapshot()` from headless terminal |
| `tests/daemon/pty/pty-manager.test.ts` | Create | PTY spawn and output tests |
| `tests/daemon/pty/screen-snapshot.test.ts` | Create | Screen snapshot tests |

**Class: `PtyManager`**

```typescript
interface ManagedSessionConfig {
  cwd: string;
  resume?: string;              // Claude session ID for --resume
  projectId: string;
  env?: Record<string, string>;
  cols?: number;                // Default: 120
  rows?: number;                // Default: 40
}

class PtyManager extends EventEmitter {
  private sessions: Map<string, ManagedPtySession>;
  private maxSessions: number;  // Default: 10

  async spawn(config: ManagedSessionConfig): Promise<ManagedPtySession>;
  async kill(sessionId: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): void;
  writeInput(sessionId: string, data: string): void;
  getScreenSnapshot(sessionId: string): ScreenSnapshot | null;
  getSession(sessionId: string): ManagedPtySession | undefined;
  getActiveSessionCount(): number;
}

interface ManagedPtySession {
  id: string;
  ptyProcess: pty.IPty;
  terminalParser: Terminal;      // @xterm/headless
  ringBuffer: RingBuffer;
  config: ManagedSessionConfig;
  ptyPid: number;
  startedAt: Date;
}

interface ScreenSnapshot {
  lines: string[];
  cursorX: number;
  cursorY: number;
  cols: number;
  rows: number;
}
```

**PTY Spawn Details:**

- Binary: `claude` (must be on PATH or specified via config).
- Args: `['--resume', sessionId]` if resuming, `[]` otherwise.
- TERM: `xterm-256color`.
- Environment additions:
  - `CLAUDE_CONTEXT_PATH`: ensures hooks write to the correct store.
  - `AGENTCTX_MANAGED=1`: signals to hooks that this is a daemon-managed session.
  - `AGENTCTX_SESSION_ID`: the daemon's session UUID.

**PTY Output Wiring:**

```
ptyProcess.onData(data) ──┬──► terminalParser.write(data)   // screen state
                          ├──► ringBuffer.write(data)        // reconnection replay
                          └──► broadcastToClients(data)      // live streaming
```

**PTY Exit Handling:**

When the PTY process exits (`ptyProcess.onExit`), the `PtyManager` emits `session:exited` and cleans up:
- Close the terminal parser.
- Notify all connected clients with a `session_ended` control message.
- Remove from the active sessions map.

**Max Sessions Enforcement:**

If `spawn()` is called when `maxSessions` is reached, reject with an error: `"Maximum managed sessions (10) reached. Release or stop an existing session."`.

**Acceptance Criteria**

- [ ] `spawn()` creates a `node-pty` process with `claude` and the correct arguments
- [ ] The PTY uses `xterm-256color` TERM with configurable initial dimensions (default 120x40)
- [ ] `@xterm/headless` parser maintains server-side terminal state from PTY output
- [ ] PTY output is broadcast to all connected clients in real time
- [ ] `AGENTCTX_MANAGED=1` and `AGENTCTX_SESSION_ID` environment variables are set inside the PTY
- [ ] `CLAUDE_CONTEXT_PATH` is passed through so GC hooks fire normally (dual output path)
- [ ] `resize()` updates both the PTY and the headless terminal parser dimensions
- [ ] `getScreenSnapshot()` returns the current terminal screen content, cursor position, and dimensions
- [ ] When the `claude` process exits, connected clients are notified and the session is cleaned up
- [ ] `max_managed_sessions` limit is enforced; spawn rejects when limit is reached
- [ ] `kill()` sends SIGINT, waits 5s, then SIGKILL if needed
- [ ] The ring buffer stores PTY output for reconnection replay

**Edge Cases**

- `claude` binary not found on PATH.
- PTY process exits immediately (e.g., invalid `--resume` session ID).
- Very large PTY output bursts (performance of terminal parser and ring buffer).
- Terminal resize to 0x0 (invalid dimensions -- clamp to minimum 1x1).
- `@xterm/headless` parser crash on malformed ANSI sequences.

**Estimated Effort**: L (Large) -- 5-6 hours

---

### Task 7: Ring Buffer

**Description**

Implement an 8MB ring buffer for storing recent PTY output to enable reconnection replay. When a client connects (or reconnects) to a managed session, the ring buffer contents are replayed so the client sees the current terminal state.

**Prerequisites / Inputs**

- None (standalone data structure).

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/pty/ring-buffer.ts` | Create | `RingBuffer` class |
| `tests/daemon/pty/ring-buffer.test.ts` | Create | Ring buffer tests |

**Class: `RingBuffer`**

```typescript
class RingBuffer {
  private buffer: Buffer;
  private writePos: number;
  private totalWritten: number;
  private readonly capacity: number;

  constructor(capacity: number);   // Default: 8 * 1024 * 1024 (8MB)
  write(data: Buffer): void;
  read(): Buffer;                  // Returns contents in chronological order
  get bytesWritten(): number;
  get usedBytes(): number;
  clear(): void;
}
```

**Key Behaviors:**

- Write appends data byte-by-byte into a circular buffer.
- When `totalWritten < capacity`, `read()` returns `buffer[0..writePos]`.
- When `totalWritten >= capacity` (wrapped), `read()` returns `buffer[writePos..end] + buffer[0..writePos]`.
- `clear()` resets all counters and fills buffer with zeros.
- Buffer size is configurable via daemon config (`session.max_ring_buffer_bytes`, default 8MB).

**Reconnection Replay Protocol:**

When a client connects to a managed session:
1. Send a terminal reset sequence (`\x1bc`) to clear stale state.
2. Send the ring buffer contents via `ringBuffer.read()`.
3. Begin streaming live PTY output.

The terminal reset before replay prevents rendering artifacts from the ring buffer starting mid-ANSI-escape-sequence (E-6 from story).

**Acceptance Criteria**

- [ ] Buffer correctly stores and retrieves data smaller than capacity
- [ ] Buffer correctly wraps around when data exceeds capacity
- [ ] `read()` returns data in chronological order after wrap
- [ ] `read()` returns an empty buffer when no data has been written
- [ ] `write()` handles data larger than the remaining capacity (wraps correctly)
- [ ] `usedBytes` returns the actual amount of usable data (min of totalWritten, capacity)
- [ ] `bytesWritten` tracks total bytes ever written (not limited by capacity)
- [ ] `clear()` resets the buffer to an empty state
- [ ] Buffer handles being written to and read from concurrently (no data corruption)
- [ ] Performance: writing 8MB of data completes in under 100ms
- [ ] Reconnection replay prepends terminal reset sequence before buffer contents

**Edge Cases**

- Write exactly `capacity` bytes (buffer is full, no wrap yet).
- Write `capacity + 1` bytes (first wrap-around).
- Read after clear (returns empty buffer).
- Very small writes (1 byte at a time) -- must not lose data.
- Very large writes (larger than capacity) -- old data is overwritten, only last `capacity` bytes are retained.

**Estimated Effort**: S (Small) -- 2 hours

---

### Task 8: Terminal Client Attachment

**Description**

Implement the `agentctx agent attach <session-id>` command that connects the user's terminal to a managed session's PTY. The command enters raw terminal mode, forwards all keystrokes to the daemon (except the detach sequence), and forwards all PTY output to the terminal.

**Prerequisites / Inputs**

- Task 6 (PtyManager) for PTY access.
- Task 7 (Ring Buffer) for reconnection replay.
- Daemon WebSocket or Unix socket server for IPC.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/cli/commands/agent-attach.ts` | Create | `agentctx agent attach` command handler |
| `src/cli/terminal/detach-detector.ts` | Create | `DetachDetector` class (Ctrl+B d chord) |
| `src/daemon/connections/terminal-handler.ts` | Create | Daemon-side handler for terminal client connections |
| `tests/cli/terminal/detach-detector.test.ts` | Create | Detach detection tests |
| `tests/daemon/connections/terminal-handler.test.ts` | Create | Terminal connection tests |

**CLI Command: `agentctx agent attach`**

```
agentctx agent attach <session-id>  [--read-only]

Arguments:
  <session-id>   Daemon session ID or partial match (first 8 chars)

Options:
  --read-only    Observe only, do not claim input focus
```

**Attach Flow (client side):**

1. Connect to daemon (Unix socket at `~/.claude-context/daemon.sock` or WebSocket at `localhost:{port}`).
2. Authenticate with daemon token from `~/.claude-context/daemon.json`.
3. Send `{ type: 'attach', sessionId, readOnly, terminalSize: { cols, rows } }`.
4. Wait for `attach_response`.
5. If success: receive ring buffer replay (binary data).
6. Enter raw terminal mode (`process.stdin.setRawMode(true)`).
7. Forward stdin to daemon (through `DetachDetector`), receive PTY output on stdout.
8. Handle `SIGWINCH` (terminal resize) -- forward to daemon.

**Class: `DetachDetector`**

```typescript
class DetachDetector {
  private ctrlBPressed: boolean;
  private ctrlBTimer: NodeJS.Timeout | null;
  private readonly CHORD_TIMEOUT_MS: number;  // 500

  processInput(data: Buffer, passthrough: (data: Buffer) => void): boolean;
  private clearTimer(): void;
}
```

Key sequence: Ctrl+B (0x02) followed by `d` (0x64) within 500ms.
- If Ctrl+B then `d` within 500ms: return `true` (detach).
- If Ctrl+B then non-`d` key: pass through both bytes.
- If Ctrl+B then 500ms timeout: pass through the Ctrl+B.
- All other bytes: pass through immediately.

**Daemon-Side: `TerminalHandler`**

Handles the `attach` message:
1. Validate session exists and is in `managed` or `resumed` mode.
2. Register client as a `terminal` type connection.
3. If not `--read-only` and no active writer, grant input focus.
4. Send ring buffer replay data.
5. Forward incoming binary data to PTY input (if client has input focus).
6. Forward PTY output to client as binary data.
7. Handle `resize` messages by calling `ptyManager.resize()`.

**Terminal Resize Forwarding:**

The active writer's terminal size determines the PTY size. When no writer is active, use the minimum dimensions of all connected terminal clients. See `determineEffectiveSize()` in the story spec.

**Acceptance Criteria**

- [ ] `agentctx agent attach <id>` connects the terminal to a managed session's PTY
- [ ] Partial session ID matching works (first 8 characters)
- [ ] The terminal enters raw mode on attach, restores on detach/disconnect
- [ ] All keystrokes are forwarded to the daemon's PTY (except the detach sequence)
- [ ] All PTY output is forwarded back to the user's terminal in real time
- [ ] Ctrl+B d (within 500ms) detaches without stopping the agent
- [ ] Ctrl+B followed by any other key passes both characters through
- [ ] Ctrl+B followed by 500ms timeout passes the Ctrl+B through
- [ ] Terminal resize events (SIGWINCH) are forwarded to the daemon
- [ ] The daemon resizes the PTY based on the active writer's terminal dimensions
- [ ] `--read-only` mode allows observation without input forwarding
- [ ] On connection, the ring buffer is replayed (preceded by terminal reset) to bring the terminal up to current state
- [ ] On disconnection (network loss, terminal close), the client exits cleanly and the daemon session continues
- [ ] The attach command fails with a clear error if the session is not in managed/resumed mode
- [ ] The attach command fails with a clear error if the session does not exist

**Edge Cases**

- Attach to a session that is currently transitioning (takeover in progress).
- Network drops during attached session -- daemon session continues, client restores terminal.
- Ctrl+B d at the exact boundary of a data chunk.
- Attach when another terminal client is already attached (second client gets read-only until it requests control).
- `stdin` is not a TTY (piped input) -- skip raw mode, disable detach detection.

**Estimated Effort**: L (Large) -- 5-6 hours

---

### Task 9: Detach/Reattach Lifecycle

**Description**

Implement PTY persistence when all clients disconnect from a managed session, including configurable idle timeout and graceful shutdown. This enables the "close laptop, reopen anywhere" workflow (F12.6).

**Prerequisites / Inputs**

- Task 6 (PtyManager) owns the PTY processes.
- Task 7 (Ring Buffer) stores data for reconnection replay.
- Task 8 (Terminal Client Attachment) for reattach.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/sessions/lifecycle-manager.ts` | Create | `ManagedSessionLifecycle` class |
| `tests/daemon/sessions/lifecycle-manager.test.ts` | Create | Lifecycle tests |

**Class: `ManagedSessionLifecycle`**

```typescript
interface LifecycleConfig {
  idleTimeoutMs: number;           // Default: 86400000 (24 hours)
  maxManagedSessions: number;      // Default: 10
  persistOnDaemonRestart: boolean; // Default: true
}

class ManagedSessionLifecycle extends EventEmitter {
  private idleTimers: Map<string, NodeJS.Timeout>;

  onAllClientsDisconnected(session: TrackedSession): void;
  onClientReconnected(session: TrackedSession, clientId: string): void;
  private startIdleTimer(session: TrackedSession): void;
  private cancelIdleTimer(session: TrackedSession): void;
  private gracefulShutdown(session: TrackedSession): Promise<void>;
}
```

**Idle Timeout Behavior:**

When the last client disconnects from a managed session:
1. Log: "All clients disconnected from session {id}. PTY continues running."
2. Start idle timer (default 24 hours).
3. If a client reconnects before timeout: cancel timer, replay ring buffer.
4. If timeout fires: send SIGINT to PTY process. Wait 5 seconds. If still running, SIGKILL.

**Reconnection Replay:**

When a client reconnects to a session that has been running unattended:
1. Send terminal reset sequence (`\x1bc`).
2. Send ring buffer contents.
3. Begin live PTY output streaming.
4. If the ring buffer has wrapped more than once, optionally send the screen snapshot from `@xterm/headless` instead (more compact, avoids mid-escape-sequence issues).

**Configuration:**

Read from daemon config file (location defined by daemon infrastructure):

```json
{
  "session": {
    "idle_timeout_ms": 86400000,
    "max_ring_buffer_bytes": 8388608,
    "max_managed_sessions": 10,
    "persist_on_daemon_restart": true
  }
}
```

**Acceptance Criteria**

- [ ] The PTY keeps running when all clients disconnect from a managed session
- [ ] Idle timeout is configurable (default 24 hours) and triggers graceful shutdown
- [ ] Idle timeout is cancelled when a client reconnects
- [ ] On reconnection, the ring buffer is replayed to bring the client up to current terminal state
- [ ] Reconnection replay is preceded by a terminal reset sequence
- [ ] Sleep/wake cycles do not kill managed sessions (PTY survives system sleep)
- [ ] Multiple consecutive detach/reattach cycles work without state corruption
- [ ] Graceful shutdown sends SIGINT first, then SIGKILL after 5 seconds if needed
- [ ] Idle timeout of 0 means infinite (no automatic shutdown)
- [ ] Setting changes are picked up dynamically (no daemon restart needed)

**Edge Cases**

- Client reconnects during the 5-second graceful shutdown window (cancel shutdown, keep session).
- Multiple sessions hit idle timeout simultaneously (process serially).
- System clock jumps (e.g., NTP sync) -- idle timer should use monotonic time if available.
- Very long-running session (days) -- ring buffer has wrapped many times, replay uses screen snapshot.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 10: Conflict Prevention / Single-Writer Model

**Description**

Implement the single-writer model that ensures only one client can send input to a managed session at a time. Includes the "Request Control" flow for transferring input focus between clients.

**Prerequisites / Inputs**

- Task 6 (PtyManager) for PTY input routing.
- Task 3 (SessionRegistry) for client tracking.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/connections/writer-controller.ts` | Create | `WriterController` class |
| `tests/daemon/connections/writer-controller.test.ts` | Create | Writer control tests |

**Class: `WriterController`**

```typescript
class WriterController extends EventEmitter {
  handleClientConnected(session: TrackedSession, client: ConnectedClient): void;
  handleClientDisconnected(session: TrackedSession, clientId: string): void;
  handleClientInput(session: TrackedSession, clientId: string, data: Buffer): void;
  handleControlRequest(session: TrackedSession, requesterId: string, message?: string): Promise<boolean>;
  private transferControl(session: TrackedSession, fromId: string, toId: string): void;
  getActiveWriter(session: TrackedSession): string | null;
}
```

**Rules:**

1. **Observed sessions**: All daemon clients are read-only. The original CLI terminal is the only writer.
2. **Managed/Resumed sessions**: The first connecting client gets automatic input focus (unless `--read-only`).
3. **Request Control flow**:
   a. Requester sends `request_control` message.
   b. Daemon notifies current writer with `control_requested` (includes requester type and optional message).
   c. Current writer responds with `control_response` (granted/denied) within 30 seconds.
   d. If granted: transfer focus. If denied or timeout: deny request.
4. **Input from non-writer**: Silently dropped. Client receives `input_dropped` notification.
5. **Writer disconnects**: If there are pending control requests, grant to first in queue. Otherwise, session has no active writer until someone connects or requests control.

**Acceptance Criteria**

- [ ] Only one client at a time can send input to a managed session
- [ ] Observed sessions are always read-only for daemon clients
- [ ] The first client to connect to a managed session automatically gets input focus
- [ ] `--read-only` clients do not get automatic input focus
- [ ] "Request control" flow notifies the current writer and waits for response
- [ ] Control request has a 30-second timeout; denied on timeout
- [ ] When the active writer disconnects, the next pending requester (if any) gets focus
- [ ] Input from non-writer clients is dropped with a notification to the client
- [ ] All writer state changes are broadcast to all connected clients
- [ ] Rapid control transfers do not cause race conditions
- [ ] Request control on a session with no active writer grants immediately

**Edge Cases**

- Two clients request control simultaneously.
- Active writer disconnects while a control request is pending.
- Client sends input immediately after disconnect notification (race condition).
- Control request denied, then requester disconnects before receiving denial.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 11: Integration Tests (Watcher + Timeline + Streaming)

**Description**

Create integration tests that validate the full pipeline from event file creation to client notification. Tests verify that the SessionWatcher, Event Normalizer, Session Registry, and Timeline Streamer work together end-to-end.

**Prerequisites / Inputs**

- Tasks 1, 3, 4 (watcher, registry, normalizer/streamer).

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `tests/daemon/integration/watcher-to-client.test.ts` | Create | End-to-end watcher pipeline tests |
| `tests/daemon/integration/multi-client-subscription.test.ts` | Create | Multi-client subscription tests |
| `tests/daemon/integration/test-helpers.ts` | Create | Shared test utilities |

**Test Cases:**

| # | Test | Validates |
|---|------|-----------|
| 1 | Write a `SessionStarted` event file; verify daemon registers an observed session within 5 seconds | Tasks 1, 3 |
| 2 | Write a `UserPromptReceived` event file; verify subscribed WebSocket client receives a normalized `TimelineItem` within 200ms | Tasks 1, 4 |
| 3 | Write all 10 event types; verify each is correctly normalized | Task 4 |
| 4 | Two WebSocket clients subscribe to same session; both receive events | Task 4 |
| 5 | Client subscribes to session A; events for session B are NOT received | Task 4 |
| 6 | Write events out of sequence order; verify client receives them in sequence order | Task 4 |
| 7 | Write malformed JSON event file; verify it is skipped without crashing | Task 4 |
| 8 | Client disconnects; verify subscription is cleaned up | Task 4 |
| 9 | Heartbeat messages received every 30 seconds | Task 4 |
| 10 | SSE endpoint streams timeline events correctly | Task 4 |

**Test Helpers:**

```typescript
async function writeTestEvent(eventsDir: string, projectId: string, sessionId: string, event: Partial<GCEvent>): Promise<string>;
function createMockWebSocketClient(): MockWSClient;
function waitForEvent<T>(emitter: EventEmitter, eventName: string, timeoutMs: number): Promise<T>;
```

**Acceptance Criteria**

- [ ] All 10 test cases pass
- [ ] Tests use isolated temp directories for the event store
- [ ] Tests clean up all resources (watchers, connections, temp files) after completion
- [ ] Latency measurements are logged (target: < 200ms end-to-end)
- [ ] Tests run in under 30 seconds total

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 12: Session State Indicator

**Description**

Extend the `gc-hook` wrapper to display a session status indicator when a session is being observed or managed by the daemon. The daemon writes status files that the hook reads; the hook outputs a status line to stderr.

**Prerequisites / Inputs**

- Task 3 (SessionRegistry) for session state.
- Story 02 `gc-hook` script (to be modified).

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/status/status-writer.ts` | Create | Writes/updates/removes status files |
| `src/gc-hook` | Modify | Add status line output to stderr |
| `tests/daemon/status/status-writer.test.ts` | Create | Status file write tests |

**Status File Location and Format:**

```
~/.claude-context/status/{gc-session-id}.json
```

```json
{
  "mode": "observed",
  "daemon_pid": 12345,
  "connected_clients": 2,
  "observing_since": "2026-02-22T10:30:00.000Z",
  "client_details": [
    { "type": "mobile", "connected_at": "2026-02-22T10:35:00.000Z" },
    { "type": "dashboard", "connected_at": "2026-02-22T10:32:00.000Z" }
  ]
}
```

**Class: `StatusWriter`**

```typescript
class StatusWriter {
  private statusDir: string;  // ~/.claude-context/status/

  constructor(basePath: string);
  async ensureStatusDir(): Promise<void>;
  async writeStatus(session: TrackedSession): Promise<void>;
  async removeStatus(gcSessionId: string): Promise<void>;
  async removeAllStatuses(): Promise<void>;
}
```

Updates are triggered by:
- Client connects or disconnects.
- Session mode changes.
- Session ends (status file removed).
- Daemon shuts down (all status files removed).

**gc-hook Modification (Bash):**

After normal hook processing, add status line check:

```bash
# Read status file if it exists
_gc_status_dir="${GC_BASE}/status"
_gc_session_id="${SESSION_ID:-}"  # SESSION_ID from hook environment

if [ -n "$AGENTCTX_MANAGED" ]; then
  _gc_client_count="${AGENTCTX_CLIENTS:-0}"
  echo "[AgentCtx: managed | ${_gc_client_count} clients connected]" >&2
elif [ -n "$_gc_session_id" ] && [ -f "${_gc_status_dir}/${_gc_session_id}.json" ]; then
  _gc_client_count=$(jq -r '.connected_clients // 0' "${_gc_status_dir}/${_gc_session_id}.json" 2>/dev/null)
  if [ "$_gc_client_count" != "0" ] && [ "$_gc_client_count" != "null" ]; then
    echo "[AgentCtx: observed by ${_gc_client_count} clients]" >&2
  fi
fi
```

Status output only on specific hook events: `SessionStart`, `TurnCompleted`, `UserPromptSubmit`. This avoids flooding stderr during rapid tool calls.

**File Permissions:**

Status files: `0600`. Status directory: `0700`.

**Acceptance Criteria**

- [ ] Managed sessions have `AGENTCTX_MANAGED=1` and `AGENTCTX_SESSION_ID` environment variables set
- [ ] The daemon writes a status file to `~/.claude-context/status/{session-id}.json` for observed sessions
- [ ] The status file includes mode, connected client count, daemon PID, and client details
- [ ] The `gc-hook` reads the status file and outputs a status line to stderr
- [ ] Status line format: `[AgentCtx: observed by N clients]` for observed sessions
- [ ] Status line format: `[AgentCtx: managed | N clients connected]` for managed sessions
- [ ] Status line only appears on `SessionStart`, `TurnCompleted`, and `UserPromptSubmit` hooks
- [ ] The status file is updated when clients connect or disconnect
- [ ] The status file is removed when the daemon stops observing a session
- [ ] All status files are removed on daemon shutdown
- [ ] Status line does not interfere with Claude Code's hook protocol (stderr only)
- [ ] Status files have 0600 permissions; status directory has 0700

**Edge Cases**

- Status file is stale (daemon crashed without cleanup) -- gc-hook checks `daemon_pid` is still running.
- `jq` is not available -- skip status line (do not break the hook).
- Multiple concurrent updates to the same status file (atomic write via temp + rename).

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 13: Resume Handback

**Description**

Implement `agentctx agent release <session-id>` which stops a daemon-managed PTY session and provides the user with the `claude --resume <session-id>` command to continue in their own terminal.

**Prerequisites / Inputs**

- Task 5 (TakeoverEngine) for reading Claude session state.
- Task 6 (PtyManager) for stopping the managed PTY.
- Task 3 (SessionRegistry) for state transitions.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/cli/commands/agent-release.ts` | Create | `agentctx agent release` command handler |
| `src/daemon/takeover/release-handler.ts` | Create | Daemon-side release logic |
| `tests/daemon/takeover/release-handler.test.ts` | Create | Release flow tests |

**CLI Command: `agentctx agent release`**

```
agentctx agent release <session-id>

Arguments:
  <session-id>   Daemon session ID or partial match (first 8 chars)
```

**Release Flow:**

1. Validate session exists and is in `managed` or `resumed` mode.
2. Notify all connected clients: `{ type: 'session_releasing', message: '...' }`.
3. Disconnect all clients gracefully: `{ type: 'disconnect', reason: 'session_released' }`.
4. Send SIGINT to the `claude` process inside the PTY.
5. Wait up to 5 seconds for process exit.
6. Read the GC session ID from the session state (for the `--resume` command).
7. Clean up managed session state (remove from registry, close PTY).
8. Output: `"Session released. Resume in your terminal with:\n  claude --resume {gc-session-id}"`.

**Acceptance Criteria**

- [ ] `agentctx agent release <id>` stops the daemon-managed PTY
- [ ] All connected clients are notified with `session_releasing` before disconnection
- [ ] All clients are disconnected gracefully with `disconnect` + `session_released` reason
- [ ] SIGINT is sent to gracefully stop the `claude` process
- [ ] The release command outputs the exact `claude --resume <session-id>` command
- [ ] After release, the session is removed from the managed sessions registry
- [ ] The session transitions to `closed` mode
- [ ] Partial session ID matching works (first 8 characters)
- [ ] Release fails with clear error if session is not in managed/resumed mode
- [ ] Release fails with clear error if session does not exist
- [ ] If the user does not resume, no data is lost (GC event store persists)

**Edge Cases**

- Release while a client has input focus and is mid-prompt.
- Claude process does not exit after SIGINT (escalate to SIGTERM, then fail with instructions).
- GC session ID cannot be determined (output warning, suggest manual lookup).
- Release of a session that was recovered after a daemon crash (no PTY to stop, only deregister).

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 14: Auto-Detect Running Sessions on Startup

**Description**

When the daemon starts (or restarts), scan for already-running `claude` processes and correlate them with recent events in the GC event store. This handles the case where the daemon starts after a `claude` session is already running (E-1 from story, F12.9).

**Prerequisites / Inputs**

- Task 1 (SessionWatcher) for ongoing detection (startup scan is for pre-existing sessions).
- Task 2 (Process Correlator) for PID matching.
- Task 3 (SessionRegistry) for session registration.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/startup/session-scanner.ts` | Create | `scanExistingSessions()` function |
| `tests/daemon/startup/session-scanner.test.ts` | Create | Startup scan tests |

**Function: `scanExistingSessions()`**

```typescript
async function scanExistingSessions(
  registry: SessionRegistry,
  correlator: SessionCorrelator,
  eventsDir: string,
  maxAgeMs: number,        // Default: 24 * 60 * 60 * 1000 (24 hours)
): Promise<ScanResult>;

interface ScanResult {
  processesFound: number;
  sessionsCorrelated: number;
  processesUnmatched: number;
  duration: number;        // milliseconds
}
```

**Scan Algorithm:**

1. Find all running `claude` processes owned by the current user.
2. Find recent sessions in the event store (modified within `maxAgeMs`).
3. For each process:
   a. Derive project ID from process cwd.
   b. Find sessions in the same project that have NOT ended (no `SessionEnded` event).
   c. Match by start time proximity (within 60 seconds).
   d. If matched: register as Observed with PID.
   e. If not matched: log warning.
4. The scan must complete within 5 seconds (fail-fast on slow filesystem).

**Finding Recent Sessions:**

```typescript
interface RecentSession {
  projectId: string;
  sessionId: string;
  startedAt: Date;
  lastEvent: GCEvent;
  hasEnded: boolean;
  eventCount: number;
}

async function findRecentSessions(eventsDir: string, maxAgeMs: number): Promise<RecentSession[]>;
```

Scan `events/{project-id}/{session-id}/` directories. For each:
- Check directory mtime against cutoff.
- Read first event file (for start time) and last event file (for `hasEnded` check).
- Only include sessions where `hasEnded === false`.

**Acceptance Criteria**

- [ ] On daemon startup, running `claude` processes are detected
- [ ] Running processes are correlated with recent sessions in the event store (last 24 hours)
- [ ] Correlation uses working directory (project ID) and start time proximity (within 60 seconds)
- [ ] Matched sessions are registered as Observed with the correct PID
- [ ] Unmatched processes are logged as warnings
- [ ] Sessions with a `SessionEnded` event are excluded from correlation
- [ ] The scan filters out `claude` processes owned by different users
- [ ] The scan completes within 5 seconds even with many projects/sessions
- [ ] The scan handles an empty event store gracefully (returns 0 correlated)
- [ ] The scan handles the event store directory not existing (returns 0 correlated)

**Edge Cases**

- No running `claude` processes (scan completes quickly with 0 results).
- Many sessions in event store (performance -- scan only recent by mtime).
- Process started more than 24 hours ago (excluded by maxAge, but process is still running -- edge case, accept missed detection).
- Event files are malformed JSON (skip silently).

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 15: Security & Authentication

**Description**

Implement the security layer for PTY access and session management. Includes daemon token generation, client authentication, rate limiting for takeover and attach/detach operations, and session ownership validation.

**Prerequisites / Inputs**

- Task 3 (SessionRegistry) for session access.
- Task 5 (TakeoverEngine) for takeover rate limiting.
- Task 8 (Terminal Client Attachment) for attach rate limiting.
- Daemon HTTP/WS server infrastructure.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/security/token-manager.ts` | Create | Daemon token generation and validation |
| `src/daemon/security/rate-limiter.ts` | Create | Per-session rate limiting |
| `src/daemon/security/ownership-validator.ts` | Create | Session ownership (same-user) validation |
| `src/daemon/security/auth-middleware.ts` | Create | WebSocket/HTTP authentication middleware |
| `tests/daemon/security/token-manager.test.ts` | Create | Token tests |
| `tests/daemon/security/rate-limiter.test.ts` | Create | Rate limiter tests |
| `tests/daemon/security/ownership-validator.test.ts` | Create | Ownership validation tests |

**Token Manager:**

```typescript
class TokenManager {
  private token: string;

  async initialize(): Promise<void>;  // Generate token, write daemon.json
  validate(candidateToken: string): boolean;
  async readFromDisk(): Promise<string | null>;  // For CLI clients
}
```

- Token: `crypto.randomBytes(32).toString('hex')` (64-character hex string = 256 bits).
- Stored in `~/.claude-context/daemon.json` with mode `0600`.
- `daemon.json` also stores: `pid`, `started_at`, `socket_path`, `http_port`.

**Rate Limiter:**

```typescript
interface RateLimitConfig {
  attach: { limit: 10; windowMs: 60000 };
  detach: { limit: 10; windowMs: 60000 };
  takeover: { limit: 3; windowMs: 60000 };
  requestControl: { limit: 5; windowMs: 60000 };
}

class RateLimiter {
  check(operation: string, sessionId: string): boolean;
  reset(sessionId: string): void;
}
```

Uses a sliding window counter per `(operation, sessionId)` pair.

**Ownership Validator:**

```typescript
class OwnershipValidator {
  validateProcessOwnership(pid: number): boolean;
}
```

- Linux: Read `/proc/{pid}/status`, check `Uid:` line matches `process.getuid()`.
- macOS: Use `ps -o uid= -p {pid}`, check matches `process.getuid()`.
- If cannot verify: allow (defensive, for cases where /proc is not readable).

**Auth Middleware:**

```typescript
function authenticateClient(req: IncomingMessage, tokenManager: TokenManager): boolean;
```

Checks `Authorization: Bearer {token}` header. For Unix socket connections, authentication is implicit (filesystem permissions on the socket enforce same-user access).

**Acceptance Criteria**

- [ ] Daemon generates a random 256-bit token on startup
- [ ] Token is stored in `~/.claude-context/daemon.json` with 0600 permissions
- [ ] `agentctx` CLI reads the token from `daemon.json` for authentication
- [ ] WebSocket/HTTP connections without valid token are rejected with 401
- [ ] Unix socket connections bypass token auth (filesystem permissions suffice)
- [ ] Session takeover is rate-limited to 3 attempts per session per minute
- [ ] Attach/detach operations are rate-limited to 10 per session per minute
- [ ] Request control is rate-limited to 5 per session per minute
- [ ] Rate limit exceeded returns a clear error with retry-after time
- [ ] The daemon verifies managed processes belong to the same OS user
- [ ] Cross-user session access is denied with a clear error
- [ ] `daemon.json` includes `pid`, `started_at`, `socket_path`, `http_port`
- [ ] All daemon state files have restrictive permissions (0600 files, 0700 directories)

**Edge Cases**

- `daemon.json` already exists from a previous daemon instance (overwrite with new token).
- `daemon.json` is deleted while daemon is running (regenerate on next auth request).
- Rate limiter window edge: exactly at the boundary of the 60-second window.
- UID check on macOS where `/proc` does not exist.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 16: Daemon Crash Recovery

**Description**

Implement crash recovery for managed sessions. The daemon persists managed session metadata to disk so that on restart, it can detect orphaned `claude` processes and re-adopt them as Observed sessions (the PTY connection is lost, but the process may still be running).

**Prerequisites / Inputs**

- Task 3 (SessionRegistry) for session state.
- Task 6 (PtyManager) for managed session data.

**Implementation Details**

| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/recovery/state-persister.ts` | Create | Persist managed session metadata to disk |
| `src/daemon/recovery/crash-recovery.ts` | Create | Recovery logic on daemon restart |
| `tests/daemon/recovery/crash-recovery.test.ts` | Create | Recovery tests |

**State Persister:**

```typescript
interface PersistedManagedSession {
  id: string;
  ptyPid: number;
  gcSessionId: string;
  projectId: string;
  cwd: string;
  startedAt: string;
}

class StatePersister {
  private stateFile: string;  // ~/.claude-context/managed-sessions.json

  async persist(sessions: ManagedPtySession[]): Promise<void>;
  async load(): Promise<PersistedManagedSession[]>;
  async clear(): Promise<void>;
}
```

The state file is updated on every managed session state change:
- Session spawned (added to file).
- Session exited (removed from file).
- Daemon shutting down gracefully (file cleared).

**Crash Recovery:**

```typescript
async function recoverManagedSessions(
  registry: SessionRegistry,
  persister: StatePersister,
): Promise<RecoveryResult>;

interface RecoveryResult {
  orphanedProcessesFound: number;
  sessionsRecovered: number;       // Re-registered as observed
  processesGone: number;           // Were running, now exited
}
```

Recovery algorithm:
1. Read `managed-sessions.json`.
2. For each persisted session, check if the PID is still running.
3. If running: register as Observed with `recoveredFromCrash = true`. (Cannot re-adopt as Managed because PTY file descriptors are lost.)
4. If not running: log and skip.
5. Clear the state file after recovery.

**Graceful Shutdown Hooks:**

Register `process.on('SIGTERM')`, `process.on('SIGINT')`, and `process.on('uncaughtException')` to attempt cleanup:
- Persist final state.
- Send SIGINT to all managed PTY processes (so they can save state).
- Write status indicating shutdown reason.

**Acceptance Criteria**

- [ ] Managed session metadata is persisted to `~/.claude-context/managed-sessions.json` on every state change
- [ ] On daemon restart, `managed-sessions.json` is read and orphaned processes are detected
- [ ] Orphaned processes that are still running are registered as Observed with `recoveredFromCrash = true`
- [ ] Orphaned processes that have exited are cleaned up (logged, entry removed)
- [ ] After recovery, `managed-sessions.json` is cleared
- [ ] On graceful daemon shutdown (`SIGTERM`, `SIGINT`), managed sessions are cleaned up
- [ ] On `uncaughtException`, the daemon attempts to persist state before crashing
- [ ] `managed-sessions.json` has 0600 permissions
- [ ] Recovery completes within 5 seconds
- [ ] If `managed-sessions.json` does not exist, recovery is a no-op

**Edge Cases**

- Daemon crashes while writing `managed-sessions.json` (partial write) -- use atomic write (temp + rename).
- PID reuse: the PID from the state file now belongs to a different process -- verify it is `claude` before registering.
- Multiple daemon instances running simultaneously (should not happen, but guard against it via PID file / lock).
- `managed-sessions.json` contains sessions from a very old daemon run (stale entries).

**Estimated Effort**: M (Medium) -- 3-4 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/`.

| File | Action | Task(s) |
|------|--------|---------|
| `src/daemon/watchers/session-watcher.ts` | Create | 1 |
| `src/daemon/watchers/inotify-check.ts` | Create | 1 |
| `src/daemon/correlator/process-finder.ts` | Create | 2 |
| `src/daemon/correlator/session-correlator.ts` | Create | 2 |
| `src/daemon/sessions/session-registry.ts` | Create | 3 |
| `src/daemon/sessions/types.ts` | Create | 3 |
| `src/daemon/sessions/lifecycle-manager.ts` | Create | 9 |
| `src/daemon/timeline/event-normalizer.ts` | Create | 4 |
| `src/daemon/timeline/timeline-streamer.ts` | Create | 4 |
| `src/daemon/timeline/types.ts` | Create | 4 |
| `src/daemon/takeover/takeover-engine.ts` | Create | 5 |
| `src/daemon/takeover/claude-session-reader.ts` | Create | 5 |
| `src/daemon/takeover/release-handler.ts` | Create | 13 |
| `src/daemon/pty/pty-manager.ts` | Create | 6 |
| `src/daemon/pty/screen-snapshot.ts` | Create | 6 |
| `src/daemon/pty/ring-buffer.ts` | Create | 7 |
| `src/daemon/connections/terminal-handler.ts` | Create | 8 |
| `src/daemon/connections/writer-controller.ts` | Create | 10 |
| `src/daemon/status/status-writer.ts` | Create | 12 |
| `src/daemon/startup/session-scanner.ts` | Create | 14 |
| `src/daemon/security/token-manager.ts` | Create | 15 |
| `src/daemon/security/rate-limiter.ts` | Create | 15 |
| `src/daemon/security/ownership-validator.ts` | Create | 15 |
| `src/daemon/security/auth-middleware.ts` | Create | 15 |
| `src/daemon/recovery/state-persister.ts` | Create | 16 |
| `src/daemon/recovery/crash-recovery.ts` | Create | 16 |
| `src/cli/commands/agent-attach.ts` | Create | 8 |
| `src/cli/commands/agent-release.ts` | Create | 13 |
| `src/cli/terminal/detach-detector.ts` | Create | 8 |
| `src/gc-hook` | Modify | 12 |
| `tests/daemon/watchers/session-watcher.test.ts` | Create | 1 |
| `tests/daemon/correlator/process-finder.test.ts` | Create | 2 |
| `tests/daemon/correlator/session-correlator.test.ts` | Create | 2 |
| `tests/daemon/sessions/session-registry.test.ts` | Create | 3 |
| `tests/daemon/sessions/lifecycle-manager.test.ts` | Create | 9 |
| `tests/daemon/timeline/event-normalizer.test.ts` | Create | 4 |
| `tests/daemon/timeline/timeline-streamer.test.ts` | Create | 4 |
| `tests/daemon/takeover/takeover-engine.test.ts` | Create | 5 |
| `tests/daemon/takeover/claude-session-reader.test.ts` | Create | 5 |
| `tests/daemon/takeover/release-handler.test.ts` | Create | 13 |
| `tests/daemon/pty/pty-manager.test.ts` | Create | 6 |
| `tests/daemon/pty/screen-snapshot.test.ts` | Create | 6 |
| `tests/daemon/pty/ring-buffer.test.ts` | Create | 7 |
| `tests/cli/terminal/detach-detector.test.ts` | Create | 8 |
| `tests/daemon/connections/terminal-handler.test.ts` | Create | 8 |
| `tests/daemon/connections/writer-controller.test.ts` | Create | 10 |
| `tests/daemon/status/status-writer.test.ts` | Create | 12 |
| `tests/daemon/startup/session-scanner.test.ts` | Create | 14 |
| `tests/daemon/security/token-manager.test.ts` | Create | 15 |
| `tests/daemon/security/rate-limiter.test.ts` | Create | 15 |
| `tests/daemon/security/ownership-validator.test.ts` | Create | 15 |
| `tests/daemon/recovery/crash-recovery.test.ts` | Create | 16 |
| `tests/daemon/integration/watcher-to-client.test.ts` | Create | 11 |
| `tests/daemon/integration/multi-client-subscription.test.ts` | Create | 11 |
| `tests/daemon/integration/test-helpers.ts` | Create | 11 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone |
|-------|-------|-----------|
| **Phase 1: Foundation** | Task 1 (SessionWatcher), Task 2 (Process Correlator), Task 7 (Ring Buffer) | Filesystem events detected, processes found, buffer ready |
| **Phase 2: Core State** | Task 3 (Session Registry), Task 15 (Security) | Sessions tracked with state machine, auth in place |
| **Phase 3: Observation** | Task 4 (Event Normalizer + Timeline Streaming), Task 12 (Status Indicator), Task 14 (Startup Scan) | Observed sessions work end-to-end |
| **Phase 4: Integration Test** | Task 11 (Integration Tests) | Observation pipeline validated |
| **Phase 5: PTY Management** | Task 6 (PTY Proxy), Task 10 (Single-Writer) | Managed sessions can be spawned |
| **Phase 6: Terminal Attach** | Task 8 (Terminal Attachment), Task 9 (Detach/Reattach Lifecycle) | Full terminal attach/detach |
| **Phase 7: Takeover & Release** | Task 5 (Session Takeover), Task 13 (Resume Handback) | Observed -> Managed transitions |
| **Phase 8: Resilience** | Task 16 (Daemon Crash Recovery) | Crash recovery works |

Tasks 1, 2, and 7 can be developed in parallel (Phase 1). Tasks 3 and 15 can be partially parallelized. Tasks 4, 12, and 14 can be developed in parallel (Phase 3). Tasks 6 and 10 can be developed in parallel (Phase 5).

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `node-pty` compilation issues on different platforms | Medium | High (managed sessions broken) | Provide prebuilt binaries via `prebuild-install`. Document build prerequisites (python3, make, gcc). |
| inotify watch limit exhaustion on Linux | Medium | High (watcher stops working) | Check on startup, warn user, document the `sysctl` fix. Fallback to polling mode if watches exhausted. |
| PID correlation incorrectly matches the wrong process | Low | High (SIGINT kills wrong process) | Verify PID is `claude` before sending signals. Mark ambiguous matches as `pid: null`. |
| Race condition between watcher and process correlator | Medium | Medium (session registered without PID) | PID correlation runs after session registration; PID can be updated later via re-correlation. |
| `@xterm/headless` memory usage for long-running sessions | Low | Medium (daemon memory grows) | Limit scrollback to 1000 lines. Monitor memory usage per session. |
| Ring buffer replay starts mid-ANSI-escape-sequence | Medium | Low (visual artifacts) | Send terminal reset (`\x1bc`) before replay. Offer screen snapshot as alternative. |
| Claude Code changes session state file format | Low | High (takeover/resume breaks) | Abstract session file reading behind an interface. Version-check the file format. |
| WebSocket connection drops during PTY streaming | High | Low (client reconnects) | Ring buffer enables replay. Heartbeat detects drops. Client auto-reconnects. |
| Multiple daemon instances running simultaneously | Low | High (conflicting session management) | PID file / lock at `~/.claude-context/daemon.pid`. Check on startup, refuse to start if another daemon is running. |
| SIGINT does not stop Claude process (stuck in blocking call) | Low | Medium (takeover fails) | Escalate to SIGTERM. Do NOT use SIGKILL. Abort takeover if both fail. Document for users. |

---

## Notes for Implementation

1. **TypeScript throughout**: The daemon is a Node.js TypeScript application. All daemon code uses TypeScript with strict mode enabled. The only Bash modification is the `gc-hook` status indicator (Task 12).

2. **Event-driven architecture**: The daemon uses Node.js `EventEmitter` extensively. The `SessionRegistry` is the central event bus. Components communicate via events, not direct method calls (loose coupling).

3. **Dual output paths are key**: Managed sessions produce BOTH PTY streams (for terminal rendering) and GC hook events (for structured data). These are independent paths. The PTY stream is for real-time interaction; GC hooks are for search, analytics, and sync. Both must work simultaneously.

4. **No npm for the daemon**: The project design says "Node.js (no npm) read side" for the original GC stories. However, this story introduces `node-pty`, `@xterm/headless`, `chokidar`, and `ws` as dependencies. These REQUIRE npm (they have native bindings or substantial code). The daemon is a separate application from the GC read side and does use npm. Clarify this with the project owner if there is ambiguity.

5. **Partial session ID matching**: Throughout the CLI commands (`attach`, `release`, `takeover`), session IDs can be specified by their first 8 characters. If the prefix is ambiguous (matches multiple sessions), the command fails with a clear error listing all matches.

6. **Platform compatibility**: Process discovery differs between Linux (`/proc` filesystem) and macOS (`ps` command). Both paths must be implemented and tested. The `node-pty` API is cross-platform.

7. **Latency targets**: Observed sessions: < 200ms from hook fire to client receipt. Managed sessions: < 50ms from PTY output to client receipt. These targets should be measured in integration tests.

8. **Security model**: Local access (Unix socket) relies on filesystem permissions. Remote access (WebSocket over network) uses token auth. The token is generated per daemon lifetime and stored in `daemon.json`. Remote access via relay (F10) adds E2EE on top, but that is out of scope for this story.

9. **Graceful degradation**: If `chokidar` fails (inotify limit), fall back to polling. If process correlation fails, register session without PID (observation works, takeover disabled). If `node-pty` fails to compile, managed sessions are unavailable but observed sessions work.

10. **Testing with real `claude` processes**: Integration tests that involve actual `claude` processes are manual verification tests (M-1 through M-8 in the story). Automated tests use mock processes and mock event files.

---

## Effort Estimates

| Task | Complexity | Estimate |
|------|------------|---------|
| Task 1: SessionWatcher | M | 3-4 hours |
| Task 2: Process Correlator | M | 3-4 hours |
| Task 3: Session Registry & State Machine | L | 4-6 hours |
| Task 4: Event Normalizer & Timeline Streaming | M | 4-5 hours |
| Task 5: Session Takeover Flow | L | 5-6 hours |
| Task 6: Managed Session PTY Proxy | L | 5-6 hours |
| Task 7: Ring Buffer | S | 2 hours |
| Task 8: Terminal Client Attachment | L | 5-6 hours |
| Task 9: Detach/Reattach Lifecycle | M | 3-4 hours |
| Task 10: Conflict Prevention / Single-Writer | M | 3-4 hours |
| Task 11: Integration Tests | M | 3-4 hours |
| Task 12: Session State Indicator | S | 2-3 hours |
| Task 13: Resume Handback | S | 2-3 hours |
| Task 14: Auto-Detect Running Sessions on Startup | M | 3-4 hours |
| Task 15: Security & Authentication | M | 3-4 hours |
| Task 16: Daemon Crash Recovery | M | 3-4 hours |
| **Total** | | **~56-73 hours (~12-16 working days)** |
