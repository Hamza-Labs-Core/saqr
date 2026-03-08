# Implementation Plan: Story 16 -- Mobile App Shell (Expo)

**Date**: 2026-02-24
**Story**: 16-mobile-app-shell
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (96-128 hours)
**Prerequisites**: Story 08 (Mobile Data Layer) -- completed, 269 tests passing. No other stories are hard prerequisites; this story builds UI on top of the Story 08 data layer.

---

### Relationship to Existing Code

Story 08 produced the pure TypeScript data layer in `/home/meywd/Saqr/packages/mobile/src/` with:
- **10 type modules**: `types/agent.ts`, `types/daemon.ts`, `types/session.ts`, `types/usage.ts`, `types/navigation.ts`, `types/crypto.ts`, `types/notification.ts`, `types/errors.ts`, `types/file.ts`, `types/index.ts`
- **9 service classes**: `ConnectionManager`, `DaemonRegistry`, `AgentDataAggregator`, `SessionHistoryManager`, `UsageDataAggregator`, `NotificationManager`, `OfflineCacheManager`, `EncryptionKeyManager`, `VoiceInputManager`
- **269 tests** across 10 test files

This story adds the Expo app shell, expo-router pages, Zustand stores (bridging data layer services to React), React Query hooks, and UI components. The existing `src/` directory remains untouched; new code lives alongside it in `app/`, `components/`, `stores/`, `hooks/`, and `lib/`.

### Reference Architecture: Paseo

The Paseo app (at `github.com/getpaseo/paseo/packages/app`) uses:
- **Expo SDK 54** (`expo@^54.0.18`), **React 19.1.0**, **React Native 0.81.5**
- **expo-router ~6** with file-based routing under `src/app/`
- **Zustand 5** for client state
- **@tanstack/react-query 5** for server state
- **react-native-unistyles 3** for theming
- Route structure: `src/app/index.tsx`, `src/app/settings.tsx`, `src/app/pair-scan.tsx`, `src/app/h/[serverId]/agent/[agentId].tsx`, etc.
- Deep provider nesting in `_layout.tsx`: `GestureHandlerRootView > SafeAreaProvider > KeyboardProvider > BottomSheetModalProvider > QueryClientProvider > DaemonRegistryProvider > VoiceProvider > Stack`

Our Saqr app follows this same architecture but adapted for our own data layer types.

---

## Task Dependency Graph

```
Task 1: Build Configuration (app.json, metro.config.js, tsconfig.json, babel.config.js)
  |
  +---> Task 2: Theme System & Lib Utilities (lib/theme.ts, lib/storage.ts, lib/api-client.ts)
  |       |
  |       +---> Task 3: Zustand Stores (stores/daemon-store.ts, stores/agent-store.ts, etc.)
  |       |       |
  |       |       +---> Task 5: Core Screens (app/index.tsx, app/pair-scan.tsx, app/settings.tsx)
  |       |       |       |
  |       |       |       +---> Task 7: Server Screens (app/h/[serverId]/*.tsx)
  |       |       |       |       |
  |       |       |       |       +---> Task 8: Agent Detail Screen (app/h/[serverId]/agent/[agentId].tsx)
  |       |       |       |
  |       |       |       +---> Task 9: Push Notifications & Voice Integration
  |       |       |
  |       |       +---> Task 4: React Query Hooks (hooks/use-daemon-connection.ts, etc.)
  |       |
  |       +---> Task 6: UI Components (components/DaemonCard.tsx, etc.)
  |
  +---> Task 10: Unit & Integration Tests
  |
  +---> Task 11: CI/CD GitHub Actions Workflows
```

---

## Tasks

### Task 1: Build Configuration

Transform `packages/mobile` from a pure TypeScript library into a runnable Expo app while preserving the existing data layer.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/app.json` | Expo configuration |
| `packages/mobile/app.config.js` | Dynamic Expo config (variant support) |
| `packages/mobile/metro.config.js` | Metro bundler config for monorepo |
| `packages/mobile/babel.config.js` | Babel config for Expo + Zustand |
| `packages/mobile/index.ts` | Expo entry point (already exists as `src/index.ts` -- keep that for lib, add root `index.ts` for app entry) |
| `packages/mobile/assets/` | Icon and splash assets directory |
| `packages/mobile/assets/icon.png` | App icon (1024x1024) |
| `packages/mobile/assets/splash-icon.png` | Splash screen icon |
| `packages/mobile/assets/adaptive-icon.png` | Android adaptive icon foreground |
| `packages/mobile/assets/favicon.png` | Web favicon |

#### app.json

```json
{
  "expo": {
    "name": "Saqr",
    "slug": "saqr",
    "version": "0.1.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "scheme": "saqr",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "platforms": ["ios", "android", "web"],
    "ios": {
      "bundleIdentifier": "dev.saqr.app",
      "buildNumber": "1",
      "supportsTablet": true,
      "infoPlist": {
        "NSMicrophoneUsageDescription": "Saqr needs microphone access for voice commands.",
        "NSCameraUsageDescription": "Saqr needs camera access to scan QR pairing codes.",
        "ITSAppUsesNonExemptEncryption": false
      }
    },
    "android": {
      "package": "dev.saqr.app",
      "versionCode": 1,
      "adaptiveIcon": {
        "foregroundImage": "./assets/adaptive-icon.png",
        "backgroundColor": "#ffffff"
      },
      "usesCleartextTraffic": true,
      "permissions": ["RECORD_AUDIO", "CAMERA"]
    },
    "web": {
      "bundler": "metro",
      "output": "static",
      "favicon": "./assets/favicon.png"
    },
    "plugins": [
      "expo-router",
      ["expo-camera", {
        "cameraPermission": "Allow Saqr to access your camera to scan pairing QR codes."
      }],
      "expo-secure-store",
      ["expo-notifications", {
        "color": "#1a73e8"
      }],
      "expo-audio",
      ["expo-build-properties", {
        "android": { "minSdkVersion": 29 }
      }]
    ],
    "experiments": {
      "typedRoutes": true
    },
    "extra": {
      "router": {}
    }
  }
}
```

#### metro.config.js

Following Paseo's pattern for monorepo resolution with `.js` -> `.ts` mapping for the existing data layer:

```javascript
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo root for shared packages
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, "node_modules"),
  path.join(monorepoRoot, "node_modules"),
];

