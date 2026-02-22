# Story 14: Mobile App (Paseo Fork)

## Overview

The Mobile App is a native iOS and Android application forked from Paseo's existing Expo/React Native app. It is the primary remote interface for managing agents, reviewing session history, and interacting with daemons running on development machines. The app connects to one or more AgentContext daemons via direct LAN connections or the Cloudflare E2EE relay, providing a unified view of all agents across all machines.

This story covers the **app shell, navigation, data layer, and all features NOT related to session rendering**. The actual CLI-to-mobile rendering (structured event cards, streaming text, diff components, terminal emulator widget) is specified in Story 08 (F13). This story covers the container those rendering components live in, plus all app-level features: multi-daemon registry, QR pairing, session history browsing, usage dashboard, push notifications, file explorer, voice input, encryption key management, and offline mode.

**Guiding principle**: The mobile app is a remote control, not a replacement for the CLI. Users should be able to monitor, review, and intervene from their phone -- but the heavy lifting happens on their development machines. Every screen must load fast, even on slow cellular connections, because the user might be checking on a long-running agent from a coffee shop.

---

## Scope

### In Scope

- Expo/React Native app shell and navigation structure
- Multi-daemon registry with AsyncStorage persistence (F6.1)
- QR code pairing for daemon connection (F6.2)
- Unified agent view across all machines (F6.3)
- Agent interaction: prompts, streaming output, permission approval (F6.4)
- Session history browsing with cross-machine search (F6.5)
- Usage dashboard with charts (F6.6)
- Push notifications for agent events (F6.7)
- Diff viewer shell (F6.8; rendering details in Story 08/F13.3)
- File explorer for remote workspace browsing (F6.9)
- Voice input for hands-free prompting (F6.10)
- Encryption key management with Keychain/Keystore (F6.11)
- QR key transfer between devices (F6.12)
- Offline mode with cached session history (F6.13)

### Out of Scope (Non-Goals)

- CLI session rendering components (Story 08 / F13)
- Structured event renderer, streaming text renderer, terminal emulator widget (F13.1-F13.14)
- Desktop app / Tauri wrapper (F7)
- GitHub integration UI (F8; separate story)
- Sync server implementation (F9)
- Encryption algorithm implementation (F10; this story consumes the crypto API)
- Account management / registration (F9.8)
- Codex agent provider (F1.3)
- Session takeover / managed session PTY proxy (F12.3-F12.7)

---

## Requirements

### 1. App Shell & Navigation

The app uses React Navigation v6+ with a bottom tab navigator as the root, a stack navigator per tab, and modal overlays for QR scanning and settings.

#### Navigation Structure

```
Root (BottomTabNavigator)
  |
  +-- Agents Tab (StackNavigator)
  |     |-- AgentListScreen (unified, all machines)
  |     |-- AgentDetailScreen (single agent: streaming output, interaction)
  |     +-- AgentSessionScreen (live session view -- delegates to Story 08 components)
  |
  +-- Sessions Tab (StackNavigator)
  |     |-- SessionListScreen (history across all machines, search)
  |     |-- SessionDetailScreen (event timeline -- delegates to Story 08 components)
  |     +-- SessionFileExplorerScreen (remote file browser)
  |
  +-- Dashboard Tab (StackNavigator)
  |     |-- UsageDashboardScreen (token usage, charts)
  |     +-- ProjectUsageDetailScreen (per-project breakdown)
  |
  +-- Settings Tab (StackNavigator)
        |-- SettingsScreen (main settings)
        |-- DaemonRegistryScreen (list of registered machines)
        |-- DaemonDetailScreen (single machine: connection info, status)
        |-- EncryptionKeyScreen (key status, biometric settings)
        |-- QRScannerScreen (modal overlay for pairing and key transfer)
        +-- NotificationSettingsScreen (per-event-type toggles)

Modal Overlays (presented over any tab):
  |-- QRScannerModal (camera-based QR scanner)
  +-- PairConfirmationModal (confirm pairing with new daemon)
```

#### Tab Bar Configuration

```typescript
// types/navigation.ts
type RootTabParamList = {
  AgentsTab: undefined;
  SessionsTab: undefined;
  DashboardTab: undefined;
  SettingsTab: undefined;
};
```

| Tab | Icon | Badge |
|-----|------|-------|
| Agents | `terminal-outline` | Count of agents needing attention (permission requests, errors) |
| Sessions | `time-outline` | Unread session count (sessions updated since last viewed) |
| Dashboard | `bar-chart-outline` | None |
| Settings | `settings-outline` | None (red dot if key management action needed) |

#### Theme

The app uses a dark theme by default (matching terminal aesthetics). Light theme is available via settings toggle.

```typescript
// theme/colors.ts
const DarkTheme = {
  background: '#0D1117',       // GitHub Dark-style background
  surface: '#161B22',          // Card backgrounds
  surfaceElevated: '#1C2128',  // Elevated surfaces (modals)
  text: '#E6EDF3',             // Primary text
  textSecondary: '#8B949E',    // Secondary text
  accent: '#58A6FF',           // Links, active elements
  success: '#3FB950',          // Completed, connected
  warning: '#D29922',          // Needs attention
  error: '#F85149',            // Errors, disconnected
  border: '#30363D',           // Borders, separators
};
```

#### Acceptance Criteria

- [ ] Bottom tab navigator renders with 4 tabs: Agents, Sessions, Dashboard, Settings
- [ ] Each tab has its own stack navigator for push/pop navigation
- [ ] QR scanner presents as a modal overlay (not a pushed screen)
- [ ] Badge counts update in real time as daemon events arrive
- [ ] Tab bar hides during full-screen views (agent interaction, session detail)
- [ ] Deep links from push notifications navigate to the correct screen
- [ ] Navigation state persists across app backgrounding/foregrounding
- [ ] Dark theme is default; light theme toggle in Settings
- [ ] All screens handle safe area insets (notch, home indicator)
- [ ] Navigation transitions complete in under 200ms

---

### 2. Multi-Daemon Registry (F6.1)

Users register multiple development machines (daemons) in the app. Each daemon is represented by a `HostProfile` and persisted in AsyncStorage. The app maintains concurrent WebSocket connections to all registered daemons.

#### HostProfile Data Structure

```typescript
// types/daemon.ts
interface HostProfile {
  id: string;                     // UUID, generated on pairing
  name: string;                   // User-provided label (e.g., "Work MacBook", "Linux VM")
  hostname: string;               // Machine hostname from daemon
  connectionType: 'lan' | 'relay';
  lanAddress?: string;            // e.g., "192.168.1.42:9120"
  relayServerId?: string;         // Paseo relay server ID for E2EE connections
  publicKey: string;              // Daemon's Curve25519 public key (base64)
  pairedAt: string;               // ISO 8601 timestamp
  lastSeen: string;               // ISO 8601 timestamp of last successful communication
  connectionState: ConnectionState;
  daemonVersion: string;          // Daemon software version
  os: 'linux' | 'macos' | 'windows';
  machineId: string;              // Daemon's unique machine identifier
}

type ConnectionState = 'connected' | 'disconnected' | 'connecting' | 'error';

interface DaemonRegistryState {
  hosts: HostProfile[];
  activeConnections: Map<string, WebSocket>;
}
```

#### AsyncStorage Persistence

```typescript
// storage/daemon-registry.ts
const REGISTRY_KEY = '@agentctx/daemon-registry';

async function loadRegistry(): Promise<HostProfile[]> {
  const raw = await AsyncStorage.getItem(REGISTRY_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveRegistry(hosts: HostProfile[]): Promise<void> {
  await AsyncStorage.setItem(REGISTRY_KEY, JSON.stringify(hosts));
}

async function addHost(host: HostProfile): Promise<void> {
  const hosts = await loadRegistry();
  hosts.push(host);
  await saveRegistry(hosts);
}

async function removeHost(hostId: string): Promise<void> {
  const hosts = await loadRegistry();
  await saveRegistry(hosts.filter(h => h.id !== hostId));
}

async function updateHost(hostId: string, updates: Partial<HostProfile>): Promise<void> {
  const hosts = await loadRegistry();
  const idx = hosts.findIndex(h => h.id === hostId);
  if (idx >= 0) {
    hosts[idx] = { ...hosts[idx], ...updates };
    await saveRegistry(hosts);
  }
}
```

#### Connection Management

The app maintains a persistent WebSocket connection to each registered daemon. Connections are managed by a `ConnectionManager` singleton.

```typescript
// services/connection-manager.ts
class ConnectionManager {
  private connections: Map<string, DaemonConnection> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  async connectAll(hosts: HostProfile[]): Promise<void>;
  async connect(host: HostProfile): Promise<void>;
  async disconnect(hostId: string): Promise<void>;
  async disconnectAll(): Promise<void>;

  getConnection(hostId: string): DaemonConnection | undefined;
  getConnectionState(hostId: string): ConnectionState;

  // Event emitter for connection state changes
  onConnectionStateChange(callback: (hostId: string, state: ConnectionState) => void): void;
}
```

Connection lifecycle:

1. On app launch, load all `HostProfile` entries from AsyncStorage.
2. For each host, attempt connection based on `connectionType`:
   - `lan`: Direct WebSocket to `ws://{lanAddress}/ws`
   - `relay`: E2EE WebSocket through `wss://relay.agentctx.dev` using Paseo's relay protocol
3. On successful connection, update `connectionState` to `'connected'` and `lastSeen`.
4. On connection drop, set `connectionState` to `'disconnected'` and begin exponential backoff reconnection (1s, 2s, 4s, 8s, max 60s).
5. On app background (AppState change), connections remain open but reduce heartbeat frequency (from 10s to 30s).
6. On app foreground, immediately send heartbeat to all connections and refresh agent data.

