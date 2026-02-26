# Implementation Plan: Story 19 -- Web Application (Hosted)

**Date**: 2026-02-25
**Story**: 19-web-app
**Status**: Planning
**Estimated Total Effort**: ~14-18 days (112-144 hours)
**Prerequisites**: Story 11 (Sync Server) -- auth API + sync endpoints. Story 07 (Encrypted Sync) -- client-side crypto patterns. Story 12 (Security) -- key management. Story 01 (Session Attach) -- PTY streaming via relay. Story 02 (CLI Rendering) -- timeline item types.

---

### Relationship to Existing Code

The web app is a new `packages/web` React SPA that consumes existing server APIs and mirrors data models from the mobile and sync-client packages:

- **`@saqr/shared`** (`packages/shared/src/events/types.ts`): 12 unified event types (`TypedEvent` discriminated union) used for session timeline rendering.
- **`@saqr/shared`** (`packages/shared/src/crypto/types.ts`): `MasterKey`, `EncryptionResult`, `KeyDerivationParams` -- crypto type definitions shared across all clients.
- **`packages/sync-server/src/types.ts`**: Auth types (`RegisterRequest`, `LoginRequest`, `AuthTokenResponse`), sync types (`PushRequest`, `PullResponse`), account types (`AccountInfo`, `DeleteAccountRequest`), machine types (`MachineInfo`), tier types (`Tier`, `TierLimits`).
- **`packages/sync-client/src/encryption.ts`**: `EncryptionManager` -- XChaCha20-Poly1305 via libsodium. Must be ported to browser (replace `createRequire` with direct ESM import of `libsodium-wrappers`).
- **`packages/sync-client/src/key-manager.ts`**: `KeyManager`, `RecoveryBlob` -- passphrase-based key recovery via Argon2id. The web version replaces filesystem storage with IndexedDB + Web Crypto API.
- **`packages/mobile/src/types/agent.ts`**: `AgentSummary`, `AgentStatus`, `TokenUsage`, `PermissionRequest` -- agent view models to mirror in the web app.
- **`packages/mobile/src/types/session.ts`**: `SessionSummary`, `SessionFilter`, `SessionEvent`, `SessionEventsPage` -- session history types to reuse.
- **`packages/mobile/src/types/daemon.ts`**: `HostProfile`, `ConnectionState` -- daemon/machine types for relay connections.
- **`packages/mobile/src/types/usage.ts`**: `UsageStats`, `DailyUsage`, `ProjectUsage` -- usage analytics types.

The web app does NOT import from `@saqr/mobile` at runtime. Instead it re-exports or mirrors the relevant types, since mobile depends on React Native primitives. The web app DOES import from `@saqr/shared` for event types and crypto types.

### Architecture Overview

```
Browser
  |
  +-- React SPA (Vite + React 19 + React Router 7)
  |     |
  |     +-- Zustand stores (auth, agents, sessions, keys, connections)
  |     +-- TanStack React Query (server state caching)
  |     +-- xterm.js (terminal rendering for managed sessions)
  |     +-- libsodium-wrappers (WASM, client-side E2EE)
  |     +-- IndexedDB + Web Crypto API (key storage)
  |
  +-- Sync Server (Cloudflare Workers)
  |     |
  |     +-- /api/auth/* (register, login, reset)
  |     +-- /api/sync/* (push, pull, machines)
  |     +-- /api/account/* (profile, delete, export)
  |     +-- /api/billing/* (Stripe session creation)
  |
  +-- E2EE Relay WebSocket
        |
        +-- Daemon connection (live agent state, PTY streaming)
```

Deployed to **Cloudflare Pages** via `wrangler pages deploy`. No server-side rendering -- pure client SPA with `_redirects` for client-side routing.

---

## Task Dependency Graph

```
Task 1: Package Scaffolding (Vite, React, Tailwind, tsconfig, package.json)
  |
  +---> Task 2: Core Libraries (api-client, crypto, key-storage, relay-client, stripe)
  |       |
  |       +---> Task 3: Zustand Stores (auth, agents, sessions, keys, connections)
  |       |       |
  |       |       +---> Task 5: Auth Pages (login, register, forgot/reset password, email verify)
  |       |       |       |
  |       |       |       +---> Task 6: Dashboard & Account Pages (overview, machines, usage, settings)
  |       |       |       |       |
  |       |       |       |       +---> Task 9: Billing Pages (plan, upgrade, Stripe redirect)
  |       |       |       |
  |       |       |       +---> Task 7: Agent Pages (list, detail, terminal, structured, permissions)
  |       |       |       |       |
  |       |       |       |       +---> Task 8: Session History Pages (list, search, detail, diff viewer)
  |       |       |
  |       |       +---> Task 4: React Hooks + TanStack Query (use-auth, use-agents, use-sessions, use-relay, use-terminal)
  |       |
  |       +---> Task 10: Encryption Key Import Page (passphrase + QR scan)
  |
  +---> Task 11: Tests (42+ unit/integration tests)
  |
  +---> Task 12: CI/CD Deployment (Cloudflare Pages via GitHub Actions)
```

---

## Tasks

### Task 1: Package Scaffolding

Create the `packages/web` package with Vite + React 19 + TypeScript + Tailwind CSS.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/package.json` | Package manifest with all dependencies |
| `packages/web/tsconfig.json` | TypeScript config (strict, ESNext, paths) |
| `packages/web/vite.config.ts` | Vite config with React plugin, path aliases |
| `packages/web/tailwind.config.ts` | Tailwind CSS config with dark mode, custom theme |
| `packages/web/postcss.config.js` | PostCSS config for Tailwind |
| `packages/web/index.html` | HTML entry point |
| `packages/web/src/main.tsx` | React entry point |
| `packages/web/src/router.tsx` | React Router config with all routes |
| `packages/web/src/globals.css` | Tailwind directives + base styles |
| `packages/web/public/favicon.svg` | Saqr favicon |
| `packages/web/public/_redirects` | Cloudflare Pages SPA redirect rule |
| `packages/web/vitest.config.ts` | Vitest config for unit tests |

#### package.json

```json
{
  "name": "@saqr/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "typecheck": "tsc --noEmit",
    "deploy": "wrangler pages deploy dist --project-name saqr-web"
  },
  "dependencies": {
    "@saqr/shared": "workspace:*",
    "@stripe/stripe-js": "^4.0.0",
    "@tanstack/react-query": "^5.90.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "@xterm/addon-search": "^0.15.0",
    "libsodium-wrappers": "^0.7.15",
    "lucide-react": "^0.460.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^7.0.0",
    "zustand": "^5.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/libsodium-wrappers": "^0.7.14",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "~5.9.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0",
    "wrangler": "^3.90.0"
  }
}
```

#### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

#### vite.config.ts

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ["libsodium-wrappers"],
  },
});
```

