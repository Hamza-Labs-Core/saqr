# Story 16: Mobile App Shell (Expo)

## Overview

Story 08 implemented the mobile data layer — TypeScript types, services, and 269 unit tests for connection management, daemon registry, agent aggregation, session history, usage data, notifications, offline cache, encryption keys, and voice input. That data layer has no UI and no runnable app.

This story builds the **actual Expo/React Native application** that consumes Story 08's data layer. It creates the app shell with navigation, screens, and native build configuration — producing real iOS and Android binaries that users can install.

The implementation follows Paseo's architecture: Expo SDK 54, expo-router (file-based routing), Zustand for state, TanStack React Query for server state, and platform-specific integrations for voice, notifications, and secure storage.

**Guiding principle**: Ship the smallest runnable app first. The initial version needs: daemon pairing (QR), agent list, agent detail with streaming output, and basic settings. Advanced features (voice, file explorer, usage charts) build on top in subsequent iterations within this story.

---

## Scope

### In Scope

- Expo SDK 54 project setup inside `packages/mobile` (alongside existing data layer)
- expo-router file-based navigation structure
- State management (Zustand stores consuming Story 08 services)
- Server state management (TanStack React Query for daemon API calls)
- Core screens:
  - Home / daemon list
  - QR pairing (camera-based daemon connection)
  - Agent list (unified across daemons)
  - Agent detail (streaming output, prompt input, permission approval)
  - Session history with search
  - Settings (daemon management, notifications, appearance)
- WebSocket connection to daemon(s) for real-time streaming
- Push notifications via expo-notifications
- Secure storage for encryption keys via expo-secure-store
- Voice input integration (expo-av or @boudra/expo-two-way-audio)
- Dark/light theme with system preference detection
- Android APK + iOS builds via GitHub Actions (not EAS)
- Expo web export for Cloudflare Pages deployment

### Out of Scope

- EAS Build (builds happen in GitHub Actions directly)
- App Store / Google Play submission automation (manual for now)
- CLI session rendering components (Story 02 — consumed as components when ready)
- Desktop-specific features (Story 17)
- Sync server integration (Story 11 — the app connects to daemons directly)

---

## Requirements

### 1. Expo Project Setup

Initialize the Expo app within the existing `packages/mobile` directory. The current data layer (src/types, src/services) remains untouched — the app shell imports from it.

#### Directory Structure

```
packages/mobile/
├── app/                          # expo-router pages
│   ├── _layout.tsx               # Root layout (providers, theme)
│   ├── index.tsx                 # Home — daemon list
│   ├── pair-scan.tsx             # QR pairing screen
│   ├── settings.tsx              # App settings
│   └── h/
│       └── [serverId]/
│           ├── _layout.tsx       # Server layout (header, tabs)
│           ├── index.tsx         # Server home
│           ├── agents.tsx        # Agent list
│           ├── agent/
│           │   └── [agentId].tsx # Agent detail
│           └── settings.tsx      # Server settings
├── components/                   # Reusable UI components
│   ├── AgentCard.tsx
│   ├── AgentStream.tsx
│   ├── DaemonCard.tsx
│   ├── PermissionPrompt.tsx
│   ├── PromptInput.tsx
│   ├── QRScanner.tsx
│   ├── SessionListItem.tsx
│   └── VoicePanel.tsx
├── stores/                       # Zustand stores
│   ├── daemon-store.ts
│   ├── agent-store.ts
│   ├── session-store.ts
│   └── settings-store.ts
├── hooks/                        # React hooks
│   ├── use-daemon-connection.ts
│   ├── use-agent-stream.ts
│   └── use-voice-input.ts
├── lib/                          # Utilities
│   ├── api-client.ts
│   ├── theme.ts
│   └── storage.ts
├── src/                          # Existing data layer (Story 08)
│   ├── types/
│   └── services/
├── app.json                      # Expo config
├── eas.json                      # EAS config (for local use)
├── package.json
├── tsconfig.json
└── metro.config.js
```

#### app.json

```json
{
  "expo": {
    "name": "Saqr",
    "slug": "saqr",
    "version": "0.1.0",
    "orientation": "portrait",
    "scheme": "saqr",
    "platforms": ["ios", "android", "web"],
    "ios": {
      "bundleIdentifier": "dev.saqr.app",
      "buildNumber": "1",
      "supportsTablet": true
    },
    "android": {
      "package": "dev.saqr.app",
      "versionCode": 1,
      "adaptiveIcon": {
        "foregroundImage": "./assets/adaptive-icon.png",
        "backgroundColor": "#ffffff"
      }
    },
    "web": {
      "bundler": "metro",
      "output": "static"
    },
    "plugins": [
      "expo-router",
      "expo-secure-store",
      "expo-camera"
    ]
  }
}
```

### 2. Navigation (expo-router)

File-based routing with the following structure:

| Route | Screen | Description |
|-------|--------|-------------|
| `/` | Home | List of connected daemons with status |
| `/pair-scan` | QR Pairing | Camera + manual entry for daemon pairing |
| `/settings` | Settings | App preferences, theme, notifications |
| `/h/[serverId]/` | Server Home | Overview of a specific daemon |
| `/h/[serverId]/agents` | Agent List | All agents on this daemon |
| `/h/[serverId]/agent/[agentId]` | Agent Detail | Streaming output, prompt, permissions |
| `/h/[serverId]/settings` | Server Settings | Daemon-specific config |

Root layout wraps the app in providers:

```tsx
// app/_layout.tsx
export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Stack>
          <Stack.Screen name="index" options={{ title: "Saqr" }} />
          <Stack.Screen name="pair-scan" options={{ presentation: "modal" }} />
          <Stack.Screen name="settings" />
          <Stack.Screen name="h/[serverId]" options={{ headerShown: false }} />
        </Stack>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
```

### 3. State Management

**Zustand** for client state (daemon registry, UI preferences):

```typescript
// stores/daemon-store.ts
interface DaemonStore {
  daemons: Map<string, DaemonConnection>;
  activeDaemonId: string | null;
  addDaemon: (config: DaemonConfig) => void;
  removeDaemon: (id: string) => void;
  setActive: (id: string) => void;
}
```

**TanStack React Query** for server state (agent data from daemon API):

```typescript
// hooks/use-agents.ts
export function useAgents(serverId: string) {
  return useQuery({
    queryKey: ["agents", serverId],
    queryFn: () => daemonApi.getAgents(serverId),
    refetchInterval: 5000,
  });
}
```

### 4. Real-time Agent Streaming

WebSocket connection to each daemon for live agent output. Uses the connection manager from Story 08.

```typescript
// hooks/use-agent-stream.ts
export function useAgentStream(serverId: string, agentId: string) {
  const ws = useDaemonConnection(serverId);
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    const unsub = ws.subscribe(`agent:${agentId}`, (event) => {
      setEvents((prev) => [...prev, event]);
    });
    return unsub;
  }, [ws, agentId]);

  return { events };
}
```

### 5. QR Pairing

Camera-based QR scanning to pair with a daemon. The QR code contains the daemon's connection info (host, port, public key for E2EE).

Uses `expo-camera` for scanning, falls back to manual IP:port entry.

### 6. Push Notifications

`expo-notifications` for agent events (permission requests, task completion, errors). Notification categories with action buttons (Approve/Deny for permissions).

### 7. Voice Input

Speech-to-text for hands-free agent prompting. Uses `expo-av` for audio recording, sends audio to daemon's speech endpoint.

### 8. Native Dependencies

| Package | Purpose |
|---------|---------|
| `expo` ~54 | App framework |
| `expo-router` ~4 | File-based navigation |
| `expo-camera` | QR code scanning |
| `expo-secure-store` | Encryption key storage |
| `expo-notifications` | Push notifications |
| `expo-av` | Voice recording |
| `react-native` ~0.81 | UI framework |
| `react` ~19 | Component framework |
| `zustand` | Client state |
| `@tanstack/react-query` | Server state |
| `@xterm/xterm` | Terminal emulator (web) |

---

## CI/CD — GitHub Actions Build

Mobile builds run in GitHub Actions, NOT EAS. This avoids a third-party dependency and keeps builds free for open source.

### Android APK (GitHub Actions)

```yaml
# Build on ubuntu-latest
# 1. Setup Java 17, Android SDK, Node.js 22
# 2. npx expo prebuild --platform android
# 3. cd android && ./gradlew assembleRelease
# 4. Upload APK as release asset
```

### iOS Simulator Build (GitHub Actions)

```yaml
# Build on macos-latest
# 1. Setup Node.js 22, CocoaPods
# 2. npx expo prebuild --platform ios
# 3. xcodebuild -workspace ios/Saqr.xcworkspace -scheme Saqr -sdk iphonesimulator
# 4. Upload .app as release asset
```

> **Note**: iOS App Store builds require Apple Developer account + signing certificates. When ready, add a separate job with code signing.

### Web Export

```yaml
# 1. npx expo export --platform web
# 2. Deploy dist/ to Cloudflare Pages via wrangler pages deploy
```

---

## Testing Plan

### Unit Tests (extend existing 269)

| Test | Description |
|------|-------------|
| T-1 | Zustand daemon store: add/remove/setActive round-trip |
| T-2 | Agent stream hook: receives and accumulates events |
| T-3 | QR pairing: parses daemon connection info from QR data |
| T-4 | Theme provider: respects system color scheme |
| T-5 | API client: retries on network failure |

### Integration Tests

| Test | Description |
|------|-------------|
| T-6 | App renders home screen with daemon list |
| T-7 | Navigation: tap daemon → agent list → agent detail |
| T-8 | QR scan flow: scan → connect → shows in daemon list |
| T-9 | Agent detail: displays streaming events |
| T-10 | Permission prompt: approve/deny sends to daemon |

### E2E Tests (Maestro or Detox)

| Test | Description |
|------|-------------|
| T-11 | Full pairing flow on Android |
| T-12 | Full pairing flow on iOS simulator |
| T-13 | Send prompt to agent, receive streaming response |

---

## Definition of Done

- [ ] `npx expo start` launches the app in dev mode (iOS simulator, Android emulator, web)
- [ ] Home screen lists connected daemons with status indicators
- [ ] QR pairing connects to a daemon and persists the connection
- [ ] Agent list shows all agents across connected daemons
- [ ] Agent detail displays streaming output in real-time
- [ ] Prompt input sends messages to agents
- [ ] Permission requests show approve/deny UI
- [ ] Push notifications fire for agent events
- [ ] Dark/light theme follows system preference
- [ ] Android APK builds in GitHub Actions (< 15 min)
- [ ] iOS simulator build works in GitHub Actions (< 20 min)
- [ ] Web export deploys to Cloudflare Pages
- [ ] Existing 269 data layer tests still pass
- [ ] New UI tests bring total to 300+
