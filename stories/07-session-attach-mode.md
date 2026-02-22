# Story 07: Session Attach Mode (Hybrid)

## Overview

Session Attach Mode is the foundation of the AgentContext daemon's relationship with running coding agents. Rather than requiring users to start all agents through the daemon, Attach Mode detects agents the user starts independently (e.g., typing `claude` in a terminal), observes their activity in real time via GC hook events, and optionally takes over those sessions for full management — including cross-device continuation, PTY proxying, and multi-client attachment.

This story defines three operating modes for agent sessions: **Observed** (read-only monitoring of independently started agents), **Managed** (daemon-owned PTY with full interaction), and **Resumed** (an observed session that was stopped and restarted under daemon control). The transitions between these modes — particularly the Session Takeover flow — are the critical innovation that distinguishes AgentContext from a simple monitoring tool. Users start agents wherever they want, however they want, and the daemon seamlessly integrates without disrupting their workflow.

The implementation combines filesystem watching (inotify/fswatch on the GC event store), process correlation (matching new session events to running `claude` processes), PTY multiplexing (node-pty + xterm headless for server-side terminal emulation), and a ring buffer architecture for reconnection replay. Multi-client support allows a terminal, mobile app, and web dashboard to all view and interact with the same agent session simultaneously, with a single-writer model preventing input conflicts.

This is one of the most complex stories in the AgentContext product because it spans the full stack: filesystem watchers, Unix process signals, PTY management, WebSocket streaming, terminal I/O forwarding, and state machine transitions. Every piece must be robust against real-world failures — network drops, crashed daemons, stuck processes, and race conditions between multiple clients.

---

## Scope

### In Scope

- Filesystem watcher for `~/.claude-context/events/` (inotify/fswatch)
- Session auto-detection from new SessionStarted events
- Process correlation (session events to running `claude` PIDs)
- Observed session timeline (streaming GC hook events to clients)
- Session takeover flow (Observed to Resumed/Managed)
- Managed session PTY proxy (node-pty + xterm headless)
- Ring buffer for reconnection replay (8MB)
- Terminal client attachment (`agentctx agent attach <id>`)
- Detach/reattach lifecycle (PTY persistence)
- Resume handback (release back to foreground CLI)
- Session state indicators (CLI status line)
- Auto-detection of already-running sessions on daemon startup
- Conflict prevention (single-writer model)
- Security controls for PTY and session access

### Out of Scope (Non-Goals)

- Mobile app UI rendering of session data (Story 13 / F13)
- Desktop app Tauri integration (F7)
- Encrypted sync of session data (F5)
- GitHub integration or worktree management (F8)
- Agent orchestration via SDK (F3 — though we invoke it for takeover)
- Multi-agent parallel sessions in worktrees (F3.3)
- OpenCode or Codex hook integration (F1.2, F1.3)
- Permission handling UI (F3.5 — we relay permission events, not implement the UI)
- Cross-machine session attachment (requires sync, separate story)

---

## Requirements

### 1. Session Auto-Detection (F12.1)

The daemon watches the GC event store directory for newly created session directories and event files. When a new `SessionStarted` event appears, the daemon registers the session as an **Observed** session and begins streaming its events to connected clients.

#### Filesystem Watcher Implementation

The watcher must monitor the entire `~/.claude-context/events/` tree recursively, detecting both new directories (indicating a new session) and new `.json` files (indicating new events within an existing session).

**Linux (inotify via `chokidar`):**

```typescript
import chokidar from 'chokidar';

interface WatcherConfig {
  eventsDir: string;          // ~/.claude-context/events/
  debounceMs: number;         // 50ms — batch rapid file creations
  ignorePatterns: string[];   // ['.lock', '.tmp']
}

class SessionWatcher {
  private watcher: chokidar.FSWatcher;
  private knownSessions: Map<string, ObservedSession>;

  constructor(private config: WatcherConfig) {
    this.knownSessions = new Map();
  }

  start(): void {
    this.watcher = chokidar.watch(this.config.eventsDir, {
      persistent: true,
      ignoreInitial: true,         // Don't fire for existing files
      depth: 3,                    // events/{project-id}/{session-id}/*.json
      awaitWriteFinish: {
        stabilityThreshold: 100,   // Wait 100ms after last write
        pollInterval: 50,
      },
      ignored: [
        /(^|[\/\\])\../,          // Hidden files except we need .lock awareness
        /\.lock$/,
        /\.tmp$/,
      ],
    });

    this.watcher.on('add', (filePath: string) => this.onFileCreated(filePath));
    this.watcher.on('addDir', (dirPath: string) => this.onDirCreated(dirPath));
    this.watcher.on('error', (error: Error) => this.onWatcherError(error));
  }

  private async onFileCreated(filePath: string): Promise<void> {
    // Only process .json event files
    if (!filePath.endsWith('.json')) return;

    const parsed = this.parseEventPath(filePath);
    if (!parsed) return;

    const { projectId, sessionId, sequence } = parsed;
    const sessionKey = `${projectId}/${sessionId}`;

    // Read and parse the event file
    const event = await this.readEventFile(filePath);
    if (!event) return;

    if (event.event_type === 'SessionStarted' && !this.knownSessions.has(sessionKey)) {
      await this.registerObservedSession(projectId, sessionId, event);
    }

    // Stream event to all connected clients watching this session
    this.broadcastEvent(sessionKey, event);
  }

  private parseEventPath(filePath: string): ParsedPath | null {
    // Expected: {eventsDir}/{project-id}/{session-id}/{sequence}.json
    const relative = path.relative(this.config.eventsDir, filePath);
    const parts = relative.split(path.sep);
    if (parts.length !== 3) return null;

    const [projectId, sessionId, filename] = parts;
    const match = filename.match(/^(\d{6})\.json$/);
    if (!match) return null;

    return { projectId, sessionId, sequence: parseInt(match[1], 10) };
  }

  stop(): void {
    this.watcher?.close();
  }
}
```

**macOS (fswatch fallback via same `chokidar` — uses kqueue internally):**

On macOS, `chokidar` uses the native FSEvents API, which is efficient for recursive watches. No additional configuration is needed. The same code works on both platforms.

**inotify watch limit considerations:**

On Linux, the default inotify watch limit (`/proc/sys/fs/inotify/max_user_watches`) is typically 8192 or 65536. Each watched directory consumes one watch. For users with many projects and sessions, this limit could be reached. The daemon should:

1. Check the current limit on startup.
2. Log a warning if the limit is below 16384.
3. Suggest increasing it: `echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches`

```typescript
async function checkInotifyLimit(): Promise<void> {
  if (process.platform !== 'linux') return;

  try {
    const limit = parseInt(
      await fs.readFile('/proc/sys/fs/inotify/max_user_watches', 'utf-8'),
      10
    );
    if (limit < 16384) {
      logger.warn(
        `inotify watch limit is ${limit} (recommended: 65536). ` +
        `Increase with: echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches`
      );
    }
  } catch {
    // Not Linux or /proc not available — skip
  }
}
```

#### Process Correlation

When a `SessionStarted` event is detected, the daemon attempts to find the corresponding `claude` process to determine its PID, which is needed for future takeover operations.

```typescript
interface ProcessInfo {
  pid: number;
  command: string;
  cwd: string;
  startTime: Date;
  ppid: number;
}

async function findClaudeProcesses(): Promise<ProcessInfo[]> {
  const processes: ProcessInfo[] = [];

  if (process.platform === 'linux') {
    // Read /proc directly for accuracy
    const procDirs = await fs.readdir('/proc');
    for (const dir of procDirs) {
      if (!/^\d+$/.test(dir)) continue;
      try {
        const cmdline = await fs.readFile(`/proc/${dir}/cmdline`, 'utf-8');
        if (!cmdline.includes('claude')) continue;

        const stat = await fs.readFile(`/proc/${dir}/stat`, 'utf-8');
        const cwd = await fs.readlink(`/proc/${dir}/cwd`);
        const startTime = parseStatStartTime(stat);
        const ppid = parseStatPpid(stat);

        processes.push({
          pid: parseInt(dir, 10),
          command: cmdline.replace(/\0/g, ' ').trim(),
          cwd,
          startTime,
          ppid,
        });
      } catch {
        // Process may have exited between readdir and readFile
        continue;
      }
    }
  } else {
    // macOS: use ps
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,lstart,command | grep -E "[c]laude"'
    );
    // Parse ps output into ProcessInfo objects
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const info = parsePsLine(line);
      if (info) processes.push(info);
    }
  }

  return processes;
}
```

**Correlation algorithm:**

```typescript
async function correlateSessionToProcess(
  projectId: string,
  sessionId: string,
  sessionStartedEvent: GCEvent
): Promise<number | null> {
  const processes = await findClaudeProcesses();

  // 1. Match by working directory (project_id is derived from cwd)
  const candidates = processes.filter(p => {
    const derivedId = deriveProjectId(p.cwd);
    return derivedId === projectId;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].pid;

  // 2. Multiple candidates — use process start time proximity
  //    The SessionStarted event timestamp should be close to the process start time
  const eventTime = new Date(sessionStartedEvent.timestamp).getTime();
  candidates.sort((a, b) => {
    const diffA = Math.abs(a.startTime.getTime() - eventTime);
    const diffB = Math.abs(b.startTime.getTime() - eventTime);
    return diffA - diffB;
  });

  // Accept if within 30 seconds of session start
  const best = candidates[0];
  const timeDiff = Math.abs(best.startTime.getTime() - eventTime);
  if (timeDiff < 30000) return best.pid;

  // 3. Cannot confidently correlate — register without PID
  return null;
}
```

#### Session Registration

```typescript
interface ObservedSession {
  id: string;                    // Internal daemon session ID (UUID)
  gcSessionId: string;           // GC event store session ID
  projectId: string;             // GC project ID
  pid: number | null;            // OS process ID (null if not correlated)
  mode: 'observed' | 'managed' | 'resumed';
  startedAt: Date;
  lastEventAt: Date;
  eventCount: number;
  connectedClients: Set<string>; // Client IDs observing this session
  metadata: {
    model?: string;
    source?: string;             // startup | resume | compact | clear
    cwd?: string;
  };
}

async function registerObservedSession(
  projectId: string,
  sessionId: string,
  event: GCEvent
): Promise<ObservedSession> {
  const pid = await correlateSessionToProcess(projectId, sessionId, event);

  const session: ObservedSession = {
    id: crypto.randomUUID(),
    gcSessionId: sessionId,
    projectId,
    pid,
    mode: 'observed',
    startedAt: new Date(event.timestamp),
    lastEventAt: new Date(event.timestamp),
    eventCount: 1,
    connectedClients: new Set(),
    metadata: {
      model: event.data?.model,
      source: event.data?.source,
      cwd: event.data?.cwd,
    },
  };

  this.knownSessions.set(`${projectId}/${sessionId}`, session);
  this.emit('session:discovered', session);

  logger.info(
    `Discovered session ${sessionId} for project ${projectId}` +
    (pid ? ` (PID ${pid})` : ' (PID unknown)')
  );

  return session;
}
```