#### tailwind.config.ts

Dark mode via `class` strategy. Custom color tokens matching the mobile theme from Story 16.

```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        saqr: {
          primary: "var(--color-primary)",
          surface: "var(--color-surface)",
          "surface-elevated": "var(--color-surface-elevated)",
          foreground: "var(--color-foreground)",
          muted: "var(--color-muted)",
          border: "var(--color-border)",
          destructive: "var(--color-destructive)",
          success: "var(--color-success)",
          warning: "var(--color-warning)",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
```

#### src/router.tsx

```tsx
import { createBrowserRouter } from "react-router";

export const router = createBrowserRouter([
  {
    path: "/",
    lazy: () => import("./pages/auth/login"),
  },
  {
    path: "/auth",
    children: [
      { path: "login", lazy: () => import("./pages/auth/login") },
      { path: "register", lazy: () => import("./pages/auth/register") },
      { path: "forgot-password", lazy: () => import("./pages/auth/forgot-password") },
      { path: "reset-password", lazy: () => import("./pages/auth/reset-password") },
    ],
  },
  {
    path: "/app",
    lazy: () => import("./components/layout/app-shell"),
    children: [
      { index: true, lazy: () => import("./pages/dashboard/index") },
      { path: "machines", lazy: () => import("./pages/dashboard/machines") },
      { path: "usage", lazy: () => import("./pages/dashboard/usage") },
      { path: "settings", lazy: () => import("./pages/dashboard/settings") },
      { path: "agents", lazy: () => import("./pages/agents/index") },
      { path: "agents/:agentId", lazy: () => import("./pages/agents/[agentId]") },
      { path: "sessions", lazy: () => import("./pages/sessions/index") },
      { path: "sessions/:sessionId", lazy: () => import("./pages/sessions/[sessionId]") },
      { path: "billing", lazy: () => import("./pages/billing/index") },
      { path: "billing/upgrade", lazy: () => import("./pages/billing/upgrade") },
      { path: "setup/import-key", lazy: () => import("./pages/setup/import-key") },
    ],
  },
]);
```

#### public/_redirects

```
/*  /index.html  200
```

This ensures Cloudflare Pages serves `index.html` for all client-side routes.

---

### Task 2: Core Libraries

Implement the foundational library modules in `src/lib/`. These are pure TypeScript modules with no React dependencies -- they handle API communication, cryptography, key storage, relay WebSocket, and Stripe.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/lib/api-client.ts` | Sync server REST client (auth, sync, account, billing) |
| `packages/web/src/lib/crypto.ts` | Browser-compatible encryption (XChaCha20-Poly1305 via libsodium-wrappers) |
| `packages/web/src/lib/key-storage.ts` | IndexedDB key store with Web Crypto AES-GCM wrapping |
| `packages/web/src/lib/relay-client.ts` | E2EE relay WebSocket client for daemon communication |
| `packages/web/src/lib/stripe.ts` | Stripe.js redirect helper for checkout |
| `packages/web/src/lib/query-client.ts` | TanStack React Query client singleton |

#### lib/api-client.ts

HTTP client wrapping `fetch` for all sync server endpoints. Handles JWT token attachment, refresh, and error mapping.

```typescript
import type {
  RegisterRequest,
  LoginRequest,
  AuthTokenResponse,
  AccountInfo,
  MachineInfo,
  PullResponse,
  Tier,
} from "@saqr/shared"; // re-exported or mirrored types

export interface ApiClientConfig {
  baseUrl: string;
  getAccessToken: () => string | null;
  onTokenExpired: () => void;
}

export class ApiClient {
  constructor(private config: ApiClientConfig) {}

  // Auth endpoints
  async register(req: RegisterRequest): Promise<AuthTokenResponse> { /* ... */ }
  async login(req: LoginRequest): Promise<AuthTokenResponse> { /* ... */ }
  async forgotPassword(email: string): Promise<void> { /* ... */ }
  async resetPassword(token: string, password: string): Promise<void> { /* ... */ }
  async verifyEmail(token: string): Promise<void> { /* ... */ }

  // Account endpoints
  async getAccount(): Promise<AccountInfo> { /* ... */ }
  async deleteAccount(confirmation: string): Promise<void> { /* ... */ }
  async exportData(): Promise<Blob> { /* ... */ }

  // Machine endpoints
  async getMachines(): Promise<MachineInfo[]> { /* ... */ }

  // Sync endpoints
  async pull(machineId: string, cursor: string | null): Promise<PullResponse> { /* ... */ }

  // Billing endpoints
  async createCheckoutSession(tier: Tier): Promise<{ url: string }> { /* ... */ }

  // Recovery key endpoint
  async getRecoveryBlob(): Promise<RecoveryBlob | null> { /* ... */ }

  // Internal
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.config.getAccessToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      this.config.onTokenExpired();
      throw new ApiError("Token expired", 401);
    }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new ApiError(errorBody.message ?? response.statusText, response.status);
    }
    return response.json() as Promise<T>;
  }
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}
```

#### lib/crypto.ts

Browser-compatible port of `packages/sync-client/src/encryption.ts`. Key differences from the Node.js version:

1. Uses `import sodium from "libsodium-wrappers"` (ESM, no `createRequire`)
2. No filesystem operations -- key bytes provided externally
3. Same XChaCha20-Poly1305 encrypt/decrypt + Argon2id key derivation

```typescript
import sodium from "libsodium-wrappers";
import type { MasterKey, EncryptionResult } from "@saqr/shared";