// Resolve .js imports from src/ to .ts source files
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath;
  if (origin && moduleName.endsWith(".js")) {
    const tsName = moduleName.replace(/\.js$/, ".ts");
    const candidate = path.resolve(path.dirname(origin), tsName);
    if (fs.existsSync(candidate)) {
      return (defaultResolve ?? require("metro-resolver").resolve)(context, tsName, platform);
    }
  }
  return (defaultResolve ?? require("metro-resolver").resolve)(context, moduleName, platform);
};

module.exports = config;
```

#### tsconfig.json (replace existing)

Switch from NodeNext to Expo's base config:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "paths": {
      "@/*": ["./src/*"],
      "@app/*": ["./app/*"],
      "@components/*": ["./components/*"],
      "@stores/*": ["./stores/*"],
      "@hooks/*": ["./hooks/*"],
      "@lib/*": ["./lib/*"]
    }
  },
  "include": [
    "**/*.ts",
    "**/*.tsx",
    ".expo/types/**/*.ts",
    "expo-env.d.ts"
  ]
}
```

**Important**: The existing `tsconfig.json` sets `rootDir: "src"` and `module: "NodeNext"`. This needs to change because Expo uses its own TS base config. The existing vitest tests reference `.js` extensions in imports (e.g., `"../services/connection-manager.js"`) which Metro will resolve via the custom resolver above.

#### babel.config.js

```javascript
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", {
        unstable_transformImportMeta: true,
      }],
    ],
  };
};
```

#### vitest.config.ts (keep existing)

The existing vitest config at `/home/meywd/Saqr/packages/mobile/vitest.config.ts` remains unchanged. Vitest runs independently of Metro/Expo. New UI-related tests will be added to `src/__tests__/` (for stores/hooks) and tested with vitest.

#### package.json Changes

The existing `package.json` needs significant dependency additions:

```json
{
  "name": "@saqr/mobile",
  "version": "0.1.0",
  "private": true,
  "main": "index.ts",
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "web": "expo start --web",
    "build": "tsc --noEmit",
    "build:web": "expo export --platform web",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "typecheck": "tsc --noEmit",
    "lint": "expo lint",
    "clean": "rm -rf dist .expo android ios"
  },
  "dependencies": {
    "@saqr/shared": "workspace:*",
    "@expo/vector-icons": "^15.0.2",
    "@gorhom/bottom-sheet": "^5.2.6",
    "@react-native-async-storage/async-storage": "2.2.0",
    "@react-navigation/bottom-tabs": "^7.4.0",
    "@react-navigation/native": "^7.1.8",
    "@tanstack/react-query": "^5.90.11",
    "expo": "^54.0.18",
    "expo-audio": "~1.0.13",
    "expo-av": "^16.0.7",
    "expo-build-properties": "^1.0.9",
    "expo-camera": "~17.0.10",
    "expo-clipboard": "~8.0.7",
    "expo-constants": "~18.0.9",
    "expo-crypto": "^15.0.8",
    "expo-font": "~14.0.9",
    "expo-haptics": "~15.0.7",
    "expo-linking": "~8.0.8",
    "expo-notifications": "^0.32.16",
    "expo-router": "~6.0.13",
    "expo-secure-store": "~14.0.1",
    "expo-splash-screen": "~31.0.10",
    "expo-system-ui": "~6.0.7",
    "lucide-react-native": "^0.546.0",
    "react": "19.1.0",
    "react-dom": "19.1.0",
    "react-native": "^0.81.5",
    "react-native-gesture-handler": "~2.28.0",
    "react-native-keyboard-controller": "^1.19.2",
    "react-native-reanimated": "~4.1.1",
    "react-native-safe-area-context": "~5.6.0",
    "react-native-screens": "~4.16.0",
    "react-native-svg": "^15.14.0",
    "react-native-web": "~0.21.0",
    "react-native-webview": "^13.16.0",
    "zustand": "^5.0.9",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "~19.2.0",
    "typescript": "~5.9.2",
    "vitest": "^3.0.0",
    "eslint-config-expo": "~10.0.0"
  }
}
```

Key changes from existing:
- `"main"` changes from `"./dist/index.js"` to `"index.ts"` (Expo entry)
- Remove `"types"`, `"exports"` (app, not library)
- Add all Expo + RN dependencies matching Paseo's versions
- Keep `vitest` in devDependencies for data layer tests

---

### Task 2: Theme System & Library Utilities

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/lib/theme.ts` | Color tokens, dark/light themes, ThemeProvider |
| `packages/mobile/lib/storage.ts` | AsyncStorage wrapper for Zustand persistence |
| `packages/mobile/lib/api-client.ts` | HTTP client with retry logic for daemon API calls |
| `packages/mobile/lib/query-client.ts` | TanStack React Query client singleton |
| `packages/mobile/lib/constants.ts` | Layout breakpoints, timing constants |

#### lib/theme.ts

```typescript
import { useColorScheme } from "react-native";
import { createContext, useContext } from "react";

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceElevated: string;
  foreground: string;
  foregroundMuted: string;
  primary: string;
  primaryForeground: string;
  destructive: string;
  success: string;
  warning: string;
  border: string;
  borderMuted: string;
  // Agent status colors
  statusRunning: string;
  statusIdle: string;
  statusError: string;
  statusWaiting: string;
  statusCompleted: string;
  statusDisconnected: string;
}