#### Acceptance Criteria

- [ ] Daemon watches `~/.claude-context/events/` recursively for new files and directories
- [ ] New `SessionStarted` events trigger automatic session registration in daemon state
- [ ] The watcher uses `chokidar` with `awaitWriteFinish` to avoid reading partial writes
- [ ] `.lock` and `.tmp` files are ignored by the watcher
- [ ] On Linux, the daemon checks inotify watch limits on startup and warns if below 16384
- [ ] Process correlation matches `SessionStarted` events to running `claude` PIDs via working directory and start time proximity
- [ ] When multiple `claude` processes match, the closest by start time (within 30s) is selected
- [ ] Sessions where no PID can be correlated are still registered (with `pid: null`)
- [ ] Registered sessions emit a `session:discovered` event for other daemon components
- [ ] The watcher handles the event store directory not existing at startup (waits for creation)
- [ ] The watcher recovers gracefully if the filesystem watcher is interrupted (e.g., by inotify limit exhaustion)

---

### 2. Observed Session Timeline (F12.2)

Once a session is registered as Observed, the daemon streams all subsequent GC hook events to connected WebSocket/SSE clients in real time. This provides a read-only view of the session as it progresses.

#### Event Streaming Architecture

```
claude (user's terminal)
  │
  ├─ Hook fires → gc-hook → capture-event → writes .json to event store
  │                                            │
  │                                            ▼
  │                                    chokidar watcher detects new file
  │                                            │
  │                                            ▼
  │                                    Daemon reads event file
  │                                            │
  │                                            ▼
  │                                    Normalize to TimelineItem
  │                                            │
  │                    ┌───────────────────────┼───────────────────────┐
  │                    ▼                       ▼                       ▼
  │               WebSocket client       SSE client              Dashboard
  │               (mobile app)           (terminal)              (browser)
  │
  └─ User continues interacting with claude in their terminal (unaware)
```

#### Event Normalization

GC hook events use the raw capture format (event envelope with `data` payload). For client consumption, these are normalized into a unified `TimelineItem` format:

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
  data: Record<string, unknown>; // normalized payload (tool name, prompt text, etc.)
  raw?: Record<string, unknown>; // original envelope data (optional, for debugging)
}

function normalizeGCEvent(session: ObservedSession, event: GCEvent): TimelineItem {
  const typeMap: Record<string, TimelineItemType> = {
    'SessionStarted': 'session_started',
    'UserPromptReceived': 'user_prompt',
    'ToolCallRequested': 'tool_call_started',
    'ToolCallCompleted': 'tool_call_completed',
    'ToolCallFailed': 'tool_call_failed',
    'AgentSpawned': 'agent_spawned',
    'AgentCompleted': 'agent_completed',
    'TurnCompleted': 'turn_completed',
    'CompactionTriggered': 'compaction_triggered',
    'SessionEnded': 'session_ended',
  };

  return {
    id: event.event_id,
    sessionId: session.id,
    gcSessionId: session.gcSessionId,
    type: typeMap[event.event_type] || event.event_type as TimelineItemType,
    timestamp: event.timestamp,
    sequence: event.sequence,
    data: extractNormalizedData(event),
  };
}

function extractNormalizedData(event: GCEvent): Record<string, unknown> {
  const d = event.data;
  switch (event.event_type) {
    case 'UserPromptReceived':
      return { prompt: d.prompt };
    case 'ToolCallRequested':
      return { toolName: d.tool_name, toolInput: d.tool_input, toolUseId: d.tool_use_id };
    case 'ToolCallCompleted':
      return {
        toolName: d.tool_name,
        toolInput: d.tool_input,
        toolResponse: d.tool_response,
        toolUseId: d.tool_use_id,
      };
    case 'ToolCallFailed':
      return {
        toolName: d.tool_name,
        error: d.error,
        isInterrupt: d.is_interrupt,
        toolUseId: d.tool_use_id,
      };
    case 'SessionStarted':
      return { source: d.source, model: d.model };
    case 'SessionEnded':
      return { reason: d.reason };
    case 'CompactionTriggered':
      return { trigger: d.trigger };
    default:
      return d;
  }
}
```

#### WebSocket Protocol

Events are sent to clients over WebSocket connections using a JSON message protocol:

```typescript
// Server → Client message types
interface WSMessage {
  type: 'timeline_event' | 'session_update' | 'error' | 'heartbeat';
}

interface TimelineEventMessage extends WSMessage {
  type: 'timeline_event';
  sessionId: string;
  event: TimelineItem;
}

interface SessionUpdateMessage extends WSMessage {
  type: 'session_update';
  sessionId: string;
  update: {
    mode?: 'observed' | 'managed' | 'resumed';
    connectedClients?: number;
    eventCount?: number;
    lastEventAt?: string;
  };
}

// Client → Server message types
interface WSClientMessage {
  type: 'subscribe' | 'unsubscribe';
  sessionId: string;
}
```

Clients subscribe to specific sessions. The daemon only streams events for subscribed sessions, avoiding unnecessary data transfer.

#### Latency Expectations

| Segment | Target | Hard Limit |
|---------|--------|------------|
| Hook fires to event file written | < 100ms | 5000ms (sync hook timeout) |
| Event file written to watcher detects | < 50ms | 200ms (chokidar stabilityThreshold) |
| Watcher detects to client receives | < 50ms | 100ms |
| **Total: hook fire to client receives** | **< 200ms** | **5300ms** |

The typical end-to-end latency should be under 200ms. The hard limit accounts for sync hooks (which have a 5-second timeout) and worst-case filesystem watcher delays.

#### What Data Is Available vs. Not Available

| Available (Observed Mode) | NOT Available (Observed Mode) |
|---------------------------|-------------------------------|
| User prompts (full text) | Streaming Claude response text (only complete turns) |
| Tool calls (name, input, output) | Live character-by-character output |
| Tool failures and errors | PTY screen state (ANSI rendering) |
| Session lifecycle events | Terminal dimensions / cursor position |
| Token usage (if in event data) | Real-time thinking/reasoning blocks |
| Compaction notifications | File contents being read (unless in tool_response) |
| Agent spawn/completion | Interactive confirmations in progress |

**Key limitation**: In Observed mode, the daemon only sees structured GC hook events. It does NOT have access to the PTY stream. This means clients cannot see Claude's streaming text output character-by-character — they see the completed turn after `TurnCompleted` fires. For real-time streaming text, the session must be Managed (Requirement 4).

#### Acceptance Criteria

- [ ] GC hook events are streamed to subscribed WebSocket clients within 200ms of the hook firing
- [ ] Events are normalized from GC envelope format to `TimelineItem` before sending
- [ ] All 10 GC event types are correctly normalized with appropriate data extraction
- [ ] Clients subscribe to specific sessions and only receive events for subscribed sessions
- [ ] Multiple clients can observe the same session simultaneously
- [ ] The WebSocket protocol includes heartbeat messages (every 30 seconds) for connection health
- [ ] SSE fallback is available for clients that cannot use WebSocket
- [ ] Observed sessions provide structured event data but NOT streaming text or PTY output
- [ ] Session event count and `lastEventAt` are updated with each new event
- [ ] Events are ordered by sequence number, not by watcher detection order

---

### 3. Session Takeover — Stop/Resume (F12.3)

Session Takeover is the flow where a remotely connected client (mobile app, desktop app, or web dashboard) takes control of an Observed session. The daemon stops the original CLI process and restarts the session under its own management using the Claude SDK's resume capability.

#### Takeover State Machine

```
Observed                 Resumed (Managed)
┌──────────┐  takeover   ┌──────────────────┐
│          │────────────►│                  │
│ CLI owns │             │ Daemon owns      │
│ Read-only│             │ Full interaction │
│          │             │                  │
└──────────┘             └──────────────────┘
      │                         │
      │ SessionEnded            │ release
      ▼                         ▼
┌──────────┐             ┌──────────────────┐
│          │             │                  │
│  Closed  │             │  Released        │
│          │             │  (CLI reclaims)  │
└──────────┘             └──────────────────┘
```

#### Takeover Flow — Pseudocode

```typescript
interface TakeoverRequest {
  sessionId: string;       // Daemon session ID
  requestedBy: string;     // Client ID initiating takeover
  timeout: number;         // Max wait for graceful stop (default: 5000ms)
}

interface TakeoverResult {
  success: boolean;
  managedSessionId?: string;
  error?: string;
}

async function takeoverSession(req: TakeoverRequest): Promise<TakeoverResult> {
  const session = this.knownSessions.get(req.sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }

  if (session.mode !== 'observed') {
    return { success: false, error: `Session is ${session.mode}, not observed` };
  }

  if (!session.pid) {
    return { success: false, error: 'Session PID unknown — cannot send signal' };
  }

  // Step 1: Verify PID is still a claude process
  const stillRunning = await verifyClaudeProcess(session.pid);
  if (!stillRunning) {
    return { success: false, error: `PID ${session.pid} is no longer a claude process` };
  }

  // Step 2: Mark session as transitioning (prevent concurrent takeover attempts)
  session.mode = 'transitioning' as any;
  this.emit('session:takeover_started', { sessionId: session.id, by: req.requestedBy });

  try {
    // Step 3: Send SIGINT to the claude process
    logger.info(`Sending SIGINT to PID ${session.pid} for session ${session.id}`);
    process.kill(session.pid, 'SIGINT');

    // Step 4: Wait for SessionEnded event (or timeout)
    const ended = await this.waitForSessionEnd(session, req.timeout);

    if (!ended) {
      // SIGINT didn't work within timeout — try SIGTERM
      logger.warn(`SIGINT timeout for PID ${session.pid}, trying SIGTERM`);
      process.kill(session.pid, 'SIGTERM');

      const terminated = await this.waitForProcessExit(session.pid, 3000);
      if (!terminated) {
        // Process is stuck — abort takeover
        session.mode = 'observed';
        return {
          success: false,
          error: `Process ${session.pid} did not respond to SIGINT or SIGTERM`,
        };
      }
    }

    // Step 5: Read session state for resume
    const sessionState = await this.readClaudeSessionState(session);
    if (!sessionState) {
      session.mode = 'observed';
      return {
        success: false,
        error: 'Could not read Claude session state file for resume',
      };
    }

    // Step 6: Spawn managed session with resume
    const managedSession = await this.spawnManagedSession({
      resume: sessionState.sessionId,
      cwd: session.metadata.cwd || sessionState.cwd,
      projectId: session.projectId,
      originalSession: session,
    });

    // Step 7: Transition to resumed mode
    session.mode = 'resumed';
    session.pid = managedSession.ptyPid;
    this.emit('session:takeover_completed', {
      sessionId: session.id,
      managedSessionId: managedSession.id,
      by: req.requestedBy,
    });

    return { success: true, managedSessionId: managedSession.id };

  } catch (err) {
    session.mode = 'observed';
    logger.error(`Takeover failed for session ${session.id}:`, err);
    return { success: false, error: `Takeover failed: ${err.message}` };
  }
}
```

#### Claude Session State File

Claude Code stores session state in `~/.claude/projects/{project-dir-hash}/.session.json`. This file contains the session ID needed for `--resume`.

```typescript
interface ClaudeSessionState {
  sessionId: string;       // The Claude session ID for --resume
  cwd: string;             // Working directory of the session
  model: string;           // Model being used
  lastUpdated: string;     // ISO 8601 timestamp
}