export class WebEncryptionManager {
  private _masterKey: Uint8Array | null = null;
  private _keyId: string | null = null;
  private _initialized = false;

  async init(): Promise<void> {
    await sodium.ready;
    this._initialized = true;
  }

  // Same API as sync-client's EncryptionManager:
  setMasterKey(keyBytes: Uint8Array): void { /* validate 32 bytes, set */ }
  getKeyId(): string { /* return _keyId */ }
  async generateMasterKey(): Promise<MasterKey> { /* keygen */ }
  async deriveKeyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    // Argon2id: opslimit=3, memlimit=64MB, ALG_ARGON2ID13
  }
  async encrypt(plaintext: Uint8Array, key?: Uint8Array): Promise<EncryptionResult> { /* xchacha20 */ }
  async decrypt(ciphertext: Uint8Array, nonce: Uint8Array, key?: Uint8Array): Promise<Uint8Array> { /* xchacha20 */ }
  async encryptString(text: string, key?: Uint8Array): Promise<EncryptionResult> { /* convenience */ }
  async decryptToString(ciphertext: Uint8Array, nonce: Uint8Array, key?: Uint8Array): Promise<string> { /* convenience */ }

  // Utility
  fromBase64(b64: string): Uint8Array { return sodium.from_base64(b64); }
  toBase64(data: Uint8Array): string { return sodium.to_base64(data); }
}
```

#### lib/key-storage.ts

Stores the master key in IndexedDB, wrapped with a non-extractable AES-GCM CryptoKey derived from a device-specific secret via Web Crypto API. This prevents key extraction from DevTools.

```typescript
export interface StoredKey {
  wrappedKey: ArrayBuffer;    // AES-GCM encrypted master key
  iv: Uint8Array;             // AES-GCM IV
  keyId: string;              // Key identifier
  createdAt: string;          // ISO 8601
  locked: boolean;            // If true, passphrase re-entry needed
}

export class KeyStorage {
  private dbName = "saqr-keys";
  private storeName = "master-keys";

  /** Open or create the IndexedDB database */
  private async openDb(): Promise<IDBDatabase> { /* ... */ }

  /** Generate a non-extractable AES-GCM wrapping key via Web Crypto */
  private async getWrappingKey(): Promise<CryptoKey> {
    // Derive from a stable device fingerprint + user password hash
    // Using PBKDF2 with Web Crypto API
  }

  /** Store the master key, wrapped with AES-GCM */
  async storeKey(masterKeyBytes: Uint8Array, keyId: string): Promise<void> {
    const wrappingKey = await this.getWrappingKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedKey = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      wrappingKey,
      masterKeyBytes
    );
    // Store { wrappedKey, iv, keyId, createdAt, locked: false } in IndexedDB
  }

  /** Retrieve and unwrap the master key */
  async retrieveKey(): Promise<{ keyBytes: Uint8Array; keyId: string } | null> { /* ... */ }

  /** Clear all stored keys (logout with clear) */
  async clearKeys(): Promise<void> { /* ... */ }

  /** Lock the key (require passphrase re-entry) */
  async lockKey(): Promise<void> { /* ... */ }

  /** Check if a key exists */
  async hasKey(): Promise<boolean> { /* ... */ }
}
```

#### lib/relay-client.ts

WebSocket client that connects to the E2EE relay server for live daemon communication. Messages are encrypted/decrypted using the master key.

```typescript
export type RelayMessageType =
  | "agent_list"
  | "agent_update"
  | "agent_stream"
  | "permission_request"
  | "permission_response"
  | "prompt"
  | "pty_output"
  | "pty_input"
  | "pty_resize";

export interface RelayMessage {
  type: RelayMessageType;
  machineId: string;
  agentId?: string;
  data: unknown;
  timestamp: string;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export class RelayClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(msg: RelayMessage) => void>> = new Map();
  private _status: ConnectionStatus = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private relayUrl: string,
    private accessToken: string,
    private machineId: string,
  ) {}

  get status(): ConnectionStatus { return this._status; }

  connect(): void {
    // WebSocket to relay with JWT auth in protocol header
    // Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
  }

  disconnect(): void { /* close + clear timer */ }

  send(type: RelayMessageType, data: unknown, agentId?: string): void {
    // Serialize and send through WebSocket
  }

  on(type: RelayMessageType, handler: (msg: RelayMessage) => void): () => void {
    // Subscribe to message type, return unsubscribe function
  }

  onStatusChange(handler: (status: ConnectionStatus) => void): () => void { /* ... */ }
}
```

#### lib/stripe.ts

```typescript
import { loadStripe } from "@stripe/stripe-js";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

export async function redirectToCheckout(sessionId: string): Promise<void> {
  const stripe = await stripePromise;
  if (!stripe) throw new Error("Stripe failed to load");
  const { error } = await stripe.redirectToCheckout({ sessionId });
  if (error) throw new Error(error.message);
}
```

#### lib/query-client.ts

```typescript
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,       // 30 seconds
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
});
```

---

### Task 3: Zustand Stores

Create Zustand stores that manage client-side state. Each store handles a distinct domain. Stores use `persist` middleware where appropriate (auth tokens persist; ephemeral agent state does not).

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/stores/auth-store.ts` | JWT tokens, user info, login/logout actions |
| `packages/web/src/stores/agent-store.ts` | Agent state across all connected machines |
| `packages/web/src/stores/session-store.ts` | Session history cache and search state |
| `packages/web/src/stores/key-store.ts` | Encryption key state (has key, locked, key ID) |
| `packages/web/src/stores/connection-store.ts` | Relay WebSocket connection state per machine |

#### stores/auth-store.ts

