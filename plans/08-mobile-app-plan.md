# Implementation Plan: Story 08 -- Mobile App (Paseo Fork)

**Date**: 2026-02-22
**Story**: 14-mobile-app
**Status**: Planning
**Estimated Total Effort**: ~18-22 days (144-176 hours)
**Prerequisites**: Story 02 (CLI Session Rendering) rendering components available as a dependency; Story 07 (Encrypted Cloud Sync) crypto API consumable; Story 05 (Agent Process Orchestration) daemon WebSocket API operational; Story 11 (Sync Server) relay infrastructure running.

---

### Relationship to Other Stories

This is the **primary remote interface story**. It produces the Expo/React Native mobile app that consumes APIs and protocols defined by multiple other stories:

- **Story 02** (CLI Session Rendering): Provides the structured event renderer, streaming text renderer, diff viewer component, and terminal emulator widget (F13.1-F13.14). This story provides the *shell* those components render inside.
- **Story 05** (Agent Process Orchestration): Provides the daemon's WebSocket API for agent lifecycle operations -- `listAgents`, `getAgent`, `sendPrompt`, `approvePermission`, `denyPermission`, streaming subscriptions.
- **Story 06** (Local Dashboard): Shares the daemon's HTTP/WS server endpoints. The mobile app connects to the same `/ws` endpoint the dashboard uses.
- **Story 07** (Encrypted Cloud Sync): Provides the client-side encryption API (`XChaCha20-Poly1305`, `Argon2id` key derivation) that this story consumes for encrypting/decrypting session data.
- **Story 11** (Sync Server): Provides the Cloudflare relay for E2EE WebSocket connections when daemons are not on the same LAN.
- **Story 12** (Security & Encryption): Defines the cryptographic primitives (Curve25519 ECDH, XChaCha20-Poly1305, key storage specifications) consumed by QR pairing and key transfer.

### What This Plan Does NOT Cover

- Session rendering components (Story 02 / F13) -- this plan integrates them but does not implement them.
- Daemon-side WebSocket API (Story 05 / Story 06) -- this plan calls those APIs.
- Sync server / relay infrastructure (Story 11) -- this plan connects through the relay.
- Encryption algorithm implementation (Story 12) -- this plan wraps libsodium calls.
- Session takeover / managed PTY proxy (Story 01 / F12.3-F12.7) -- out of scope.

---

## Task Dependency Graph

```
Task 1: Expo Project Bootstrap & Navigation Shell
  |
  +---> Task 2: Type System & Data Models
  |       |
  |       +---> Task 3: Connection Manager & Daemon Connection (needs 2)
  |       |       |
  |       |       +---> Task 5: Unified Agent View -- AgentListScreen (needs 3, 4)
  |       |       |       |
  |       |       |       +---> Task 6: Agent Interaction -- AgentDetailScreen (needs 5)
  |       |       |
  |       |       +---> Task 7: Session History -- SessionListScreen (needs 3, 4)
  |       |       |       |
  |       |       |       +---> Task 8: Session Search (needs 7)
  |       |       |
  |       |       +---> Task 9: Usage Dashboard -- DashboardScreen (needs 3)
  |       |       |
  |       |       +---> Task 10: File Explorer (needs 3)
  |       |       |
  |       |       +---> Task 14: Push Notifications (needs 3)
  |       |
  |       +---> Task 4: QR Code Pairing (needs 2, 1)
  |       |
  |       +---> Task 11: Voice Input (needs 2)
  |       |
  |       +---> Task 12: Encryption Key Management (needs 2)
  |       |       |
  |       |       +---> Task 13: QR Key Transfer (needs 12, 4)
  |       |
  |       +---> Task 15: Offline Mode & SQLite Cache (needs 2)
  |
  +---> Task 16: Theme System (needs 1)
  |
  +---> Task 17: Integration & E2E Tests (needs all)
```

---

## Tasks

### Task 1: Expo Project Bootstrap & Navigation Shell

**Description**

Initialize the Expo/React Native project with the full navigation structure: bottom tab navigator (Agents, Sessions, Dashboard, Settings), stack navigators per tab, and modal overlay for QR scanning. This task produces a buildable app skeleton with placeholder screens that subsequent tasks fill in.

**Prerequisites/Inputs**

- Node.js 18+, npm/yarn, Expo CLI (`npx expo`)
- Paseo fork repository (for reference architecture; we are forking the navigation patterns, not copying code verbatim)
- Expo SDK 51+

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/` | Root directory for the Expo project |
| `mobile/app.json` | Expo configuration (app name, slug, SDK version, iOS/Android config) |
| `mobile/app/(tabs)/_layout.tsx` | Bottom tab navigator layout with 4 tabs |
| `mobile/app/(tabs)/agents.tsx` | Agents tab root (placeholder) |
| `mobile/app/(tabs)/sessions.tsx` | Sessions tab root (placeholder) |
| `mobile/app/(tabs)/dashboard.tsx` | Dashboard tab root (placeholder) |
| `mobile/app/(tabs)/settings.tsx` | Settings tab root (placeholder) |
| `mobile/app/agent/[id].tsx` | Agent detail screen (placeholder) |
| `mobile/app/session/[id].tsx` | Session detail screen (placeholder) |
| `mobile/app/session/file-explorer.tsx` | File explorer screen (placeholder) |
| `mobile/app/settings/daemons.tsx` | Daemon registry screen (placeholder) |
| `mobile/app/settings/daemon/[id].tsx` | Daemon detail screen (placeholder) |
| `mobile/app/settings/encryption.tsx` | Encryption key screen (placeholder) |
| `mobile/app/settings/notifications.tsx` | Notification settings screen (placeholder) |
| `mobile/app/_layout.tsx` | Root layout with navigation container, modal overlays |
| `mobile/components/shared/QRScanner.tsx` | QR scanner modal (placeholder) |
| `mobile/components/shared/PairConfirmationModal.tsx` | Pair confirmation modal (placeholder) |

Bottom tab configuration:

```typescript
// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: '#58A6FF', tabBarStyle: { backgroundColor: '#0D1117', borderTopColor: '#30363D' } }}>
      <Tabs.Screen name="agents" options={{ title: 'Agents', tabBarIcon: ({ color, size }) => <Ionicons name="terminal-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="sessions" options={{ title: 'Sessions', tabBarIcon: ({ color, size }) => <Ionicons name="time-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} /> }} />
    </Tabs>
  );
}
```

Deep link configuration in `app/_layout.tsx`:

```typescript
const DeepLinkConfig = {
  screens: {
    AgentsTab: { screens: { AgentDetail: 'agent/:hostId/:agentId' } },
    SessionsTab: { screens: { SessionDetail: 'session/:hostId/:sessionId' } },
  },
};
```

Project initialization commands:

```bash
npx create-expo-app mobile --template tabs
cd mobile
npx expo install expo-router @react-navigation/native @react-navigation/bottom-tabs @react-navigation/stack react-native-screens react-native-safe-area-context
npx expo install @expo/vector-icons
npx expo install react-native-gesture-handler react-native-reanimated
```

**Acceptance Criteria**

- [ ] `npx expo start` launches the app on iOS Simulator and Android Emulator
- [ ] Bottom tab navigator renders with 4 tabs: Agents, Sessions, Dashboard, Settings
- [ ] Each tab shows a placeholder screen with the tab name
- [ ] Stack navigation works: tapping a list item pushes a detail screen
- [ ] QR scanner modal presents over any active tab
- [ ] Safe area insets are handled on all screens (notch, home indicator)
- [ ] Navigation transitions complete in under 200ms
- [ ] Back navigation (swipe or button) works on all stack screens
- [ ] App builds for both iOS (15+) and Android (API 26+)
- [ ] `app.json` is configured with correct bundleIdentifier and package name

**Edge Cases**

- Android hardware back button must pop the stack navigator, not exit the app (unless at tab root)
- Tab bar must remain visible when navigating within a tab's stack; hide during full-screen modals
- Deep link with an invalid agent/session ID should show a "Not Found" screen rather than crashing

**Estimated Effort**: L (Large) -- 8-12 hours

---

### Task 2: Type System & Data Models

**Description**

Define all TypeScript types, interfaces, and enums that the entire app shares. This is the foundational type layer that every screen, hook, service, and component depends on. All types from the story specification are codified here with JSDoc documentation.

**Prerequisites/Inputs**

- Task 1 (Expo project exists)
- Story 08 specification (data structures from sections 2-14)
- Story 05 specification (AgentStreamEvent types)

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/types/navigation.ts` | `RootTabParamList`, stack param lists for each tab |
| `mobile/types/daemon.ts` | `HostProfile`, `ConnectionState`, `DaemonRegistryState` |
| `mobile/types/agent.ts` | `AgentSummary`, `AgentStatus`, `AgentDetail`, `AgentStreamEvent` |
| `mobile/types/session.ts` | `SessionSummary`, `SessionFilter`, `SessionSearchResult`, `SearchMatch`, `SessionEventsPage` |
| `mobile/types/usage.ts` | `UsageStats`, `DailyUsage`, `ProjectUsage`, `ModelUsage`, `DateRange` |
| `mobile/types/file.ts` | `FileEntry`, `GitFileStatus` |
| `mobile/types/notification.ts` | `AgentNotification`, `NotificationType`, `NotificationSettings` |
| `mobile/types/crypto.ts` | `KeyInfo`, `KeyStorageOptions`, `PairingPayload`, `KeyTransferPayload` |
| `mobile/types/errors.ts` | `QRScanError`, `VoiceInputError`, `ConnectionError` |

Key interfaces (exact from story spec):

```typescript
// types/daemon.ts
export interface HostProfile {
  id: string;
  name: string;
  hostname: string;
  connectionType: 'lan' | 'relay';
  lanAddress?: string;
  relayServerId?: string;
  publicKey: string;
  pairedAt: string;
  lastSeen: string;
  connectionState: ConnectionState;
  daemonVersion: string;
  os: 'linux' | 'macos' | 'windows';
  machineId: string;
}

export type ConnectionState = 'connected' | 'disconnected' | 'connecting' | 'error';
```

```typescript
// types/agent.ts
export type AgentStatus = 'initializing' | 'idle' | 'running' | 'waiting_permission' | 'error' | 'completed' | 'disconnected';

export interface AgentSummary {
  id: string;
  hostId: string;
  hostName: string;
  provider: 'claude-code' | 'opencode' | 'codex';
  model: string;
  status: AgentStatus;
  projectName: string;
  projectPath: string;
  currentActivity?: string;
  lastPrompt?: string;
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; estimatedCost: number; };
  pendingPermissions: number;
}
```

All types must:
- Use `string` for ISO 8601 timestamps (not `Date`)
- Be exported individually (no default exports)
- Include JSDoc comments for non-obvious fields
- Use discriminated unions for error types

**Acceptance Criteria**

- [ ] All 9 type files compile without errors under `strict` TypeScript configuration
- [ ] Every interface from Story 08 sections 2-14 is represented
- [ ] Navigation param lists are complete for all screens
- [ ] No `any` types used anywhere
- [ ] All optional fields are explicitly marked with `?`
- [ ] Types are importable from other files: `import { HostProfile } from '@/types/daemon'`

**Edge Cases**

- `estimatedCost` can be 0 for cached sessions where cost was not computed
- `lastSeen` may be arbitrarily far in the past for daemons that have been offline

**Estimated Effort**: S (Small) -- 3-4 hours

---

### Task 3: Connection Manager & Daemon Connection

**Description**

Implement the `ConnectionManager` singleton and `DaemonConnection` class that manage persistent WebSocket connections to all registered daemons. The `ConnectionManager` handles connection lifecycle, exponential backoff reconnection, and app state transitions. The `DaemonConnection` wraps each WebSocket and provides typed methods for agent, session, file, and usage operations.

**Prerequisites/Inputs**