#### DaemonConnection Interface

```typescript
// services/daemon-connection.ts
interface DaemonConnection {
  hostId: string;
  ws: WebSocket;
  state: ConnectionState;

  // Agent operations
  listAgents(): Promise<AgentSummary[]>;
  getAgent(agentId: string): Promise<AgentDetail>;
  sendPrompt(agentId: string, prompt: string): Promise<void>;
  approvePermission(agentId: string, toolUseId: string): Promise<void>;
  denyPermission(agentId: string, toolUseId: string): Promise<void>;

  // Session operations
  listSessions(filter?: SessionFilter): Promise<SessionSummary[]>;
  getSessionEvents(sessionId: string, cursor?: string): Promise<SessionEventsPage>;

  // File operations
  listFiles(agentId: string, path: string): Promise<FileEntry[]>;
  getFileContent(agentId: string, filePath: string): Promise<string>;

  // Usage operations
  getUsageStats(range: DateRange): Promise<UsageStats>;

  // Streaming
  subscribeToAgent(agentId: string, callback: (event: AgentStreamEvent) => void): Unsubscribe;
  subscribeToEvents(callback: (event: DaemonEvent) => void): Unsubscribe;
}
```

#### Acceptance Criteria

- [ ] `HostProfile` data persists across app restarts via AsyncStorage
- [ ] Users can register up to 10 daemons (soft limit, configurable)
- [ ] LAN connections use direct WebSocket (`ws://`)
- [ ] Relay connections use E2EE WebSocket through Paseo relay (`wss://`)
- [ ] Connection state is tracked per daemon: `connected`, `disconnected`, `connecting`, `error`
- [ ] Disconnected daemons reconnect with exponential backoff (1s-60s)
- [ ] All registered daemons are connected concurrently on app launch
- [ ] Connection state changes propagate to UI within 100ms
- [ ] Removing a host closes its connection and deletes its `HostProfile` from AsyncStorage
- [ ] App functions normally with a mix of connected and disconnected daemons (disconnected ones show greyed-out data)

---

### 3. QR Code Pairing (F6.2)

Users pair the app with a daemon by scanning a QR code displayed by the daemon (on the local dashboard or terminal). The QR encodes connection information and an ephemeral public key for establishing an E2EE channel.

#### QR Payload Format

The daemon generates a QR code containing a JSON payload encoded as a URL:

```
agentctx://pair?data=<base64url-encoded-json>
```

The decoded JSON payload:

```json
{
  "version": 1,
  "hostname": "work-macbook",
  "os": "macos",
  "daemonVersion": "1.0.0",
  "machineId": "a3f7b2c9d1e4",
  "lan": {
    "address": "192.168.1.42",
    "port": 9120
  },
  "relay": {
    "serverId": "server-abc123def456"
  },
  "ephemeralPublicKey": "base64-encoded-curve25519-public-key",
  "expiresAt": "2026-02-21T15:00:00Z",
  "nonce": "base64-encoded-random-nonce"
}
```

#### Pairing Flow

```
Daemon (Machine)                         Phone (App)
   |                                         |
   |  1. Generate ephemeral Curve25519       |
   |     keypair                             |
   |  2. Display QR code with payload        |
   |                                         |
   |                                    3. User opens QR scanner
   |                                    4. Parse QR → validate payload
   |                                    5. Check expiry (reject if > 5 min old)
   |                                    6. Generate own ephemeral keypair
   |                                    7. Compute shared secret: ECDH(myPriv, theirPub)
   |                                         |
   |  <--- 8. Connect to daemon (LAN first, fallback relay) --->
   |                                         |
   |  <--- 9. Exchange public keys over connection --->
   |                                         |
   |  10. Daemon verifies shared secret      |
   |      matches its ephemeral key          |
   |                                         |
   |  11. Daemon sends HostProfile data      |
   |      (encrypted with shared secret)     |
   |                                    12. Decrypt, validate, display
   |                                        confirmation screen:
   |                                        "Pair with work-macbook (macOS)?"
   |                                    13. User confirms
   |                                    14. Store HostProfile in AsyncStorage
   |                                    15. Establish persistent connection
   |                                         |
   |  16. Daemon marks phone as paired       |
   |      client                             |
   |                                         |
```

#### Camera Permission Handling

The app must request camera permission before opening the QR scanner. On iOS and Android:

```typescript
// hooks/useCamera.ts
async function requestCameraPermission(): Promise<'granted' | 'denied' | 'blocked'> {
  const { status } = await Camera.requestCameraPermissionsAsync();
  if (status === 'granted') return 'granted';

  // Check if permanently denied (user selected "Don't Allow")
  const { canAskAgain } = await Camera.getCameraPermissionsAsync();
  return canAskAgain ? 'denied' : 'blocked';
}
```

When permission is `'blocked'`, display a screen explaining why camera access is needed, with a button to open device Settings.

#### QR Scanner Component

```typescript
// components/QRScanner.tsx
interface QRScannerProps {
  onScan: (payload: PairingPayload) => void;
  onError: (error: QRScanError) => void;
  onClose: () => void;
}

type QRScanError =
  | { type: 'INVALID_FORMAT'; message: string }
  | { type: 'EXPIRED'; message: string }
  | { type: 'PARSE_ERROR'; message: string }
  | { type: 'CAMERA_ERROR'; message: string };
```

The scanner uses `expo-camera` with the barcode scanner configuration. It processes only the first valid `agentctx://pair` QR code detected, then pauses scanning while the pairing confirmation modal is displayed.

#### Pairing Confirmation UI

After scanning a valid QR code, the app displays a confirmation modal:

```
+---------------------------------------+
|         Pair with new machine?        |
|                                       |
|  [computer icon]                      |
|                                       |
|  Name: work-macbook                   |
|  OS: macOS                            |
|  Daemon: v1.0.0                       |
|  Connection: LAN (192.168.1.42)       |
|                                       |
|  [Cancel]           [Pair]            |
+---------------------------------------+
```

The user can edit the machine name before confirming.

#### Acceptance Criteria

- [ ] QR scanner opens as a modal overlay with camera preview
- [ ] Camera permission is requested before opening scanner; blocked state shows instructions to enable in Settings
- [ ] QR payload is validated: correct URL scheme (`agentctx://pair`), valid JSON, required fields present
- [ ] Expired QR codes (> 5 minutes old) are rejected with a clear error
- [ ] Pairing confirmation modal shows machine name, OS, version, and connection type
- [ ] User can edit the machine name before confirming
- [ ] On confirmation, `HostProfile` is created and persisted in AsyncStorage
- [ ] LAN connection is attempted first; if unreachable, falls back to relay
- [ ] Ephemeral keys are destroyed after pairing completes
- [ ] Scanning the same daemon's QR twice updates the existing `HostProfile` rather than creating a duplicate
- [ ] Error states (invalid QR, expired, network error) show user-friendly messages with retry option

---

### 4. Unified Agent View (F6.3)

The Agents tab shows all agents across all connected daemons in a single, sortable, filterable list. Users see at a glance which agents are running, idle, waiting for permission, or errored.

#### AgentSummary Data Structure

```typescript
// types/agent.ts
interface AgentSummary {
  id: string;                        // Unique agent ID (from daemon)
  hostId: string;                    // Which daemon this agent belongs to
  hostName: string;                  // Human-readable daemon name
  provider: 'claude-code' | 'opencode' | 'codex';
  model: string;                     // e.g., "claude-opus-4-6"
  status: AgentStatus;
  projectName: string;               // Basename of working directory
  projectPath: string;               // Full path on remote machine
  currentActivity?: string;          // Brief description (e.g., "Running Bash command")
  lastPrompt?: string;               // Truncated last user prompt (first 100 chars)
  sessionId: string;
  startedAt: string;                 // ISO 8601
  lastActivityAt: string;            // ISO 8601
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    estimatedCost: number;           // In USD
  };
  pendingPermissions: number;        // Count of pending permission requests
}

type AgentStatus =
  | 'initializing'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'error'
  | 'completed'
  | 'disconnected';                  // Host is disconnected
```

#### Agent List Screen

```typescript
// screens/AgentListScreen.tsx
interface AgentListScreenState {
  agents: AgentSummary[];
  sortBy: 'lastActivity' | 'machine' | 'status' | 'project';
  sortDirection: 'asc' | 'desc';
  filterMachine: string | null;      // null = all machines
  filterProvider: string | null;     // null = all providers
  filterStatus: AgentStatus | null;  // null = all statuses
  isRefreshing: boolean;
}
```

Features:

- **Pull-to-refresh**: Triggers a re-fetch of agent lists from all connected daemons.
- **Sort**: Tap column header to sort. Default sort is by `lastActivityAt` descending (most recently active first).
- **Filter chips**: Horizontal scrollable row of filter chips at the top: Machine (dropdown), Provider (multi-select), Status (multi-select).
- **Agent card**: Each agent is rendered as a card showing:
  - Status indicator (colored dot: green=running, yellow=waiting, red=error, grey=idle/disconnected)
  - Project name (bold)
  - Machine name (subtle, below project)
  - Current activity or last prompt (truncated)
  - Time since last activity ("2m ago", "1h ago")
  - Token usage summary (input/output)
  - Badge for pending permissions count (if > 0)

#### Real-Time Updates

Agent list updates in real time via WebSocket subscriptions from all connected daemons. When any daemon sends an agent status change event, the list item updates in place without a full re-render.

```typescript
// hooks/useAgentList.ts
function useAgentList(): {
  agents: AgentSummary[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  // 1. On mount, fetch agent lists from all connected daemons
  // 2. Merge into single list, keyed by (hostId, agentId)
  // 3. Subscribe to real-time agent events from all daemons
  // 4. On event, update the specific agent in the list
  // 5. On unmount, unsubscribe
}
```