```typescript
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Tier } from "@saqr/shared";

interface UserInfo {
  userId: string;
  email: string;
  tier: Tier;
}

interface AuthState {
  accessToken: string | null;
  user: UserInfo | null;
  isAuthenticated: boolean;

  setAuth: (token: string, user: UserInfo) => void;
  clearAuth: () => void;
  updateTier: (tier: Tier) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      user: null,
      isAuthenticated: false,

      setAuth: (token, user) =>
        set({ accessToken: token, user, isAuthenticated: true }),

      clearAuth: () =>
        set({ accessToken: null, user: null, isAuthenticated: false }),

      updateTier: (tier) =>
        set((state) => ({
          user: state.user ? { ...state.user, tier } : null,
        })),
    }),
    {
      name: "saqr-auth",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        accessToken: state.accessToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
```

#### stores/agent-store.ts

Mirrors the mobile `AgentDataAggregator` pattern but as a flat Zustand store. Agents from all machines are merged into a single list, grouped by machine.

```typescript
import { create } from "zustand";

// Mirrors mobile's AgentSummary, AgentStatus, TokenUsage
interface AgentSummary {
  id: string;
  hostId: string;
  hostName: string;
  provider: "claude-code" | "opencode" | "codex";
  model: string;
  status: AgentStatus;
  projectName: string;
  projectPath: string;
  currentActivity?: string;
  lastPrompt?: string;
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  tokenUsage: TokenUsage;
  pendingPermissions: number;
}

type AgentStatus = "initializing" | "idle" | "running" | "waiting_permission" | "error" | "completed" | "disconnected";

interface AgentState {
  agents: AgentSummary[];
  selectedAgentId: string | null;

  setAgentsForMachine: (machineId: string, agents: AgentSummary[]) => void;
  updateAgent: (machineId: string, agentId: string, updates: Partial<AgentSummary>) => void;
  markMachineDisconnected: (machineId: string) => void;
  selectAgent: (agentId: string | null) => void;

  getAgentsByMachine: () => Map<string, AgentSummary[]>;
  getAttentionCount: () => number;
}
```

#### stores/session-store.ts

```typescript
interface SessionState {
  sessions: SessionSummary[];
  filter: SessionFilter;
  searchQuery: string;
  isLoading: boolean;

  setSessions: (sessions: SessionSummary[]) => void;
  appendSessions: (sessions: SessionSummary[]) => void;
  setFilter: (filter: Partial<SessionFilter>) => void;
  setSearchQuery: (query: string) => void;
  getFilteredSessions: () => SessionSummary[];
}
```

#### stores/key-store.ts

```typescript
interface KeyState {
  hasKey: boolean;
  keyId: string | null;
  isLocked: boolean;
  isLoading: boolean;

  checkKeyExists: () => Promise<void>;
  importFromPassphrase: (passphrase: string, recoveryBlob: RecoveryBlob) => Promise<void>;
  lock: () => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  clearKeys: () => Promise<void>;
}
```

#### stores/connection-store.ts

```typescript
interface ConnectionState {
  connections: Record<string, {
    status: "disconnected" | "connecting" | "connected" | "error";
    lastConnectedAt: string | null;
    error: string | null;
  }>;

  connect: (machineId: string) => void;
  disconnect: (machineId: string) => void;
  disconnectAll: () => void;
  updateStatus: (machineId: string, status: string, error?: string) => void;
}
```

---

### Task 4: React Hooks + TanStack Query