- Task 2 (type definitions)
- Daemon WebSocket API specification (Story 05, Story 06)
- Paseo relay protocol specification (for E2EE relay connections)

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/services/connection-manager.ts` | `ConnectionManager` singleton class |
| `mobile/services/daemon-connection.ts` | `DaemonConnection` class per host |
| `mobile/storage/daemon-registry.ts` | AsyncStorage wrapper for `HostProfile[]` persistence |
| `mobile/hooks/useConnection.ts` | React hook exposing connection state to components |

`ConnectionManager` class:

```typescript
// services/connection-manager.ts
class ConnectionManager {
  private static instance: ConnectionManager;
  private connections: Map<string, DaemonConnection> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private listeners: Set<(hostId: string, state: ConnectionState) => void> = new Set();

  static getInstance(): ConnectionManager;

  async connectAll(hosts: HostProfile[]): Promise<void>;
  async connect(host: HostProfile): Promise<void>;
  async disconnect(hostId: string): Promise<void>;
  async disconnectAll(): Promise<void>;

  getConnection(hostId: string): DaemonConnection | undefined;
  getConnectionState(hostId: string): ConnectionState;

  onConnectionStateChange(callback: (hostId: string, state: ConnectionState) => void): () => void;

  // Internal
  private scheduleReconnect(host: HostProfile, attempt: number): void;
  private clearReconnect(hostId: string): void;
}
```

Reconnection strategy:
- Backoff: `delay = min(1000 * 2^attempt, 60000)` -- 1s, 2s, 4s, 8s, 16s, 32s, 60s cap
- On app background (`AppState` change to `background`): reduce heartbeat from 10s to 30s
- On app foreground: immediate heartbeat to all connections + refresh agent data
- On network state change (NetInfo): trigger reconnect on all disconnected hosts

`DaemonConnection` class:

```typescript
// services/daemon-connection.ts
class DaemonConnection {
  readonly hostId: string;
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, Set<(event: any) => void>> = new Map();
  private messageQueue: Array<{ resolve: Function; reject: Function; timeout: ReturnType<typeof setTimeout> }> = [];
  private nextRequestId: number = 1;

  constructor(host: HostProfile);

  async open(): Promise<void>;
  close(): void;

  get state(): ConnectionState;

  // Agent operations (send JSON-RPC over WebSocket)
  async listAgents(): Promise<AgentSummary[]>;
  async getAgent(agentId: string): Promise<AgentDetail>;
  async sendPrompt(agentId: string, prompt: string): Promise<void>;
  async approvePermission(agentId: string, toolUseId: string): Promise<void>;
  async denyPermission(agentId: string, toolUseId: string): Promise<void>;

  // Session operations
  async listSessions(filter?: SessionFilter): Promise<SessionSummary[]>;
  async getSessionEvents(sessionId: string, cursor?: string): Promise<SessionEventsPage>;

  // File operations
  async listFiles(agentId: string, path: string): Promise<FileEntry[]>;
  async getFileContent(agentId: string, filePath: string): Promise<{ content: string; size: number; mimeType: string }>;
  async getGitStatus(agentId: string): Promise<Map<string, GitFileStatus>>;

  // Usage operations
  async getUsageStats(range: DateRange): Promise<UsageStats>;

  // Streaming subscriptions
  subscribeToAgent(agentId: string, callback: (event: AgentStreamEvent) => void): () => void;
  subscribeToEvents(callback: (event: DaemonEvent) => void): () => void;

  // Internal
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  private handleMessage(data: string): void;
  private sendHeartbeat(): void;
}
```

WebSocket message protocol (JSON-RPC 2.0 over WebSocket):

```json
// Request
{ "jsonrpc": "2.0", "method": "agent.list", "id": 1, "params": {} }

// Response
{ "jsonrpc": "2.0", "id": 1, "result": [...] }

// Notification (server push)
{ "jsonrpc": "2.0", "method": "agent.event", "params": { "agentId": "...", "event": {...} } }
```

AsyncStorage registry:

```typescript
// storage/daemon-registry.ts
const REGISTRY_KEY = '@agentctx/daemon-registry';

export async function loadRegistry(): Promise<HostProfile[]>;
export async function saveRegistry(hosts: HostProfile[]): Promise<void>;
export async function addHost(host: HostProfile): Promise<void>;
export async function removeHost(hostId: string): Promise<void>;
export async function updateHost(hostId: string, updates: Partial<HostProfile>): Promise<void>;
```

React hook:

```typescript
// hooks/useConnection.ts
export function useConnection(hostId: string): {
  state: ConnectionState;
  connection: DaemonConnection | undefined;
};

export function useAllConnections(): {
  hosts: HostProfile[];
  connectionStates: Map<string, ConnectionState>;
  connectedCount: number;
  totalCount: number;
};
```

**Acceptance Criteria**

- [ ] `ConnectionManager` connects to all registered daemons on initialization
- [ ] LAN connections use `ws://{lanAddress}/ws`
- [ ] Relay connections use `wss://relay.agentctx.dev` with Paseo relay protocol
- [ ] Disconnected daemons reconnect with exponential backoff (1s, 2s, 4s... 60s cap)
- [ ] Connection state changes propagate to UI within 100ms via `onConnectionStateChange`
- [ ] App background reduces heartbeat frequency from 10s to 30s
- [ ] App foreground triggers immediate heartbeat on all connections
- [ ] `DaemonConnection.sendRequest` times out after 30s with a rejection
- [ ] Removing a host closes its WebSocket and clears its reconnection timer
- [ ] `HostProfile[]` persists across app restarts via AsyncStorage
- [ ] Network state changes (NetInfo) trigger reconnect attempts on disconnected hosts
- [ ] Concurrent connections to 5+ daemons do not cause memory pressure or thread starvation

**Edge Cases**

- WebSocket `onerror` before `onopen` (daemon unreachable): set state to `error`, begin backoff
- WebSocket `onclose` with code 1006 (abnormal): treat as disconnect, begin backoff
- Multiple rapid connect/disconnect calls for the same host: only one WebSocket exists at a time
- `sendRequest` called while WebSocket is connecting: queue the request, send on open
- AsyncStorage `getItem` returns `null` on first launch: return empty array, not throw

**Estimated Effort**: XL (Extra Large) -- 12-16 hours

---

### Task 4: QR Code Pairing

**Description**

Implement the QR code scanning, payload validation, ephemeral key exchange (ECDH), and daemon pairing flow. This includes the camera permission handling, QR scanner component, pairing confirmation modal, and the cryptographic handshake.

**Prerequisites/Inputs**

- Task 1 (navigation shell for modal overlay)
- Task 2 (types: `PairingPayload`, `HostProfile`)
- Task 3 (ConnectionManager to register the new host after pairing)
- `expo-camera` for QR scanning
- `libsodium-wrappers-sumo` for Curve25519 ECDH

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `mobile/components/shared/QRScanner.tsx` | Camera-based QR scanner with validation |
| `mobile/components/shared/PairConfirmationModal.tsx` | Confirmation UI after valid scan |
| `mobile/hooks/useCamera.ts` | Camera permission handling hook |
| `mobile/services/pairing.ts` | ECDH key exchange and pairing handshake logic |

QR payload URL format: `agentctx://pair?data=<base64url-encoded-json>`

Decoded JSON:
```json
{
  "version": 1,
  "hostname": "work-macbook",
  "os": "macos",
  "daemonVersion": "1.0.0",
  "machineId": "a3f7b2c9d1e4",
  "lan": { "address": "192.168.1.42", "port": 9120 },
  "relay": { "serverId": "server-abc123def456" },
  "ephemeralPublicKey": "<base64>",
  "expiresAt": "2026-02-21T15:00:00Z",
  "nonce": "<base64>"
}
```

Validation checks in `QRScanner`:
1. URL scheme is `agentctx://pair`
2. `data` parameter exists and is valid base64url
3. Decoded JSON has all required fields (`version`, `hostname`, `os`, `machineId`, `ephemeralPublicKey`, `expiresAt`)
4. `version` is 1 (future-proof)
5. `expiresAt` is not more than 5 minutes in the past
6. `ephemeralPublicKey` is a valid 32-byte Curve25519 key when decoded from base64

Pairing handshake (`services/pairing.ts`):

```typescript
import sodium from 'libsodium-wrappers-sumo';

export async function performPairing(payload: PairingPayload): Promise<HostProfile> {
  await sodium.ready;

  // 1. Generate ephemeral Curve25519 keypair
  const myKeypair = sodium.crypto_box_keypair();

  // 2. Compute shared secret via ECDH
  const theirPublicKey = sodium.from_base64(payload.ephemeralPublicKey);
  const sharedSecret = sodium.crypto_scalarmult(myKeypair.privateKey, theirPublicKey);

  // 3. Connect to daemon (LAN first, relay fallback)
  const ws = await connectToDaemon(payload);

  // 4. Exchange public keys
  ws.send(JSON.stringify({
    type: 'pair_handshake',
    publicKey: sodium.to_base64(myKeypair.publicKey),
  }));

  // 5. Receive encrypted HostProfile data
  const response = await waitForMessage(ws, 'pair_response', 10000);
  const decrypted = sodium.crypto_secretbox_open_easy(
    sodium.from_base64(response.ciphertext),
    sodium.from_base64(response.nonce),
    sharedSecret
  );

  // 6. Parse and return HostProfile
  const hostData = JSON.parse(sodium.to_string(decrypted));

  // 7. Destroy ephemeral keys
  sodium.memzero(myKeypair.privateKey);
  sodium.memzero(sharedSecret);

  return {
    id: crypto.randomUUID(),
    name: payload.hostname,
    hostname: payload.hostname,
    connectionType: ws.url.startsWith('wss://relay') ? 'relay' : 'lan',
    lanAddress: payload.lan ? `${payload.lan.address}:${payload.lan.port}` : undefined,
    relayServerId: payload.relay?.serverId,
    publicKey: hostData.publicKey,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    connectionState: 'connected',
    daemonVersion: payload.daemonVersion,
    os: payload.os,
    machineId: payload.machineId,
  };
}

async function connectToDaemon(payload: PairingPayload): Promise<WebSocket> {
  // Try LAN first (3s timeout)
  if (payload.lan) {
    try {
      return await connectWithTimeout(`ws://${payload.lan.address}:${payload.lan.port}/ws/pair`, 3000);
    } catch { /* fall through to relay */ }
  }
  // Fallback to relay
  if (payload.relay) {
    return await connectWithTimeout(`wss://relay.agentctx.dev/pair/${payload.relay.serverId}`, 10000);
  }
  throw new Error('No connection method available');
}
```

Camera permission hook:

```typescript
// hooks/useCamera.ts
export function useCamera(): {
  permission: 'granted' | 'denied' | 'blocked' | 'undetermined';
  requestPermission: () => Promise<'granted' | 'denied' | 'blocked'>;
};
```

Duplicate detection: If `machineId` matches an existing `HostProfile`, update the existing entry instead of creating a new one.

**Acceptance Criteria**

- [ ] QR scanner opens as a modal overlay with live camera preview
- [ ] Camera permission is requested before opening scanner; `blocked` state shows instructions to enable in Settings
- [ ] QR payload is validated: correct URL scheme, valid JSON, required fields present
- [ ] Expired QR codes (> 5 minutes old) are rejected with "QR code has expired" error
- [ ] Pairing confirmation modal shows machine name, OS, version, and connection type
- [ ] User can edit the machine name before confirming
- [ ] On confirmation, `HostProfile` is persisted in AsyncStorage via `addHost()`
- [ ] LAN connection is attempted first (3s timeout); relay is used as fallback
- [ ] Ephemeral keys are zeroed after pairing completes (success or failure)
- [ ] Scanning the same daemon's QR twice updates the existing `HostProfile` (no duplicate)
- [ ] Error states (invalid QR, expired, network error) show user-friendly messages with retry option

**Edge Cases**

- QR code scanned in low light: rely on `expo-camera` auto-exposure; show "Move closer" hint if no detection after 5s
- QR code from a different app (not `agentctx://pair`): show "Invalid QR code -- this doesn't appear to be an AgentContext pairing code"
- Network timeout during handshake: show "Could not reach [hostname]. Ensure the machine is online." with retry button
- User cancels pairing after scanning but before confirmation: no state change, scanner can be reopened
- Camera permission permanently denied on Android: show dialog with "Open Settings" button

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 5: Unified Agent View -- AgentListScreen