export const darkTheme: ThemeColors = {
  background: "#000000",
  surface: "#1a1a1a",
  surfaceElevated: "#2a2a2a",
  foreground: "#ffffff",
  foregroundMuted: "#8e8e93",
  primary: "#0a84ff",
  primaryForeground: "#ffffff",
  destructive: "#ff453a",
  success: "#30d158",
  warning: "#ffd60a",
  border: "#38383a",
  borderMuted: "#2c2c2e",
  statusRunning: "#30d158",
  statusIdle: "#8e8e93",
  statusError: "#ff453a",
  statusWaiting: "#ffd60a",
  statusCompleted: "#0a84ff",
  statusDisconnected: "#48484a",
};

export const lightTheme: ThemeColors = {
  background: "#ffffff",
  surface: "#f2f2f7",
  surfaceElevated: "#ffffff",
  foreground: "#000000",
  foregroundMuted: "#8e8e93",
  primary: "#007aff",
  primaryForeground: "#ffffff",
  destructive: "#ff3b30",
  success: "#34c759",
  warning: "#ffcc00",
  border: "#c6c6c8",
  borderMuted: "#e5e5ea",
  statusRunning: "#34c759",
  statusIdle: "#8e8e93",
  statusError: "#ff3b30",
  statusWaiting: "#ffcc00",
  statusCompleted: "#007aff",
  statusDisconnected: "#c7c7cc",
};
```

#### lib/storage.ts

Thin wrapper around `@react-native-async-storage/async-storage` for Zustand `persist` middleware:

```typescript
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StateStorage } from "zustand/middleware";

export const zustandStorage: StateStorage = {
  getItem: async (key: string) => AsyncStorage.getItem(key),
  setItem: async (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: async (key: string) => AsyncStorage.removeItem(key),
};
```

#### lib/api-client.ts

HTTP client that wraps `fetch` with daemon base URL resolution and retry:

```typescript
export class ApiClient {
  constructor(private baseUrl: string) {}

  async get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "GET",
      signal: options?.signal,
    });
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries = 2,
    delay = 1000
  ): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok) return response;
        if (response.status >= 500 && attempt < retries) {
          await new Promise((r) => setTimeout(r, delay * Math.pow(2, attempt)));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        if (attempt === retries) throw error;
        await new Promise((r) => setTimeout(r, delay * Math.pow(2, attempt)));
      }
    }
    throw new Error("Max retries exceeded");
  }
}
```

---

### Task 3: Zustand Stores

Create Zustand stores that bridge Story 08 service classes into React-friendly state. Each store wraps a service from `src/services/` and exposes reactive state.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/stores/daemon-store.ts` | Wraps DaemonRegistry + ConnectionManager |
| `packages/mobile/stores/agent-store.ts` | Wraps AgentDataAggregator |
| `packages/mobile/stores/session-store.ts` | Wraps SessionHistoryManager |
| `packages/mobile/stores/settings-store.ts` | App preferences (theme, notifications) |
| `packages/mobile/stores/voice-store.ts` | Wraps VoiceInputManager |

#### stores/daemon-store.ts

```typescript
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { zustandStorage } from "../lib/storage";
import { DaemonRegistry } from "../src/services/daemon-registry";
import { ConnectionManager } from "../src/services/connection-manager";
import type { HostProfile, ConnectionState } from "../src/types/daemon";
import type { PairingPayload } from "../src/types/crypto";

interface DaemonState {
  // State
  daemons: HostProfile[];
  connectionStates: Record<string, ConnectionState>;
  activeDaemonId: string | null;

  // Actions
  addDaemon: (host: HostProfile) => void;
  removeDaemon: (id: string) => void;
  setActive: (id: string | null) => void;
  updateConnectionState: (id: string, state: ConnectionState) => void;
  pairFromQR: (url: string) => { success: boolean; error?: string; hostId?: string };
  getDaemon: (id: string) => HostProfile | undefined;

  // Internal service refs (not persisted)
  _registry: DaemonRegistry;
  _connectionManager: ConnectionManager;
}

export const useDaemonStore = create<DaemonState>()(
  persist(
    (set, get) => {
      const registry = new DaemonRegistry();
      const connectionManager = ConnectionManager.create();

      return {
        daemons: [],
        connectionStates: {},
        activeDaemonId: null,
        _registry: registry,
        _connectionManager: connectionManager,

        addDaemon: (host) => {
          registry.addHost(host);
          connectionManager.registerHost(host);
          set({ daemons: registry.getAll() });
        },

        removeDaemon: (id) => {
          registry.removeHost(id);
          connectionManager.removeHost(id);
          set((state) => ({
            daemons: registry.getAll(),
            activeDaemonId: state.activeDaemonId === id ? null : state.activeDaemonId,
          }));
        },

        setActive: (id) => set({ activeDaemonId: id }),

        updateConnectionState: (id, state) => {
          set((prev) => ({
            connectionStates: { ...prev.connectionStates, [id]: state },
          }));
        },

        pairFromQR: (url: string) => {
          const result = DaemonRegistry.parseQRPayloadUrl(url);
          if (!result.success) {
            return { success: false, error: result.error.message };
          }
          const host = DaemonRegistry.createHostFromPayload(
            result.payload,
            result.payload.ephemeralPublicKey
          );
          get().addDaemon(host);
          return { success: true, hostId: host.id };
        },

        getDaemon: (id) => registry.getById(id),
      };
    },
    {
      name: "saqr-daemon-registry",
      storage: createJSONStorage(() => zustandStorage),
      partialize: (state) => ({
        daemons: state.daemons,
        activeDaemonId: state.activeDaemonId,
      }),
    }
  )
);
```