async function readClaudeSessionState(
  session: ObservedSession
): Promise<ClaudeSessionState | null> {
  // Claude stores session files keyed by a hash of the project directory
  // Try to find the session file by scanning known locations
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  try {
    const projectDirs = await fs.readdir(claudeProjectsDir);
    for (const dir of projectDirs) {
      const sessionFile = path.join(claudeProjectsDir, dir, '.session.json');
      try {
        const content = await fs.readFile(sessionFile, 'utf-8');
        const state = JSON.parse(content) as ClaudeSessionState;
        // Match by session ID if available in the state
        if (state.sessionId === session.gcSessionId) {
          return state;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}
```

#### Wait for SessionEnded Event

```typescript
async function waitForSessionEnd(
  session: ObservedSession,
  timeoutMs: number
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      this.off('timeline_event', handler);
      resolve(false);
    }, timeoutMs);

    const handler = (event: TimelineItem) => {
      if (
        event.gcSessionId === session.gcSessionId &&
        event.type === 'session_ended'
      ) {
        clearTimeout(timer);
        this.off('timeline_event', handler);
        resolve(true);
      }
    };

    this.on('timeline_event', handler);
  });
}
```

#### What the Original Terminal Shows

After the daemon sends SIGINT and the `claude` process exits, the user's original terminal receives a message. The daemon writes to the terminal via a mechanism that depends on how Claude exits:

1. **Claude exits normally after SIGINT**: Claude Code itself prints its exit message. The daemon then writes to the user's terminal via the GC hook system (a `SessionEnded` hook payload can include a message).
2. **Post-exit notification**: The daemon cannot directly write to the user's terminal after the process exits. Instead, the `capture-event` script for the `SessionEnded` hook can print a message to stderr:

```
Session taken over by AgentCtx (mobile).
Run 'agentctx agent attach <session-id>' to reconnect from this terminal.
```

This message appears in the terminal after `claude` exits. The mechanism is: the `SessionEnded` hook fires synchronously before the prompt returns, and the hook's stderr output is visible in the terminal.

#### Acceptance Criteria

- [ ] The `takeover` operation transitions an Observed session to Resumed/Managed
- [ ] SIGINT is sent to the correlated PID to gracefully stop the CLI session
- [ ] The daemon waits up to 5 seconds for a `SessionEnded` event after SIGINT
- [ ] If SIGINT times out, SIGTERM is sent with an additional 3-second timeout
- [ ] If both signals fail, the takeover is aborted and the session stays Observed
- [ ] Before sending signals, the daemon verifies the PID is still a `claude` process
- [ ] The session state file is read from `~/.claude/projects/` for resume
- [ ] After the original session stops, a managed session is spawned with `resume: sessionId`
- [ ] Concurrent takeover attempts on the same session are prevented (transitioning state)
- [ ] The original terminal shows a message directing the user to `agentctx agent attach`
- [ ] Takeover cannot be initiated if the session PID is unknown (`pid: null`)
- [ ] All takeover transitions emit events for connected clients to update their UI
- [ ] The takeover flow completes within 10 seconds (5s SIGINT timeout + 3s SIGTERM timeout + 2s resume spawn)

---

### 4. Managed Session — PTY Proxy (F12.4)

A Managed session is one where the daemon owns the PTY that `claude` runs inside. This provides full interaction: any connected client can see real-time terminal output and send input. Managed sessions are created either by `agentctx agent start` or by taking over an Observed session.

#### Architecture

```
                            ┌──────────────────────────────────────────┐
                            │              AgentContext Daemon           │
                            │                                          │
agentctx agent start ──────►│  ┌────────────────────────────────────┐  │
  OR takeover ─────────────►│  │         PTY Manager                │  │
                            │  │                                    │  │
                            │  │  node-pty                          │  │
                            │  │  ┌───────────┐                    │  │
                            │  │  │           │◄── stdin from       │  │
                            │  │  │  claude   │    active writer    │  │
                            │  │  │  process  │                    │  │
                            │  │  │           │──── stdout ────┐   │  │
                            │  │  └───────────┘                │   │  │
                            │  │                               │   │  │
                            │  │         ┌─────────────────────┘   │  │
                            │  │         │                         │  │
                            │  │    ┌────▼─────┐  ┌────────────┐  │  │
                            │  │    │ xterm.js │  │ Ring Buffer │  │  │
                            │  │    │ headless │  │   (8 MB)    │  │  │
                            │  │    │ (parser) │  │             │  │  │
                            │  │    └────┬─────┘  └──────┬─────┘  │  │
                            │  │         │               │         │  │
                            │  └─────────┼───────────────┼─────────┘  │
                            │            │               │            │
                            │    screen  │    reconnect   │            │
                            │    state   │    replay      │            │
                            │            │               │            │
                            │  ┌─────────▼───────────────▼─────────┐  │
                            │  │      Client Connection Manager    │  │
                            │  │                                    │  │
                            │  │  WebSocket ────► Mobile App        │  │
                            │  │  WebSocket ────► Desktop App       │  │
                            │  │  WebSocket ────► Web Dashboard     │  │
                            │  │  Raw PTY I/O ──► Terminal Client   │  │
                            │  └────────────────────────────────────┘  │
                            │                                          │
                            │  ┌────────────────────────────────────┐  │
                            │  │    GC Hook Events (dual path)     │  │
                            │  │    claude fires hooks as usual →   │  │
                            │  │    capture-event writes to store → │  │
                            │  │    watcher streams to clients      │  │
                            │  └────────────────────────────────────┘  │
                            └──────────────────────────────────────────┘
```

#### node-pty Spawn

```typescript
import * as pty from 'node-pty';

interface ManagedSessionConfig {
  cwd: string;
  resume?: string;              // Session ID to resume (for takeover)
  projectId: string;
  env?: Record<string, string>; // Additional environment variables
  cols?: number;                // Initial terminal columns (default: 120)
  rows?: number;                // Initial terminal rows (default: 40)
}

interface ManagedSession {
  id: string;                     // Daemon session ID
  ptyProcess: pty.IPty;
  terminalParser: Terminal;       // @xterm/headless Terminal instance
  ringBuffer: RingBuffer;
  config: ManagedSessionConfig;
  connectedClients: Map<string, ConnectedClient>;
  activeWriter: string | null;    // Client ID that currently has input focus
  startedAt: Date;
  ptyPid: number;
}

function spawnManagedSession(config: ManagedSessionConfig): ManagedSession {
  const args: string[] = [];
  if (config.resume) {
    args.push('--resume', config.resume);
  }

  const cols = config.cols || 120;
  const rows = config.rows || 40;

  // Set up environment so GC hooks still fire inside the managed PTY
  const env = {
    ...process.env,
    ...config.env,
    // Ensure CLAUDE_CONTEXT_PATH is set so hooks write to the right store
    CLAUDE_CONTEXT_PATH: process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), '.claude-context'),
    // Signal to hooks that this is a daemon-managed session
    AGENTCTX_MANAGED: '1',
    AGENTCTX_SESSION_ID: crypto.randomUUID(),
  };

  const ptyProcess = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: config.cwd,
    env,
  });

  // Set up server-side terminal emulation
  const { Terminal } = require('@xterm/headless');
  const terminalParser = new Terminal({ cols, rows, scrollback: 1000 });

  // Set up ring buffer for reconnection replay
  const ringBuffer = new RingBuffer(8 * 1024 * 1024); // 8MB

  const session: ManagedSession = {
    id: env.AGENTCTX_SESSION_ID,
    ptyProcess,
    terminalParser,
    ringBuffer,
    config,
    connectedClients: new Map(),
    activeWriter: null,
    startedAt: new Date(),
    ptyPid: ptyProcess.pid,
  };

  // Wire up PTY output
  ptyProcess.onData((data: string) => {
    // 1. Feed to terminal parser (maintains screen state)
    terminalParser.write(data);

    // 2. Append to ring buffer (for reconnection replay)
    ringBuffer.write(Buffer.from(data, 'utf-8'));

    // 3. Broadcast to all connected clients
    for (const [clientId, client] of session.connectedClients) {
      client.sendPtyData(data);
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    logger.info(
      `Managed session ${session.id} exited: code=${exitCode}, signal=${signal}`
    );
    this.emit('managed_session:exited', { sessionId: session.id, exitCode, signal });
    this.cleanupManagedSession(session);
  });

  return session;
}
```

#### Ring Buffer Implementation

The ring buffer stores the most recent 8MB of PTY output for reconnection replay. When a new client connects to a managed session, the ring buffer contents are replayed so the client sees the current terminal state.

```typescript
class RingBuffer {
  private buffer: Buffer;
  private writePos: number = 0;
  private totalWritten: number = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = Buffer.alloc(capacity);
  }

  write(data: Buffer): void {
    for (let i = 0; i < data.length; i++) {
      this.buffer[this.writePos] = data[i];
      this.writePos = (this.writePos + 1) % this.capacity;
    }
    this.totalWritten += data.length;
  }

  /**
   * Returns the contents of the ring buffer in chronological order.
   * If the buffer has wrapped, returns from the oldest data to the newest.
   */
  read(): Buffer {
    if (this.totalWritten <= this.capacity) {
      // Buffer hasn't wrapped yet — return from start to writePos
      return Buffer.from(this.buffer.subarray(0, this.writePos));
    }

    // Buffer has wrapped — return oldest (writePos) to newest (writePos - 1)
    const part1 = this.buffer.subarray(this.writePos);       // Older data
    const part2 = this.buffer.subarray(0, this.writePos);     // Newer data
    return Buffer.concat([part1, part2]);
  }

  get bytesWritten(): number {
    return this.totalWritten;
  }

  get usedBytes(): number {
    return Math.min(this.totalWritten, this.capacity);
  }

  clear(): void {
    this.writePos = 0;
    this.totalWritten = 0;
    this.buffer.fill(0);
  }
}
```

#### Server-Side Terminal Emulation

The `@xterm/headless` parser maintains a server-side representation of the terminal screen. This is used for:

1. **Screen snapshot**: When a mobile or web client connects, they can request the current screen state instead of replaying the entire ring buffer.
2. **Screen diffing**: Send only changed cells to clients for bandwidth optimization.
3. **Search**: Allow clients to search visible terminal content.

```typescript
function getScreenSnapshot(session: ManagedSession): ScreenSnapshot {
  const term = session.terminalParser;
  const lines: string[] = [];

  for (let row = 0; row < term.rows; row++) {
    const line = term.buffer.active.getLine(row);
    lines.push(line ? line.translateToString(true) : '');
  }

  return {
    lines,
    cursorX: term.buffer.active.cursorX,
    cursorY: term.buffer.active.cursorY,
    cols: term.cols,
    rows: term.rows,
  };
}
```

#### Dual Output Paths

Managed sessions have TWO independent output paths:

1. **PTY stream**: Raw terminal bytes, streamed to clients for terminal rendering. This provides real-time, character-by-character output.
2. **GC hook events**: Structured events captured by the usual GC hook mechanism. Since `claude` is running inside the managed PTY with the same hooks configured, `capture-event` fires as normal and writes to the event store. The daemon's watcher picks these up and streams them as `TimelineItem` events.

These paths serve different purposes:
- PTY stream: Rich, real-time terminal experience (for `agentctx agent attach` and xterm.js widgets)
- GC hook events: Structured data for search, analytics, sync, and projections

Both paths operate simultaneously. There is no conflict because they are read-only: the PTY stream is output from the process, and GC hooks write to separate files that the watcher reads.

#### Multi-Client Simultaneous Connection

Multiple clients can connect to the same managed session:

```typescript
interface ConnectedClient {
  id: string;
  type: 'terminal' | 'websocket' | 'sse';
  connectedAt: Date;
  lastActivity: Date;
  hasInputFocus: boolean;
  terminalSize?: { cols: number; rows: number };