**Description**

Implement the Agents tab main screen that displays all agents across all connected daemons in a unified, sortable, filterable list with real-time updates.

**Prerequisites/Inputs**

- Task 3 (ConnectionManager for fetching agent data and subscribing to events)
- Task 4 (at least one daemon paired, so agent data can be displayed)
- `@shopify/flash-list` for virtualized rendering

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/app/(tabs)/agents.tsx` | Full implementation replacing placeholder |
| `mobile/components/agents/AgentCard.tsx` | Individual agent card component |
| `mobile/components/agents/AgentStatusBadge.tsx` | Status indicator dot with color |
| `mobile/components/agents/AgentFilterBar.tsx` | Horizontal filter chip row |
| `mobile/components/shared/EmptyState.tsx` | Reusable empty state component |
| `mobile/hooks/useAgentList.ts` | Hook that merges agent data from all daemons |

`useAgentList` hook:

```typescript
export function useAgentList(): {
  agents: AgentSummary[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  sortBy: (field: 'lastActivity' | 'machine' | 'status' | 'project') => void;
  sortDirection: 'asc' | 'desc';
  setFilter: (filter: Partial<AgentListFilter>) => void;
  activeFilter: AgentListFilter;
} {
  // 1. On mount: fetch listAgents() from all connected DaemonConnections
  // 2. Merge into single array keyed by (hostId, agentId) -- avoid duplicates
  // 3. Subscribe to agent events from all daemons via subscribeToEvents()
  // 4. On agent event: update the specific AgentSummary in state (in-place update, no full re-render)
  // 5. On unmount: unsubscribe from all daemon event subscriptions
}

interface AgentListFilter {
  machineId: string | null;
  provider: string | null;
  status: AgentStatus | null;
}
```

`AgentCard` component layout:

```
+---------------------------------------------+
| [colored dot]  my-project                    |
|              Work MacBook                    |
|              Running Bash command   2m ago    |
|              In: 8.2k  Out: 3.1k  $0.42    |
|                              [! 2 pending]   |
+---------------------------------------------+
```

- Status dot colors: green=running, yellow=waiting_permission, red=error, grey=idle/disconnected, blue=initializing
- Project name: bold, 16pt
- Machine name: secondary color, 12pt
- Current activity / last prompt: truncated to 60 chars, 14pt
- Time since last activity: relative format ("2m ago", "1h ago", "yesterday")
- Token usage: "In: 8.2k  Out: 3.1k" formatted with K/M suffixes
- Permission badge: orange circle with count, visible only when `pendingPermissions > 0`

Filter bar:
- Horizontal `ScrollView` of filter chips
- "Machine" chip: dropdown listing all registered daemon names
- "Provider" chip: multi-select (Claude Code, OpenCode, Codex)
- "Status" chip: multi-select (Running, Idle, Waiting, Error, Completed)

Empty states:
- No daemons registered: "No machines registered. Tap + to scan a QR code and pair your first machine." + "Pair Machine" button
- All daemons disconnected: "All machines are offline. Check your network connection." + reconnect icon
- No agents running: "No agents running. Start an agent from your machine's terminal or dashboard."

**Acceptance Criteria**

- [ ] Agent list shows agents from all connected daemons in a single FlashList
- [ ] Each AgentCard displays status dot, project, machine, activity, time ago, tokens, cost
- [ ] Default sort: `lastActivityAt` descending (most recently active first)
- [ ] Sort by machine, status, or project name via header taps
- [ ] Filter by machine, provider, or status via horizontal chip bar
- [ ] Pull-to-refresh triggers `listAgents()` on all connected daemons
- [ ] Agent status changes update in real time (< 500ms from daemon event to UI update)
- [ ] Tapping an AgentCard navigates to `agent/[id]` with `hostId` and `agentId` params
- [ ] Agents from disconnected daemons show with `disconnected` status and 50% opacity
- [ ] Pending permission count badge is visible when > 0
- [ ] Empty states display appropriate messages with actionable suggestions
- [ ] List scrolls at 60fps with 50+ agents (FlashList virtualization)

**Edge Cases**

- Two agents on different machines with the same project name: differentiated by machine name
- Agent list updates while user is mid-scroll: maintain scroll position, do not jump
- Filter returns 0 results: show "No agents match your filters" with "Clear Filters" button
- Daemon connects while agent list is visible: new agents appear in list without manual refresh

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 6: Agent Interaction -- AgentDetailScreen

**Description**

Implement the agent detail screen where users view streaming agent output, send prompts, and approve/deny permission requests. This screen hosts the session timeline area (delegated to Story 02 rendering components) and provides the prompt input and permission action sheet.

**Prerequisites/Inputs**

- Task 5 (navigation from AgentListScreen)
- Task 3 (DaemonConnection for agent operations and streaming)
- Story 02 rendering components (or placeholder/mock for initial development)

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/app/agent/[id].tsx` | Full implementation replacing placeholder |
| `mobile/components/shared/PromptInput.tsx` | Multiline text input with send/voice buttons |
| `mobile/components/agents/PermissionActionSheet.tsx` | Bottom sheet for permission requests |
| `mobile/components/agents/AgentHeader.tsx` | Status, model, tokens, cost header bar |
| `mobile/hooks/useAgentStream.ts` | Hook for streaming agent events |

`useAgentStream` hook:

```typescript
export function useAgentStream(hostId: string, agentId: string): {
  events: AgentStreamEvent[];
  status: AgentStatus;
  pendingPermissions: PermissionRequest[];
  tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; estimatedCost: number };
  sendPrompt: (prompt: string) => Promise<void>;
  approvePermission: (toolUseId: string) => Promise<void>;
  denyPermission: (toolUseId: string) => Promise<void>;
  alwaysAllowPermission: (toolUseId: string) => Promise<void>;
  interrupt: () => Promise<void>;
  isConnected: boolean;
}
```

Screen layout (from story spec):

```
+---------------------------------------+
| < back    [agent-name]    [machine]   |
|---------------------------------------|
| Status: running           Cost: $0.42 |
| Model: claude-opus-4-6   Tokens: 12k |
|---------------------------------------|
|                                       |
|  [ Session timeline area ]            |
|  (Story 02 F13 rendering components  |
|   or placeholder ScrollView)          |
|                                       |
|---------------------------------------|
| [mic] [message input field]    [send] |
+---------------------------------------+
```

`PromptInput` component:

```typescript
interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  onVoiceStart: () => void;
  disabled: boolean;
  placeholder: string;
  maxLength: number;  // 100,000 characters
}
```

Behavior:
- Auto-growing TextInput: 1 line to 6 lines, then internal scroll
- `KeyboardAvoidingView` wraps the entire screen to keep input above keyboard
- Send button: enabled when `!disabled && text.trim().length > 0`
- Voice button: microphone icon to the left of input field (wired in Task 11)
- Disabled state when agent is `running`: placeholder "Agent is running..."
- Disabled state when agent is `error`/`completed`: placeholder "Session ended"

`PermissionActionSheet` (presented as a bottom sheet via `@gorhom/bottom-sheet` or `react-native-reanimated`):

```typescript
interface PermissionActionSheetProps {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
  onDismiss: () => void;
}
```

Content:
- Tool name + icon (map tool names to Ionicons: Bash=terminal, Read=document, Write=create, Edit=pencil, Glob/Grep=search)
- Description: human-readable summary of what the tool wants to do
- File path or command (if applicable), in monospace
- Three buttons: "Allow" (green), "Deny" (red), "Always Allow" (blue)
- Haptic feedback on button press: `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)` on iOS

Interrupt: long-press on the header status area presents an "Interrupt Agent?" confirmation dialog.

**Acceptance Criteria**

- [ ] Agent detail screen header shows status, model, token usage, and cost
- [ ] Session timeline area renders (placeholder or Story 02 components)
- [ ] Prompt input is multiline, auto-growing up to 6 lines, with KeyboardAvoidingView
- [ ] Send button enabled only when agent is idle and input is non-empty
- [ ] Prompt is sent to daemon via `DaemonConnection.sendPrompt()` and appears in timeline immediately
- [ ] Permission requests appear as bottom sheet with Allow/Deny/Always Allow
- [ ] Haptic feedback fires on permission button press (iOS and Android)
- [ ] Permission response is sent to daemon and reflected in timeline within 200ms
- [ ] Agent can be interrupted via long-press on status area
- [ ] Screen handles status transitions: running -> idle -> waiting_permission -> running
- [ ] Input placeholder text changes based on agent status
- [ ] Multiple pending permissions are queued; dismissing one shows the next

**Edge Cases**

- Permission request arrives while another is displayed: queue it, show badge count
- Agent transitions to `completed` while user is typing: input becomes disabled, draft is preserved
- Connection drops while viewing: banner "Connection lost. Reconnecting..." shown above timeline
- Very long prompt (>10,000 chars): input remains responsive, send transmits the full text
- Keyboard dismiss on scroll: tapping the timeline area dismisses the keyboard

**Estimated Effort**: XL (Extra Large) -- 14-18 hours

---

### Task 7: Session History -- SessionListScreen

**Description**

Implement the Sessions tab main screen with cross-machine session browsing, pagination, date/machine/project filters, and real-time indicators for active sessions.

**Prerequisites/Inputs**

- Task 3 (DaemonConnection for `listSessions()`)
- Task 2 (SessionSummary, SessionFilter types)
- `@shopify/flash-list` for virtualized list

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/app/(tabs)/sessions.tsx` | Full implementation replacing placeholder |
| `mobile/components/sessions/SessionCard.tsx` | Individual session card component |
| `mobile/components/sessions/SessionFilterBar.tsx` | Date range, machine, project filter chips |
| `mobile/hooks/useSessionList.ts` | Hook that fetches, merges, paginates sessions |

`useSessionList` hook:

```typescript
export function useSessionList(): {
  sessions: SessionSummary[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  hasMore: boolean;
  filter: SessionFilter;
  setFilter: (filter: Partial<SessionFilter>) => void;
}
```

Pagination strategy:
- Initial load: request 20 sessions from each connected daemon, sorted by `startedAt` descending
- Client-side merge: interleave results from all daemons by `startedAt`
- Infinite scroll: when user scrolls to bottom, request the next 20 from each daemon using cursor
- Cursor: each daemon returns a cursor string; the hook maintains one cursor per daemon

`SessionCard` layout:

```
+---------------------------------------------+
| [status dot]  my-project (Work MacBook)      |
|              "Add dark mode support to..."   |
|              2h 15m | 342 events | $1.23     |
|              Today, 2:30 PM                  |
+---------------------------------------------+
```

- Status dot: green=active, grey=completed, red=error
- Project name: bold + machine name in parentheses (secondary color)
- Last prompt preview: truncated to 150 chars, italic
- Duration: formatted as "Xh Ym" or "Xm" or "Xs"
- Event count + estimated cost
- Timestamp: relative for today ("2:30 PM"), absolute for older dates ("Feb 21")

Filter bar chips:
- Date range: "All", "Today", "This Week", "This Month", "Custom" (date picker)
- Machine: dropdown listing all registered daemons
- Project: dropdown listing all known projects
- Status: "All", "Active", "Completed", "Error"

**Acceptance Criteria**

- [ ] Session list shows sessions from all connected daemons sorted by date (newest first)
- [ ] Each SessionCard displays project, machine, duration, event count, cost, last prompt preview
- [ ] Filter chips: date range (Today, This Week, This Month, Custom), machine, project, status
- [ ] Pagination loads 20 sessions per page with infinite scroll
- [ ] Pull-to-refresh fetches fresh session data from all daemons
- [ ] Active sessions show a green dot and update their `lastActivityAt` in real time
- [ ] Tapping a SessionCard navigates to `session/[id]` with `hostId` and `sessionId` params
- [ ] Sessions from disconnected daemons appear with "Last synced Xh ago" indicator
- [ ] Empty state: "No sessions found" with filter-clear suggestion
- [ ] List scrolls at 60fps with 100+ sessions

**Edge Cases**

- Different daemons have overlapping session timestamps: merge sort is stable, preserving per-daemon order
- Daemon connects while session list is visible: trigger automatic refresh
- Custom date range where end < start: swap them silently
- Session list with 0 sessions matching filter: show "No sessions match" empty state
- Very old sessions (> 1 year): show full date "Feb 21, 2025"

**Estimated Effort**: L (Large) -- 8-12 hours

---

### Task 8: Session Search

**Description**

Implement the two-phase session search: local debounced search across cached session metadata, and remote full-text search across all connected daemons' event stores. Search results show highlighted matching snippets.

**Prerequisites/Inputs**

- Task 7 (SessionListScreen that hosts the search bar)
- Task 15 (SQLite cache for local search, or at minimum the session metadata cache)
- Task 3 (DaemonConnection for remote search)

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/components/sessions/SessionSearchBar.tsx` | Search input with debounce |
| `mobile/hooks/useSessionSearch.ts` | Two-phase search hook |

`useSessionSearch` hook:

```typescript
export function useSessionSearch(): {
  query: string;
  setQuery: (q: string) => void;
  localResults: SessionSummary[];      // From SQLite cache, appears instantly
  remoteResults: SessionSearchResult[]; // From daemons, appears on submit
  isSearchingLocal: boolean;
  isSearchingRemote: boolean;
  submitSearch: () => void;             // Triggers remote search
  clearSearch: () => void;
}

interface SessionSearchResult {
  session: SessionSummary;
  matches: SearchMatch[];
}

interface SearchMatch {
  eventType: string;
  fieldName: string;     // "prompt", "tool_input", "tool_output"
  snippet: string;       // Plain text with match boundaries marked
  eventSequence: number;
}
```

Local search (phase 1):
- As user types, debounce at 300ms
- Query SQLite `cached_sessions` table: `WHERE project_name LIKE '%query%' OR last_prompt_preview LIKE '%query%'`
- Results appear immediately in the list
- No highlighting (metadata-only search)

Remote search (phase 2):
- On explicit submit (Enter key or "Search" button)
- Send search query to all connected daemons: `DaemonConnection.searchSessions(query)`
- Each daemon returns `SessionSearchResult[]` with matching snippets
- Merge results from all daemons, sorted by relevance (match count then date)
- Highlight matched terms in snippets using `<Text style={{ backgroundColor: '#3B2A00' }}>` wrapper

Search bar component:
- TextInput with search icon on the left, clear (X) button on the right
- "Search" button appears on the right when text is entered
- When active, filter chips below the search bar are replaced by "Searching..." indicator
- Results section shows "Local results" followed by "Results from [machine names]"

**Acceptance Criteria**

- [ ] Search bar filters sessions by project name and prompt text with 300ms debounce
- [ ] Local search results appear within 100ms from SQLite cache
- [ ] Remote search queries all connected daemons on explicit submit
- [ ] Remote search results show highlighted matching snippets
- [ ] Search results are merged and sorted by relevance (match count, then date)
- [ ] Clearing search restores the original session list
- [ ] "No results" state shows "No sessions match [query]" with suggestion text
- [ ] Search handles special characters without crashing (SQL injection safe)
- [ ] Remote search shows per-daemon loading indicators
- [ ] If a daemon is disconnected, its search is skipped with a note

**Edge Cases**

- Search query is a single character: local search runs but remote search waits for submit
- Search returns 500+ results: paginate remote results in batches of 20
- Daemon disconnects mid-search: show partial results with "Could not search [machine]" note
- Empty query submit: no-op
- Query with only whitespace: treated as empty

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 9: Usage Dashboard -- DashboardScreen

**Description**

Implement the Dashboard tab with aggregated token usage across all daemons, featuring a daily bar chart, summary cards, per-project breakdown, and per-model breakdown.

**Prerequisites/Inputs**

- Task 3 (DaemonConnection for `getUsageStats()`)
- Task 2 (UsageStats, DailyUsage, ProjectUsage, ModelUsage types)
- `react-native-chart-kit` or `victory-native` for charts
- `react-native-svg` for chart rendering

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/app/(tabs)/dashboard.tsx` | Full implementation replacing placeholder |
| `mobile/components/dashboard/DailyUsageChart.tsx` | Stacked bar chart for daily token usage |
| `mobile/components/dashboard/SummaryCards.tsx` | Input/Output/Cache token summary |
| `mobile/components/dashboard/ProjectBreakdown.tsx` | Per-project percentage bars |
| `mobile/components/dashboard/ModelBreakdown.tsx` | Per-model usage bars |
| `mobile/components/dashboard/DateRangeSelector.tsx` | Dropdown for period selection |
| `mobile/hooks/useUsageStats.ts` | Hook that aggregates usage from all daemons |
| `mobile/app/dashboard/project/[id].tsx` | ProjectUsageDetailScreen |

`useUsageStats` hook:

```typescript
export function useUsageStats(range: DateRange): {
  stats: UsageStats | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}
```

Data aggregation:
1. Request `getUsageStats(range)` from each connected daemon in parallel
2. Merge: sum `totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`, `totalCost`
3. Merge `byDay`: group by `date`, sum token counts per day
4. Merge `byProject`: group by `projectId`, sum token counts, recalculate percentages
5. Merge `byModel`: group by `model`, sum token counts
6. Sort `byProject` by `cost` descending
7. If >5 projects, group tail into "Other (N projects)"

`DailyUsageChart`:

```typescript
interface DailyUsageChartProps {
  data: DailyUsage[];
  range: 'week' | 'month';
  onBarPress?: (day: DailyUsage) => void;
}
```

- Stacked bar chart: blue (input tokens) + green (output tokens)
- X-axis: day labels (M, T, W...) for week view; date numbers (1, 2, 3...) for month view
- Y-axis: token count with K/M suffixes
- Bar press: show tooltip with exact numbers for that day
- Month+ views: aggregate to weekly bars for readability

`SummaryCards`: three cards in a horizontal row:
- Input Tokens (formatted with K/M suffix)
- Output Tokens
- Cache Reads

`ProjectBreakdown`: vertical list of horizontal progress bars:
- Project name + percentage + cost on the same row
- Progress bar width = percentage of total
- Tappable: navigates to ProjectUsageDetailScreen

`DateRangeSelector`: dropdown with options:
- This Week (default)
- This Month
- Last Month
- Last 3 Months
- Custom Range (opens date picker modal)

**Acceptance Criteria**

- [ ] Dashboard shows total cost for the selected period prominently at top
- [ ] Daily bar chart renders with stacked input/output tokens
- [ ] Chart bars are tappable with tooltip showing exact day stats
- [ ] Summary cards show total input tokens, output tokens, and cache reads
- [ ] Per-project breakdown shows percentage bars sorted by cost descending
- [ ] >5 projects grouped into "Other (N projects)" entry
- [ ] Per-model breakdown shows usage split across models
- [ ] Date range dropdown: This Week, This Month, Last Month, Last 3 Months, Custom
- [ ] Data is aggregated from all connected daemons (parallel fetch)
- [ ] Dashboard loads within 2 seconds with 100+ projects across 5 daemons
- [ ] Tapping a project navigates to ProjectUsageDetailScreen
- [ ] Pull-to-refresh reloads data for the current date range

**Edge Cases**

- Zero usage for selected period: show empty chart with "No usage data for this period"
- Single daemon with data, others disconnected: show available data with "Data from N of M machines" note
- Cost calculation with 0 tokens: show $0.00, not NaN
- Very large numbers (>1B tokens): format with B suffix
- Date range crosses midnight/timezone boundaries: use UTC for all calculations

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 10: File Explorer

**Description**

Implement the remote file explorer that allows users to browse an agent's workspace directory tree and view syntax-highlighted file content, with git status indicators and lazy-loaded directory expansion.

**Prerequisites/Inputs**

- Task 3 (DaemonConnection for `listFiles()`, `getFileContent()`, `getGitStatus()`)
- Task 2 (FileEntry, GitFileStatus types)

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/app/session/file-explorer.tsx` | File explorer screen |
| `mobile/components/files/FileTree.tsx` | Collapsible tree view component |
| `mobile/components/files/FileTreeNode.tsx` | Individual tree node (file or directory) |
| `mobile/components/files/FileViewer.tsx` | Syntax-highlighted file viewer |

`FileTree` component:

```typescript
interface FileTreeProps {
  hostId: string;
  agentId: string;
  rootPath: string;
  onFileSelect: (file: FileEntry) => void;
}
```

Tree behavior:
- Root node: workspace directory name, auto-expanded
- Directories: tappable to expand/collapse; children loaded from daemon on first expand (lazy)
- Sort: directories first (alphabetical), then files (alphabetical)
- Git status: colored dot next to name (orange=modified, green=added, red=deleted, grey=untracked)
- Large directories (`node_modules/`, `.git/`): collapsed with "(N items)" label, not auto-expanded
- Indentation: 16px per level, with vertical guide lines

State management:
```typescript
interface FileTreeState {
  expandedPaths: Set<string>;          // Which directories are expanded
  children: Map<string, FileEntry[]>;  // Cached children per directory path
  loading: Set<string>;                // Directories currently loading
  gitStatus: Map<string, GitFileStatus>; // Path -> status, loaded once on mount
}
```

`FileViewer` component:

```typescript
interface FileViewerProps {
  hostId: string;
  agentId: string;
  filePath: string;
  language: string;  // Inferred from file extension
  onClose: () => void;
}
```

Features:
- Header: file path, git status badge, file size, last modified
- Content: syntax-highlighted text with line numbers in a gutter
- Pinch-to-zoom: 8pt to 24pt font size (reuse `useDiffGestures` from Task 9-related diff shell)
- Horizontal scroll for long lines (no wrapping)
- "Copy" button in header to copy content to clipboard
- Large files (>100KB): show first 1000 lines with "Show full file" button
- Binary files: show "Binary file (X KB)" message instead of content

Language detection: map file extension to highlight.js language name:
```typescript
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.rb': 'ruby',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.json': 'json', '.yaml': 'yaml',
  '.yml': 'yaml', '.md': 'markdown', '.html': 'html', '.css': 'css', '.sql': 'sql',
  '.swift': 'swift', '.kt': 'kotlin', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
};
```

**Acceptance Criteria**

- [ ] File tree renders the agent's workspace directory structure
- [ ] Directories expand on tap, loading children from the daemon on demand
- [ ] Loading spinner shows while directory children are being fetched
- [ ] Files are tappable and open in the syntax-highlighted viewer
- [ ] Git status indicators (colored dots) appear next to modified/added/deleted/untracked files
- [ ] Files sorted: directories first (alpha), then files (alpha)
- [ ] File viewer renders syntax-highlighted content with line numbers
- [ ] Pinch-to-zoom works in file viewer (8pt-24pt range)
- [ ] Large files (>100KB) truncated with "Show full file" option
- [ ] Large directories (node_modules, .git) show item count and collapse by default
- [ ] File content loads within 1 second for files up to 50KB over LAN
- [ ] Binary files show "Binary file (X KB)" instead of content
- [ ] "Copy" button copies file content to clipboard

**Edge Cases**

- Directory with 10,000+ files: paginate the file list from daemon (first 200, "Load more")
- Symlinks: show with a link icon, resolve to target for content viewing
- File deleted since tree was loaded: show "File not found" error on open attempt
- Deeply nested directory (20+ levels): tree scroll remains performant
- Empty directory: show "(empty)" label
- Permission denied on file read: show "Permission denied" error

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 11: Voice Input

**Description**

Implement the voice input feature that provides hands-free dictation for sending prompts to agents. Uses platform-native speech-to-text (iOS Speech Framework / Android SpeechRecognizer) with real-time partial transcript display and visual feedback.

**Prerequisites/Inputs**

- Task 2 (VoiceInputError type)
- Task 6 (PromptInput component where voice button lives)
- `@react-native-voice/voice` for cross-platform speech recognition
- `expo-haptics` for feedback

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/hooks/useVoiceInput.ts` | Core voice input hook |
| `mobile/components/shared/VoiceIndicator.tsx` | Visual feedback during recording |
| `mobile/services/speech.ts` | Speech recognition configuration and platform abstraction |

`useVoiceInput` hook:

```typescript
export function useVoiceInput(): {
  isRecording: boolean;
  isProcessing: boolean;
  transcript: string;           // Real-time partial transcript
  finalTranscript: string;      // Final transcript after stopping
  error: VoiceInputError | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string>;
  cancelRecording: () => void;
  duration: number;             // Recording duration in seconds
}
```

Implementation:

```typescript
import Voice from '@react-native-voice/voice';

// In useVoiceInput:
useEffect(() => {
  Voice.onSpeechResults = (e) => setFinalTranscript(e.value?.[0] ?? '');
  Voice.onSpeechPartialResults = (e) => setTranscript(e.value?.[0] ?? '');
  Voice.onSpeechError = (e) => setError({ type: 'RECOGNITION_FAILED', message: e.error?.message ?? 'Unknown error' });
  Voice.onSpeechEnd = () => setIsRecording(false);

  return () => { Voice.destroy().then(Voice.removeAllListeners); };
}, []);

async function startRecording() {
  const available = await Voice.isAvailable();
  if (!available) { setError({ type: 'NOT_AVAILABLE', message: 'Speech recognition not available' }); return; }
  setIsRecording(true);
  setTranscript('');
  await Voice.start(speechConfig.language);
  // Start silence timeout: auto-stop after 3s of no speech
  silenceTimer = setTimeout(() => stopRecording(), speechConfig.silenceTimeout);
  // Start max duration timer
  maxTimer = setTimeout(() => stopRecording(), speechConfig.maxDuration);
}
```

Speech configuration:

```typescript
export const SpeechConfig = {
  language: 'en-US',
  partialResults: true,
  silenceTimeout: 3000,
  maxDuration: 60000,
  punctuation: true,
};
```

`VoiceIndicator` component:

```typescript
interface VoiceIndicatorProps {
  isRecording: boolean;
  isProcessing: boolean;
  duration: number;           // Display as "0:12"
}
```

Visual feedback during recording:
- Microphone button: changes to red with pulsing scale animation (1.0 -> 1.1 at 1Hz using `react-native-reanimated`)
- Duration counter: "0:12" shown next to the microphone
- Three animated bars above input field for waveform visualization (heights animate randomly to simulate audio amplitude)
- Partial transcript appears in the input field in italic styling, updating in real time

**Acceptance Criteria**

- [ ] Microphone icon appears in PromptInput area (left of text field)
- [ ] Tapping microphone requests permission (if needed) and starts recording
- [ ] Partial transcript appears in real time in the input field as user speaks
- [ ] Tapping microphone again (or 3s silence) stops recording and finalizes transcript
- [ ] Visual feedback: red pulsing microphone, waveform bars, duration counter
- [ ] Final transcript is placed in the input field and is editable before sending
- [ ] Maximum recording duration is 60 seconds (auto-stop)
- [ ] Error states (permission denied, not available, recognition failed) show clear messages
- [ ] Cancel recording (swipe away) discards transcript without modifying input
- [ ] Voice input works offline for on-device recognition (iOS 13+)
- [ ] Language is configurable in app settings (defaults to `en-US`)

**Edge Cases**

- Microphone permission denied: show "Microphone access is needed for voice input. Enable in Settings." with link
- No speech detected for 3 seconds: auto-stop and show "No speech detected" briefly
- Very noisy environment: let platform handle noise cancellation; show whatever transcript is available
- User starts typing while recording: stop recording, keep partial transcript + typed text
- App goes to background during recording: stop recording, finalize transcript

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 12: Encryption Key Management

**Description**

Implement the encryption key manager that stores, retrieves, and manages the user's master encryption key in the platform's secure storage (iOS Keychain / Android Keystore) with biometric gating, and provides the key status display screen.

**Prerequisites/Inputs**

- Task 2 (KeyInfo, KeyStorageOptions types)
- `react-native-keychain` for platform secure storage with biometric ACL
- `libsodium-wrappers-sumo` for Argon2id key derivation (passphrase recovery)
- `expo-local-authentication` for biometric availability detection

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/services/key-manager.ts` | KeyManager class for secure storage operations |
| `mobile/services/key-cache.ts` | In-memory key cache with auto-clear |
| `mobile/app/settings/encryption.tsx` | EncryptionKeyScreen implementation |

`KeyManager` class:

```typescript
import * as Keychain from 'react-native-keychain';
import sodium from 'libsodium-wrappers-sumo';

export class KeyManager {
  private static readonly SERVICE = 'dev.agentctx.masterkey';
  private static readonly KEY_INFO_KEY = '@agentctx/key-info';

  async hasKey(): Promise<boolean> {
    const creds = await Keychain.getGenericPassword({ service: KeyManager.SERVICE });
    return creds !== false;
  }

  async storeKey(masterKey: Uint8Array, options: KeyStorageOptions = { biometricRequired: true, biometricLabel: 'Unlock AgentContext encryption key', accessLevel: 'whenUnlocked' }): Promise<void> {
    const keyBase64 = sodium.to_base64(masterKey);
    const keyId = sodium.to_hex(sodium.crypto_generichash(32, masterKey)).slice(0, 8);

    await Keychain.setGenericPassword('masterkey', keyBase64, {
      service: KeyManager.SERVICE,
      accessControl: options.biometricRequired
        ? Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE
        : Keychain.ACCESS_CONTROL.DEVICE_PASSCODE,
      accessible: options.accessLevel === 'whenUnlocked'
        ? Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY
        : Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
      authenticationPrompt: { title: options.biometricLabel },
    });

    // Store key metadata (non-sensitive) in AsyncStorage
    const info: KeyInfo = { keyId, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), biometricEnabled: options.biometricRequired, deviceName: 'this device' };
    await AsyncStorage.setItem(KeyManager.KEY_INFO_KEY, JSON.stringify(info));
  }

  async getKey(): Promise<Uint8Array> {
    const creds = await Keychain.getGenericPassword({
      service: KeyManager.SERVICE,
      authenticationPrompt: { title: 'Unlock Encryption Key', subtitle: 'Authenticate to decrypt your session data' },
    });
    if (!creds) throw new Error('No encryption key found on this device');

    // Update lastUsedAt
    const infoRaw = await AsyncStorage.getItem(KeyManager.KEY_INFO_KEY);
    if (infoRaw) {
      const info = JSON.parse(infoRaw);
      info.lastUsedAt = new Date().toISOString();
      await AsyncStorage.setItem(KeyManager.KEY_INFO_KEY, JSON.stringify(info));
    }

    return sodium.from_base64(creds.password);
  }

  async deleteKey(): Promise<void> {
    await Keychain.resetGenericPassword({ service: KeyManager.SERVICE });
    await AsyncStorage.removeItem(KeyManager.KEY_INFO_KEY);
  }

  async getKeyInfo(): Promise<KeyInfo | null> {
    const raw = await AsyncStorage.getItem(KeyManager.KEY_INFO_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  async recoverFromPassphrase(passphrase: string, encryptedBackup: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    await sodium.ready;
    const recoveryKey = sodium.crypto_pwhash(
      32,
      passphrase,
      salt,
      3,                              // ops limit (t=3)
      67108864,                       // mem limit (64MB)
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );
    // Decrypt the master key backup
    const nonce = encryptedBackup.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = encryptedBackup.slice(sodium.crypto_secretbox_NONCEBYTES);
    const masterKey = sodium.crypto_secretbox_open_easy(ciphertext, nonce, recoveryKey);
    sodium.memzero(recoveryKey);
    return masterKey;
  }
}
```

`KeyCache` class:

```typescript
export class KeyCache {
  private key: Uint8Array | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

  async getOrUnlock(): Promise<Uint8Array> {
    if (this.key) { this.resetTimer(); return this.key; }
    const keyManager = new KeyManager();
    this.key = await keyManager.getKey();
    this.resetTimer();
    return this.key;
  }

  clear(): void {
    if (this.key) { this.key.fill(0); this.key = null; }
    if (this.clearTimer) { clearTimeout(this.clearTimer); this.clearTimer = null; }
  }

  private resetTimer(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => this.clear(), KeyCache.CACHE_DURATION_MS);
  }
}
```

EncryptionKeyScreen layout (as specified in story):
- Status: "Active" / "No Key"
- Key ID: first 8 hex chars of SHA-256 of master key
- Created date, Last used (relative)
- Biometric toggle
- Buttons: "Transfer Key to New Device", "Recover from Passphrase", "Delete Key from This Device"
- Warning text about deletion

AppState listener integration:
- On `AppState` change to `background`: start a 5-minute timer
- On timer expiry: call `KeyCache.clear()`
- On `AppState` change to `active`: cancel the timer (key stays cached)

**Acceptance Criteria**

- [ ] Master key is stored in iOS Keychain with `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`
- [ ] Master key is stored in Android Keystore with `SECURE_HARDWARE` security level
- [ ] Biometric prompt appears when `getKey()` is called
- [ ] Biometric can be toggled on/off (re-stores key with different access control)
- [ ] Key status screen shows key ID, creation date, last used time
- [ ] Key is cached in memory for 5 minutes via KeyCache, then zeroed
- [ ] Key memory is zeroed when app backgrounds for > 5 minutes
- [ ] "Delete Key from This Device" shows confirmation dialog, then clears key from Keychain/Keystore
- [ ] Recovery from passphrase: Argon2id derives recovery key, decrypts master key backup
- [ ] If no key exists, screen shows "No encryption key on this device" with transfer/recover options
- [ ] Key operations never log the raw key bytes

**Edge Cases**

- Biometric fails 3 times: OS falls back to passcode/PIN
- User cancels biometric prompt: `getKey()` rejects, caller shows "Key locked" message
- Keychain/Keystore is wiped (device reset): `hasKey()` returns false, user must re-transfer
- Argon2id with wrong passphrase: decryption fails, show "Incorrect passphrase" error
- Low memory: Argon2id with 64MB may cause issues on old devices; catch and suggest retry

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 13: QR Key Transfer

**Description**

Implement the full QR-based encryption key transfer flow between two devices using ephemeral Curve25519 ECDH for establishing a secure channel, XChaCha20-Poly1305 for encrypting the master key, and visual key ID verification for MITM prevention.

**Prerequisites/Inputs**

- Task 12 (KeyManager for reading/storing the master key)
- Task 4 (QR scanner component for scanning; QR generation library for displaying)
- `libsodium-wrappers-sumo` for Curve25519, XChaCha20-Poly1305
- `react-native-qrcode-svg` for QR code display

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/services/key-transfer.ts` | Key transfer sender and receiver logic |
| `mobile/app/settings/key-transfer-send.tsx` | "Transfer Key" screen (Device A - displays QR) |
| `mobile/app/settings/key-transfer-receive.tsx` | "Receive Key" screen (Device B - scans QR) |
| `mobile/components/shared/KeyVerificationModal.tsx` | Key ID visual verification dialog |

QR payload format for key transfer:
```
agentctx://key-transfer?data=<base64url-encoded-json>
```

```json
{
  "version": 1,
  "type": "key_transfer",
  "ephemeralPublicKey": "<base64>",
  "lan": { "address": "192.168.1.42", "port": 9121 },
  "relay": { "serverId": "transfer-session-xyz" },
  "expiresAt": "2026-02-21T15:02:00Z",
  "nonce": "<base64>"
}
```

Sender flow (Device A -- `key-transfer-send.tsx`):

```typescript
export async function initiateSend(): Promise<void> {
  await sodium.ready;

  // 1. Generate ephemeral Curve25519 keypair
  const senderKeypair = sodium.crypto_box_keypair();

  // 2. Start a temporary WebSocket server or connect to relay with a unique session ID
  const transferSessionId = crypto.randomUUID();

  // 3. Display QR code with payload (ephemeral public key + connection info)
  const payload: KeyTransferPayload = {
    version: 1,
    type: 'key_transfer',
    ephemeralPublicKey: sodium.to_base64(senderKeypair.publicKey),
    lan: await getLocalAddress(),
    relay: { serverId: `transfer-${transferSessionId}` },
    expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    nonce: sodium.to_base64(sodium.randombytes_buf(24)),
  };

  // 4. Wait for receiver connection...
  // 5. Receive receiver's ephemeral public key
  // 6. Compute shared secret: ECDH(senderPriv, receiverPub)
  // 7. Biometric unlock to get master key
  // 8. Encrypt master key: XChaCha20-Poly1305(sharedSecret, masterKey)
  // 9. Send encrypted master key
  // 10. Receive key ID from receiver for verification
  // 11. Compare key IDs, display verification screen
  // 12. On "Yes, Confirm": send "verified" message
  // 13. Destroy ephemeral keys
}
```

Receiver flow (Device B -- `key-transfer-receive.tsx`):

```typescript
export async function initiateReceive(payload: KeyTransferPayload): Promise<void> {
  await sodium.ready;

  // 1. Generate own ephemeral keypair
  const receiverKeypair = sodium.crypto_box_keypair();

  // 2. Connect to sender (LAN first, relay fallback)
  const ws = await connectToSender(payload);

  // 3. Send own public key
  ws.send(JSON.stringify({ type: 'receiver_key', publicKey: sodium.to_base64(receiverKeypair.publicKey) }));

  // 4. Compute shared secret: ECDH(receiverPriv, senderPub)
  const theirPub = sodium.from_base64(payload.ephemeralPublicKey);
  const sharedSecret = sodium.crypto_scalarmult(receiverKeypair.privateKey, theirPub);

  // 5. Receive encrypted master key
  const msg = await waitForMessage(ws, 'encrypted_key', 30000);

  // 6. Decrypt master key
  const masterKey = sodium.crypto_secretbox_open_easy(
    sodium.from_base64(msg.ciphertext),
    sodium.from_base64(msg.nonce),
    sharedSecret
  );

  // 7. Derive key ID
  const keyId = sodium.to_hex(sodium.crypto_generichash(32, masterKey)).slice(0, 8);

  // 8. Send key ID to sender for verification
  ws.send(JSON.stringify({ type: 'key_id', keyId }));

  // 9. Wait for "verified" from sender
  await waitForMessage(ws, 'verified', 60000);

  // 10. Store master key in Keychain/Keystore
  const keyManager = new KeyManager();
  await keyManager.storeKey(masterKey);

  // 11. Destroy ephemeral keys
  sodium.memzero(receiverKeypair.privateKey);
  sodium.memzero(sharedSecret);
}
```

Key verification modal:

```
+---------------------------------------+
|       Key Transfer Complete           |
|---------------------------------------|
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

Timeout: QR code expires after 2 minutes. The sender screen shows a countdown timer. When expired, the QR code dims and a "Generate new code" button appears.

**Acceptance Criteria**

- [ ] Device A generates and displays a QR code for key transfer with 2-minute countdown
- [ ] Device B scans the QR code and initiates ECDH key exchange
- [ ] Master key is encrypted with ECDH shared secret via XChaCha20-Poly1305
- [ ] Both devices display key ID (first 8 hex chars) for visual verification
- [ ] If verification fails ("No, Try Again"), the transferred key is discarded
- [ ] QR code expires after 2 minutes; expired code shows error on scan
- [ ] Biometric authentication is required on Device A before reading the master key
- [ ] On success, Device B stores key in Keychain/Keystore with biometric protection
- [ ] All ephemeral keys are zeroed after transfer completes or fails
- [ ] LAN transfer attempted first (3s timeout); relay used as fallback
- [ ] Entire flow completes within 30 seconds on LAN
- [ ] Connection loss mid-transfer: both sides clean up, show "Transfer failed" with retry option

**Edge Cases**

- QR code scanned after expiry: "This pairing code has expired. Generate a new one on the sending device."
- Receiver connects but sender's key is locked (biometric fail): sender shows error, receiver sees timeout
- Network drops after ECDH but before key transmission: both sides destroy ephemeral keys, show error
- Two receivers try to connect: sender accepts only the first, rejects the second
- Key ID mismatch (MITM): transferred key is zeroed, user is warned about possible interception

**Estimated Effort**: XL (Extra Large) -- 12-16 hours

---

### Task 14: Push Notifications

**Description**

Implement push notification setup, delivery, deep linking, and background handling for agent events. Includes APNs (iOS) and FCM (Android) configuration, actionable notifications for permission requests, and notification settings screen.

**Prerequisites/Inputs**

- Task 3 (DaemonConnection to register push tokens and receive events)
- Task 1 (navigation deep links)
- `expo-notifications` for cross-platform push handling
- `expo-device` for checking if running on physical device (push doesn't work on simulators)

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/services/notification-setup.ts` | Push registration, category setup, token management |
| `mobile/services/notification-handler.ts` | Foreground/background notification handling |
| `mobile/app/settings/notifications.tsx` | Notification settings screen |
| `mobile/hooks/useNotifications.ts` | Hook for notification state in components |

Notification setup (`services/notification-setup.ts`):

```typescript
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

export async function setupNotifications(): Promise<string | null> {
  if (!Device.isDevice) return null; // Push doesn't work on simulators

  // Request permission
  const { status } = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true, allowCriticalAlerts: false },
  });
  if (status !== 'granted') return null;

  // Get Expo push token
  const token = await Notifications.getExpoPushTokenAsync({ projectId: 'agentctx-mobile' });

  // Set up iOS notification categories (actionable notifications)
  await Notifications.setNotificationCategoryAsync('PERMISSION_REQUEST', [
    { identifier: 'ALLOW', buttonTitle: 'Allow', options: { opensAppToForeground: false } },
    { identifier: 'DENY', buttonTitle: 'Deny', options: { opensAppToForeground: false, isDestructive: true } },
    { identifier: 'VIEW', buttonTitle: 'View Details', options: { opensAppToForeground: true } },
  ]);

  // Set up Android notification channels
  await Notifications.setNotificationChannelAsync('agent_permissions', {
    name: 'Permission Requests',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
  });
  await Notifications.setNotificationChannelAsync('agent_completions', {
    name: 'Agent Completions',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default',
  });
  await Notifications.setNotificationChannelAsync('agent_errors', {
    name: 'Agent Errors',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
  });
  await Notifications.setNotificationChannelAsync('agent_updates', {
    name: 'Agent Updates',
    importance: Notifications.AndroidImportance.LOW,
  });

  return token.data;
}
```

Notification handler (`services/notification-handler.ts`):

```typescript
// Foreground: show notification as a local notification (or suppress if viewing that agent)
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data;
    // If user is currently viewing this agent, suppress the notification
    const currentScreen = navigationRef.getCurrentRoute();
    if (currentScreen?.name === 'AgentDetail' && currentScreen.params?.agentId === data.agentId) {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
    }
    return { shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true };
  },
});