#### stores/agent-store.ts

```typescript
import { create } from "zustand";
import { AgentDataAggregator } from "../src/services/agent-data-aggregator";
import type { AgentSummary, AgentListFilter, AgentSortField, SortDirection } from "../src/types/agent";

interface AgentState {
  agents: AgentSummary[];
  filter: AgentListFilter;
  sortBy: AgentSortField;
  sortDirection: SortDirection;

  setAgentsForHost: (hostId: string, agents: AgentSummary[]) => void;
  updateAgent: (hostId: string, agentId: string, updates: Partial<AgentSummary>) => void;
  markHostDisconnected: (hostId: string) => void;
  setFilter: (filter: Partial<AgentListFilter>) => void;
  setSortBy: (field: AgentSortField) => void;
  toggleSortDirection: () => void;

  getFilteredAgents: () => AgentSummary[];
  getAttentionCount: () => number;

  _aggregator: AgentDataAggregator;
}

export const useAgentStore = create<AgentState>()((set, get) => {
  const aggregator = new AgentDataAggregator();

  return {
    agents: [],
    filter: { machineId: null, provider: null, status: null },
    sortBy: "lastActivity" as AgentSortField,
    sortDirection: "desc" as SortDirection,
    _aggregator: aggregator,

    setAgentsForHost: (hostId, agents) => {
      aggregator.setAgentsForHost(hostId, agents);
      set({ agents: aggregator.getMergedAgents() });
    },

    updateAgent: (hostId, agentId, updates) => {
      aggregator.updateAgent(hostId, agentId, updates);
      set({ agents: aggregator.getMergedAgents() });
    },

    markHostDisconnected: (hostId) => {
      aggregator.markHostDisconnected(hostId);
      set({ agents: aggregator.getMergedAgents() });
    },

    setFilter: (filter) => set((state) => ({ filter: { ...state.filter, ...filter } })),
    setSortBy: (field) => set({ sortBy: field }),
    toggleSortDirection: () => set((state) => ({
      sortDirection: state.sortDirection === "asc" ? "desc" : "asc",
    })),

    getFilteredAgents: () => {
      const { filter, sortBy, sortDirection } = get();
      const filtered = aggregator.getFiltered(filter);
      // Apply sort in-place
      return aggregator.getSorted(sortBy, sortDirection)
        .filter(a => filtered.some(f => f.id === a.id && f.hostId === a.hostId));
    },

    getAttentionCount: () => aggregator.getAttentionCount(),
  };
});
```

#### stores/settings-store.ts

```typescript
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { zustandStorage } from "../lib/storage";
import type { NotificationSettings } from "../src/types/notification";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../src/types/notification";

type ThemePreference = "light" | "dark" | "auto";

interface SettingsState {
  theme: ThemePreference;
  notifications: NotificationSettings;
  hapticFeedback: boolean;

  setTheme: (theme: ThemePreference) => void;
  setNotifications: (settings: Partial<NotificationSettings>) => void;
  setHapticFeedback: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "auto",
      notifications: DEFAULT_NOTIFICATION_SETTINGS,
      hapticFeedback: true,

      setTheme: (theme) => set({ theme }),
      setNotifications: (settings) =>
        set((state) => ({
          notifications: { ...state.notifications, ...settings },
        })),
      setHapticFeedback: (enabled) => set({ hapticFeedback: enabled }),
    }),
    {
      name: "saqr-settings",
      storage: createJSONStorage(() => zustandStorage),
    }
  )
);
```

---

### Task 4: React Query Hooks

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/hooks/use-daemon-connection.ts` | WebSocket connection management per daemon |
| `packages/mobile/hooks/use-agent-stream.ts` | Real-time agent event stream via WebSocket |
| `packages/mobile/hooks/use-agents.ts` | React Query hook for agent list |
| `packages/mobile/hooks/use-sessions.ts` | React Query hook for session history |
| `packages/mobile/hooks/use-usage.ts` | React Query hook for usage data |
| `packages/mobile/hooks/use-voice-input.ts` | Voice input state bridge |
| `packages/mobile/hooks/use-theme.ts` | Theme hook respecting system preference |
| `packages/mobile/lib/query-client.ts` | Shared QueryClient instance |

#### hooks/use-agents.ts

```typescript
import { useQuery } from "@tanstack/react-query";
import type { AgentSummary } from "../src/types/agent";
import { ApiClient } from "../lib/api-client";

export function useAgents(serverId: string, baseUrl: string) {
  const client = new ApiClient(baseUrl);
  return useQuery({
    queryKey: ["agents", serverId],
    queryFn: () => client.get<AgentSummary[]>("/api/agents"),
    refetchInterval: 5000,
    enabled: !!serverId && !!baseUrl,
  });
}
```

#### hooks/use-agent-stream.ts

```typescript
import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentStreamEvent } from "../src/types/agent";