#### Empty States

- **No daemons registered**: "No machines registered. Tap + to scan a QR code and pair your first machine."
- **All daemons disconnected**: "All machines are offline. Check your network connection."
- **No agents running**: "No agents running. Start an agent from your machine's terminal or dashboard."

#### Acceptance Criteria

- [ ] Agent list shows agents from all connected daemons in a single list
- [ ] Each agent card displays status, project, machine, activity, and token usage
- [ ] Sort by last activity (default), machine, status, or project name
- [ ] Filter by machine, provider, or status via horizontal chip bar
- [ ] Pull-to-refresh fetches fresh data from all daemons
- [ ] Agent status changes update in real time (< 500ms from daemon event)
- [ ] Tapping an agent card navigates to AgentDetailScreen
- [ ] Agents from disconnected daemons show with `disconnected` status and greyed-out styling
- [ ] Pending permission count badge is visible on the agent card
- [ ] Empty states display appropriate messages with actionable suggestions

---

### 5. Agent Interaction (F6.4)

From the AgentDetailScreen, users can send prompts, view streaming output, and approve or deny permission requests. This is the primary interaction surface for managing agents remotely.

#### Agent Detail Screen Layout

```
+---------------------------------------+
| < back    [agent-name]    [machine]   |
|---------------------------------------|
| Status: running           Cost: $0.42 |
| Model: claude-opus-4-6   Tokens: 12k |
|---------------------------------------|
|                                       |
|  [ Session timeline area ]            |
|  (delegates to Story 08 F13          |
|   rendering components)              |
|                                       |
|                                       |
|---------------------------------------|
| [voice] [message input field]  [send] |
+---------------------------------------+
```

#### WebSocket Connection

Each agent detail screen establishes a dedicated streaming subscription to the agent via the daemon's WebSocket connection:

```typescript
// hooks/useAgentStream.ts
function useAgentStream(hostId: string, agentId: string): {
  events: AgentStreamEvent[];
  status: AgentStatus;
  pendingPermissions: PermissionRequest[];
  sendPrompt: (prompt: string) => Promise<void>;
  approvePermission: (toolUseId: string) => Promise<void>;
  denyPermission: (toolUseId: string) => Promise<void>;
  alwaysAllowPermission: (toolUseId: string) => Promise<void>;
  interrupt: () => Promise<void>;
}
```

#### Prompt Input

The prompt input area is a multiline text input at the bottom of the screen:

```typescript
// components/PromptInput.tsx
interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  onVoiceStart: () => void;
  disabled: boolean;               // Disabled when agent is not idle
  placeholder: string;             // "Send a prompt..." or "Agent is running..."
  maxLength: number;               // 100,000 characters
}
```

Behavior:

- **Auto-growing**: Input field grows vertically up to 6 lines, then becomes scrollable.
- **Send button**: Enabled only when input is non-empty and agent status is `idle` or `waiting_permission`.
- **Keyboard handling**: `KeyboardAvoidingView` ensures the input stays above the keyboard on both iOS and Android.
- **Voice button**: Microphone icon to the left of the input field. Triggers voice input (Section 11).
- **Disabled states**: When agent is `running`, the input shows "Agent is running..." as placeholder and the send button is disabled. When agent is `error` or `completed`, input shows "Session ended" and is disabled.

#### Permission Handling

When an agent requests permission, the app shows an action sheet:

```typescript
// components/PermissionActionSheet.tsx
interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;             // Human-readable description
  filePath?: string;               // For file operations
  command?: string;                 // For Bash operations
  timestamp: string;
}
```

The action sheet appears as a bottom sheet with:
- Tool name and icon
- Description of what the tool wants to do
- File path or command (if applicable)
- Three buttons: "Allow", "Deny", "Always Allow (this session)"
- Haptic feedback on button press (iOS: medium impact, Android: tick)

If the app is backgrounded when a permission request arrives, a push notification is sent (Section 8).

#### Acceptance Criteria

- [ ] Agent detail screen shows agent status, model, token usage, and cost in header
- [ ] Session timeline renders using Story 08 (F13) rendering components
- [ ] Prompt input is multiline, auto-growing, with keyboard avoidance
- [ ] Send button is enabled only when agent is idle and input is non-empty
- [ ] Prompt is sent to the daemon via WebSocket and appears immediately in the timeline
- [ ] Permission requests appear as action sheets with Allow/Deny/Always Allow
- [ ] Haptic feedback fires on permission action button press
- [ ] Permission approved/denied state is sent to daemon and reflected in timeline within 200ms
- [ ] Agent can be interrupted via a long-press action or toolbar button
- [ ] Screen handles agent status transitions gracefully (running -> idle -> waiting_permission -> running)
- [ ] Input is disabled with appropriate placeholder text when agent is not accepting prompts

---

### 6. Session History (F6.5)

The Sessions tab provides a searchable, cross-machine view of all past sessions. Users can browse by date, project, or machine, and search for specific content across all sessions.

#### Session List Screen

```typescript
// types/session.ts
interface SessionSummary {
  sessionId: string;
  hostId: string;
  hostName: string;
  projectId: string;
  projectName: string;
  startedAt: string;                // ISO 8601
  endedAt?: string;                 // ISO 8601, undefined if still active
  duration: number;                 // Seconds
  eventCount: number;
  promptCount: number;
  toolCallCount: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    estimatedCost: number;
  };
  lastPromptPreview: string;        // First 150 chars of last user prompt
  status: 'active' | 'completed' | 'error';
  isDecrypted: boolean;             // False if encrypted data not yet decrypted
}

interface SessionFilter {
  machineId?: string;
  projectId?: string;
  dateFrom?: string;                // ISO 8601
  dateTo?: string;
  searchQuery?: string;
  status?: 'active' | 'completed' | 'error';
  sortBy?: 'date' | 'duration' | 'tokens' | 'project';
  sortDirection?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;                  // Pagination cursor
}
```

#### Session List UI

The session list screen has a search bar at the top, filter chips below it, and a virtualized list of session cards.

```
+---------------------------------------+
| [search icon] Search sessions...      |
|---------------------------------------|
| [All] [Today] [This Week] [Machine v]|
|---------------------------------------|
| > my-project (Work MacBook)           |
|   "Add dark mode support to the..."   |
|   2h 15m | 342 events | $1.23        |
|   Today, 2:30 PM                      |
|---------------------------------------|
| > api-server (Linux VM)               |
|   "Fix the authentication bug in..."  |
|   45m | 127 events | $0.56           |
|   Today, 11:00 AM                     |
|---------------------------------------|
| > ...                                 |
+---------------------------------------+
```

Each session card shows:
- Project name (bold) + machine name (subtle)
- Last prompt preview (truncated)
- Duration + event count + estimated cost
- Timestamp (relative for today, absolute for older)
- Status indicator (green dot = active, grey = completed, red = error)

#### Search Implementation

Search operates in two phases:

1. **Local search** (immediate): Searches across cached session metadata (project name, last prompt preview, timestamps) stored in the local SQLite cache (Section 14). Results appear as the user types with debounced input (300ms).

2. **Remote search** (on submit): When the user presses "Search" or hits enter, the app sends a search query to all connected daemons. Each daemon searches its event store (full-text search across prompts, tool inputs, and tool outputs) and returns matching session IDs with snippets.

```typescript
// hooks/useSessionSearch.ts
function useSessionSearch(): {
  results: SessionSearchResult[];
  isSearching: boolean;
  search: (query: string) => void;
  clearSearch: () => void;
}

interface SessionSearchResult {
  session: SessionSummary;
  matches: SearchMatch[];          // Highlighted snippets from matching events
}

interface SearchMatch {
  eventType: string;
  fieldName: string;               // "prompt", "tool_input", "tool_output"
  snippet: string;                 // Text with <mark> tags around matched terms
  eventSequence: number;
}
```

#### Pagination

Sessions are loaded in pages of 20. Scrolling to the bottom triggers loading the next page. Each daemon is queried independently and results are merged client-side, sorted by `startedAt` descending.

#### Acceptance Criteria

- [ ] Session list shows sessions from all connected daemons sorted by date (newest first)
- [ ] Each session card displays project, machine, duration, event count, cost, and last prompt preview
- [ ] Search bar filters sessions by project name, prompt text, and metadata (debounced, 300ms)
- [ ] Remote search queries all connected daemons on explicit search action
- [ ] Search results show highlighted matching snippets
- [ ] Filter chips: date range (Today, This Week, This Month, Custom), machine, project, status
- [ ] Pagination loads 20 sessions at a time with infinite scroll
- [ ] Active sessions show a green indicator and update in real time
- [ ] Tapping a session navigates to SessionDetailScreen
- [ ] Sessions from disconnected daemons appear with stale data indicator ("Last synced 2h ago")
- [ ] Empty state: "No sessions found" with suggestion to adjust filters

---

### 7. Usage Dashboard (F6.6)

The Dashboard tab shows aggregated token usage across all connected daemons, with daily and monthly timeline views and per-project breakdowns.

#### UsageStats Data Structure

```typescript
// types/usage.ts
interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCost: number;
  byDay: DailyUsage[];
  byProject: ProjectUsage[];
  byModel: ModelUsage[];
}

interface DailyUsage {
  date: string;                    // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  sessionCount: number;
}

interface ProjectUsage {
  projectId: string;
  projectName: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  percentage: number;              // Share of total cost (0-100)
  sessionCount: number;
}

interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  sessionCount: number;
}
```

#### Dashboard Screen Layout