// Background: handle actionable notification responses
Notifications.addNotificationResponseReceivedListener(async (response) => {
  const action = response.actionIdentifier;
  const data = response.notification.request.content.data as Record<string, string>;

  if (data.type === 'permission_request') {
    if (action === 'ALLOW') {
      await sendPermissionResponseBackground(data.hostId, data.agentId, data.toolUseId, 'allow');
    } else if (action === 'DENY') {
      await sendPermissionResponseBackground(data.hostId, data.agentId, data.toolUseId, 'deny');
    } else {
      // Default tap or VIEW action: navigate to agent
      navigate('AgentDetail', { hostId: data.hostId, agentId: data.agentId });
    }
  } else {
    // Other notification types: navigate to appropriate screen
    handleDeepLink(data);
  }
});
```

Push token distribution:
- On token acquisition, send the token to all connected daemons via `DaemonConnection.registerPushToken(token)`
- On token rotation (detected via `Notifications.addPushTokenListener`), re-send to all daemons

Notification settings screen:

```typescript
interface NotificationSettings {
  enabled: boolean;
  perType: {
    permission_request: boolean;  // Default: true
    agent_completed: boolean;     // Default: true
    agent_error: boolean;         // Default: true
    session_ended: boolean;       // Default: false
    long_running_update: boolean; // Default: false
  };
  quietHours: {
    enabled: boolean;
    startTime: string;            // "22:00"
    endTime: string;              // "08:00"
  };
}
```

Stored in AsyncStorage at `@agentctx/notification-settings`. Sent to daemons so they can filter server-side.

Duplicate suppression: when the app is connected via WebSocket and in the foreground, daemons skip sending push notifications. The daemon tracks whether the mobile client has an active WebSocket.

Badge management:
- App badge count = total pending permission requests across all agents
- Updated on each permission request/response
- Cleared when user views agent detail screen with pending permissions

**Acceptance Criteria**

- [ ] Push notifications fire for permission requests, agent completions, and agent errors
- [ ] APNs and FCM payloads are correctly formatted per platform
- [ ] Permission request notifications are "time-sensitive" (iOS) / "high priority" (Android)
- [ ] iOS actionable notifications: "Allow", "Deny", "View Details" work without opening app
- [ ] Android notification channels are configured for each notification type
- [ ] Tapping a notification deep links to the correct agent or session screen
- [ ] Background handler sends permission responses to the daemon
- [ ] Notification settings screen allows per-type toggles and quiet hours
- [ ] Quiet hours suppress all non-critical notifications during configured range
- [ ] No duplicate notifications when app is connected via WebSocket
- [ ] Badge count reflects total pending permission requests
- [ ] Push token rotation is handled (re-sent to all daemons)
- [ ] Notifications are grouped by agent (iOS thread-id, Android tag)

**Edge Cases**

- Push permission denied by user: show "Enable notifications in Settings for agent alerts" banner on Agents tab
- App killed during background handler: permission remains pending, shown again on next app open
- Two phones paired to same daemon: both receive notifications, first-to-respond wins
- Quiet hours across midnight: handle 22:00-08:00 correctly (start > end)
- Notification tap when app is not loaded: cold start + deep link navigation

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 15: Offline Mode & SQLite Cache

**Description**

Implement the local SQLite cache database for offline browsing of previously viewed sessions, usage data, and host information. Includes cache population, LRU eviction, stale data indicators, and the `CacheManager` service.

**Prerequisites/Inputs**

- Task 2 (all types that get cached)
- `expo-sqlite` or `@op-engineering/op-sqlite` for SQLite database
- `@react-native-community/netinfo` for network state detection

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/storage/cache-db.ts` | SQLite database initialization and migration |
| `mobile/services/cache-manager.ts` | CacheManager class with CRUD, eviction, integrity checks |
| `mobile/components/shared/StaleDataBanner.tsx` | "Viewing cached data" banner component |
| `mobile/hooks/useNetworkState.ts` | Hook for online/offline state |