export function useAgentStream(wsUrl: string | null, agentId: string) {
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!wsUrl || !agentId) return;

    const ws = new WebSocket(`${wsUrl}/ws?agentId=${agentId}`);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as AgentStreamEvent;
        if (parsed.agentId === agentId) {
          setEvents((prev) => [...prev, parsed]);
        }
      } catch { /* ignore parse errors */ }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [wsUrl, agentId]);

  const sendPrompt = useCallback((prompt: string) => {
    wsRef.current?.send(JSON.stringify({
      type: "send_prompt",
      agentId,
      data: { prompt },
    }));
  }, [agentId]);

  const approvePermission = useCallback((toolUseId: string) => {
    wsRef.current?.send(JSON.stringify({
      type: "approve_permission",
      agentId,
      data: { toolUseId },
    }));
  }, [agentId]);

  const denyPermission = useCallback((toolUseId: string) => {
    wsRef.current?.send(JSON.stringify({
      type: "deny_permission",
      agentId,
      data: { toolUseId },
    }));
  }, [agentId]);

  return { events, isConnected, sendPrompt, approvePermission, denyPermission };
}
```

#### hooks/use-theme.ts

```typescript
import { useColorScheme } from "react-native";
import { useMemo } from "react";
import { useSettingsStore } from "../stores/settings-store";
import { darkTheme, lightTheme, type ThemeColors } from "../lib/theme";

export function useTheme(): { theme: ThemeColors; isDark: boolean } {
  const systemScheme = useColorScheme();
  const preference = useSettingsStore((s) => s.theme);

  return useMemo(() => {
    const isDark =
      preference === "auto"
        ? systemScheme === "dark"
        : preference === "dark";
    return { theme: isDark ? darkTheme : lightTheme, isDark };
  }, [systemScheme, preference]);
}
```

---

### Task 5: Root Layout & Core Screens

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/app/_layout.tsx` | Root layout with all providers |
| `packages/mobile/app/index.tsx` | Home screen -- daemon list |
| `packages/mobile/app/pair-scan.tsx` | QR pairing modal |
| `packages/mobile/app/settings.tsx` | App settings screen |

#### app/_layout.tsx

Following Paseo's provider nesting pattern:

```tsx
import { Stack } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { queryClient } from "../lib/query-client";
import { ThemeProvider } from "../lib/theme";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" options={{ title: "Saqr" }} />
              <Stack.Screen
                name="pair-scan"
                options={{ presentation: "modal", title: "Pair Daemon" }}
              />
              <Stack.Screen name="settings" options={{ title: "Settings" }} />
              <Stack.Screen name="h/[serverId]" />
            </Stack>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

#### app/index.tsx

Home screen showing list of connected daemons with status indicators and a "+" button to pair new daemons:

```tsx
import { View, FlatList, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useDaemonStore } from "../stores/daemon-store";
import { DaemonCard } from "../components/DaemonCard";
import { useTheme } from "../hooks/use-theme";

export default function HomeScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const daemons = useDaemonStore((s) => s.daemons);
  const connectionStates = useDaemonStore((s) => s.connectionStates);

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      {/* Header with title + settings gear + "+" button */}
      <FlatList
        data={daemons}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <DaemonCard
            host={item}
            connectionState={connectionStates[item.id] ?? "disconnected"}
            onPress={() => router.push(`/h/${item.id}`)}
          />
        )}
        ListEmptyComponent={/* Welcome / empty state with pair button */}
      />
      <Pressable onPress={() => router.push("/pair-scan")}>
        {/* FAB or header button to add daemon */}
      </Pressable>
    </View>
  );
}
```

#### app/pair-scan.tsx

QR scanning screen using `expo-camera`:

```tsx
import { CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useDaemonStore } from "../stores/daemon-store";

export default function PairScanScreen() {
  const router = useRouter();
  const pairFromQR = useDaemonStore((s) => s.pairFromQR);
  const [permission, requestPermission] = useCameraPermissions();
  const [manualInput, setManualInput] = useState("");
  const [scanned, setScanned] = useState(false);

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    const result = pairFromQR(data);
    if (result.success) {
      router.replace(`/h/${result.hostId}`);
    } else {
      // Show error, allow re-scan
      setScanned(false);
    }
  };

  // Render camera view or manual entry fallback
}
```

---

### Task 6: UI Components

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/components/DaemonCard.tsx` | Daemon list item with status dot, name, OS icon |
| `packages/mobile/components/AgentCard.tsx` | Agent list item with status, project, provider badge |
| `packages/mobile/components/AgentStream.tsx` | Scrollable event list for agent detail |
| `packages/mobile/components/PermissionPrompt.tsx` | Permission approve/deny card |
| `packages/mobile/components/PromptInput.tsx` | Multiline text input with send button + voice button |
| `packages/mobile/components/QRScanner.tsx` | Camera-based QR scanner component |
| `packages/mobile/components/SessionListItem.tsx` | Session history list item |
| `packages/mobile/components/VoicePanel.tsx` | Voice recording UI overlay |
| `packages/mobile/components/StatusDot.tsx` | Colored connection/agent status indicator |
| `packages/mobile/components/EmptyState.tsx` | Shared empty state component |

Each component receives data via props and uses the `useTheme()` hook for styling. No business logic inside components -- they are pure presentational. Business logic lives in stores and hooks.

Key component interfaces:

**DaemonCard**: Receives `HostProfile` + `ConnectionState`. Displays daemon name, hostname, OS icon, connection status dot, last seen time. Pressable -> navigates to `/h/[serverId]`.

**AgentCard**: Receives `AgentSummary`. Displays provider badge (Claude/OpenCode/Codex icon), project name, status badge, current activity preview, pending permission count. Pressable -> navigates to `/h/[serverId]/agent/[agentId]`.

**PermissionPrompt**: Receives `PermissionRequest` + approve/deny callbacks. Shows tool name, description, file path or command. Amber border. "Allow" / "Deny" / "Always Allow" buttons with haptic feedback.