```
+---------------------------------------+
|           Usage Dashboard             |
|---------------------------------------|
|  [This Month v]    Total: $47.23      |
|---------------------------------------|
|                                       |
|  +---------------------------------+  |
|  |  Daily Token Usage (bar chart)  |  |
|  |  [||||| ||||||| |||| ||||||||]  |  |
|  |   M  T  W  T  F  S  S          |  |
|  +---------------------------------+  |
|                                       |
|  Summary Cards:                       |
|  +--------+ +--------+ +--------+    |
|  | Input  | | Output | | Cache  |    |
|  | 1.2M   | | 850K   | | 4.1M   |    |
|  | tokens | | tokens | | reads  |    |
|  +--------+ +--------+ +--------+    |
|                                       |
|  Per-Project Breakdown:               |
|  +-----------------------------------+|
|  | my-project          42%  $19.84  ||
|  | [====================          ] ||
|  | api-server           28%  $13.22  ||
|  | [=============                 ] ||
|  | docs-site            15%   $7.08  ||
|  | [=======                       ] ||
|  | other (3 projects)   15%   $7.09  ||
|  | [=======                       ] ||
|  +-----------------------------------+|
|                                       |
|  Per-Model Breakdown:                 |
|  +-----------------------------------+|
|  | claude-opus-4-6    65%   $30.70  ||
|  | claude-sonnet-4-5  35%   $16.53  ||
|  +-----------------------------------+|
+---------------------------------------+
```

#### Charts Library

Use `react-native-chart-kit` for the bar chart (lightweight, no native module required) or `victory-native` for more advanced charts. The selection depends on the final rendering complexity:

- **Daily timeline**: Stacked bar chart with input tokens (blue) and output tokens (green).
- **Per-project percentage**: Horizontal progress bars with percentage labels.
- **Per-model breakdown**: Horizontal bars or pie chart.

```typescript
// components/DailyUsageChart.tsx
interface DailyUsageChartProps {
  data: DailyUsage[];
  range: 'week' | 'month';
  onBarPress?: (day: DailyUsage) => void;
}
```

#### Data Aggregation

Usage data is aggregated client-side from all connected daemons:

1. On Dashboard tab mount, request `getUsageStats(range)` from each connected daemon.
2. Merge results: sum token counts, concatenate `byDay` arrays (group by date), concatenate `byProject` arrays (group by projectId).
3. Recalculate percentages after merging.
4. Cache the aggregated result for the current view period (invalidate on new events or period change).

#### Date Range Selection

A dropdown at the top allows selecting:
- This Week (default for daily view)
- This Month
- Last Month
- Last 3 Months
- Custom Range (date picker)

When "This Month" or longer ranges are selected, the daily chart switches to weekly aggregation to remain readable.

#### Acceptance Criteria

- [ ] Dashboard shows total cost for the selected period prominently
- [ ] Daily token usage bar chart renders with stacked input/output tokens
- [ ] Chart bars are tappable -- pressing a bar shows a tooltip with exact numbers for that day
- [ ] Summary cards show total input tokens, output tokens, and cache read tokens
- [ ] Per-project breakdown shows percentage bars sorted by cost descending
- [ ] Per-model breakdown shows usage split across models
- [ ] Date range dropdown supports: This Week, This Month, Last Month, Last 3 Months, Custom
- [ ] Data is aggregated from all connected daemons
- [ ] Dashboard loads within 2 seconds even with 100+ projects across 5 daemons
- [ ] Tapping a project in the breakdown navigates to ProjectUsageDetailScreen
- [ ] Usage updates in real time as new events arrive from connected daemons

---

### 8. Push Notifications (F6.7)

The app receives push notifications when agents need attention: permission requests, errors, completion, and other significant events. Notifications are sent via APNs (iOS) and FCM (Android).

#### Notification Architecture

```
Daemon (Machine A)
  |
  +-- Agent event occurs (permission request, error, completion)
  |
  +-- Is mobile client connected via WebSocket?
       |
       +-- YES: Send event via WebSocket (no push needed)
       |
       +-- NO: Send push notification via relay server
             |
             +-- Relay server forwards to APNs/FCM
             |
             +-- Phone receives push
             +-- User taps -> deep link to agent/session
```

#### Notification Payload Format

```typescript
// types/notification.ts
interface AgentNotification {
  type: NotificationType;
  hostId: string;
  hostName: string;
  agentId: string;
  projectName: string;
  sessionId: string;
  title: string;
  body: string;
  data: Record<string, string>;    // Deep link parameters
}

type NotificationType =
  | 'permission_request'           // Agent needs permission approval
  | 'agent_completed'              // Agent finished its task
  | 'agent_error'                  // Agent encountered an error
  | 'session_ended'                // Session ended (normally or abnormally)
  | 'long_running_update';         // Agent has been running for > 10 minutes, progress update
```

#### APNs / FCM Payloads

**APNs (iOS)**:

```json
{
  "aps": {
    "alert": {
      "title": "Permission Required - Work MacBook",
      "subtitle": "my-project",
      "body": "Claude wants to run: rm -rf node_modules && npm install"
    },
    "sound": "default",
    "badge": 1,
    "category": "PERMISSION_REQUEST",
    "thread-id": "agent-abc123",
    "interruption-level": "time-sensitive"
  },
  "data": {
    "type": "permission_request",
    "hostId": "host-uuid",
    "agentId": "agent-abc123",
    "sessionId": "session-xyz",
    "toolUseId": "tool-use-789"
  }
}
```

**FCM (Android)**:

```json
{
  "notification": {
    "title": "Permission Required - Work MacBook",
    "body": "Claude wants to run: rm -rf node_modules && npm install"
  },
  "data": {
    "type": "permission_request",
    "hostId": "host-uuid",
    "agentId": "agent-abc123",
    "sessionId": "session-xyz",
    "toolUseId": "tool-use-789"
  },
  "android": {
    "priority": "high",
    "notification": {
      "channel_id": "agent_permissions",
      "tag": "agent-abc123"
    }
  }
}
```

#### Notification Categories (iOS) / Channels (Android)

| Category/Channel | Priority | Use Case |
|-----------------|----------|----------|
| `agent_permissions` | Time-Sensitive (iOS) / High (Android) | Permission requests |
| `agent_completions` | Active (iOS) / Default (Android) | Agent finished |
| `agent_errors` | Active (iOS) / High (Android) | Errors requiring attention |
| `agent_updates` | Passive (iOS) / Low (Android) | Progress updates |

#### Actionable Notifications (iOS)

For permission requests, iOS supports inline actions:

```typescript
// notification-setup.ts
Notifications.setNotificationCategoryAsync('PERMISSION_REQUEST', [
  {
    identifier: 'ALLOW',
    buttonTitle: 'Allow',
    options: { opensAppToForeground: false },
  },
  {
    identifier: 'DENY',
    buttonTitle: 'Deny',
    options: { opensAppToForeground: false, isDestructive: true },
  },
  {
    identifier: 'VIEW',
    buttonTitle: 'View Details',
    options: { opensAppToForeground: true },
  },
]);
```

Android achieves similar functionality with notification actions.

#### Deep Linking

Tapping a notification opens the app and navigates to the relevant screen:

```typescript
// navigation/deep-links.ts
const DeepLinkConfig = {
  screens: {
    AgentsTab: {
      screens: {
        AgentDetail: 'agent/:hostId/:agentId',
        AgentSession: 'session/:hostId/:sessionId',
      },
    },
    SessionsTab: {
      screens: {
        SessionDetail: 'session/:hostId/:sessionId',
      },
    },
  },
};

// Handle notification tap
function handleNotificationResponse(response: Notifications.NotificationResponse): void {
  const data = response.notification.request.content.data;

  switch (data.type) {
    case 'permission_request':
      navigate('AgentDetail', { hostId: data.hostId, agentId: data.agentId });
      break;
    case 'agent_completed':
    case 'agent_error':
      navigate('AgentDetail', { hostId: data.hostId, agentId: data.agentId });
      break;
    case 'session_ended':
      navigate('SessionDetail', { hostId: data.hostId, sessionId: data.sessionId });
      break;
  }
}
```

#### Background Notification Handling

When a notification action is taken without opening the app (e.g., "Allow" on a permission request), the app must handle it in the background:

```typescript
// tasks/background-notification.ts
Notifications.addNotificationResponseReceivedListener((response) => {
  const action = response.actionIdentifier;
  const data = response.notification.request.content.data;

  if (data.type === 'permission_request') {
    if (action === 'ALLOW') {
      // Send approval to daemon (wake network connection briefly)
      sendPermissionResponse(data.hostId, data.agentId, data.toolUseId, 'allow');
    } else if (action === 'DENY') {
      sendPermissionResponse(data.hostId, data.agentId, data.toolUseId, 'deny');
    }
  }
});
```

#### Notification Settings

Users can configure which notification types they want to receive, per daemon:

```typescript
// types/notification-settings.ts
interface NotificationSettings {
  enabled: boolean;                // Master toggle
  perType: {
    permission_request: boolean;   // Default: true
    agent_completed: boolean;      // Default: true
    agent_error: boolean;          // Default: true
    session_ended: boolean;        // Default: false
    long_running_update: boolean;  // Default: false
  };
  quietHours: {
    enabled: boolean;
    startTime: string;             // "22:00"
    endTime: string;               // "08:00"
  };
}
```

#### Acceptance Criteria

- [ ] Push notifications fire for permission requests, agent completions, and agent errors
- [ ] APNs (iOS) and FCM (Android) payloads are correctly formatted
- [ ] Permission request notifications are "time-sensitive" (iOS) / "high priority" (Android)
- [ ] iOS actionable notifications allow "Allow" / "Deny" without opening the app
- [ ] Tapping a notification deep links to the correct agent or session screen
- [ ] Background notification handling sends permission responses to the daemon
- [ ] Notification settings screen allows per-type toggles
- [ ] Quiet hours suppress all non-critical notifications during configured time range
- [ ] No duplicate notifications: if the app is connected via WebSocket, push is suppressed
- [ ] Badge count on app icon reflects total pending actions (permission requests)
- [ ] Notifications are grouped by agent (iOS thread-id, Android tag)