Database initialization (`storage/cache-db.ts`):

```typescript
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'agentctx-cache.db';

export async function initializeDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);

  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS cached_hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      os TEXT NOT NULL,
      last_connected TEXT,
      cached_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cached_sessions (
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
      cached_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cached_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data_json TEXT,
      cached_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cached_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      date TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cost REAL,
      session_count INTEGER,
      cached_at TEXT NOT NULL,
      UNIQUE(host_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_host ON cached_sessions(host_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON cached_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON cached_sessions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_session ON cached_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_usage_date ON cached_usage(host_id, date);
  `);

  return db;
}
```

`CacheManager` class:

```typescript
export class CacheManager {
  private db: SQLite.SQLiteDatabase;
  private maxCacheSize: number = 500 * 1024 * 1024; // 500MB default

  constructor(db: SQLite.SQLiteDatabase) { this.db = db; }

  // Write operations (called in background as user browses)
  async cacheSessions(sessions: SessionSummary[]): Promise<void>;
  async cacheEvents(sessionId: string, events: CachedEvent[]): Promise<void>;
  async cacheUsage(hostId: string, dailyUsage: DailyUsage[]): Promise<void>;
  async cacheHost(host: HostProfile): Promise<void>;

  // Read operations (for offline display)
  async getCachedSessions(filter: SessionFilter): Promise<SessionSummary[]>;
  async getCachedEvents(sessionId: string): Promise<CachedEvent[]>;
  async getCachedUsage(range: DateRange): Promise<DailyUsage[]>;
  async getCachedHosts(): Promise<HostProfile[]>;