**PromptInput**: Multiline `TextInput` with send button and microphone icon. Uses `react-native-keyboard-controller` for keyboard avoidance. Voice button toggles `VoicePanel`.

---

### Task 7: Server Screens (Per-Daemon)

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/app/h/[serverId]/_layout.tsx` | Server layout with header showing daemon name |
| `packages/mobile/app/h/[serverId]/index.tsx` | Server home -- agent list for this daemon |
| `packages/mobile/app/h/[serverId]/agents.tsx` | All agents on this daemon |
| `packages/mobile/app/h/[serverId]/settings.tsx` | Daemon-specific settings |

#### app/h/[serverId]/_layout.tsx

```tsx
import { Stack, useLocalSearchParams } from "expo-router";
import { useDaemonStore } from "../../../stores/daemon-store";

export default function ServerLayout() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const getDaemon = useDaemonStore((s) => s.getDaemon);
  const daemon = getDaemon(serverId);

  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{ title: daemon?.name ?? "Server" }}
      />
      <Stack.Screen name="agents" options={{ title: "Agents" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="agent/[agentId]" options={{ title: "Agent" }} />
    </Stack>
  );
}
```

#### app/h/[serverId]/index.tsx

Overview of this daemon -- connection status, running agents summary, quick actions (new agent, view all agents).

#### app/h/[serverId]/agents.tsx

Uses `useAgents(serverId, baseUrl)` React Query hook to fetch agent list from daemon. Renders `FlatList` of `AgentCard` components. Pull-to-refresh triggers refetch.

---

### Task 8: Agent Detail Screen

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/app/h/[serverId]/agent/[agentId].tsx` | Agent detail with stream, prompt input, permissions |

This is the most complex screen. It shows:
1. Header with agent status, model badge, token usage
2. Scrollable event stream (`AgentStream` component using `useAgentStream` hook)
3. Any pending `PermissionPrompt` cards
4. Bottom `PromptInput` for sending messages

```tsx
import { useLocalSearchParams } from "expo-router";
import { View, FlatList } from "react-native";
import { useAgentStream } from "../../../../hooks/use-agent-stream";
import { useDaemonStore } from "../../../../stores/daemon-store";
import { AgentStream } from "../../../../components/AgentStream";
import { PromptInput } from "../../../../components/PromptInput";
import { PermissionPrompt } from "../../../../components/PermissionPrompt";

export default function AgentDetailScreen() {
  const { serverId, agentId } = useLocalSearchParams<{
    serverId: string;
    agentId: string;
  }>();
  const daemon = useDaemonStore((s) => s.getDaemon(serverId));
  const wsUrl = daemon?.lanAddress
    ? `ws://${daemon.lanAddress}`
    : null;

  const { events, isConnected, sendPrompt, approvePermission, denyPermission } =
    useAgentStream(wsUrl, agentId);

  // Separate permission events from stream events
  const permissionEvents = events.filter(e => e.type === "permission_request");
  const streamEvents = events.filter(e => e.type !== "permission_request");

  return (
    <View style={{ flex: 1 }}>
      <AgentStream events={streamEvents} />
      {permissionEvents.map((perm) => (
        <PermissionPrompt
          key={perm.data.toolUseId as string}
          request={perm.data as any}
          onApprove={() => approvePermission(perm.data.toolUseId as string)}
          onDeny={() => denyPermission(perm.data.toolUseId as string)}
        />
      ))}
      <PromptInput onSend={sendPrompt} disabled={!isConnected} />
    </View>
  );
}
```

---

### Task 9: Push Notifications & Voice Integration

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/mobile/lib/notifications.ts` | Notification setup, permission, category registration |
| `packages/mobile/hooks/use-notifications.ts` | Hook to fire notifications from agent events |

#### Push Notifications

Uses `expo-notifications` to:
1. Register notification categories matching `NOTIFICATION_CATEGORIES` from `src/types/notification.ts`
2. Map `AgentStreamEvent` to notifications via `NotificationManager` from `src/services/notification-manager.ts`
3. Support action buttons (Approve/Deny) on permission request notifications

#### Voice Integration

The `VoiceInputManager` from `src/services/voice-input-manager.ts` is wrapped by `stores/voice-store.ts` and exposed via `hooks/use-voice-input.ts`. The `VoicePanel` component uses `expo-av` for recording and the voice store for state management.

---

### Task 10: Unit & Integration Tests

Target: bring total from 269 to 300+ tests.

#### New Test Files

| File | Tests | Description |
|------|-------|-------------|
| `src/__tests__/stores/daemon-store.test.ts` | ~10 | Zustand daemon store: add/remove/setActive, persist round-trip |
| `src/__tests__/stores/agent-store.test.ts` | ~8 | Agent store: setAgentsForHost, filter, sort, attention count |
| `src/__tests__/stores/settings-store.test.ts` | ~5 | Settings store: theme/notification persistence |
| `src/__tests__/hooks/use-agent-stream.test.ts` | ~6 | Agent stream hook: event accumulation, WebSocket mock |
| `src/__tests__/hooks/use-theme.test.ts` | ~4 | Theme hook: system preference respect, manual override |
| `src/__tests__/lib/api-client.test.ts` | ~6 | API client: retry on 500, timeout, network error |
| `src/__tests__/lib/storage.test.ts` | ~3 | Storage wrapper: get/set/remove round-trip |

Total new tests: ~42, bringing total to ~311.