---

### 9. Diff Viewer (F6.8)

The diff viewer displays syntax-highlighted unified diffs for file changes made by agents. The full rendering component specification is in Story 08 (F13.3). This section covers the container, gesture support, and integration with the session timeline.

#### Diff Viewer Shell

```typescript
// components/DiffViewerShell.tsx
interface DiffViewerShellProps {
  diff: UnifiedDiff;
  filePath: string;
  language: string;                // For syntax highlighting
  onClose: () => void;
}

interface UnifiedDiff {
  oldFile: string;
  newFile: string;
  hunks: DiffHunk[];
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'added' | 'removed' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}
```

#### Gesture Support

- **Pinch-to-zoom**: Adjusts font size from 8pt to 24pt. Persists zoom level across diff views within the same session.
- **Horizontal scroll**: For long lines that exceed screen width (no line wrapping in diff view).
- **Vertical scroll**: Standard scrolling through hunks.
- **Double-tap**: Resets zoom to default (12pt).
- **Swipe left/right on tablets**: Switches between unified and side-by-side diff views (tablets only, screen width > 768pt).

```typescript
// hooks/useDiffGestures.ts
function useDiffGestures(): {
  fontSize: number;
  onPinchGesture: GestureHandler;
  onDoubleTap: GestureHandler;
  viewMode: 'unified' | 'side-by-side';
  toggleViewMode: () => void;
}
```

#### Acceptance Criteria

- [ ] Diff viewer renders unified diffs with red (removed) and green (added) line backgrounds
- [ ] Syntax highlighting is applied based on file extension
- [ ] Pinch-to-zoom adjusts font size (8pt-24pt range)
- [ ] Double-tap resets zoom to default
- [ ] Horizontal scrolling works for long lines
- [ ] Line numbers are displayed in the gutter
- [ ] On tablets (width > 768pt), swipe gesture toggles between unified and side-by-side views
- [ ] Diff viewer loads and renders within 500ms for diffs up to 500 lines
- [ ] Full rendering details defer to Story 08 (F13.3) component specification

---

### 10. File Explorer (F6.9)

The file explorer allows users to browse agent workspace files remotely. It shows a file tree with git status indicators and a syntax-highlighted file viewer.

#### File Tree Component

```typescript
// types/file.ts
interface FileEntry {
  name: string;
  path: string;                    // Relative to workspace root
  type: 'file' | 'directory';
  size?: number;                   // Bytes, for files only
  modifiedAt?: string;             // ISO 8601
  gitStatus?: GitFileStatus;
  children?: FileEntry[];          // For directories, loaded on expand
}

type GitFileStatus =
  | 'modified'                     // M (modified in working tree)
  | 'added'                        // A (new file, staged)
  | 'deleted'                      // D (deleted)
  | 'untracked'                    // ? (new, not staged)
  | 'renamed'                      // R (renamed)
  | 'ignored'                      // ! (gitignored)
  | 'clean';                       // No changes
```

#### File Tree UI

```typescript
// components/FileTree.tsx
interface FileTreeProps {
  hostId: string;
  agentId: string;
  rootPath: string;                // Agent workspace root
  onFileSelect: (file: FileEntry) => void;
}
```

The file tree is a collapsible tree view:

- Directories are expandable. Tapping a directory loads its children from the daemon on demand (lazy loading).
- Files are tappable. Tapping a file opens the syntax-highlighted viewer.
- Git status is shown as colored indicators next to each file:
  - Modified: orange dot
  - Added: green dot
  - Deleted: red dot with strikethrough name
  - Untracked: grey dot
  - Clean: no indicator
- Files are sorted: directories first (alphabetical), then files (alphabetical).
- `.git/`, `node_modules/`, and other large directories are collapsed by default with a note like "(1,423 items)".

#### File Viewer

```typescript
// components/FileViewer.tsx
interface FileViewerProps {
  hostId: string;
  agentId: string;
  filePath: string;
  language: string;
  onClose: () => void;
}
```

The file viewer shows:
- File path in the header
- Syntax-highlighted file content with line numbers
- Pinch-to-zoom (same gesture handling as diff viewer)
- "Copy" button to copy file content to clipboard
- Git status badge in the header (if modified/added/etc.)
- File size and last modified date

Large files (> 100KB) are truncated with a "Show full file" button to prevent excessive memory usage on mobile.

#### Remote File Access Protocol

File operations go through the daemon's WebSocket connection:

```typescript
// services/daemon-connection.ts (file operations)
interface FileOperations {
  // List files in a directory
  listFiles(agentId: string, path: string): Promise<FileEntry[]>;

  // Get file content (text files only)
  getFileContent(agentId: string, filePath: string): Promise<{
    content: string;
    size: number;
    mimeType: string;
    encoding: string;
  }>;

  // Get git status for all files in workspace
  getGitStatus(agentId: string): Promise<Map<string, GitFileStatus>>;
}
```

#### Acceptance Criteria

- [ ] File tree renders the agent's workspace directory structure
- [ ] Directories expand on tap, loading children from the daemon on demand
- [ ] Files are tappable and open in the syntax-highlighted viewer
- [ ] Git status indicators (colored dots) appear next to modified/added/deleted/untracked files
- [ ] Files are sorted: directories first (alpha), then files (alpha)
- [ ] File viewer renders syntax-highlighted content with line numbers
- [ ] Pinch-to-zoom works in the file viewer (8pt-24pt)
- [ ] Large files (> 100KB) are truncated with a "Show full file" option
- [ ] Large directories (node_modules, .git) show item count and are collapsed by default
- [ ] File content loads within 1 second for files up to 50KB over LAN
- [ ] Binary files show "Binary file (X KB)" instead of attempting to render content
- [ ] File explorer is accessible from both the agent detail screen and session detail screen

---

### 11. Voice Input (F6.10)

Voice input provides a hands-free dictation mode for sending prompts to agents. It uses platform-native speech-to-text APIs (iOS Speech Framework, Android SpeechRecognizer).

#### Voice Input Integration

```typescript
// hooks/useVoiceInput.ts
function useVoiceInput(): {
  isRecording: boolean;
  isProcessing: boolean;
  transcript: string;              // Real-time partial transcript
  error: VoiceInputError | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string>;
  cancelRecording: () => void;
}

type VoiceInputError =
  | { type: 'PERMISSION_DENIED'; message: string }
  | { type: 'NOT_AVAILABLE'; message: string }
  | { type: 'RECOGNITION_FAILED'; message: string }
  | { type: 'NETWORK_ERROR'; message: string };
```

#### Voice Input Flow

```
1. User taps microphone icon on PromptInput
2. Request microphone permission (if not already granted)
3. Start speech recognition (platform native)
4. Visual feedback:
   - Microphone icon turns red with pulsing animation
   - Waveform visualizer appears above input field
   - Partial transcript appears in input field in real time
5. User taps microphone icon again (or silence detected after 3s)
6. Stop recording
7. Final transcript placed in input field
8. User can edit transcript before sending
9. User taps send (or taps microphone again for another dictation)
```

#### Speech-to-Text Configuration

```typescript
// services/speech.ts
const SpeechConfig = {
  language: 'en-US',              // Configurable in settings
  partialResults: true,           // Show real-time partial transcript
  silenceTimeout: 3000,           // Auto-stop after 3s of silence
  maxDuration: 60000,             // Maximum 60 seconds per dictation
  punctuation: true,              // Enable automatic punctuation (iOS 16+)
};
```

The app uses `expo-speech` or `@react-native-voice/voice` for cross-platform speech recognition.

#### Visual Feedback

```typescript
// components/VoiceIndicator.tsx
interface VoiceIndicatorProps {
  isRecording: boolean;
  isProcessing: boolean;
  audioLevel: number;              // 0.0 - 1.0, for waveform amplitude
}
```

During recording:
- Microphone button: red, with pulsing animation (scale 1.0 -> 1.1 at 1Hz)
- Input field: shows partial transcript in italic, updating in real time
- Above input: waveform visualizer showing audio amplitude (3 animated bars)
- Duration counter: "0:12" showing recording duration

#### Acceptance Criteria

- [ ] Microphone icon appears in the prompt input area
- [ ] Tapping microphone requests permission (if needed) and starts recording
- [ ] Partial transcript appears in real time in the input field as the user speaks
- [ ] Tapping microphone again (or 3s silence) stops recording and finalizes transcript
- [ ] Visual feedback: red pulsing microphone, waveform visualizer, duration counter
- [ ] Final transcript is editable before sending
- [ ] Voice input works offline for on-device speech recognition (iOS 13+, Android varies)
- [ ] Maximum recording duration is 60 seconds
- [ ] Error states (permission denied, not available, recognition failed) show clear messages
- [ ] Language can be configured in app settings
- [ ] Cancel recording discards transcript without modifying the input field

---

### 12. Encryption Key Management (F6.11)

The app manages the user's master encryption key for E2EE sync. The key is stored in the platform's secure enclave (iOS Keychain, Android Keystore) with biometric gating.

#### Key Storage