  // Maintenance
  async getCacheSize(): Promise<number>;
  async pruneIfNeeded(): Promise<void>;  // LRU eviction when > 80% of limit
  async clearCache(): Promise<void>;
  async integrityCheck(): Promise<boolean>;  // PRAGMA integrity_check

  // Search (local)
  async searchSessions(query: string): Promise<SessionSummary[]>;
}
```

Eviction policy:
- Check cache size after each write batch
- If size > 80% of limit (400MB default), delete the oldest 20% of `cached_events` rows by `cached_at`
- Session metadata (`cached_sessions`) is retained longer -- only pruned when size > 95%

`StaleDataBanner` component:

```typescript
interface StaleDataBannerProps {
  lastSyncedAt: string;  // ISO 8601
  isConnected: boolean;
}
```

Displays: "Viewing cached data. Last synced: 2 hours ago." with a clock icon. Background color: dark yellow/amber.

Integrity check on startup:
- Run `PRAGMA integrity_check` on app launch
- If corruption detected: `db.closeAsync()`, delete the file, recreate empty
- Show toast: "Cache was reset due to a data issue."

Cache population hooks (integrate into Task 3, 7, 9):
- When `listSessions()` returns data from a daemon: `cacheManager.cacheSessions(results)` in background
- When `getSessionEvents()` returns events: `cacheManager.cacheEvents(sessionId, events)` in background
- When `getUsageStats()` returns: `cacheManager.cacheUsage(hostId, stats.byDay)` in background

Offline behavior per screen (from story spec):
- Agent List: last known states, all show "disconnected"
- Agent Detail: read-only, cached events, no prompt input
- Session List: full functionality from cache, local search only
- Session Detail: cached events with stale banner
- Dashboard: cached usage data with stale banner
- Settings: fully functional
- QR Scanner: "Pairing requires a network connection"

**Acceptance Criteria**

- [ ] SQLite database is created with all tables and indexes on first launch
- [ ] Session list is browsable offline using cached data
- [ ] Session detail shows cached events when daemon is disconnected
- [ ] Usage dashboard shows cached aggregates offline
- [ ] Stale data banner appears with timestamp of last sync when displaying cached content
- [ ] Cache is populated in the background as user browses (no UI blocking)
- [ ] Cache size limited to 500MB (configurable); LRU eviction removes oldest event data
- [ ] "Clear cache" option in Settings deletes all cached data
- [ ] Integrity check on startup detects and recovers from database corruption
- [ ] Search works offline against the local SQLite cache
- [ ] QR scanner screen shows "Network required" message when offline
- [ ] Reconnection to a daemon triggers cache refresh for visible data
- [ ] Cache writes use WAL mode for concurrent read/write safety

**Edge Cases**

- App crashes during cache write: WAL mode ensures database consistency
- Cache database file missing (deleted externally): recreate on next access
- SQLite query on 100,000+ cached events: ensure indexes are used, query completes in <200ms
- Disk full: catch write error, log warning, continue without caching
- Timezone change: all timestamps in UTC, display converts to local

**Estimated Effort**: L (Large) -- 10-14 hours

---

### Task 16: Theme System

**Description**

Implement the dark/light theme system with the specified color palettes, typography, spacing constants, and a theme toggle in Settings.

**Prerequisites/Inputs**

- Task 1 (Expo project exists)
- Story 08 theme specification (Section 1 - DarkTheme colors)

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/theme/colors.ts` | Dark and light theme color definitions |
| `mobile/theme/typography.ts` | Font sizes, weights, line heights |
| `mobile/theme/spacing.ts` | Spacing scale (4, 8, 12, 16, 24, 32, 48) |
| `mobile/theme/ThemeContext.tsx` | React context for theme state |
| `mobile/hooks/useTheme.ts` | Hook to access current theme |