Testing approach:
- **Stores**: Test Zustand stores by calling actions and asserting state. Mock AsyncStorage for persistence tests.
- **Hooks**: Test with vitest mocking WebSocket and React hooks. No JSDOM needed -- test the logic, not the rendering.
- **Components**: No component rendering tests in this story (would need React Native testing library). Integration tests via Maestro/Detox in Task 11.
- **Existing tests**: All 269 existing data layer tests must continue passing. The vitest config includes `src/**/*.test.ts` which automatically picks up new test files.

#### vitest.config.ts Update

The existing config at `/home/meywd/Saqr/packages/mobile/vitest.config.ts` already includes `src/**/*.test.ts`. No change needed as long as new test files go under `src/__tests__/`.

---

### Task 11: CI/CD GitHub Actions Workflows

#### Files to Create

| File | Purpose |
|------|---------|
| `.github/workflows/mobile-android.yml` | Android APK build |
| `.github/workflows/mobile-ios.yml` | iOS simulator build |
| `.github/workflows/mobile-web.yml` | Web export + Cloudflare Pages deploy |
| `.github/workflows/mobile-test.yml` | Run vitest on PR |

#### Android APK Workflow

```yaml
name: Mobile - Android APK
on:
  push:
    paths: ["packages/mobile/**"]
    branches: [main]
  workflow_dispatch:

jobs:
  build-android:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: cd packages/mobile && npx expo prebuild --platform android --clean
      - run: cd packages/mobile/android && ./gradlew assembleRelease
      - uses: actions/upload-artifact@v4
        with:
          name: saqr-android-apk
          path: packages/mobile/android/app/build/outputs/apk/release/*.apk
```

#### iOS Simulator Build Workflow

```yaml
name: Mobile - iOS Simulator
on:
  push:
    paths: ["packages/mobile/**"]
    branches: [main]
  workflow_dispatch:

jobs:
  build-ios:
    runs-on: macos-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: cd packages/mobile && npx expo prebuild --platform ios --clean
      - run: |
          cd packages/mobile/ios
          xcodebuild -workspace Saqr.xcworkspace -scheme Saqr \
            -sdk iphonesimulator -configuration Release \
            -derivedDataPath build
      - uses: actions/upload-artifact@v4
        with:
          name: saqr-ios-simulator
          path: packages/mobile/ios/build/Build/Products/Release-iphonesimulator/*.app
```

#### Web Export Workflow