  sendPtyData(data: string): void;
  sendTimelineEvent(event: TimelineItem): void;
  sendControlMessage(msg: ControlMessage): void;
}
```

When a client connects to a managed session:

1. Replay ring buffer contents to bring the client up to date.
2. If the client is a terminal (`agentctx agent attach`), also replay scrollback if available.
3. Begin streaming live PTY output.
4. Stream live GC hook events (timeline items) in parallel.

#### Acceptance Criteria

- [ ] `agentctx agent start` spawns `claude` inside a daemon-managed `node-pty` PTY
- [ ] The PTY uses `xterm-256color` TERM type with configurable initial dimensions (default 120x40)
- [ ] `@xterm/headless` maintains a server-side terminal state from PTY output
- [ ] An 8MB ring buffer stores recent PTY output for reconnection replay
- [ ] PTY output is broadcast to all connected clients in real time
- [ ] GC hooks fire normally inside the managed PTY (dual output path)
- [ ] Multiple clients can connect simultaneously to the same managed session
- [ ] New clients receive ring buffer replay on connection before live streaming begins
- [ ] The `AGENTCTX_MANAGED=1` environment variable is set inside the managed PTY
- [ ] When the `claude` process exits, the managed session is cleaned up and clients are notified
- [ ] Screen snapshots can be generated from the headless terminal parser on demand
- [ ] The ring buffer correctly handles wrap-around when more than 8MB has been written

---

### 5. Terminal Client Attachment (F12.5)

The `agentctx agent attach` command connects the user's terminal to a managed session's PTY, providing a native terminal experience identical to running `claude` directly.

#### Command Interface

```
agentctx agent attach <session-id>  [--read-only]

Arguments:
  <session-id>   Daemon session ID or partial match (first 8 chars)

Options:
  --read-only    Observe only, do not claim input focus
```

**Examples:**

```bash
# Attach to a specific session
agentctx agent attach abc12345-def6-7890-abcd-ef1234567890

# Attach using short ID (first 8 chars)
agentctx agent attach abc12345

# List sessions first, then attach
agentctx agent list
# ID         Project          Mode      Age    Clients
# abc12345   my-project       managed   5m     1
# def67890   other-project    observed  23m    0

agentctx agent attach abc12345

# Attach in read-only mode (no input forwarding)
agentctx agent attach abc12345 --read-only
```

#### Raw Terminal I/O Forwarding

When attached, the user's terminal enters raw mode. All keystrokes are forwarded to the daemon, which writes them to the PTY. All PTY output is forwarded back to the user's terminal.

```typescript
// Client-side (agentctx agent attach)
import * as net from 'net';
import * as readline from 'readline';

async function attachToSession(sessionId: string, readOnly: boolean): Promise<void> {
  // Connect to daemon via Unix socket or WebSocket
  const connection = await connectToDaemon();

  // Request attachment
  connection.send(JSON.stringify({
    type: 'attach',
    sessionId,
    readOnly,
    terminalSize: {
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    },
  }));

  // Wait for attachment confirmation
  const response = await connection.waitForMessage('attach_response');
  if (!response.success) {
    console.error(`Failed to attach: ${response.error}`);
    process.exit(1);
  }

  // Replay ring buffer (received as binary data)
  // This brings the terminal up to current state

  // Enter raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Forward stdin to daemon (unless read-only)
  if (!readOnly) {
    process.stdin.on('data', (data: Buffer) => {
      // Check for detach sequence: Ctrl+B d
      if (detachSequenceDetected(data)) {
        detach(connection);
        return;
      }
      connection.sendBinary(data);
    });
  }

  // Forward daemon PTY output to stdout
  connection.onBinaryMessage((data: Buffer) => {
    process.stdout.write(data);
  });

  // Handle terminal resize
  process.stdout.on('resize', () => {
    connection.send(JSON.stringify({
      type: 'resize',
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    }));
  });

  // Handle disconnection
  connection.on('close', () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    console.log('\nDisconnected from session.');
    process.exit(0);
  });
}
```

#### Detach Mechanism

The detach key sequence is **Ctrl+B d** (tmux-style). This is a two-key chord:

1. User presses Ctrl+B (0x02).
2. Within 500ms, user presses `d` (0x64).
3. The client detaches without stopping the agent.

```typescript
class DetachDetector {
  private ctrlBPressed: boolean = false;
  private ctrlBTimer: NodeJS.Timeout | null = null;
  private readonly CHORD_TIMEOUT_MS = 500;

  /**
   * Returns true if the detach sequence was detected.
   * All non-detach input is passed through via the callback.
   */
  processInput(data: Buffer, passthrough: (data: Buffer) => void): boolean {
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      if (this.ctrlBPressed) {
        this.clearTimer();
        this.ctrlBPressed = false;

        if (byte === 0x64) { // 'd'
          // Detach sequence detected — do NOT pass through
          // Pass through any remaining bytes after the 'd'
          if (i + 1 < data.length) {
            passthrough(data.subarray(i + 1));
          }
          return true;
        }

        // Not 'd' — pass through the buffered Ctrl+B and current byte
        passthrough(Buffer.from([0x02, byte]));
        continue;
      }

      if (byte === 0x02) { // Ctrl+B
        this.ctrlBPressed = true;
        this.ctrlBTimer = setTimeout(() => {
          // Timed out — pass through the Ctrl+B
          this.ctrlBPressed = false;
          passthrough(Buffer.from([0x02]));
        }, this.CHORD_TIMEOUT_MS);
        continue;
      }

      // Normal byte — pass through
      passthrough(Buffer.from([byte]));
    }

    return false;
  }

  private clearTimer(): void {
    if (this.ctrlBTimer) {
      clearTimeout(this.ctrlBTimer);
      this.ctrlBTimer = null;
    }
  }
}
```

#### Terminal Resize Forwarding (SIGWINCH)

When the user resizes their terminal window, the new dimensions must be forwarded to the daemon, which updates the managed PTY:

```typescript
// Daemon-side: handle resize from attached client
function handleClientResize(
  session: ManagedSession,
  clientId: string,
  cols: number,
  rows: number
): void {
  // Update client's recorded terminal size
  const client = session.connectedClients.get(clientId);
  if (client) {
    client.terminalSize = { cols, rows };
  }

  // Determine effective terminal size
  // Policy: use the active writer's terminal size, or the largest connected
  const effectiveSize = determineEffectiveSize(session);

  // Resize the PTY
  session.ptyProcess.resize(effectiveSize.cols, effectiveSize.rows);

  // Update the headless terminal parser
  session.terminalParser.resize(effectiveSize.cols, effectiveSize.rows);

  // Notify all clients of the size change
  for (const [id, c] of session.connectedClients) {
    if (id !== clientId) {
      c.sendControlMessage({
        type: 'resize',
        cols: effectiveSize.cols,
        rows: effectiveSize.rows,
      });
    }
  }
}