Color definitions:

```typescript
// theme/colors.ts
export const DarkTheme = {
  background: '#0D1117',
  surface: '#161B22',
  surfaceElevated: '#1C2128',
  text: '#E6EDF3',
  textSecondary: '#8B949E',
  accent: '#58A6FF',
  success: '#3FB950',
  warning: '#D29922',
  error: '#F85149',
  border: '#30363D',
};

export const LightTheme = {
  background: '#FFFFFF',
  surface: '#F6F8FA',
  surfaceElevated: '#FFFFFF',
  text: '#1F2328',
  textSecondary: '#656D76',
  accent: '#0969DA',
  success: '#1A7F37',
  warning: '#9A6700',
  error: '#CF222E',
  border: '#D0D7DE',
};
```

Typography:

```typescript
export const Typography = {
  heading1: { fontSize: 24, fontWeight: '700' as const, lineHeight: 32 },
  heading2: { fontSize: 20, fontWeight: '600' as const, lineHeight: 28 },
  heading3: { fontSize: 16, fontWeight: '600' as const, lineHeight: 24 },
  body: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  bodySmall: { fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
  code: { fontSize: 13, fontFamily: 'monospace', lineHeight: 20 },
  label: { fontSize: 11, fontWeight: '500' as const, lineHeight: 16, letterSpacing: 0.5, textTransform: 'uppercase' as const },
};
```

Theme context:

```typescript
// theme/ThemeContext.tsx
interface ThemeContextType {
  colors: typeof DarkTheme;
  isDark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>(...);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true); // Dark is default
  // Persist preference in AsyncStorage
  // Load on mount
  const colors = isDark ? DarkTheme : LightTheme;
  return <ThemeContext.Provider value={{ colors, isDark, toggleTheme: () => setIsDark(!isDark) }}>{children}</ThemeContext.Provider>;
}
```

Integration: wrap `_layout.tsx` root with `ThemeProvider`. All components use `useTheme()` for color values.

**Acceptance Criteria**

- [ ] Dark theme is the default on first launch
- [ ] Light theme toggle in Settings switches all screens to light colors
- [ ] Theme preference persists across app restarts (AsyncStorage)
- [ ] All screens use theme colors from the context (no hardcoded colors)
- [ ] Typography scale is consistent across all text elements
- [ ] Spacing scale (4/8/12/16/24/32/48) is used for all margins and paddings
- [ ] Status bar style adapts to theme (light content on dark, dark content on light)
- [ ] Tab bar background and border colors adapt to theme
- [ ] Navigation header styles adapt to theme

**Edge Cases**

- System appearance changes (dark mode toggle in OS settings): optionally follow system theme (future enhancement, not required now)
- Theme change while viewing a screen with cached data: colors update immediately without data refetch

**Estimated Effort**: S (Small) -- 3-4 hours

---

### Task 17: Integration & E2E Tests

**Description**

Create a comprehensive test suite covering unit tests for all services and hooks, integration tests for cross-component flows, and define the manual test plan for physical device verification.

**Prerequisites/Inputs**

- All previous tasks (1-16)
- Jest + React Native Testing Library for unit tests
- Detox or Maestro for E2E tests on simulators/emulators

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `mobile/__tests__/services/connection-manager.test.ts` | ConnectionManager unit tests |
| `mobile/__tests__/services/daemon-connection.test.ts` | DaemonConnection unit tests |
| `mobile/__tests__/services/key-manager.test.ts` | KeyManager unit tests |
| `mobile/__tests__/services/key-cache.test.ts` | KeyCache unit tests |
| `mobile/__tests__/services/pairing.test.ts` | QR pairing logic tests |
| `mobile/__tests__/services/key-transfer.test.ts` | Key transfer crypto tests |
| `mobile/__tests__/services/cache-manager.test.ts` | SQLite cache tests |
| `mobile/__tests__/services/notification-setup.test.ts` | Notification configuration tests |
| `mobile/__tests__/hooks/useAgentList.test.ts` | Agent list merge/sort/filter tests |
| `mobile/__tests__/hooks/useSessionList.test.ts` | Session list pagination tests |
| `mobile/__tests__/hooks/useSessionSearch.test.ts` | Search debounce and merge tests |
| `mobile/__tests__/hooks/useUsageStats.test.ts` | Usage aggregation tests |
| `mobile/__tests__/hooks/useVoiceInput.test.ts` | Voice input state machine tests |
| `mobile/__tests__/components/QRScanner.test.tsx` | QR payload validation tests |
| `mobile/__tests__/components/PermissionActionSheet.test.tsx` | Permission handling tests |
| `mobile/__tests__/storage/daemon-registry.test.ts` | AsyncStorage persistence tests |
| `mobile/__tests__/storage/cache-db.test.ts` | SQLite schema and migration tests |

Test breakdown (mapped from story spec Testing Plan):

**Unit Tests (T-1 through T-30):**

| Test | Description | Task |
|------|-------------|------|
| T-1 | HostProfile serialization/deserialization to/from AsyncStorage | 3 |
| T-2 | ConnectionManager connects to LAN daemon and handles reconnection | 3 |
| T-3 | ConnectionManager handles relay fallback when LAN unreachable | 3 |
| T-4 | QR payload parsing validates all required fields | 4 |
| T-5 | QR payload with expired timestamp is rejected | 4 |
| T-6 | QR payload with invalid URL scheme is rejected | 4 |
| T-7 | Agent list merges agents from multiple daemons correctly | 5 |
| T-8 | Agent list filters by machine, provider, and status | 5 |
| T-9 | Agent list sorts by all supported sort fields | 5 |
| T-10 | Session search debounces input at 300ms | 8 |
| T-11 | Session search merges results from multiple daemons | 8 |
| T-12 | Usage aggregation sums data across daemons correctly | 9 |
| T-13 | Usage percentage calculation handles zero total correctly | 9 |
| T-14 | Push notification payload format is correct for APNs | 14 |
| T-15 | Push notification payload format is correct for FCM | 14 |
| T-16 | Deep link parsing navigates to correct screen | 14 |
| T-17 | Diff gestures: pinch-to-zoom bounds check (8pt-24pt) | 6 |
| T-18 | File tree sorts directories before files | 10 |
| T-19 | File tree truncates large directories | 10 |
| T-20 | Voice input transcript updates in real time | 11 |
| T-21 | Voice input respects 60-second max duration | 11 |
| T-22 | KeyManager storeKey/getKey round-trip preserves key bytes | 12 |
| T-23 | KeyCache clears key after 5-minute timeout | 12 |
| T-24 | KeyCache zeros key memory on clear | 12 |
| T-25 | QR key transfer: ECDH shared secret matches on both sides | 13 |
| T-26 | QR key transfer: key ID verification detects mismatch | 13 |
| T-27 | SQLite cache insert/query for sessions | 15 |
| T-28 | SQLite cache LRU eviction removes oldest events | 15 |
| T-29 | SQLite integrity check detects corruption | 15 |
| T-30 | Offline mode: session list falls back to cached data | 15 |

**Integration Tests (T-31 through T-43):**

| Test | Description | Tasks |
|------|-------------|-------|
| T-31 | Full QR pairing flow: scan -> confirm -> connection | 3, 4 |
| T-32 | Agent list populates from real daemon WebSocket | 3, 5 |
| T-33 | Permission approval from app reaches daemon | 3, 6 |
| T-34 | Push notification fires when app backgrounded + permission requested | 14 |
| T-35 | Deep link from notification navigates to correct agent | 14 |
| T-36 | Session search returns results from multiple daemons | 7, 8 |
| T-37 | Usage dashboard renders charts with real data | 9 |
| T-38 | File explorer navigates remote directory tree | 10 |
| T-39 | Voice input sends transcribed prompt to agent | 6, 11 |
| T-40 | Key transfer from Device A to Device B via QR | 12, 13 |
| T-41 | Offline: disconnect -> browse cached -> reconnect -> refresh | 15 |
| T-42 | App survives daemon disconnection/reconnection without crash | 3 |
| T-43 | Concurrent connections to 3 daemons with real-time events | 3 |

**Manual Device Tests (M-1 through M-12):**