```yaml
name: Mobile - Web Deploy
on:
  push:
    paths: ["packages/mobile/**"]
    branches: [main]
  workflow_dispatch:

jobs:
  deploy-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: cd packages/mobile && npx expo export --platform web
      - run: |
          cd packages/mobile
          npx wrangler pages deploy dist --project-name saqr-app
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## Complete File List

### Files to Create (38 files)

| # | Path | Purpose |
|---|------|---------|
| 1 | `packages/mobile/app.json` | Expo app configuration |
| 2 | `packages/mobile/app.config.js` | Dynamic Expo config |
| 3 | `packages/mobile/metro.config.js` | Metro bundler config for monorepo |
| 4 | `packages/mobile/babel.config.js` | Babel config for Expo |
| 5 | `packages/mobile/assets/icon.png` | App icon |
| 6 | `packages/mobile/assets/splash-icon.png` | Splash icon |
| 7 | `packages/mobile/assets/adaptive-icon.png` | Android adaptive icon |
| 8 | `packages/mobile/assets/favicon.png` | Web favicon |
| 9 | `packages/mobile/lib/theme.ts` | Theme colors and provider |
| 10 | `packages/mobile/lib/storage.ts` | AsyncStorage wrapper for Zustand |
| 11 | `packages/mobile/lib/api-client.ts` | HTTP client with retry |
| 12 | `packages/mobile/lib/query-client.ts` | React Query client singleton |
| 13 | `packages/mobile/lib/constants.ts` | Layout and timing constants |
| 14 | `packages/mobile/lib/notifications.ts` | Push notification setup |
| 15 | `packages/mobile/stores/daemon-store.ts` | Zustand daemon registry store |
| 16 | `packages/mobile/stores/agent-store.ts` | Zustand agent aggregation store |
| 17 | `packages/mobile/stores/session-store.ts` | Zustand session history store |
| 18 | `packages/mobile/stores/settings-store.ts` | Zustand app settings store |
| 19 | `packages/mobile/stores/voice-store.ts` | Zustand voice input store |
| 20 | `packages/mobile/hooks/use-daemon-connection.ts` | WebSocket connection hook |
| 21 | `packages/mobile/hooks/use-agent-stream.ts` | Real-time agent stream hook |
| 22 | `packages/mobile/hooks/use-agents.ts` | React Query agents hook |
| 23 | `packages/mobile/hooks/use-sessions.ts` | React Query sessions hook |
| 24 | `packages/mobile/hooks/use-usage.ts` | React Query usage hook |
| 25 | `packages/mobile/hooks/use-voice-input.ts` | Voice input state hook |
| 26 | `packages/mobile/hooks/use-theme.ts` | Theme hook |
| 27 | `packages/mobile/hooks/use-notifications.ts` | Notification dispatch hook |
| 28 | `packages/mobile/app/_layout.tsx` | Root layout with providers |
| 29 | `packages/mobile/app/index.tsx` | Home -- daemon list |
| 30 | `packages/mobile/app/pair-scan.tsx` | QR pairing modal |
| 31 | `packages/mobile/app/settings.tsx` | App settings |
| 32 | `packages/mobile/app/h/[serverId]/_layout.tsx` | Server layout |
| 33 | `packages/mobile/app/h/[serverId]/index.tsx` | Server home |
| 34 | `packages/mobile/app/h/[serverId]/agents.tsx` | Agent list |
| 35 | `packages/mobile/app/h/[serverId]/agent/[agentId].tsx` | Agent detail |
| 36 | `packages/mobile/app/h/[serverId]/settings.tsx` | Server settings |
| 37 | `packages/mobile/components/DaemonCard.tsx` | Daemon list item |
| 38 | `packages/mobile/components/AgentCard.tsx` | Agent list item |
| 39 | `packages/mobile/components/AgentStream.tsx` | Event stream display |
| 40 | `packages/mobile/components/PermissionPrompt.tsx` | Permission approve/deny |
| 41 | `packages/mobile/components/PromptInput.tsx` | Message input |
| 42 | `packages/mobile/components/QRScanner.tsx` | QR scanner |
| 43 | `packages/mobile/components/SessionListItem.tsx` | Session list item |
| 44 | `packages/mobile/components/VoicePanel.tsx` | Voice recording UI |
| 45 | `packages/mobile/components/StatusDot.tsx` | Status indicator |
| 46 | `packages/mobile/components/EmptyState.tsx` | Empty state |

### Files to Modify (2 files)

| # | Path | Change |
|---|------|--------|
| 1 | `packages/mobile/package.json` | Add all Expo/RN dependencies, update main/scripts |
| 2 | `packages/mobile/tsconfig.json` | Switch to `expo/tsconfig.base`, add path aliases |

### Test Files to Create (7 files)

| # | Path | Est. Tests |
|---|------|------------|
| 1 | `packages/mobile/src/__tests__/stores/daemon-store.test.ts` | ~10 |
| 2 | `packages/mobile/src/__tests__/stores/agent-store.test.ts` | ~8 |
| 3 | `packages/mobile/src/__tests__/stores/settings-store.test.ts` | ~5 |
| 4 | `packages/mobile/src/__tests__/hooks/use-agent-stream.test.ts` | ~6 |
| 5 | `packages/mobile/src/__tests__/hooks/use-theme.test.ts` | ~4 |
| 6 | `packages/mobile/src/__tests__/lib/api-client.test.ts` | ~6 |
| 7 | `packages/mobile/src/__tests__/lib/storage.test.ts` | ~3 |

### CI/CD Files to Create (4 files)

| # | Path | Purpose |
|---|------|---------|
| 1 | `.github/workflows/mobile-android.yml` | Android APK build |
| 2 | `.github/workflows/mobile-ios.yml` | iOS simulator build |
| 3 | `.github/workflows/mobile-web.yml` | Web export + Cloudflare Pages deploy |
| 4 | `.github/workflows/mobile-test.yml` | Run vitest on PR |

---

## Implementation Order

1. **Task 1** (Build Config) -- must be first, makes the project bootable
2. **Task 2** (Theme + Lib) -- foundational utilities all other code depends on
3. **Task 3** (Zustand Stores) -- bridges data layer to React, needed by all screens
4. **Task 4** (React Query Hooks) -- server state management
5. **Task 6** (UI Components) -- reusable components for screens
6. **Task 5** (Root Layout + Core Screens) -- app shell with home, pairing, settings
7. **Task 7** (Server Screens) -- per-daemon navigation
8. **Task 8** (Agent Detail) -- most complex screen
9. **Task 9** (Notifications + Voice) -- enhancement features
10. **Task 10** (Tests) -- can run in parallel with Tasks 5-9
11. **Task 11** (CI/CD) -- can run in parallel with Tasks 5-9

---

## Key Design Decisions

1. **Preserve existing data layer**: All Story 08 code under `src/` remains untouched. New Expo code imports from it. The vitest config continues to find tests under `src/__tests__/`.

2. **tsconfig change**: The current `tsconfig.json` extends the root monorepo config with `module: "NodeNext"`. Expo requires its own base config (`expo/tsconfig.base`). This is a breaking change for the library build but acceptable since the mobile package is `"private": true` and consumed only by the Expo bundler.

3. **Route structure matches Paseo**: Using `app/h/[serverId]/agent/[agentId].tsx` -- identical to Paseo's pattern. This enables future code sharing and makes the codebase familiar to Paseo contributors.

4. **Zustand over Context**: Following Paseo's pattern of Zustand for client state. Stores wrap the existing service classes (DaemonRegistry, AgentDataAggregator, etc.) rather than reimplementing their logic.

5. **React Query for server state**: Agent lists, session history, and usage data are fetched from daemon HTTP APIs using React Query with automatic refetch intervals. WebSocket streams are separate (handled by custom hooks).

6. **No unistyles**: Paseo uses `react-native-unistyles` for theming. We use a simpler approach (ThemeContext + `useTheme()` hook) to reduce complexity. Can be upgraded later.

7. **Tests stay in vitest**: UI component tests would ideally use React Native Testing Library, but for this story we test stores, hooks, and utility functions with vitest (matching the existing pattern). Visual/integration tests use Maestro in CI.

---

### Critical Files for Implementation
- `/home/meywd/Saqr/packages/mobile/package.json` - Must be modified to add all Expo/RN dependencies and update scripts/main entry
- `/home/meywd/Saqr/packages/mobile/tsconfig.json` - Must switch from NodeNext to expo/tsconfig.base for Metro bundler compatibility
- `/home/meywd/Saqr/packages/mobile/src/services/connection-manager.ts` - Core data layer service that stores/hooks wrap for WebSocket connectivity
- `/home/meywd/Saqr/packages/mobile/src/services/daemon-registry.ts` - Core data layer service that the daemon-store wraps for QR pairing and host management
- `/home/meywd/Saqr/packages/mobile/src/types/agent.ts` - Defines AgentSummary, AgentStreamEvent, PermissionRequest types consumed by all agent-related screens and components