function determineEffectiveSize(session: ManagedSession): { cols: number; rows: number } {
  // If there is an active writer, use their size
  if (session.activeWriter) {
    const writer = session.connectedClients.get(session.activeWriter);
    if (writer?.terminalSize) {
      return writer.terminalSize;
    }
  }

  // Otherwise, use the minimum of all connected terminal clients
  // (ensures all clients can see all content)
  let minCols = 120;
  let minRows = 40;

  for (const [, client] of session.connectedClients) {
    if (client.type === 'terminal' && client.terminalSize) {
      minCols = Math.min(minCols, client.terminalSize.cols);
      minRows = Math.min(minRows, client.terminalSize.rows);
    }
  }

  return { cols: minCols, rows: minRows };
}
```

#### Acceptance Criteria

- [ ] `agentctx agent attach <id>` connects the terminal to a managed session's PTY
- [ ] Partial session ID matching works (first 8 characters)
- [ ] The terminal enters raw mode on attach, restores on detach
- [ ] All keystrokes are forwarded to the daemon's PTY (except the detach sequence)
- [ ] All PTY output is forwarded back to the user's terminal in real time
- [ ] Ctrl+B d (within 500ms) detaches without stopping the agent
- [ ] Ctrl+B followed by any other key (or timeout) passes both characters through
- [ ] Terminal resize events (SIGWINCH) are forwarded to the daemon
- [ ] The daemon resizes the PTY based on the active writer's terminal dimensions
- [ ] `--read-only` mode allows observation without input forwarding
- [ ] On connection, the ring buffer is replayed to bring the terminal up to current state
- [ ] On disconnection (network loss, terminal close), the client exits cleanly and the daemon session continues
- [ ] The attach command fails with a clear error if the session is not in managed mode

---

### 6. Detach/Reattach Lifecycle (F12.6)

Managed sessions persist independently of any client connection. The PTY keeps running even when all clients disconnect, enabling the "close laptop, reopen anywhere" workflow.

#### PTY Persistence

```typescript
class ManagedSessionLifecycle {
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Called when the last client disconnects from a managed session.
   */
  onAllClientsDisconnected(session: ManagedSession): void {
    logger.info(
      `All clients disconnected from session ${session.id}. ` +
      `PTY continues running (PID ${session.ptyPid}).`
    );

    // Start idle timeout
    this.startIdleTimer(session);

    // Emit event for monitoring
    this.emit('session:all_clients_disconnected', { sessionId: session.id });
  }

  /**
   * Called when a client reconnects to a managed session.
   */
  onClientReconnected(session: ManagedSession, clientId: string): void {
    logger.info(`Client ${clientId} reconnected to session ${session.id}`);

    // Cancel idle timeout
    this.cancelIdleTimer(session);

    // Replay ring buffer to bring client up to date
    const replayData = session.ringBuffer.read();
    const client = session.connectedClients.get(clientId);
    if (client && replayData.length > 0) {
      client.sendPtyData(replayData.toString('utf-8'));
    }
  }

  private startIdleTimer(session: ManagedSession): void {
    const timeoutMs = this.getIdleTimeout(session);
    if (timeoutMs <= 0) return; // Infinite idle allowed

    this.idleTimer = setTimeout(() => {
      logger.info(
        `Session ${session.id} idle timeout reached (${timeoutMs}ms). ` +
        `Sending SIGINT to claude process.`
      );
      this.gracefulShutdown(session);
    }, timeoutMs);
  }

  private cancelIdleTimer(_session: ManagedSession): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private getIdleTimeout(_session: ManagedSession): number {
    // Read from daemon config, with session-level override
    return this.config.get('session.idle_timeout_ms', this.DEFAULT_IDLE_TIMEOUT_MS);
  }

  private async gracefulShutdown(session: ManagedSession): Promise<void> {
    // Send SIGINT to claude process
    try {
      process.kill(session.ptyPid, 'SIGINT');
    } catch {
      // Process may have already exited
    }

    // Wait for exit, then cleanup
    setTimeout(() => {
      if (session.ptyProcess.pid) {
        // Force kill if still running
        try {
          process.kill(session.ptyPid, 'SIGKILL');
        } catch {
          // Already exited
        }
      }
    }, 5000);
  }
}
```

#### Configuration

Idle timeout and PTY persistence behavior are configurable in the daemon config:

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

| Setting | Default | Description |
|---------|---------|-------------|
| `idle_timeout_ms` | 86400000 (24h) | Time before an unattended managed session is shut down. Set to 0 for infinite. |
| `max_ring_buffer_bytes` | 8388608 (8MB) | Ring buffer size per managed session. |
| `max_managed_sessions` | 10 | Maximum simultaneous managed sessions. |
| `persist_on_daemon_restart` | true | If true, daemon attempts to re-adopt managed PTYs after restart (see Edge Case E-8). |

#### Laptop Lid Close Scenario

When a user closes their laptop:

1. The daemon process is suspended (SIGTSTP) or the system enters sleep.
2. On wake, the daemon resumes. The PTY is still running because `node-pty` processes survive sleep.
3. Any WebSocket connections from mobile/desktop apps may have been severed by the network change.
4. Clients reconnect and resume from the ring buffer.

**No special handling is needed** for sleep/wake — the daemon and PTY naturally persist. Network reconnection is handled by the client's WebSocket reconnection logic.

#### Reattach from Any Device

Reattachment works identically regardless of device:

- **Same terminal**: `agentctx agent attach <id>` — immediate, ring buffer replay.
- **Different terminal on same machine**: Same command, same behavior.
- **Mobile app**: WebSocket connection to daemon, ring buffer replay, xterm.js rendering.
- **Desktop app**: Same as mobile.
- **Web dashboard**: Same as mobile.
- **Different machine** (requires sync): Not covered in this story (requires F5 encrypted sync + relay).

#### Acceptance Criteria

- [ ] The PTY keeps running when all clients disconnect from a managed session
- [ ] Idle timeout is configurable (default 24 hours) and triggers graceful shutdown after the timeout
- [ ] Idle timeout is cancelled when a client reconnects
- [ ] On reconnection, the ring buffer is replayed to bring the client up to current terminal state
- [ ] Sleep/wake cycles do not kill managed sessions or the daemon
- [ ] Multiple consecutive detach/reattach cycles work without state corruption
- [ ] `max_managed_sessions` limits the number of concurrent managed sessions
- [ ] When the idle timeout fires, SIGINT is sent first, followed by SIGKILL after 5 seconds
- [ ] Session configuration overrides are respected per-session

---

### 7. Resume Handback (F12.7)

Resume Handback allows a managed or resumed session to be released back to the user's foreground terminal as a normal `claude` CLI session.

#### Terminal Reconnection

The primary way to interact with a managed session from a terminal is `agentctx agent attach`, as described in Requirement 5. This provides a tmux-like experience where the user's terminal is a thin client to the daemon's PTY.

#### Release to Foreground CLI

The `agentctx agent release` command stops the daemon-managed PTY and provides instructions for the user to resume the session in their own terminal:

```
agentctx agent release <session-id>

Arguments:
  <session-id>   Daemon session ID or partial match (first 8 chars)