```typescript
// services/key-manager.ts
class KeyManager {
  // Check if a master key exists on this device
  async hasKey(): Promise<boolean>;

  // Store master key in secure storage with biometric protection
  async storeKey(masterKey: Uint8Array, options?: KeyStorageOptions): Promise<void>;

  // Retrieve master key (triggers biometric prompt)
  async getKey(): Promise<Uint8Array>;

  // Delete master key from secure storage
  async deleteKey(): Promise<void>;

  // Get key metadata without unlocking
  async getKeyInfo(): Promise<KeyInfo | null>;
}

interface KeyStorageOptions {
  biometricRequired: boolean;      // Default: true
  biometricLabel: string;          // "Unlock AgentContext encryption key"
  accessLevel: 'whenUnlocked' | 'afterFirstUnlock';  // Default: 'whenUnlocked'
}

interface KeyInfo {
  keyId: string;                   // sha256(masterKey)[:8], for identification
  createdAt: string;               // ISO 8601
  lastUsedAt: string;
  biometricEnabled: boolean;
  deviceName: string;              // Device that generated or received this key
}
```

#### Platform-Specific Secure Storage

**iOS (Keychain)**:

```typescript
// Uses react-native-keychain
const keychainOptions: Options = {
  service: 'dev.agentctx.masterkey',
  accessControl: AccessControl.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  accessible: ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  securityLevel: SECURITY_LEVEL.SECURE_HARDWARE,
  authenticationPrompt: {
    title: 'Unlock Encryption Key',
    subtitle: 'Authenticate to decrypt your session data',
  },
};
```

**Android (Keystore)**:

```typescript
// Uses react-native-keychain with Android-specific config
const keystoreOptions: Options = {
  service: 'dev.agentctx.masterkey',
  accessControl: AccessControl.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  securityLevel: SECURITY_LEVEL.SECURE_HARDWARE,  // TEE or StrongBox
  storage: STORAGE_TYPE.AES_GCM_NO_AUTH,           // Hardware-backed
  authenticationPrompt: {
    title: 'Unlock Encryption Key',
    description: 'Use your fingerprint or PIN to decrypt session data',
  },
};
```

#### Key Status Display

The EncryptionKeyScreen shows:

```
+---------------------------------------+
|         Encryption Key                |
|---------------------------------------|
|  Status: Active                       |
|  Key ID: a3f7b2c9                     |
|  Created: Feb 15, 2026               |
|  Last Used: 2 minutes ago            |
|---------------------------------------|
|  Biometric Protection: Enabled        |
|  [Toggle to disable]                  |
|---------------------------------------|
|  [Transfer Key to New Device]         |
|  [Recover from Passphrase]            |
|  [Delete Key from This Device]        |
|---------------------------------------|
|  WARNING: Deleting the key from this  |
|  device does not affect other devices |
|  or your encrypted data on the sync   |
|  server. You can recover using your   |
|  passphrase or by scanning a QR from  |
|  another device.                      |
+---------------------------------------+
```

#### Biometric Unlock Flow

When the app needs to decrypt data (viewing encrypted session content, syncing):

1. App calls `KeyManager.getKey()`
2. OS presents biometric prompt (Face ID / Touch ID / Fingerprint)
3. User authenticates
4. Key is returned from secure storage
5. Key is held in memory for the duration of the app session (cleared on background after 5 minutes)

```typescript
// services/key-cache.ts
class KeyCache {
  private key: Uint8Array | null = null;
  private clearTimer: NodeJS.Timeout | null = null;
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000;  // 5 minutes

  async getOrUnlock(): Promise<Uint8Array> {
    if (this.key) {
      this.resetTimer();
      return this.key;
    }
    this.key = await KeyManager.getKey();
    this.resetTimer();
    return this.key;
  }

  private resetTimer(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => {
      if (this.key) {
        this.key.fill(0);  // Zero out key memory
        this.key = null;
      }
    }, this.CACHE_DURATION_MS);
  }

  clear(): void {
    if (this.key) {
      this.key.fill(0);
      this.key = null;
    }
    if (this.clearTimer) clearTimeout(this.clearTimer);
  }
}
```

#### Acceptance Criteria

- [ ] Master key is stored in iOS Keychain with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`
- [ ] Master key is stored in Android Keystore with TEE/StrongBox backing
- [ ] Biometric prompt appears when decryption is needed
- [ ] Biometric can be toggled on/off (fallback to device passcode)
- [ ] Key status screen shows key ID, creation date, and last used time
- [ ] Key is cached in memory for 5 minutes, then zeroed out
- [ ] Key memory is zeroed when app goes to background for > 5 minutes
- [ ] "Delete Key from This Device" clears key from secure storage with confirmation dialog
- [ ] Recovery from passphrase: user enters passphrase, Argon2id derives recovery key, decrypts master key backup
- [ ] If no key exists, the screen shows "No encryption key on this device" with options to transfer or recover
- [ ] Key operations (store, retrieve, delete) never expose the raw key in logs or error messages

---

### 13. QR Key Transfer (F6.12)

Users transfer their master encryption key from one device to another using QR codes and ephemeral E2EE. This is the primary mechanism for setting up a new phone or tablet with access to encrypted data.

#### Full Transfer Flow

```
Device A (has key)                    Device B (needs key)
   |                                         |
   |  1. User selects "Transfer Key"         |
   |  2. Generate ephemeral Curve25519       |
   |     keypair (keyA_pub, keyA_priv)       |
   |  3. Display QR code containing:         |
   |     - keyA_pub (base64)                 |
   |     - connection info (LAN/relay)       |
   |     - nonce                             |
   |     - expiresAt (2 minutes)             |
   |                                         |
   |                                    4. User opens QR scanner
   |                                    5. Scan QR code
   |                                    6. Generate own ephemeral keypair
   |                                       (keyB_pub, keyB_priv)
   |                                    7. Compute shared secret:
   |                                       ECDH(keyB_priv, keyA_pub)
   |                                         |
   |  <--- 8. Connect (LAN first, relay fallback) --->
   |                                         |
   |  <--- 9. Device B sends keyB_pub ---    |
   |                                         |
   |  10. Compute shared secret:             |
   |      ECDH(keyA_priv, keyB_pub)          |
   |                                         |
   |  11. Authenticate biometric to          |
   |      unlock master key                  |
   |                                         |
   |  12. Encrypt master key with            |
   |      shared secret:                     |
   |      encrypted = XChaCha20(             |
   |        key=shared_secret,               |
   |        plaintext=master_key,            |
   |        nonce=random)                    |
   |                                         |
   |  --- 13. Send encrypted master key -->  |
   |                                         |
   |                                    14. Decrypt master key with
   |                                        shared secret
   |                                    15. Derive key ID:
   |                                        sha256(master_key)[:8]
   |                                         |
   |  <--- 16. Send key ID for verification -|
   |                                         |
   |  17. Verify key ID matches own          |
   |      key ID                             |
   |                                         |
   |  --- 18. Send "verified" confirmation ->|
   |                                         |
   |                                    19. Store master key in
   |                                        Keychain/Keystore with
   |                                        biometric protection
   |                                    20. Display success:
   |                                        "Key transferred successfully"
   |                                         |
   |  21. Destroy ephemeral keys             |
   |  22. Display success on Device A        |
   |                                    23. Destroy ephemeral keys
   |                                         |
```

#### QR Key Transfer Payload

```json
{
  "version": 1,
  "type": "key_transfer",
  "ephemeralPublicKey": "base64-encoded-curve25519-public-key",
  "lan": {
    "address": "192.168.1.42",
    "port": 9121
  },
  "relay": {
    "serverId": "transfer-session-xyz"
  },
  "expiresAt": "2026-02-21T15:02:00Z",
  "nonce": "base64-encoded-random-nonce"
}
```

URL format: `agentctx://key-transfer?data=<base64url-encoded-json>`

#### Verification Step

After the transfer, both devices display the key ID (first 8 hex characters of SHA-256 of the master key). The user visually confirms they match. This prevents MITM attacks where an attacker substitutes their own key.

```
+---------------------------------------+
|       Key Transfer Complete           |
|---------------------------------------|
|                                       |
|  Verify the key ID matches on both    |
|  devices:                             |
|                                       |
|       Key ID: a3f7 b2c9              |
|                                       |
|  Does this match the other device?    |
|                                       |
|  [No, Try Again]       [Yes, Confirm] |
+---------------------------------------+
```

If the user taps "No, Try Again", the transferred key is discarded and the process restarts.

#### Acceptance Criteria

- [ ] Device A generates and displays a QR code for key transfer
- [ ] Device B scans the QR code and initiates the ECDH key exchange
- [ ] Master key is encrypted with the ECDH shared secret before transfer
- [ ] Encryption uses XChaCha20-Poly1305 (consistent with F10.3)
- [ ] Both devices display the key ID for visual verification
- [ ] If verification fails ("No, Try Again"), the transferred key is discarded
- [ ] QR code expires after 2 minutes; scanning an expired code shows an error
- [ ] Biometric authentication is required on Device A before the key is read from secure storage
- [ ] On success, Device B stores the key in its Keychain/Keystore with biometric protection
- [ ] All ephemeral keys are destroyed (zeroed) after the transfer completes or fails
- [ ] LAN transfer is attempted first; relay is used as fallback
- [ ] The entire transfer flow completes within 30 seconds on LAN

---

### 14. Offline Mode (F6.13)

The app remains functional without network connectivity by caching session history in a local SQLite database. Users can browse previously viewed sessions, review past usage data, and see stale data indicators for cached content.

#### Cache Strategy

The app uses a local SQLite database (via `expo-sqlite` or `@op-engineering/op-sqlite`) for structured caching:

```sql
-- Local cache schema
CREATE TABLE cached_sessions (
  session_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration INTEGER,
  event_count INTEGER,
  prompt_count INTEGER,
  tool_call_count INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  estimated_cost REAL,
  last_prompt_preview TEXT,
  status TEXT NOT NULL,
  cached_at TEXT NOT NULL,
  FOREIGN KEY (host_id) REFERENCES cached_hosts(id)
);

CREATE TABLE cached_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data_json TEXT,                   -- Decrypted event data (JSON string)
  cached_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES cached_sessions(session_id)
);

CREATE TABLE cached_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost REAL,
  session_count INTEGER,
  cached_at TEXT NOT NULL,
  UNIQUE(host_id, date)
);

CREATE TABLE cached_hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  last_connected TEXT,
  cached_at TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX idx_sessions_host ON cached_sessions(host_id);
CREATE INDEX idx_sessions_project ON cached_sessions(project_id);
CREATE INDEX idx_sessions_started ON cached_sessions(started_at DESC);
CREATE INDEX idx_events_session ON cached_events(session_id, sequence);
CREATE INDEX idx_usage_date ON cached_usage(host_id, date);
```

#### Cache Population

Data is cached opportunistically as the user browses:

1. **Session list**: When sessions are loaded from daemons, all `SessionSummary` objects are inserted/updated in `cached_sessions`.
2. **Session detail**: When a session's events are loaded, they are inserted into `cached_events`.
3. **Usage dashboard**: When usage stats are loaded, daily data is inserted into `cached_usage`.
4. **On connect**: When a daemon connects, its host info is updated in `cached_hosts`.

Cache writes happen in background transactions and do not block the UI.

#### Cache Size Management

- **Maximum cache size**: 500MB (configurable in settings).
- **Eviction policy**: LRU by `cached_at` timestamp. When the cache exceeds 80% of the limit, the oldest 20% of `cached_events` rows are deleted.
- **Session metadata** (`cached_sessions`) is retained longer than event data -- the list of sessions is small but the event data can be large.

```typescript
// services/cache-manager.ts
class CacheManager {
  async getCacheSize(): Promise<number>;         // Bytes
  async pruneIfNeeded(): Promise<void>;
  async clearCache(): Promise<void>;
  async getCachedSessions(filter: SessionFilter): Promise<SessionSummary[]>;
  async getCachedEvents(sessionId: string): Promise<CachedEvent[]>;
  async getCachedUsage(range: DateRange): Promise<DailyUsage[]>;
}
```

#### Stale Data Indicators

When displaying cached data (network unavailable or daemon disconnected), the UI shows:

- A banner at the top of the screen: "Viewing cached data. Last synced: 2 hours ago."
- Individual items show a subtle clock icon if their `cached_at` is more than 1 hour old.
- Active session indicators are replaced with "Unknown" status when offline.

```typescript
// components/StaleDataBanner.tsx
interface StaleDataBannerProps {
  lastSyncedAt: string;            // ISO 8601
  isConnected: boolean;
}
```

#### Offline Behavior by Screen

| Screen | Offline Behavior |
|--------|-----------------|
| Agent List | Shows last known agent states. All agents show "disconnected" status. No real-time updates. |
| Agent Detail | Read-only. No prompt input. Cached session events displayed. |
| Session List | Full functionality with cached data. Search operates on local cache only. |
| Session Detail | Displays cached events. Stale data banner shown. |
| Dashboard | Displays cached usage data. Stale data banner shown. |
| Settings | Fully functional (all local data). |
| QR Scanner | Requires network -- shows "QR pairing requires a network connection." |

#### Acceptance Criteria

- [ ] Session list is browsable offline using cached data from SQLite
- [ ] Session detail shows cached events when the daemon is disconnected
- [ ] Usage dashboard shows cached aggregates offline
- [ ] Stale data banner appears when displaying cached content with timestamp of last sync
- [ ] Cache is populated in the background as the user browses (session list, session detail, usage)
- [ ] Cache size is limited to 500MB (configurable); LRU eviction removes oldest event data
- [ ] "Clear cache" option in Settings deletes all cached data
- [ ] Cache does not store raw encryption keys or unencrypted sensitive data beyond what is displayed
- [ ] Search works offline against the local SQLite cache
- [ ] QR scanner / pairing screens gracefully indicate that network is required
- [ ] Reconnection to a daemon triggers a cache refresh for any data visible on screen

---

## Data Flow Diagrams

### App Startup Flow

```
App Launch
  |
  +-- 1. Load HostProfile[] from AsyncStorage
  |
  +-- 2. Load cached data from SQLite (session list, usage)
  |
  +-- 3. Render UI with cached data immediately
  |
  +-- 4. For each HostProfile:
  |     |
  |     +-- 4a. Attempt WebSocket connection
  |     |     |
  |     |     +-- Connected: update connectionState, fetch fresh data
  |     |     +-- Failed: set connectionState='disconnected', show cached data
  |     |
  |     +-- 4b. Subscribe to agent events
  |     +-- 4c. Subscribe to session events
  |
  +-- 5. Register for push notifications (if not already registered)
  |
  +-- 6. Check encryption key status
        |
        +-- Key exists: ready for encrypted data
        +-- No key: show "Setup encryption" prompt in Settings tab badge
```

### Event Flow: Permission Request

```
Daemon detects permission request
  |
  +-- Agent sends PermissionRequested event
  |
  +-- Is mobile connected via WebSocket?
       |
       +-- YES:
       |     |
       |     +-- Event arrives via WebSocket
       |     +-- App in foreground?
       |           |
       |           +-- YES: Show permission action sheet immediately
       |           +-- NO: Show local notification (already have the data)
       |
       +-- NO:
             |
             +-- Daemon sends push via relay
             +-- APNs/FCM delivers notification
             +-- User taps notification:
             |     +-- Deep link to AgentDetailScreen
             |     +-- Fetch permission details from daemon
             |     +-- Show permission action sheet
             +-- User taps "Allow" on notification (iOS):
                   +-- Background handler sends approval to daemon
```

---

## Edge Cases

### E-1: Daemon Disconnects Mid-Interaction

**Scenario**: The user is viewing an agent's streaming output when the daemon loses connectivity (e.g., laptop lid closed, network dropout).

**Expected behavior**: The streaming output freezes. After 5 seconds of no heartbeat, the connection state transitions to `disconnected`. A banner appears: "Connection lost to Work MacBook. Reconnecting..." The last received events remain visible. When the connection is restored, the app requests events from the last known sequence number, filling in any gaps.

**Risk**: Events may be lost if the gap is too large. Mitigation: the daemon buffers events during disconnection (up to 1000 events or 5 minutes).

---

### E-2: QR Code Scanned on Wrong Network

**Scenario**: The user scans a daemon's QR code while on a different WiFi network than the daemon. The LAN address is unreachable.

**Expected behavior**: LAN connection attempt times out after 3 seconds. App falls back to relay connection using the `relayServerId` in the QR payload. If relay also fails (daemon not connected to relay), the app shows: "Cannot reach Work MacBook. Ensure the machine is online and connected to the internet for relay access."

---

### E-3: Multiple Permission Requests Queue Up

**Scenario**: An agent fires 5 permission requests in rapid succession while the user is not looking at the app.

**Expected behavior**: Each permission request generates its own push notification, grouped by agent (iOS thread-id / Android notification group). When the user opens the app, all 5 pending permissions are listed in a queue on the AgentDetailScreen. The user can approve/deny them one at a time or use "Allow All" for the batch.

---

### E-4: Key Transfer Interrupted

**Scenario**: The key transfer process is interrupted halfway through (e.g., user walks out of Bluetooth/LAN range, app crashes).

**Expected behavior**: Device B has not yet stored the key (storage happens only after verification). No partial key data remains. Ephemeral keys are lost (garbage collected). The user must restart the transfer process from scratch. Device A's master key is unaffected.

---

### E-5: Cache Database Corruption

**Scenario**: The SQLite cache file is corrupted (e.g., due to a crash during a write operation).

**Expected behavior**: On startup, the app performs a quick integrity check (`PRAGMA integrity_check`). If corruption is detected, the cache database is deleted and recreated empty. A brief toast notification appears: "Cache was reset due to a data issue." The user loses cached offline data but the app functions normally once connected.

---

### E-6: Very Long Session (10,000+ Events)

**Scenario**: A user opens the session detail for a session with 10,000+ events.

**Expected behavior**: Events are loaded in pages of 50, using a cursor-based pagination. The timeline is rendered with a virtualized list (`FlashList`) that only keeps ~20 items in memory at a time. Scrolling is smooth at 60fps. A "Jump to latest" button appears when the user is scrolled up. The session scrubber (Story 08 / F13.11) allows jumping to any point.

---

### E-7: Push Notification Token Rotation

**Scenario**: APNs or FCM rotates the device's push token (happens periodically, especially on Android).

**Expected behavior**: The app detects the new token via the Expo notification token listener and sends the updated token to all connected daemons. Until the update propagates, push notifications may fail to deliver. The app does not crash or lose state.

---

### E-8: Biometric Authentication Fails Repeatedly

**Scenario**: The user fails biometric authentication 5 times when trying to unlock the encryption key (e.g., wet fingers on Touch ID).

**Expected behavior**: After 3 failed biometric attempts, the OS falls back to device passcode/PIN. If the user cancels the passcode prompt, the operation fails gracefully: "Encryption key locked. Encrypted data cannot be displayed." The app continues to function for non-encrypted operations (agent management, unencrypted session metadata).

---

### E-9: Two Phones Paired to the Same Daemon

**Scenario**: A user has two phones (personal and work) both paired to the same daemon.

**Expected behavior**: Both phones connect concurrently. Both receive real-time agent events via WebSocket. Push notifications are sent to both. Permission approval from either phone is honored (first-writer-wins). The daemon tracks both as paired clients and sends to both.

---

### E-10: App Killed During Background Notification Handler

**Scenario**: The OS kills the app while it is handling a background notification action (e.g., "Allow" on a permission request).

**Expected behavior**: The permission response may not reach the daemon. The permission remains pending. The next time the user opens the app, the pending permission is displayed again for action. The daemon has a timeout for pending permissions (configurable, default 10 minutes) after which it auto-denies.