Documented in a checklist file `mobile/__tests__/MANUAL_TESTS.md` with step-by-step instructions.

Mock strategy:
- WebSocket: mock with `jest-websocket-mock`
- AsyncStorage: use `@react-native-async-storage/async-storage/jest/async-storage-mock`
- SQLite: use in-memory SQLite or `expo-sqlite` mock
- Keychain: mock `react-native-keychain` with jest module mock
- Camera: mock `expo-camera` permissions
- Voice: mock `@react-native-voice/voice`
- libsodium: use actual library (pure JS, works in test environment)

**Acceptance Criteria**

- [ ] All 30 unit tests pass (`npm test`)
- [ ] All 13 integration tests pass (may require mock daemon server)
- [ ] Manual test checklist documented with step-by-step instructions
- [ ] Test coverage >80% for services/ directory
- [ ] Test coverage >70% for hooks/ directory
- [ ] No test depends on network access (all mocked)
- [ ] CI pipeline runs unit + integration tests on every PR
- [ ] Tests complete in under 2 minutes total

**Edge Cases**

- Flaky WebSocket tests: use deterministic timers (`jest.useFakeTimers()`)
- libsodium initialization: ensure `sodium.ready` is awaited in test setup
- SQLite in tests: use `:memory:` database for isolation

**Estimated Effort**: XL (Extra Large) -- 16-20 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/mobile/`.

| File | Action | Task(s) |
|------|--------|---------|
| `app.json` | Create | 1 |
| `app/_layout.tsx` | Create | 1 |
| `app/(tabs)/_layout.tsx` | Create | 1, 16 |
| `app/(tabs)/agents.tsx` | Create | 1, 5 |
| `app/(tabs)/sessions.tsx` | Create | 1, 7 |
| `app/(tabs)/dashboard.tsx` | Create | 1, 9 |
| `app/(tabs)/settings.tsx` | Create | 1 |
| `app/agent/[id].tsx` | Create | 1, 6 |
| `app/session/[id].tsx` | Create | 1 |
| `app/session/file-explorer.tsx` | Create | 1, 10 |
| `app/settings/daemons.tsx` | Create | 1 |
| `app/settings/daemon/[id].tsx` | Create | 1 |
| `app/settings/encryption.tsx` | Create | 1, 12 |
| `app/settings/notifications.tsx` | Create | 1, 14 |
| `app/settings/key-transfer-send.tsx` | Create | 13 |
| `app/settings/key-transfer-receive.tsx` | Create | 13 |
| `app/dashboard/project/[id].tsx` | Create | 9 |
| `types/navigation.ts` | Create | 2 |
| `types/daemon.ts` | Create | 2 |
| `types/agent.ts` | Create | 2 |
| `types/session.ts` | Create | 2 |
| `types/usage.ts` | Create | 2 |
| `types/file.ts` | Create | 2 |
| `types/notification.ts` | Create | 2 |
| `types/crypto.ts` | Create | 2 |
| `types/errors.ts` | Create | 2 |
| `services/connection-manager.ts` | Create | 3 |
| `services/daemon-connection.ts` | Create | 3 |
| `services/pairing.ts` | Create | 4 |
| `services/key-manager.ts` | Create | 12 |
| `services/key-cache.ts` | Create | 12 |
| `services/key-transfer.ts` | Create | 13 |
| `services/notification-setup.ts` | Create | 14 |
| `services/notification-handler.ts` | Create | 14 |
| `services/cache-manager.ts` | Create | 15 |
| `services/speech.ts` | Create | 11 |
| `storage/daemon-registry.ts` | Create | 3 |
| `storage/cache-db.ts` | Create | 15 |
| `hooks/useConnection.ts` | Create | 3 |
| `hooks/useAgentList.ts` | Create | 5 |
| `hooks/useAgentStream.ts` | Create | 6 |
| `hooks/useSessionList.ts` | Create | 7 |
| `hooks/useSessionSearch.ts` | Create | 8 |
| `hooks/useUsageStats.ts` | Create | 9 |
| `hooks/useVoiceInput.ts` | Create | 11 |
| `hooks/useDiffGestures.ts` | Create | 6 |
| `hooks/useCamera.ts` | Create | 4 |
| `hooks/useTheme.ts` | Create | 16 |
| `hooks/useNetworkState.ts` | Create | 15 |
| `hooks/useNotifications.ts` | Create | 14 |
| `components/agents/AgentCard.tsx` | Create | 5 |
| `components/agents/AgentStatusBadge.tsx` | Create | 5 |
| `components/agents/AgentFilterBar.tsx` | Create | 5 |
| `components/agents/AgentHeader.tsx` | Create | 6 |
| `components/agents/PermissionActionSheet.tsx` | Create | 6 |
| `components/sessions/SessionCard.tsx` | Create | 7 |
| `components/sessions/SessionFilterBar.tsx` | Create | 7 |
| `components/sessions/SessionSearchBar.tsx` | Create | 8 |
| `components/dashboard/DailyUsageChart.tsx` | Create | 9 |
| `components/dashboard/SummaryCards.tsx` | Create | 9 |
| `components/dashboard/ProjectBreakdown.tsx` | Create | 9 |
| `components/dashboard/ModelBreakdown.tsx` | Create | 9 |
| `components/dashboard/DateRangeSelector.tsx` | Create | 9 |
| `components/files/FileTree.tsx` | Create | 10 |
| `components/files/FileTreeNode.tsx` | Create | 10 |
| `components/files/FileViewer.tsx` | Create | 10 |
| `components/shared/QRScanner.tsx` | Create | 4 |
| `components/shared/PairConfirmationModal.tsx` | Create | 4 |
| `components/shared/PromptInput.tsx` | Create | 6 |
| `components/shared/VoiceIndicator.tsx` | Create | 11 |
| `components/shared/DiffViewerShell.tsx` | Create | 6 |
| `components/shared/EmptyState.tsx` | Create | 5 |
| `components/shared/StaleDataBanner.tsx` | Create | 15 |
| `components/shared/KeyVerificationModal.tsx` | Create | 13 |
| `theme/colors.ts` | Create | 16 |
| `theme/typography.ts` | Create | 16 |
| `theme/spacing.ts` | Create | 16 |
| `theme/ThemeContext.tsx` | Create | 16 |
| `__tests__/` (17 test files) | Create | 17 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Duration | Milestone |
|-------|-------|----------|-----------|
| **Phase 1: Foundation** | Task 1 (Bootstrap), Task 2 (Types), Task 16 (Theme) | 3-4 days | Buildable app with navigation, all types defined, themed screens |
| **Phase 2: Connectivity** | Task 3 (ConnectionManager), Task 4 (QR Pairing) | 4-5 days | App can pair with daemons and maintain connections |
| **Phase 3: Core Screens** | Task 5 (Agent List), Task 7 (Session List), Task 9 (Usage Dashboard) | 4-5 days | All three main tabs functional with real daemon data |
| **Phase 4: Interaction** | Task 6 (Agent Detail), Task 8 (Session Search), Task 10 (File Explorer) | 4-5 days | Full agent interaction, search, and file browsing |
| **Phase 5: Platform Features** | Task 11 (Voice), Task 12 (Encryption), Task 14 (Push Notifications) | 4-5 days | Voice input, key management, push notifications |
| **Phase 6: Advanced** | Task 13 (QR Key Transfer), Task 15 (Offline Mode) | 3-4 days | Key transfer flow, offline caching |
| **Phase 7: Testing** | Task 17 (Tests) | 3-4 days | Full test suite passing |

Tasks within a phase can be partially parallelized:
- Phase 1: Tasks 1, 2, 16 can all start immediately; Task 16 depends on Task 1 completing
- Phase 3: Tasks 5, 7, 9 are independent and can be done in parallel by different developers
- Phase 5: Tasks 11, 12, 14 are independent and can be parallelized

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Story 02 rendering components not ready | Medium | High (agent detail screen is a shell) | Implement placeholder components that show raw JSON events; swap in real renderers later |
| Daemon WebSocket API not finalized | Medium | High (all data fetching blocked) | Define a mock daemon server early (Task 3); code against the mock; swap real daemon later |
| `react-native-keychain` biometric issues on specific devices | Medium | Medium (key management broken) | Fall back to `expo-secure-store` without biometric ACL; document unsupported devices |
| libsodium WASM bundle size (200KB) | Low | Medium (app size increase) | Acceptable; listed in dependencies; use tree-shaking to import only needed functions |
| expo-camera QR scanning reliability | Medium | Medium (pairing UX) | Implement manual entry fallback: "Can't scan? Enter pairing code manually" |
| SQLite cache corruption on app crash | Low | Medium (cached data lost) | WAL mode prevents corruption; integrity check on startup with auto-recovery |
| Push notification token rotation on Android | Medium | Low (temporary delivery gap) | Token listener re-sends to all daemons on rotation; daemon falls back to WebSocket delivery |
| Concurrent WebSocket connections (5+ daemons) causing battery drain | Medium | Medium (user experience) | Reduce heartbeat frequency to 60s when >3 daemons are idle; batch event processing |
| Performance on low-end Android (agent list with 50+ items) | Medium | Medium (60fps target missed) | FlashList virtualization; memoize AgentCard component; profile early on low-end device |
| Expo SDK version conflicts with native modules | Low | High (build failure) | Pin all dependency versions; test on both platforms in CI |

---

## Notes for Implementation

1. **Story 02 integration is the critical dependency.** The agent detail screen and session detail screen delegate rendering to Story 02's components (F13.1-F13.14). Start with placeholder renderers that display raw event data, and swap in real components as they become available.

2. **Mock daemon server.** Build a simple WebSocket mock server early (Task 3) that simulates agent events, session data, and file operations. This unblocks all screen development without requiring the real daemon.

3. **Paseo fork reference, not copy.** The story says "forked from Paseo." This means using Paseo's architectural patterns (E2EE relay protocol, connection management strategy) as reference, not copying its codebase verbatim. The app is built from scratch using Expo Router and the specified architecture.

4. **Expo Router (file-based routing) is the navigation system.** All screens are files in `app/` directory. No manual `createStackNavigator()` calls. This simplifies deep linking significantly.

5. **AsyncStorage for small data, SQLite for large data.** HostProfiles (small, <10KB) go in AsyncStorage. Session history, events, usage (potentially MB+) go in SQLite.

6. **Key security is paramount.** The master encryption key must never appear in logs, error messages, analytics, or crash reports. Use `sodium.memzero()` aggressively. The KeyCache auto-clears after 5 minutes of background. All crypto operations should be wrapped in try/finally with cleanup.

7. **Performance-first on mobile.** Every list uses FlashList (not FlatList). Every component that renders in a list is wrapped in `React.memo()`. WebSocket event handlers use `requestAnimationFrame` batching to avoid excessive re-renders.

8. **Dark theme is the default.** Terminal users expect dark. Light theme is available but secondary.

---

## Effort Estimates

| Task | Complexity | Estimate |
|------|-----------|----------|
| Task 1: Expo Bootstrap & Navigation | L | 8-12 hours |
| Task 2: Type System & Data Models | S | 3-4 hours |
| Task 3: Connection Manager & Daemon Connection | XL | 12-16 hours |
| Task 4: QR Code Pairing | L | 10-14 hours |
| Task 5: Unified Agent View | L | 10-14 hours |
| Task 6: Agent Interaction | XL | 14-18 hours |
| Task 7: Session History | L | 8-12 hours |
| Task 8: Session Search | M | 6-8 hours |
| Task 9: Usage Dashboard | L | 10-14 hours |
| Task 10: File Explorer | L | 10-14 hours |
| Task 11: Voice Input | M | 6-8 hours |
| Task 12: Encryption Key Management | L | 10-14 hours |
| Task 13: QR Key Transfer | XL | 12-16 hours |
| Task 14: Push Notifications | L | 10-14 hours |
| Task 15: Offline Mode & SQLite Cache | L | 10-14 hours |
| Task 16: Theme System | S | 3-4 hours |
| Task 17: Integration & E2E Tests | XL | 16-20 hours |
| **Total** | | **~159-216 hours (~20-27 working days)** |