```

**Release flow:**

```typescript
async function releaseSession(sessionId: string): Promise<void> {
  const session = this.getManagedSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found or not managed`);
  }

  // Step 1: Notify all connected clients that the session is being released
  for (const [clientId, client] of session.connectedClients) {
    client.sendControlMessage({
      type: 'session_releasing',
      sessionId: session.id,
      message: 'Session is being released to foreground CLI',
    });
  }

  // Step 2: Disconnect all clients gracefully
  for (const [clientId, client] of session.connectedClients) {
    client.sendControlMessage({ type: 'disconnect', reason: 'session_released' });
  }

  // Step 3: Send SIGINT to the claude process in the managed PTY
  process.kill(session.ptyPid, 'SIGINT');

  // Step 4: Wait for the claude process to exit
  await this.waitForProcessExit(session.ptyPid, 5000);

  // Step 5: Read the session state for the resume command
  const gcSessionId = session.gcSessionId || await this.findGcSessionId(session);

  // Step 6: Clean up the managed session
  this.cleanupManagedSession(session);

  // Step 7: Print resume instructions
  console.log(`Session released. Resume in your terminal with:`);
  console.log(`  claude --resume ${gcSessionId}`);
}
```

**`claude --resume` integration:**

Claude Code's `--resume` flag accepts a session ID and restores the conversation state. The user runs this in their own terminal to continue the session as a normal CLI session, no longer managed by the daemon. The daemon stops observing the session's GC hooks (or continues observing, at the user's preference).

**Example workflow:**

```bash
# Session is currently managed by the daemon
$ agentctx agent list
# ID         Project          Mode      Age    Clients
# abc12345   my-project       managed   2h     0

# Release it back to foreground
$ agentctx agent release abc12345
# Session released. Resume in your terminal with:
#   claude --resume sess_abc123def456

# Resume in the terminal
$ claude --resume sess_abc123def456
# Claude Code session resumed — continuing from where daemon left off
```

#### Acceptance Criteria

- [ ] `agentctx agent attach <id>` provides terminal reconnection to managed sessions
- [ ] `agentctx agent release <id>` stops the daemon-managed PTY and provides a resume command
- [ ] All connected clients are notified and disconnected before release
- [ ] SIGINT is sent to gracefully stop the `claude` process in the managed PTY
- [ ] The release command outputs the exact `claude --resume <session-id>` command for the user
- [ ] The GC session ID used for `--resume` is correctly extracted from session state
- [ ] After release, the session is no longer tracked as managed by the daemon
- [ ] If the user does not resume within a reasonable time, no data is lost (GC event store persists)

---

### 8. Session State Indicator (F12.8)

When a session is being observed or managed by the daemon, the CLI shows a status indicator so the user is aware of the daemon's presence.

#### Implementation via Environment Variable

The daemon sets environment variables inside managed sessions. For observed sessions, the GC hook system can be extended to communicate status:

**Managed sessions (environment variable):**

```bash
# Set by the daemon when spawning the managed PTY
export AGENTCTX_MANAGED=1
export AGENTCTX_SESSION_ID=abc12345-def6-7890
export AGENTCTX_CLIENTS=3
```

**Observed sessions (status file):**

For sessions that the user started independently (not in a managed PTY), the daemon writes a status file that the GC hook can read:

```bash
# Daemon writes this file when observing a session
# ~/.claude-context/status/{gc-session-id}.json
{
  "mode": "observed",
  "daemon_pid": 12345,
  "connected_clients": 2,
  "observing_since": "2026-02-21T10:30:00.000Z",
  "client_details": [
    { "type": "mobile", "connected_at": "2026-02-21T10:35:00.000Z" },
    { "type": "dashboard", "connected_at": "2026-02-21T10:32:00.000Z" }
  ]
}
```

#### CLI Status Line

The GC hook (specifically a modified `gc-hook` wrapper) checks for the status file or environment variables and, if present, outputs a status line to stderr on certain hook events (e.g., `SessionStart`, `TurnCompleted`):

```bash
# In gc-hook, after normal hook processing:
if [ -n "$AGENTCTX_MANAGED" ]; then
  client_count="${AGENTCTX_CLIENTS:-0}"
  echo "[AgentCtx: managed | ${client_count} clients connected]" >&2
elif [ -f "$STATUS_DIR/${session_id}.json" ]; then
  client_count=$(jq -r '.connected_clients // 0' "$STATUS_DIR/${session_id}.json" 2>/dev/null)
  echo "[AgentCtx: observed by ${client_count} clients]" >&2
fi
```

**What the user sees:**

```
> Fix the authentication bug in login.ts
[AgentCtx: observed by 2 clients]

Claude is working on fixing the authentication bug...
```

Or for managed sessions:

```
> Refactor the database layer
[AgentCtx: managed | 3 clients connected]

I'll start by examining the current database layer...
```

#### Client Count Updates

The daemon updates the status file (for observed sessions) or environment variable (not directly possible for running processes, so the status file is the primary mechanism for both modes) whenever a client connects or disconnects:

```typescript
async function updateSessionStatus(session: ObservedSession | ManagedSession): void {
  const statusDir = path.join(
    process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), '.claude-context'),
    'status'
  );
  await fs.mkdir(statusDir, { recursive: true });

  const statusFile = path.join(statusDir, `${session.gcSessionId}.json`);
  const status = {
    mode: session.mode,
    daemon_pid: process.pid,
    connected_clients: session.connectedClients.size,
    observing_since: session.startedAt.toISOString(),
    client_details: Array.from(session.connectedClients.values()).map(c => ({
      type: c.type,
      connected_at: c.connectedAt.toISOString(),
    })),
  };

  await fs.writeFile(statusFile, JSON.stringify(status, null, 2));
}
```

#### Acceptance Criteria

- [ ] Managed sessions have `AGENTCTX_MANAGED=1` and `AGENTCTX_SESSION_ID` environment variables set
- [ ] The daemon writes a status file to `~/.claude-context/status/{session-id}.json` for observed sessions
- [ ] The status file includes mode, connected client count, and client details
- [ ] The `gc-hook` wrapper reads the status file and outputs a status line to stderr
- [ ] The status line format is `[AgentCtx: observed by N clients]` for observed sessions
- [ ] The status line format is `[AgentCtx: managed | N clients connected]` for managed sessions
- [ ] The status file is updated when clients connect or disconnect
- [ ] The status file is cleaned up when the daemon stops observing a session
- [ ] The status line does not interfere with Claude Code's hook protocol (stderr only, never stdout)

---

### 9. Auto-Detect Running Sessions (F12.9)

When the daemon starts (or restarts), it scans for already-running `claude` processes and correlates them with recent events in the GC event store.

#### Startup Scan

```typescript
async function scanExistingSessions(): Promise<void> {
  logger.info('Scanning for existing claude sessions...');

  // Step 1: Find all running claude processes
  const processes = await findClaudeProcesses();
  logger.info(`Found ${processes.length} running claude process(es)`);

  if (processes.length === 0) return;

  // Step 2: Find recent sessions in the event store (last 24 hours)
  const recentSessions = await findRecentSessions(24 * 60 * 60 * 1000);

  // Step 3: Correlate processes with sessions
  for (const proc of processes) {
    const projectId = deriveProjectId(proc.cwd);
    const matchingSession = recentSessions.find(s => {
      if (s.projectId !== projectId) return false;

      // Check if the session is still active (no SessionEnded event)
      if (s.hasEnded) return false;

      // Check time proximity (process started near session start)
      const timeDiff = Math.abs(proc.startTime.getTime() - s.startedAt.getTime());
      return timeDiff < 60000; // Within 1 minute
    });

    if (matchingSession) {
      logger.info(
        `Correlating PID ${proc.pid} with session ` +
        `${matchingSession.sessionId} (project: ${matchingSession.projectId})`
      );

      await this.registerObservedSession(
        matchingSession.projectId,
        matchingSession.sessionId,
        matchingSession.lastEvent,
      );

      // Set the PID on the registered session
      const session = this.knownSessions.get(
        `${matchingSession.projectId}/${matchingSession.sessionId}`
      );
      if (session) {
        session.pid = proc.pid;
      }
    } else {
      logger.warn(
        `Found claude process PID ${proc.pid} in ${proc.cwd} ` +
        `but no matching session in event store`
      );
    }
  }
}
```

#### Finding Recent Sessions in Event Store

```typescript
interface RecentSession {
  projectId: string;
  sessionId: string;
  startedAt: Date;
  lastEvent: GCEvent;
  hasEnded: boolean;
  eventCount: number;
}

async function findRecentSessions(maxAgeMs: number): Promise<RecentSession[]> {
  const eventsDir = path.join(
    process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), '.claude-context'),
    'events'
  );

  const sessions: RecentSession[] = [];
  const cutoff = Date.now() - maxAgeMs;

  try {
    const projectDirs = await fs.readdir(eventsDir);
    for (const projectId of projectDirs) {
      const projectPath = path.join(eventsDir, projectId);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const sessionDirs = await fs.readdir(projectPath);
      for (const sessionId of sessionDirs) {
        const sessionPath = path.join(projectPath, sessionId);
        const sessionStat = await fs.stat(sessionPath);
        if (!sessionStat.isDirectory()) continue;

        // Check if modified recently enough
        if (sessionStat.mtimeMs < cutoff) continue;

        // Read the first event to get start time
        const eventFiles = (await fs.readdir(sessionPath))
          .filter(f => /^\d{6}\.json$/.test(f))
          .sort();

        if (eventFiles.length === 0) continue;

        const firstEvent = JSON.parse(
          await fs.readFile(path.join(sessionPath, eventFiles[0]), 'utf-8')
        );
        const lastEvent = JSON.parse(
          await fs.readFile(path.join(sessionPath, eventFiles[eventFiles.length - 1]), 'utf-8')
        );

        sessions.push({
          projectId,
          sessionId,
          startedAt: new Date(firstEvent.timestamp),
          lastEvent,
          hasEnded: lastEvent.event_type === 'SessionEnded',
          eventCount: eventFiles.length,
        });
      }
    }
  } catch (err) {
    logger.error('Failed to scan event store:', err);
  }

  return sessions;
}
```

#### Limitations of Process Detection

The `ps` / `/proc` approach has known limitations:

| Limitation | Description | Mitigation |
|------------|-------------|------------|
| Multiple `node` processes | Claude Code runs as a Node.js process. Grepping for "claude" in the command line may match unrelated Node processes. | Check for `claude` in the full command line, including the script path (e.g., `/usr/local/bin/claude`). |
| Short-lived processes | A `claude` process that starts and stops between daemon startup and scan will be missed. | The filesystem watcher (Requirement 1) handles ongoing detection; startup scan is best-effort. |
| No PID in event store | GC events do not include the PID of the `claude` process. Correlation is by working directory and time. | Accept that some processes may not correlate. |
| Different user | `claude` processes from other users are visible via `ps` but not accessible for signals. | Filter by UID matching the daemon's user. |
| Containerized processes | `claude` running in Docker/container may not be visible via `/proc`. | Out of scope — only local processes are detected. |

#### Acceptance Criteria

- [ ] On daemon startup, the daemon scans for running `claude` processes
- [ ] Running processes are correlated with recent sessions in the event store (last 24 hours)
- [ ] Correlation uses working directory (project ID) and start time proximity (within 60 seconds)
- [ ] Matched sessions are registered as Observed with the correct PID
- [ ] Unmatched processes are logged as warnings
- [ ] Sessions with a `SessionEnded` event are excluded from correlation
- [ ] The scan filters out `claude` processes owned by different users
- [ ] The scan completes within 5 seconds even with many projects/sessions in the event store
- [ ] The scan handles an empty event store gracefully

---

### 10. Conflict Prevention (F12.10)

Only one client may write input to a session at a time. This prevents garbled input from multiple simultaneous writers and maintains a clear model of session control.

#### Single-Writer Model

```typescript
type WriterState = {
  activeWriter: string | null;       // Client ID with write access
  pendingRequests: WriterRequest[];   // Clients waiting for control
};

interface WriterRequest {
  clientId: string;
  requestedAt: Date;
  message?: string;                  // Optional message: "Can I take over?"
}
```

**Operating modes and write access:**

| Session Mode | Who Can Write | How Write Access Changes |
|-------------|---------------|------------------------|
| **Observed** | Only the original CLI terminal | Cannot be changed (read-only for all daemon clients) |
| **Managed** | The client with input focus | Via "Request control" flow |
| **Resumed** | The client with input focus | Via "Request control" flow |

#### Writer Assignment for Managed Sessions

When the first client connects to a managed session, it automatically gets write access:

```typescript
function onClientConnected(session: ManagedSession, client: ConnectedClient): void {
  session.connectedClients.set(client.id, client);

  if (!session.activeWriter && !client.hasInputFocus === false) {
    // First writer — grant automatically
    session.activeWriter = client.id;
    client.hasInputFocus = true;
    client.sendControlMessage({ type: 'input_focus_granted' });
  } else {
    // Another client already has focus
    client.hasInputFocus = false;
    client.sendControlMessage({
      type: 'input_focus_denied',
      activeWriter: session.activeWriter,
    });
  }

  // Notify all clients of the new client count
  broadcastSessionUpdate(session);
}
```

#### Request Control Flow

```typescript
// Client → Server
interface RequestControlMessage {
  type: 'request_control';
  sessionId: string;
  message?: string;         // "I'd like to take over to fix a bug"
}

// Server → Current Writer
interface ControlRequestNotification {
  type: 'control_requested';
  sessionId: string;
  requestedBy: string;      // Client ID
  requestedByType: string;  // 'mobile', 'terminal', 'dashboard'
  message?: string;
}

// Current Writer → Server
interface ControlResponse {
  type: 'control_response';
  sessionId: string;
  granted: boolean;
}

// Server → Requester
interface ControlGranted {
  type: 'input_focus_granted';
}

interface ControlDenied {
  type: 'input_focus_denied';
  reason: 'rejected' | 'timeout';
}
```

**Request flow:**

```typescript
async function handleControlRequest(
  session: ManagedSession,
  requesterId: string,
  message?: string
): Promise<boolean> {
  if (!session.activeWriter) {
    // No active writer — grant immediately
    session.activeWriter = requesterId;
    const requester = session.connectedClients.get(requesterId);
    if (requester) {
      requester.hasInputFocus = true;
      requester.sendControlMessage({ type: 'input_focus_granted' });
    }
    return true;
  }

  const currentWriter = session.connectedClients.get(session.activeWriter);
  if (!currentWriter) {
    // Current writer disconnected — grant to requester
    session.activeWriter = requesterId;
    const requester = session.connectedClients.get(requesterId);
    if (requester) {
      requester.hasInputFocus = true;
      requester.sendControlMessage({ type: 'input_focus_granted' });
    }
    return true;
  }

  // Ask current writer for permission
  currentWriter.sendControlMessage({
    type: 'control_requested',
    sessionId: session.id,
    requestedBy: requesterId,
    requestedByType: session.connectedClients.get(requesterId)?.type || 'unknown',
    message,
  });

  // Wait for response (30 second timeout)
  const response = await this.waitForControlResponse(session, 30000);

  if (response?.granted) {
    // Transfer control
    currentWriter.hasInputFocus = false;
    currentWriter.sendControlMessage({ type: 'input_focus_revoked' });

    session.activeWriter = requesterId;
    const requester = session.connectedClients.get(requesterId);
    if (requester) {
      requester.hasInputFocus = true;
      requester.sendControlMessage({ type: 'input_focus_granted' });
    }
    return true;
  }

  // Denied or timed out
  const requester = session.connectedClients.get(requesterId);
  if (requester) {
    requester.sendControlMessage({
      type: 'input_focus_denied',
      reason: response ? 'rejected' : 'timeout',
    });
  }
  return false;
}
```

#### Simultaneous Input Handling

If two clients attempt to send input simultaneously (race condition before the single-writer model is enforced), only the active writer's input is forwarded to the PTY. Input from non-writers is silently dropped:

```typescript
function handleClientInput(session: ManagedSession, clientId: string, data: Buffer): void {
  if (session.activeWriter !== clientId) {
    // Not the active writer — drop input silently
    logger.debug(
      `Dropped input from non-writer client ${clientId} ` +
      `(active writer: ${session.activeWriter})`
    );

    // Notify the client that their input was dropped
    const client = session.connectedClients.get(clientId);
    if (client) {
      client.sendControlMessage({
        type: 'input_dropped',
        reason: 'not_active_writer',
      });
    }
    return;
  }

  // Forward to PTY
  session.ptyProcess.write(data.toString('utf-8'));
}
```

#### Acceptance Criteria

- [ ] Only one client at a time can send input to a managed session (single-writer model)
- [ ] Observed sessions are always read-only for daemon clients (CLI is the only writer)
- [ ] The first client to connect to a managed session automatically gets input focus
- [ ] Subsequent clients must use the "Request control" flow to gain input focus
- [ ] The current writer is notified when control is requested and can accept or deny
- [ ] Control request has a 30-second timeout; if the current writer does not respond, the request is denied
- [ ] When the active writer disconnects, the next client in the pending request queue (if any) gets focus
- [ ] Input from non-writer clients is silently dropped (not buffered, not queued)
- [ ] Clients are notified when their input is dropped due to not being the active writer
- [ ] All writer state changes are broadcast to all connected clients

---

### 11. Security Considerations

PTY access and session management must be secured to prevent unauthorized access.

#### PTY Access Control

Only authenticated clients may connect to a managed session's PTY. Authentication uses the daemon's existing authentication mechanism (which varies by connection type):

| Connection Type | Authentication Method |
|-----------------|----------------------|
| Unix socket (local) | Filesystem permissions (socket owned by user, mode 0700) |
| WebSocket (local) | Token-based (daemon generates a token on startup, stored in `~/.claude-context/daemon.json`) |
| WebSocket (remote via relay) | E2EE channel — only devices with the user's master key can decrypt |
| SSE (local dashboard) | Same token as WebSocket |

```typescript
// Daemon startup: generate authentication token
async function generateDaemonToken(): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const daemonConfig = {
    pid: process.pid,
    token,
    started_at: new Date().toISOString(),
    socket_path: this.socketPath,
    http_port: this.httpPort,
  };

  const configPath = path.join(
    process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), '.claude-context'),
    'daemon.json'
  );

  await fs.writeFile(configPath, JSON.stringify(daemonConfig, null, 2), { mode: 0o600 });
  return token;
}

// Client authentication middleware
function authenticateClient(req: IncomingMessage): boolean {
  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7);
  return token === this.daemonToken;
}
```

#### Session Takeover Authorization

Session takeover (Requirement 3) requires additional authorization beyond basic authentication:

1. **Same user check**: The daemon only manages sessions for the same OS user. Cross-user takeover is not supported.
2. **Client must be authenticated**: The requesting client must have a valid daemon token.
3. **Rate limiting**: No more than 3 takeover attempts per session per minute (prevents signal flooding).

```typescript
interface TakeoverRateLimit {
  sessionId: string;
  attempts: number;
  windowStart: Date;
}

function checkTakeoverRateLimit(sessionId: string): boolean {
  const limit = this.takeoverLimits.get(sessionId);
  const now = new Date();

  if (!limit || (now.getTime() - limit.windowStart.getTime()) > 60000) {
    // New window
    this.takeoverLimits.set(sessionId, {
      sessionId,
      attempts: 1,
      windowStart: now,
    });
    return true;
  }

  if (limit.attempts >= 3) {
    return false; // Rate limited
  }

  limit.attempts++;
  return true;
}
```

#### Rate Limiting on Attach/Detach

Rapid attach/detach cycles are rate-limited to prevent abuse:

| Operation | Limit | Window |
|-----------|-------|--------|
| Attach | 10 per session | 1 minute |
| Detach | 10 per session | 1 minute |
| Takeover | 3 per session | 1 minute |
| Request control | 5 per session | 1 minute |

#### No Cross-User Session Access

The daemon enforces that all managed and observed sessions belong to the same OS user:

```typescript
function validateSessionOwnership(session: ObservedSession): boolean {
  if (session.pid) {
    // Check that the process is owned by the same user
    try {
      const procStat = fs.readFileSync(`/proc/${session.pid}/status`, 'utf-8');
      const uidLine = procStat.split('\n').find(l => l.startsWith('Uid:'));
      if (uidLine) {
        const uid = parseInt(uidLine.split('\t')[1], 10);
        return uid === process.getuid();
      }
    } catch {
      // Cannot read /proc — allow on macOS (no /proc)
      return process.platform === 'darwin';
    }
  }
  return true; // Cannot verify — allow (session without PID)
}
```

#### File Permission Security

All daemon state files must have restrictive permissions:

| File | Permissions | Purpose |
|------|-------------|---------|
| `~/.claude-context/daemon.json` | 0600 | Daemon PID, auth token |
| `~/.claude-context/status/*.json` | 0600 | Session status files |
| Unix socket | 0700 (directory) | IPC socket |

#### Acceptance Criteria

- [ ] Only authenticated clients can connect to the daemon's WebSocket/HTTP API
- [ ] The daemon generates a random 256-bit token on startup, stored in `daemon.json` with 0600 permissions
- [ ] `agentctx` CLI reads the token from `daemon.json` for authentication
- [ ] Session takeover is rate-limited to 3 attempts per session per minute
- [ ] Attach/detach operations are rate-limited to 10 per session per minute
- [ ] The daemon verifies that managed processes belong to the same OS user
- [ ] Cross-user session access is denied with a clear error
- [ ] All daemon state files have restrictive permissions (0600 for files, 0700 for directories)
- [ ] The Unix socket is created in a directory with 0700 permissions
- [ ] Remote access via relay requires E2EE (implementation is in F10, but the interface is defined here)

---

## Edge Cases

### E-1: Daemon Starts After Claude Session Already Running

**Scenario**: The user starts a `claude` session in their terminal. Several minutes later, they start the AgentContext daemon. The daemon should detect the already-running session.

**Expected behavior**: On startup, the daemon scans for running `claude` processes (Requirement 9). It finds the process, correlates it with the session's events in the GC event store, and registers it as Observed. Connected clients can then see the session's timeline (all past events from the event store, plus live events going forward).

**Risk**: The session may have been running long enough that the working directory has changed, or the event store may have many sessions, making correlation ambiguous.

**Mitigation**: Correlation uses both working directory matching AND start time proximity. If ambiguous, the session is registered with `pid: null` (no takeover possible, but observation works). The user can manually associate the PID via `agentctx agent identify <session-id> --pid <pid>`.

---

### E-2: Network Drops During Remote Session Observation

**Scenario**: A mobile app is observing a session via WebSocket through the relay. The network connection drops (e.g., entering a tunnel).

**Expected behavior**: The WebSocket connection closes. The daemon continues processing events normally. When the mobile app reconnects, it re-subscribes to the session and receives any events it missed (the daemon's event store has the full history).

**Risk**: The mobile app may not realize the connection dropped, leading to a stale UI.

**Mitigation**: The daemon sends heartbeat messages every 30 seconds. The client-side WebSocket library detects missing heartbeats and triggers reconnection. On reconnect, the client sends its last-seen event sequence number, and the daemon replays events from that point forward.

---

### E-3: Takeover Fails — SIGINT Does Not Stop the Session

**Scenario**: The daemon sends SIGINT to the `claude` process, but the process does not stop (e.g., it has a custom signal handler, it is stuck in a blocking system call, or the PID was wrong).

**Expected behavior**: After the SIGINT timeout (5 seconds), the daemon sends SIGTERM. After an additional 3-second timeout, if the process is still running, the takeover is aborted. The session remains Observed. The requesting client receives an error: "Process did not respond to SIGINT or SIGTERM."

**Risk**: SIGKILL could be used as a last resort, but it would not give `claude` a chance to save session state, making resume impossible.

**Mitigation**: Do NOT escalate to SIGKILL during takeover. If SIGTERM fails, abort the takeover entirely. The user can manually kill the process and use `claude --resume` to restart. Document this edge case in the `agentctx agent takeover` error output.

---

### E-4: Multiple Claude Processes for Same Project

**Scenario**: The user has two `claude` sessions running in the same project directory (e.g., two terminal tabs both running `claude` in `/home/user/my-project`).

**Expected behavior**: Both sessions share the same `projectId` (derived from cwd), but each has a distinct `sessionId` in the GC event store. The daemon registers both as separate Observed sessions. Process correlation may assign the wrong PID to the wrong session if the start times are close.

**Risk**: Takeover could send SIGINT to the wrong `claude` process.

**Mitigation**: When multiple processes match the same project directory, and their start times are within 5 seconds of each other, the daemon marks both sessions as `pid: null` (ambiguous) and logs a warning. Takeover is disabled for sessions with ambiguous PIDs. The user can resolve the ambiguity via `agentctx agent identify`.

---

### E-5: User Runs `claude --resume` Manually After Takeover

**Scenario**: The daemon has taken over a session (Observed to Resumed). The user, in their original terminal, runs `claude --resume <session-id>` manually, creating a second instance of the same session.

**Expected behavior**: Two `claude` processes are now running with the same session ID. The GC event store receives events from both. The daemon detects the duplicate via the filesystem watcher (two processes writing to the same session directory) and logs a warning.

**Risk**: The two `claude` processes may corrupt each other's session state. Claude Code's own session management may reject the resume if it detects an active session.

**Mitigation**: Claude Code itself should prevent duplicate resumes (it likely locks the session file). If both processes do run, the daemon tracks both and marks the session as "conflicted." Users are warned via the session state indicator: `[AgentCtx: CONFLICT — multiple writers detected]`. The user must manually resolve by stopping one of the processes.

---

### E-6: PTY Buffer Overflow (Very Long-Running Managed Session)

**Scenario**: A managed session runs for 12+ hours, producing hundreds of megabytes of PTY output. The ring buffer is only 8MB.

**Expected behavior**: The ring buffer wraps around, discarding the oldest data. When a client reconnects, they see the most recent 8MB of terminal output. This is sufficient to reconstruct the current terminal screen state (typically the last few hundred lines), but not the full session history.

**Risk**: A client that disconnected for a long time may see an incomplete terminal state on reconnection. The ring buffer replay may start mid-ANSI-escape-sequence, causing rendering artifacts.

**Mitigation**: On reconnection, the daemon first sends a "reset terminal" escape sequence (`\x1bc`) before replaying the ring buffer. This clears any stale state. Additionally, the daemon can send the current screen snapshot from the `@xterm/headless` parser instead of the ring buffer when the buffer has wrapped more than once. The GC hook events (structured data) are always available in the event store regardless of ring buffer state, so the session's structured timeline is never lost.

---

### E-7: Terminal Size Mismatch Between Clients

**Scenario**: A terminal client (120x40) and a mobile client (80x24) are both connected to the same managed session. The PTY can only have one size.

**Expected behavior**: The PTY size follows the active writer's terminal size. If the terminal client has input focus, the PTY is 120x40. If the mobile client requests control and gets it, the PTY resizes to 80x24.

**Risk**: The non-active client sees content that does not fit their screen, causing wrapping or truncation. Rapid size changes when control transfers back and forth cause Claude Code to see constant terminal resize events.

**Mitigation**: When no client has input focus (all are read-only), use the minimum dimensions of all connected terminal clients to ensure content is visible to all. Log a warning when the size difference between clients exceeds 50% in either dimension. Clients with smaller terminals can scroll horizontally if their rendering surface supports it (xterm.js does, native mobile may need to implement pinch-to-zoom).

---

### E-8: Daemon Crashes While Managing a PTY Session

**Scenario**: The daemon process crashes (segfault, OOM kill, unhandled exception) while managing one or more PTY sessions. The `claude` processes inside the PTYs are orphaned.

**Expected behavior**: When `node-pty` parent process exits, the child processes receive SIGHUP. Claude Code may or may not handle SIGHUP gracefully. If `claude` survives, it continues running as an orphan process.

**Risk**: Orphaned `claude` processes continue running with no management. If the daemon restarts, it cannot reconnect to the orphaned PTYs (the PTY file descriptors are lost with the daemon process).

**Mitigation**:

1. **Pre-crash**: The daemon writes managed session metadata (PID, session ID, cwd) to a persistent state file (`~/.claude-context/managed-sessions.json`). This file is updated on every session state change.

2. **On restart**: The daemon reads `managed-sessions.json`, checks which PIDs are still running, and for surviving processes:
   - Registers them as Observed (not Managed — the PTY connection is lost).
   - Offers to take them over again (kill and resume under a new PTY).
   - Cleans up entries for processes that are no longer running.

```typescript
interface PersistedManagedSession {
  id: string;
  ptyPid: number;
  gcSessionId: string;
  projectId: string;
  cwd: string;
  startedAt: string;
}

async function recoverManagedSessions(): Promise<void> {
  const stateFile = path.join(
    process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), '.claude-context'),
    'managed-sessions.json'
  );

  try {
    const data = await fs.readFile(stateFile, 'utf-8');
    const sessions: PersistedManagedSession[] = JSON.parse(data);

    for (const persisted of sessions) {
      const isRunning = await isProcessRunning(persisted.ptyPid);

      if (isRunning) {
        logger.info(
          `Found orphaned managed process PID ${persisted.ptyPid} ` +
          `(session ${persisted.id}). Registering as observed.`
        );

        // Register as observed — we lost the PTY but the process is alive
        await this.registerObservedSession(
          persisted.projectId,
          persisted.gcSessionId,
          { timestamp: persisted.startedAt } as GCEvent,
        );

        const session = this.knownSessions.get(
          `${persisted.projectId}/${persisted.gcSessionId}`
        );
        if (session) {
          session.pid = persisted.ptyPid;
          session.metadata.recoveredFromCrash = true;
        }
      } else {
        logger.info(
          `Previous managed process PID ${persisted.ptyPid} is no longer running. ` +
          `Cleaning up session ${persisted.id}.`
        );
      }
    }

    // Clear the state file
    await fs.writeFile(stateFile, '[]');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error('Failed to recover managed sessions:', err);
    }
  }
}
```

3. **Prevention**: The daemon uses `process.on('uncaughtException')` and `process.on('SIGTERM')` to attempt graceful cleanup of managed sessions before exiting.

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | Filesystem watcher detects a new `.json` file in the events directory and emits an event |
| T-2 | Filesystem watcher ignores `.lock` and `.tmp` files |
| T-3 | `parseEventPath` correctly extracts projectId, sessionId, and sequence from a file path |
| T-4 | `parseEventPath` returns null for invalid paths (wrong depth, non-numeric filename) |
| T-5 | Process correlation matches a `claude` process to a session by working directory |
| T-6 | Process correlation selects the closest match by start time when multiple processes match |
| T-7 | Process correlation returns null when no processes match |
| T-8 | Event normalization correctly converts all 10 GC event types to `TimelineItem` format |
| T-9 | Ring buffer correctly stores and retrieves data smaller than capacity |
| T-10 | Ring buffer correctly wraps around when data exceeds capacity |
| T-11 | Ring buffer `read()` returns data in chronological order after wrap |
| T-12 | Detach detector recognizes Ctrl+B d chord within 500ms |
| T-13 | Detach detector passes through Ctrl+B followed by non-d key |
| T-14 | Detach detector passes through Ctrl+B after 500ms timeout |
| T-15 | Single-writer model prevents non-writer input from reaching the PTY |
| T-16 | Request control flow correctly transfers focus between clients |
| T-17 | Control request times out after 30 seconds if current writer does not respond |
| T-18 | Takeover rate limiter allows 3 attempts per minute and blocks the 4th |
| T-19 | `determineEffectiveSize` returns the active writer's size when a writer is set |
| T-20 | `determineEffectiveSize` returns the minimum of all terminal sizes when no writer is set |
| T-21 | Session status file is correctly written with client count and mode |
| T-22 | Daemon token generation produces a 64-character hex string |

### Integration Tests

| Test | Description |
|------|-------------|
| T-23 | Start daemon, start `claude` in a separate terminal, verify daemon detects the session within 5 seconds |
| T-24 | Observed session events stream to WebSocket client in real time (< 200ms latency) |
| T-25 | Takeover flow: Observed session → SIGINT → SessionEnded → Managed session spawn → client receives control |
| T-26 | Takeover aborts cleanly when SIGINT and SIGTERM both fail (process stuck) |
| T-27 | Managed session PTY: `agentctx agent start` spawns claude, output streams to WebSocket client |
| T-28 | `agentctx agent attach` connects terminal to managed session, keystrokes reach claude |
| T-29 | Ctrl+B d detaches terminal client without stopping the managed session |
| T-30 | Ring buffer replay: disconnect client, wait for new output, reconnect, verify replay includes missed output |
| T-31 | Multi-client: two WebSocket clients connected to same managed session both receive PTY output |
| T-32 | Request control: client B requests control from client A, A grants, B's input reaches PTY |
| T-33 | `agentctx agent release` stops managed session and outputs correct `claude --resume` command |
| T-34 | Idle timeout: start managed session, disconnect all clients, verify session stops after configured timeout |
| T-35 | Daemon restart recovery: crash daemon while managing a session, restart, verify orphaned process is detected |
| T-36 | Session state indicator: start observed session, verify `[AgentCtx: observed by N clients]` appears |
| T-37 | Rate limiting: attempt 4 takeovers in 1 minute, verify 4th is rejected |
| T-38 | Authentication: attempt WebSocket connection without token, verify rejection |
| T-39 | Cross-user: verify daemon rejects observation of claude process owned by different user |

### Manual Verification

| Test | Description |
|------|-------------|
| M-1 | Start `claude` in terminal, start daemon, open dashboard, verify session appears with live events |
| M-2 | Use mobile app to observe a session, then tap "Take Over," verify session transitions to managed and terminal shows message |
| M-3 | Start managed session, attach from terminal, type a prompt, verify Claude responds, detach with Ctrl+B d, verify session continues |
| M-4 | Close laptop lid with managed session running, reopen, `agentctx agent attach`, verify session is intact with ring buffer replay |
| M-5 | Two terminals attached to same managed session: verify only the active writer's input is processed |
| M-6 | Release a managed session, run `claude --resume` in terminal, verify conversation continues seamlessly |
| M-7 | Start daemon after `claude` is already running, verify daemon picks up the existing session |
| M-8 | Kill the daemon process while a managed session is running, restart daemon, verify recovery behavior |

---

## Definition of Done

- [ ] Filesystem watcher detects new sessions and events in `~/.claude-context/events/` within 200ms
- [ ] Observed sessions stream GC hook events to all subscribed WebSocket/SSE clients
- [ ] Session takeover flow (SIGINT, wait for SessionEnded, spawn managed) works end-to-end
- [ ] Managed sessions use `node-pty` with `@xterm/headless` for server-side terminal emulation
- [ ] 8MB ring buffer enables reconnection replay for managed sessions
- [ ] `agentctx agent attach <id>` connects terminal with raw I/O forwarding and Ctrl+B d detach
- [ ] PTY persists when all clients disconnect; idle timeout is configurable
- [ ] `agentctx agent release <id>` releases managed session back to foreground CLI with `--resume` command
- [ ] Session state indicator shows observation/management status in CLI via status file
- [ ] Startup scan detects already-running `claude` processes and correlates with event store
- [ ] Single-writer model prevents simultaneous input; "Request control" flow transfers focus
- [ ] Daemon authentication via token prevents unauthorized access to PTY sessions
- [ ] Rate limiting prevents signal flooding and attach/detach abuse
- [ ] Daemon crash recovery re-adopts orphaned processes as observed sessions
- [ ] All 22 unit tests pass
- [ ] All 17 integration tests pass
- [ ] Latency from hook fire to client notification is under 200ms for observed sessions
- [ ] Managed session PTY output reaches clients within 50ms
- [ ] Code handles all 8 documented edge cases with appropriate behavior