Create React hooks that bridge Zustand stores, TanStack Query, and the core libraries into composable units for pages.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/hooks/use-auth.ts` | Auth flow: login, register, logout, password reset |
| `packages/web/src/hooks/use-agents.ts` | Agent list + real-time updates via relay |
| `packages/web/src/hooks/use-sessions.ts` | Session history with search, pagination |
| `packages/web/src/hooks/use-relay.ts` | Relay WebSocket lifecycle management |
| `packages/web/src/hooks/use-terminal.ts` | xterm.js instance management |
| `packages/web/src/hooks/use-theme.ts` | Dark/light theme with system preference |

#### hooks/use-auth.ts

```typescript
export function useAuth() {
  const { accessToken, user, isAuthenticated, setAuth, clearAuth } = useAuthStore();
  const apiClient = useApiClient();
  const navigate = useNavigate();

  const loginMutation = useMutation({
    mutationFn: (req: LoginRequest) => apiClient.login(req),
    onSuccess: (data) => {
      setAuth(data.access_token, data.user);
      navigate("/app");
    },
  });

  const registerMutation = useMutation({
    mutationFn: (req: RegisterRequest) => apiClient.register(req),
    onSuccess: () => navigate("/auth/login?registered=true"),
  });

  const logout = () => {
    clearAuth();
    navigate("/auth/login");
  };

  return { user, isAuthenticated, login: loginMutation, register: registerMutation, logout };
}
```

#### hooks/use-agents.ts

```typescript
export function useAgents(machineId?: string) {
  const relay = useRelayConnection();
  const store = useAgentStore();

  // Subscribe to relay agent_list and agent_update messages
  useEffect(() => {
    if (!relay) return;
    const unsubList = relay.on("agent_list", (msg) => {
      store.setAgentsForMachine(msg.machineId, msg.data as AgentSummary[]);
    });
    const unsubUpdate = relay.on("agent_update", (msg) => {
      store.updateAgent(msg.machineId, msg.agentId!, msg.data as Partial<AgentSummary>);
    });
    return () => { unsubList(); unsubUpdate(); };
  }, [relay]);

  const agents = machineId
    ? store.agents.filter((a) => a.hostId === machineId)
    : store.agents;

  return { agents, attentionCount: store.getAttentionCount() };
}
```

#### hooks/use-terminal.ts

```typescript
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement>,
  relayClient: RelayClient | null,
  agentId: string,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 14,
      theme: { background: "#1a1a2e", foreground: "#e0e0e0" },
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    // Forward user input to relay
    terminal.onData((data) => {
      relayClient?.send("pty_input", { input: data }, agentId);
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(containerRef.current);

    terminal.onResize(({ cols, rows }) => {
      relayClient?.send("pty_resize", { cols, rows }, agentId);
    });

    // Receive PTY output from relay
    const unsub = relayClient?.on("pty_output", (msg) => {
      if (msg.agentId === agentId) {
        terminal.write(msg.data as string);
      }
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    return () => {
      unsub?.();
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [containerRef, relayClient, agentId]);

  const search = (query: string) => searchAddonRef.current?.findNext(query);

  return { terminal: terminalRef, search };
}
```

#### hooks/use-theme.ts

```typescript
export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");

  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = () => {
      const isDark = theme === "dark" || (theme === "system" && mq.matches);
      root.classList.toggle("dark", isDark);
    };

    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return { theme, setTheme };
}
```

---

### Task 5: Auth Pages

Implement the authentication flow pages: login, register, forgot password, reset password.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/pages/auth/login.tsx` | Email + password login form |
| `packages/web/src/pages/auth/register.tsx` | Registration with password strength meter |
| `packages/web/src/pages/auth/forgot-password.tsx` | Password reset request |
| `packages/web/src/pages/auth/reset-password.tsx` | New password entry with token |

#### pages/auth/login.tsx

- Email + password form with Zod validation
- "Remember me" checkbox (switches `sessionStorage` to `localStorage` for auth store)
- Error display for invalid credentials
- Rate limit messaging after 5 failed attempts (from server 429 response)
- Link to register and forgot-password
- On success: `useAuth().login.mutate()` -> redirect to `/app`
- Responsive: centered card on desktop, full-width on mobile

#### pages/auth/register.tsx

- Email + password + confirm password form
- Password strength meter (min 10 chars, must contain uppercase + number)
- Terms of service + privacy policy checkboxes (required)
- Zod schema validation:
  ```typescript
  const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(10).regex(/[A-Z]/).regex(/[0-9]/),
    confirmPassword: z.string(),
    acceptTerms: z.literal(true),
  }).refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
  ```
- On success: redirect to "check your email" interstitial

#### pages/auth/forgot-password.tsx

- Email input form
- POST `/api/auth/forgot-password`
- Success state: "If an account exists, we sent a reset link" (no email enumeration)

#### pages/auth/reset-password.tsx

- Token from URL query param
- New password + confirm password form
- Same strength requirements as register
- On success: auto-login and redirect to `/app`

---

### Task 6: Dashboard & Account Pages

Implement the main dashboard (account overview) and supporting account management pages.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/pages/dashboard/index.tsx` | Account overview: tier, usage summary, recent activity |
| `packages/web/src/pages/dashboard/machines.tsx` | Registered machines list with status |
| `packages/web/src/pages/dashboard/usage.tsx` | Usage analytics with charts |
| `packages/web/src/pages/dashboard/settings.tsx` | Account settings, data export, delete |
| `packages/web/src/components/layout/app-shell.tsx` | Sidebar + header + content layout |
| `packages/web/src/components/layout/sidebar.tsx` | Navigation sidebar with route links |
| `packages/web/src/components/layout/header.tsx` | Top bar with user menu + theme toggle |
| `packages/web/src/components/common/loading.tsx` | Loading spinner/skeleton states |
| `packages/web/src/components/common/error-boundary.tsx` | React error boundary wrapper |

#### components/layout/app-shell.tsx

Three-panel responsive layout matching the story's breakpoint table:

| Breakpoint | Layout |
|------------|--------|
| < 768px | Single column, bottom nav, hamburger menu |
| 768-1024px | Two-panel: collapsed sidebar + content |
| > 1024px | Three-panel: sidebar + list + detail |

```tsx
export function AppShell() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated) navigate("/auth/login");
  }, [isAuthenticated]);

  return (
    <div className="flex h-screen bg-saqr-surface text-saqr-foreground">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Header />
        <div className="p-4 md:p-6 lg:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
```

#### pages/dashboard/index.tsx

- Account overview card: email, tier badge, member since
- Usage summary bars: machines used/limit, storage used/limit
- Quick actions: "View Agents", "Import Key", "Upgrade Plan"
- Recent sessions list (last 5)

#### pages/dashboard/machines.tsx

- Fetch machines via `useQuery({ queryKey: ["machines"], queryFn: () => apiClient.getMachines() })`
- List of `MachineInfo` cards showing: name, hostname, OS, last seen, active status
- Connection status dot (green=online via relay, grey=offline)
- "Connect" button triggers relay connection

#### pages/dashboard/usage.tsx

- Date range selector with presets (This Week, This Month, Last 3 Months, Custom)
- Usage breakdown mirroring `UsageStats` type: total tokens, cost, by-day chart, by-project table
- Uses `<canvas>` or simple bar chart (no heavy chart library -- can use CSS-based bars)

#### pages/dashboard/settings.tsx

- Edit display name
- Change password (current + new + confirm)
- Notification preferences toggles
- **Data Export**: button -> triggers server export -> downloads `.json.enc` -> client-side decrypt with master key -> save as `.json`
- **Delete Account**: "Delete My Account" button -> confirmation modal -> type "DELETE" -> POST `/api/account/delete` with `{ confirmation: "DELETE" }` -> crypto-shred -> redirect to login

---

### Task 7: Agent Pages

Implement the agent list and agent detail pages with dual view mode (terminal + structured).

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/pages/agents/index.tsx` | Agent list across all machines |
| `packages/web/src/pages/agents/[agentId].tsx` | Agent detail with terminal/structured view |
| `packages/web/src/components/agents/agent-card.tsx` | Agent summary card |
| `packages/web/src/components/agents/agent-status.tsx` | Live status badge with color |
| `packages/web/src/components/agents/permission-modal.tsx` | Approve/deny permission modal |
| `packages/web/src/components/terminal/terminal-view.tsx` | xterm.js wrapper component |
| `packages/web/src/components/terminal/structured-view.tsx` | Card-based timeline for observed sessions |

#### pages/agents/index.tsx

- Agent list grouped by machine (collapsible sections)
- Sort by: last activity, machine, status, project
- Filter by: machine, provider, status
- Live status badges via relay WebSocket:
  - Running: green pulse animation
  - Idle: grey
  - Error: red
  - Waiting permission: amber with count badge
- Click agent card -> navigate to `/app/agents/:agentId`

#### pages/agents/[agentId].tsx

Agent detail page with dual view mode:

- **Header**: agent provider badge, model, project name, status, token usage summary
- **View toggle**: Structured (default) / Terminal -- keyboard shortcut Ctrl+T
- **Structured view** (`structured-view.tsx`): renders `TypedEvent` discriminated union as cards:
  - `SessionStarted`: session info card with cwd, model
  - `UserPromptReceived`: user message bubble
  - `ToolCallRequested` / `ToolCallCompleted` / `ToolCallFailed`: tool call cards with collapsible input/output
  - `PermissionRequested`: inline permission card with approve/deny buttons
  - `TurnCompleted`: token usage summary
  - `AgentSpawned` / `AgentCompleted`: sub-agent lifecycle cards
  - `SessionEnded`: session summary card
- **Terminal view** (`terminal-view.tsx`): xterm.js rendering of live PTY output
- **Prompt input bar**: bottom-fixed multiline input, Shift+Enter for newline, Enter to send
- **Permission banner**: amber bar at top when pending permissions exist

#### components/agents/permission-modal.tsx

```tsx
interface PermissionModalProps {
  request: PermissionRequest;
  onApprove: () => void;
  onDeny: () => void;
}

// Renders: tool name, description, file path or command
// "Allow" (green) / "Deny" (red) buttons
// Shows tool_input in collapsible code block
```

#### components/terminal/terminal-view.tsx

Wraps the `useTerminal` hook into a React component:

```tsx
export function TerminalView({ agentId }: { agentId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const relay = useRelayConnection();
  const { search } = useTerminal(containerRef, relay, agentId);

  // Search bar overlay on Ctrl+F
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="relative h-full">
      {showSearch && <TerminalSearchBar onSearch={search} onClose={() => setShowSearch(false)} />}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
```

---

### Task 8: Session History Pages

Implement session browsing, search, and detail timeline views.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/pages/sessions/index.tsx` | Session history list with search + filters |
| `packages/web/src/pages/sessions/[sessionId].tsx` | Session detail timeline |
| `packages/web/src/components/sessions/timeline-item.tsx` | Per-event-type renderer (12 event types) |
| `packages/web/src/components/sessions/diff-viewer.tsx` | Syntax-highlighted unified diff |
| `packages/web/src/components/sessions/search-bar.tsx` | Session search with filter dropdowns |
| `packages/web/src/components/common/code-block.tsx` | Syntax-highlighted code block |

#### pages/sessions/index.tsx

- Search bar with full-text query input
- Filter dropdowns: machine, project, date range, status
- Session list with `SessionSummary` cards showing:
  - Project name, daemon name, started at, duration
  - Event count, prompt count, tool call count
  - Token usage and cost
  - Last prompt preview (truncated)
  - Encryption status badge (decrypted / locked)
- Infinite scroll pagination via TanStack Query's `useInfiniteQuery`
- Sort by: date, duration, tokens, project

#### pages/sessions/[sessionId].tsx

- Session header: project, machine, duration, status, token totals
- Event timeline: vertical timeline with event cards
- Each event rendered by `timeline-item.tsx` based on `TypedEvent.type` discriminator:
  - Switch on all 12 event types from `@saqr/shared`
  - Tool calls show collapsible input/output with syntax highlighting
  - File diffs use `diff-viewer.tsx`
  - User prompts rendered as user message bubbles
- Encrypted events show "locked" state with "Import Key" link if no key available
- Pagination: events loaded in pages of 50, scroll to load more

#### components/sessions/diff-viewer.tsx

Renders unified diff format with line-by-line coloring:

```tsx
interface DiffViewerProps {
  diff: string;
  filename: string;
}

// Parse unified diff format
// Green background for additions (+)
// Red background for deletions (-)
// Grey for context lines
// Line numbers in gutter
// Syntax highlighting within changed lines
```

#### components/sessions/timeline-item.tsx

```tsx
import type { TypedEvent } from "@saqr/shared";

interface TimelineItemProps {
  event: TypedEvent;
  timestamp: string;
  sequence: number;
}

export function TimelineItem({ event, timestamp, sequence }: TimelineItemProps) {
  switch (event.type) {
    case "SessionStarted":
      return <SessionStartedCard payload={event.payload} timestamp={timestamp} />;
    case "UserPromptReceived":
      return <UserPromptCard payload={event.payload} timestamp={timestamp} />;
    case "ToolCallRequested":
      return <ToolCallRequestedCard payload={event.payload} timestamp={timestamp} />;
    case "ToolCallCompleted":
      return <ToolCallCompletedCard payload={event.payload} timestamp={timestamp} />;
    case "ToolCallFailed":
      return <ToolCallFailedCard payload={event.payload} timestamp={timestamp} />;
    // ... all 12 event types
  }
}
```

---

### Task 9: Billing Pages

Implement the billing/subscription management UI with Stripe Checkout integration.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/pages/billing/index.tsx` | Current plan, usage limits, billing info |
| `packages/web/src/pages/billing/upgrade.tsx` | Tier comparison table, Stripe Checkout redirect |

#### pages/billing/index.tsx

- Current tier badge (Free / Pro / Team) with tier-specific color
- Usage bars showing consumption vs. limits:
  - Machines: `used / limit` (e.g., "2 / 3 machines")
  - Storage: `used / quota` with percentage bar (e.g., "1.2 GB / 5 GB")
  - Sync operations: `count / limit per month`
  - Data retention: `X days` (varies by tier)
- Next billing date and amount (if Pro/Team)
- "Change Plan" button -> navigates to upgrade page
- Billing history table (if available from API)

#### pages/billing/upgrade.tsx

- Three-column tier comparison table:

| Feature | Free | Pro | Team |
|---------|------|-----|------|
| Machines | 3 | 10 | Unlimited |
| Storage | 1 GB | 10 GB | 100 GB |
| Retention | 30 days | 1 year | Unlimited |
| Rate limit | 60/min | 300/min | 1000/min |
| Price | $0 | $9/mo | $29/mo |

- "Select Plan" button for each tier
- On click: POST `/api/billing/create-checkout-session` with selected tier
- Receive `{ url: string }` (Stripe Checkout URL)
- Redirect via `redirectToCheckout(sessionId)` from `lib/stripe.ts`
- Return URL handles `?success=true` or `?canceled=true` query params

---

### Task 10: Encryption Key Import Page

Implement the key import flow for passphrase-based recovery and QR scan.

#### Files to Create

| File | Purpose |
|------|---------|
| `packages/web/src/pages/setup/import-key.tsx` | Key import wizard (passphrase or QR) |

#### pages/setup/import-key.tsx

Two-tab interface: "Passphrase" and "QR Scan".

**Passphrase Tab:**

1. User enters recovery passphrase in a password input
2. Click "Import Key"
3. Fetch recovery blob from sync server: `apiClient.getRecoveryBlob()`
4. Derive key via Argon2id using `WebEncryptionManager.deriveKeyFromPassphrase(passphrase, salt)`
5. Decrypt master key from recovery blob
6. Store in IndexedDB via `KeyStorage.storeKey(masterKeyBytes, keyId)`
7. Update key store state
8. Show success -> redirect to dashboard

Error handling:
- Wrong passphrase: "Incorrect passphrase. Please try again."
- No recovery blob on server: "No recovery key found. Export a recovery key from your desktop first."
- Argon2id is slow (~2-5 seconds in WASM): show progress spinner with "Deriving key..."

**QR Scan Tab:**

1. Request camera permission via `navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })`
2. Render camera feed in a `<video>` element
3. Scan for QR codes using a lightweight JS QR decoder (e.g., `jsQR` or `qr-scanner`)
4. Parse `KeyTransferPayload` from QR data
5. Perform ECDH key exchange via libsodium Curve25519:
   - Generate ephemeral keypair
   - Compute shared secret with scanned pubkey
   - Receive encrypted master key via relay WebSocket
   - Decrypt master key with shared secret
6. Store in IndexedDB
7. Show success

Key lifecycle controls on this page:
- If key already exists: show "Key imported" status with key ID
- "Lock Key" button: marks key as locked, requires passphrase to unlock
- "Clear Key" button: removes key from IndexedDB entirely

---

### Task 11: Tests

Target: 42+ new unit and integration tests.

#### Test Files to Create

| File | Tests | Description |
|------|-------|-------------|
| `packages/web/__tests__/api-client.test.ts` | ~8 | REST client: request formatting, auth header, error mapping, token expired callback, retry on 500 |
| `packages/web/__tests__/crypto.test.ts` | ~7 | WebEncryptionManager: init, encrypt/decrypt roundtrip, Argon2id key derivation, base64 helpers, wrong key rejection |
| `packages/web/__tests__/key-storage.test.ts` | ~6 | IndexedDB store/retrieve/clear, AES-GCM wrapping, lock/unlock state |
| `packages/web/__tests__/relay-client.test.ts` | ~5 | WebSocket connect/disconnect, message routing, auto-reconnect, status tracking |
| `packages/web/__tests__/auth-store.test.ts` | ~5 | setAuth/clearAuth, persistence roundtrip, tier update |
| `packages/web/__tests__/agent-store.test.ts` | ~5 | setAgentsForMachine, updateAgent, markDisconnected, groupByMachine, attentionCount |
| `packages/web/__tests__/components/terminal-view.test.ts` | ~3 | xterm.js initialization, PTY data write, resize event |
| `packages/web/__tests__/components/timeline-item.test.ts` | ~3 | Render each of the 12 event type cards, verify correct discriminator handling |
| `packages/web/__tests__/components/permission-modal.test.ts` | ~3 | Approve callback, deny callback, tool info display |

Total new tests: **45**, exceeding the 42 minimum. Test coverage priorities:

1. **Core libraries** (api-client, crypto, key-storage, relay-client): highest priority -- these handle security-critical operations. Test the logic thoroughly without rendering.
2. **Stores**: test Zustand stores by calling actions and asserting state changes. No DOM needed.
3. **Components**: lightweight tests verifying correct behavior through mocked dependencies. Use `jsdom` environment in vitest for DOM-related tests.

#### Testing Approach

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["__tests__/**/*.test.ts"],
    setupFiles: ["__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

#### Key Test Patterns

**Crypto tests**: Mock `libsodium-wrappers` or use the real WASM module. Since Argon2id is slow, use a fast-path test salt and verify the derived key matches a known value.

```typescript
// __tests__/crypto.test.ts
describe("WebEncryptionManager", () => {
  let manager: WebEncryptionManager;

  beforeAll(async () => {
    manager = new WebEncryptionManager();
    await manager.init();
  });

  it("encrypts and decrypts a string roundtrip", async () => {
    const key = await manager.generateMasterKey();
    const encrypted = await manager.encryptString("hello world");
    const decrypted = await manager.decryptToString(
      manager.fromBase64(encrypted.ciphertext),
      manager.fromBase64(encrypted.nonce)
    );
    expect(decrypted).toBe("hello world");
  });

  it("rejects decryption with wrong key", async () => {
    await manager.generateMasterKey();
    const encrypted = await manager.encryptString("secret");
    const wrongKey = await manager.generateMasterKey(); // generates new key, replaces old
    await expect(
      manager.decryptToString(
        manager.fromBase64(encrypted.ciphertext),
        manager.fromBase64(encrypted.nonce)
      )
    ).rejects.toThrow();
  });
});
```

**API client tests**: Mock `fetch` globally. Verify headers, body formatting, error mapping.

```typescript
// __tests__/api-client.test.ts
describe("ApiClient", () => {
  it("attaches Bearer token to requests", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    globalThis.fetch = fetchSpy;

    const client = new ApiClient({
      baseUrl: "https://api.saqr.dev",
      getAccessToken: () => "test-token",
      onTokenExpired: vi.fn(),
    });

    await client.getAccount();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.saqr.dev/api/account",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      })
    );
  });

  it("calls onTokenExpired on 401 response", async () => {
    const onExpired = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    const client = new ApiClient({
      baseUrl: "https://api.saqr.dev",
      getAccessToken: () => "expired-token",
      onTokenExpired: onExpired,
    });

    await expect(client.getAccount()).rejects.toThrow();
    expect(onExpired).toHaveBeenCalled();
  });
});
```

**Key storage tests**: Mock IndexedDB with `fake-indexeddb` or a simple in-memory mock. Mock Web Crypto API's `subtle.encrypt`/`subtle.decrypt`.

**Relay client tests**: Mock `WebSocket` class. Verify connect/disconnect lifecycle, message deserialization, auto-reconnect timer.

**Store tests**: Create store instances, call actions, assert state.

```typescript
// __tests__/auth-store.test.ts
describe("useAuthStore", () => {
  beforeEach(() => useAuthStore.getState().clearAuth());

  it("sets auth state on login", () => {
    useAuthStore.getState().setAuth("token123", {
      userId: "u1", email: "a@b.com", tier: "free",
    });
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.accessToken).toBe("token123");
    expect(state.user?.email).toBe("a@b.com");
  });

  it("clears auth state on logout", () => {
    useAuthStore.getState().setAuth("tok", { userId: "u1", email: "a@b.com", tier: "free" });
    useAuthStore.getState().clearAuth();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
```

#### Test Mapping to Story Test Cases

| Story TC | Test File | Coverage |
|----------|-----------|----------|
| TC19.1-TC19.6 | auth-store.test.ts, api-client.test.ts | Auth flows, validation |
| TC19.7-TC19.8 | api-client.test.ts | JWT expiry, token refresh |
| TC19.9-TC19.13 | agent-store.test.ts, relay-client.test.ts | Agent list, updates, permissions |
| TC19.14 | components/terminal-view.test.ts | Dual view toggle |
| TC19.15-TC19.19 | components/terminal-view.test.ts | xterm.js rendering, input, search |
| TC19.20-TC19.24 | crypto.test.ts, key-storage.test.ts | Key import, storage, lock/clear |
| TC19.25-TC19.27 | api-client.test.ts | Billing API calls |
| TC19.28-TC19.32 | components/timeline-item.test.ts | Session history, event rendering |

---

### Task 12: CI/CD Deployment

Set up GitHub Actions workflows for testing, building, and deploying to Cloudflare Pages.

#### Files to Create

| File | Purpose |
|------|---------|
| `.github/workflows/web-test.yml` | Run vitest on PR for packages/web changes |
| `.github/workflows/web-deploy.yml` | Build + deploy to Cloudflare Pages on main push |

#### web-test.yml

```yaml
name: Web - Test
on:
  pull_request:
    paths: ["packages/web/**", "packages/shared/**"]
  push:
    paths: ["packages/web/**", "packages/shared/**"]
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: cd packages/web && pnpm typecheck
      - run: cd packages/web && pnpm test
```

#### web-deploy.yml

```yaml
name: Web - Deploy
on:
  push:
    paths: ["packages/web/**", "packages/shared/**"]
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      deployments: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: cd packages/web && pnpm build
        env:
          VITE_API_BASE_URL: ${{ vars.API_BASE_URL }}
          VITE_RELAY_URL: ${{ vars.RELAY_URL }}
          VITE_STRIPE_PUBLISHABLE_KEY: ${{ vars.STRIPE_PUBLISHABLE_KEY }}
      - name: Deploy to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy packages/web/dist --project-name=saqr-web
```

#### Environment Variables

The web app uses Vite's `import.meta.env` for configuration:

| Variable | Purpose | Example |
|----------|---------|---------|
| `VITE_API_BASE_URL` | Sync server API base URL | `https://api.saqr.dev` |
| `VITE_RELAY_URL` | E2EE relay WebSocket URL | `wss://relay.saqr.dev` |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | `pk_live_...` |

These are set as Cloudflare Pages environment variables for production builds and as `.env.local` for local development.

#### Cloudflare Pages Configuration

- **Build command**: `pnpm --filter @saqr/web build`
- **Build output directory**: `packages/web/dist`
- **Root directory**: `/` (monorepo root, so pnpm workspace resolution works)
- **`_redirects`** file handles SPA client-side routing

---

## Summary

| Task | Files | Tests | Effort |
|------|-------|-------|--------|
| 1. Package Scaffolding | 12 | 0 | 1 day |
| 2. Core Libraries | 6 | 0 | 2.5 days |
| 3. Zustand Stores | 5 | 0 | 1.5 days |
| 4. React Hooks + TanStack Query | 6 | 0 | 1.5 days |
| 5. Auth Pages | 4 | 0 | 1.5 days |
| 6. Dashboard & Account Pages | 9 | 0 | 2 days |
| 7. Agent Pages | 7 | 0 | 2.5 days |
| 8. Session History Pages | 6 | 0 | 2 days |
| 9. Billing Pages | 2 | 0 | 1 day |
| 10. Encryption Key Import | 1 | 0 | 1.5 days |
| 11. Tests | 9 | 45 | 2 days |
| 12. CI/CD Deployment | 2 | 0 | 0.5 day |
| **Total** | **69** | **45** | **~19.5 days** |

### Acceptance Criteria Mapping

| Criterion | Task(s) |
|-----------|---------|
| Register, verify, login from browser | 5 (Auth Pages) |
| View agents across all machines | 7 (Agent Pages) |
| Send prompts and approve permissions | 7 (Agent Pages) |
| View terminal output (xterm.js) | 4 (use-terminal), 7 (terminal-view) |
| View structured timeline for observed sessions | 7 (structured-view) |
| Import encryption key via passphrase or QR | 10 (Key Import) |
| Browse session history with search | 8 (Session Pages) |
| View and upgrade subscription tier | 9 (Billing Pages) |
| Export data and delete account | 6 (Dashboard settings) |
| Responsive on phone, tablet, desktop | 6 (app-shell breakpoints) |
| 30+ unit tests passing | 11 (45 tests) |
| Deploys to Cloudflare Pages via CI/CD | 12 (GitHub Actions) |