---

## Technical Specifications

### Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `expo` | ~51+ | App framework, build system |
| `react-native` | 0.74+ | UI framework |
| `@react-navigation/native` | 6.x | Navigation |
| `@react-navigation/bottom-tabs` | 6.x | Tab navigator |
| `@react-navigation/stack` | 6.x | Stack navigator |
| `expo-camera` | ~15+ | QR code scanning |
| `expo-notifications` | ~0.28+ | Push notifications |
| `expo-sqlite` | ~14+ | Local cache database |
| `expo-secure-store` | ~13+ | Fallback secure storage |
| `react-native-keychain` | 9.x | Platform secure storage (Keychain/Keystore) with biometric ACL |
| `@react-native-async-storage/async-storage` | 1.x | Daemon registry persistence |
| `react-native-chart-kit` | 6.x | Usage dashboard charts |
| `@shopify/flash-list` | 1.x | Virtualized lists |
| `react-native-gesture-handler` | 2.x | Gesture handling (pinch, swipe) |
| `react-native-reanimated` | 3.x | Animations |
| `@react-native-voice/voice` | 3.x | Speech-to-text |
| `libsodium-wrappers-sumo` | 0.7.x | Cryptography (XChaCha20, Curve25519, Argon2id) |
| `react-native-svg` | 15.x | Chart rendering, icons |

### Performance Targets

| Metric | Target | Hard Limit |
|--------|--------|------------|
| App cold start to interactive | < 2s | 4s |
| Tab switch | < 100ms | 300ms |
| Agent list render (50 agents) | < 200ms | 500ms |
| Session list render (100 sessions) | < 300ms | 500ms |
| WebSocket reconnect | < 1s | 5s |
| Permission action to daemon | < 200ms | 1s |
| QR scan to pairing complete | < 5s (LAN) | 15s (relay) |
| File tree expand (100 entries) | < 500ms | 1s |
| Usage chart render | < 300ms | 1s |
| Cache read (session list) | < 50ms | 200ms |

### Minimum OS Versions

| Platform | Minimum | Recommended |
|----------|---------|-------------|
| iOS | 15.0 | 17.0+ |
| Android | API 26 (8.0 Oreo) | API 33 (13)+ |

### File Locations (in Expo project)

```
app/
  (tabs)/
    agents.tsx                     # Agents tab root
    sessions.tsx                   # Sessions tab root
    dashboard.tsx                  # Dashboard tab root
    settings.tsx                   # Settings tab root
  agent/
    [id].tsx                       # Agent detail
  session/
    [id].tsx                       # Session detail
    file-explorer.tsx              # File explorer
  settings/
    daemons.tsx                    # Daemon registry
    daemon/[id].tsx                # Daemon detail
    encryption.tsx                 # Encryption key management
    notifications.tsx              # Notification settings

components/
  agents/
    AgentCard.tsx
    AgentStatusBadge.tsx
    PermissionActionSheet.tsx
  sessions/
    SessionCard.tsx
    SessionSearchBar.tsx
  dashboard/
    DailyUsageChart.tsx
    ProjectBreakdown.tsx
    ModelBreakdown.tsx
    SummaryCards.tsx
  files/
    FileTree.tsx
    FileTreeNode.tsx
    FileViewer.tsx
  shared/
    DiffViewerShell.tsx
    PromptInput.tsx
    VoiceIndicator.tsx
    QRScanner.tsx
    StaleDataBanner.tsx
    EmptyState.tsx

hooks/
  useAgentList.ts
  useAgentStream.ts
  useSessionList.ts
  useSessionSearch.ts
  useUsageStats.ts
  useVoiceInput.ts
  useDiffGestures.ts
  useCamera.ts
  useConnection.ts

services/
  connection-manager.ts
  daemon-connection.ts
  key-manager.ts
  key-cache.ts
  cache-manager.ts
  speech.ts
  notification-setup.ts

storage/
  daemon-registry.ts               # AsyncStorage wrapper
  cache-db.ts                      # SQLite wrapper

types/
  navigation.ts
  daemon.ts
  agent.ts
  session.ts
  usage.ts
  file.ts
  notification.ts

theme/
  colors.ts
  typography.ts
  spacing.ts
```

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | `HostProfile` serialization/deserialization to/from AsyncStorage |
| T-2 | `ConnectionManager` connects to LAN daemon and handles reconnection |
| T-3 | `ConnectionManager` handles relay fallback when LAN is unreachable |
| T-4 | QR payload parsing validates all required fields |
| T-5 | QR payload with expired timestamp is rejected |
| T-6 | QR payload with invalid URL scheme is rejected |
| T-7 | Agent list merges agents from multiple daemons correctly |
| T-8 | Agent list filters by machine, provider, and status |
| T-9 | Agent list sorts by all supported sort fields |
| T-10 | Session search debounces input at 300ms |
| T-11 | Session search merges results from multiple daemons |
| T-12 | Usage aggregation sums data across daemons correctly |
| T-13 | Usage percentage calculation handles zero total correctly |
| T-14 | Push notification payload format is correct for APNs |
| T-15 | Push notification payload format is correct for FCM |
| T-16 | Deep link parsing navigates to correct screen |
| T-17 | Diff gestures: pinch-to-zoom bounds check (8pt-24pt) |
| T-18 | File tree sorts directories before files |
| T-19 | File tree truncates large directories |
| T-20 | Voice input transcript updates in real time |
| T-21 | Voice input respects 60-second max duration |
| T-22 | `KeyManager.storeKey` / `getKey` round-trip preserves key bytes |
| T-23 | `KeyCache` clears key after 5-minute timeout |
| T-24 | `KeyCache` zeros key memory on clear |
| T-25 | QR key transfer: ECDH shared secret matches on both sides |
| T-26 | QR key transfer: key ID verification detects mismatch |
| T-27 | SQLite cache insert/query for sessions |
| T-28 | SQLite cache LRU eviction removes oldest events |
| T-29 | SQLite integrity check detects corruption |
| T-30 | Offline mode: session list falls back to cached data |

### Integration Tests

| Test | Description |
|------|-------------|
| T-31 | Full QR pairing flow: scan QR -> confirm -> connection established |
| T-32 | Agent list populates from real daemon WebSocket connection |
| T-33 | Permission approval from app reaches daemon and affects agent |
| T-34 | Push notification fires when app is backgrounded and permission is requested |
| T-35 | Deep link from notification navigates to correct agent |
| T-36 | Session search returns results from multiple connected daemons |
| T-37 | Usage dashboard renders charts with real data from daemon |
| T-38 | File explorer navigates remote directory tree from daemon |
| T-39 | Voice input sends transcribed prompt to agent |
| T-40 | Key transfer from Device A to Device B via QR code completes successfully |
| T-41 | Offline mode: disconnect network -> browse cached sessions -> reconnect -> cache refreshes |
| T-42 | App survives daemon disconnection and reconnection without crash |
| T-43 | Concurrent connections to 3 daemons all receive real-time events |

### Manual / Device Tests

| Test | Description |
|------|-------------|
| M-1 | QR scanner on physical iOS device (Camera permission flow) |
| M-2 | QR scanner on physical Android device (Camera permission flow) |
| M-3 | Biometric unlock on iOS (Face ID and Touch ID) |
| M-4 | Biometric unlock on Android (fingerprint) |
| M-5 | Push notification on iOS (permission, actionable) |
| M-6 | Push notification on Android (permission, high priority) |
| M-7 | Voice input on physical device (microphone permission, dictation accuracy) |
| M-8 | App performance on low-end Android device (session list scrolling at 60fps) |
| M-9 | App in background for 30 minutes -> foreground -> reconnection |
| M-10 | Key transfer between two physical devices via QR |
| M-11 | Airplane mode -> browse cached data -> disable airplane mode -> reconnect |
| M-12 | Diff viewer pinch-to-zoom on physical device (gesture accuracy) |

---

## Definition of Done

- [ ] Expo/React Native project builds and runs on both iOS (15+) and Android (API 26+)
- [ ] Bottom tab navigation with Agents, Sessions, Dashboard, Settings tabs
- [ ] Multi-daemon registry: register, edit, remove daemons with AsyncStorage persistence
- [ ] QR pairing: scan QR, validate payload, confirm, establish connection
- [ ] Unified agent list: agents from all daemons, sortable, filterable, real-time updates
- [ ] Agent interaction: send prompts, view streaming output, approve/deny permissions
- [ ] Session history: cross-machine browsing, search, pagination, filter by date/project/machine
- [ ] Usage dashboard: daily bar chart, summary cards, per-project and per-model breakdowns
- [ ] Push notifications: permission requests, completions, errors with deep links
- [ ] iOS actionable notifications for permission approve/deny without opening app
- [ ] Diff viewer shell with pinch-to-zoom and horizontal scroll
- [ ] File explorer: remote file tree with git status indicators, syntax-highlighted viewer
- [ ] Voice input: platform-native speech-to-text, real-time transcript, visual feedback
- [ ] Encryption key management: Keychain/Keystore storage, biometric unlock, key status display
- [ ] QR key transfer: full ECDH flow with verification step
- [ ] Offline mode: SQLite cache, stale data indicators, graceful degradation
- [ ] All 30 unit tests pass
- [ ] All 13 integration tests pass
- [ ] All 12 manual/device tests verified on physical devices
- [ ] Performance targets met: cold start < 2s, tab switch < 100ms, list render < 300ms
- [ ] Dark theme default with light theme toggle
- [ ] Deep linking from notifications to correct screens
- [ ] No crashes on network disconnection/reconnection
- [ ] Memory usage stays under 200MB during normal operation
- [ ] App size under 50MB (download) and 100MB (installed)
