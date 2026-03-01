# Story 19: Web Application (Hosted)

## Overview

The local dashboard (Story 06) runs on the user's machine alongside the daemon. It only works when the daemon is running and the user is on the same machine. There is no hosted web interface for remote access.

This story builds a **hosted web application** that lets users manage agents, view session history, and interact with terminals from any browser — without installing anything. It's the browser-based counterpart to the mobile app (Story 16) and desktop app (Story 17).

The web app serves two distinct user segments:

1. **Remote agent management** — Users connect to their daemon(s) via the E2EE relay and interact with agents from a browser. Terminal rendering uses xterm.js, session rendering uses the same structured timeline components as mobile.
2. **Account management** — Registration, login, subscription tier, billing, data export, account deletion.

**Architecture**: The web app is a React SPA deployed to Cloudflare Pages. It authenticates via the sync server (JWT), connects to daemons via the relay WebSocket, and decrypts data client-side using the user's master key (stored in browser IndexedDB with Web Crypto API protection).

**Guiding principle**: The web app must work without any local software. A user should be able to open a browser on a public computer, log in, interact with their agents, and log out — leaving nothing behind.

---

## Scope

### In Scope

- React SPA with Vite + React Router
- Deploy to Cloudflare Pages (via `wrangler pages deploy`)
- Authentication pages: register, login, forgot password, email verification
- Account dashboard: profile, tier info, machine list, usage summary
- Agent management: agent list across machines, agent detail with streaming
- Terminal view: xterm.js for managed sessions, structured view for observed
- Session history: search, browse, filter by machine/project/date
- Permission approval: approve/deny tool calls from browser
- Prompt input: send prompts to agents from browser
- Encryption key management: import key via passphrase entry or QR scan (webcam)
- E2EE relay connection: WebSocket to relay for live daemon communication
- Responsive design: mobile-friendly (works on phone browsers too)
- Dark/light theme with system preference detection
- Stripe Checkout integration for tier upgrades (redirects to Stripe)
- Data export: download encrypted archive, decrypt client-side
- Account deletion with confirmation

### Out of Scope

- Native mobile features (push notifications, biometric unlock — use Story 16)
- Local daemon interaction (direct HTTP — use Story 06 dashboard)
- Payment webhook handling (Story 20)
- Admin interface (Story 15)

---

## Requirements

### 1. Project Setup

Create a new package `packages/web` with Vite + React + TypeScript.

#### Directory Structure

```
packages/web/
├── src/
│   ├── main.tsx                    # Entry point
│   ├── router.tsx                  # React Router config
│   ├── pages/
│   │   ├── auth/
│   │   │   ├── login.tsx           # Email + password login
│   │   │   ├── register.tsx        # Registration with email verification
│   │   │   ├── forgot-password.tsx # Password reset request
│   │   │   └── reset-password.tsx  # Password reset with token
│   │   ├── dashboard/
│   │   │   ├── index.tsx           # Account overview
│   │   │   ├── machines.tsx        # Registered machines list
│   │   │   ├── usage.tsx           # Usage analytics
│   │   │   └── settings.tsx        # Account settings, data export, delete
│   │   ├── agents/
│   │   │   ├── index.tsx           # Agent list across all machines
│   │   │   └── [agentId].tsx       # Agent detail with terminal/structured view
│   │   ├── sessions/
│   │   │   ├── index.tsx           # Session history with search
│   │   │   └── [sessionId].tsx     # Session detail timeline
│   │   ├── billing/
│   │   │   ├── index.tsx           # Current plan, usage, limits
│   │   │   └── upgrade.tsx         # Tier comparison, Stripe Checkout redirect
│   │   └── setup/
│   │       └── import-key.tsx      # Import encryption key (passphrase or QR)
│   ├── components/
│   │   ├── layout/
│   │   │   ├── app-shell.tsx       # Sidebar + header + content
│   │   │   ├── sidebar.tsx         # Navigation sidebar
│   │   │   └── header.tsx          # Top bar with user menu
│   │   ├── terminal/
│   │   │   ├── terminal-view.tsx   # xterm.js wrapper for managed sessions
│   │   │   └── structured-view.tsx # Card-based timeline for observed sessions
│   │   ├── agents/
│   │   │   ├── agent-card.tsx      # Agent summary card
│   │   │   ├── agent-status.tsx    # Live status badge
│   │   │   └── permission-modal.tsx# Approve/deny modal
│   │   ├── sessions/
│   │   │   ├── timeline-item.tsx   # Per-event-type renderer
│   │   │   ├── diff-viewer.tsx     # Syntax-highlighted unified diff
│   │   │   └── search-bar.tsx      # Session search with filters
│   │   └── common/
│   │       ├── code-block.tsx      # Syntax-highlighted code
│   │       ├── loading.tsx         # Loading states
│   │       └── error-boundary.tsx  # Error handling
│   ├── stores/
│   │   ├── auth-store.ts           # JWT tokens, user info
│   │   ├── agent-store.ts          # Agent state across machines
│   │   ├── session-store.ts        # Session history cache
│   │   ├── key-store.ts            # Encryption key (IndexedDB)
│   │   └── connection-store.ts     # Relay WebSocket connections
│   ├── lib/
│   │   ├── api-client.ts           # Sync server REST client
│   │   ├── relay-client.ts         # E2EE relay WebSocket client
│   │   ├── crypto.ts               # Client-side decrypt (libsodium-wrappers)
│   │   ├── key-storage.ts          # IndexedDB + Web Crypto for key protection
│   │   └── stripe.ts               # Stripe.js redirect helper
│   └── hooks/
│       ├── use-auth.ts             # Auth state + login/logout/register
│       ├── use-agents.ts           # Agent list + streaming
│       ├── use-sessions.ts         # Session history + search
│       ├── use-relay.ts            # Relay WebSocket connection
│       └── use-terminal.ts         # xterm.js integration
├── public/
│   └── favicon.svg
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── __tests__/
    ├── auth-store.test.ts
    ├── agent-store.test.ts
    ├── api-client.test.ts
    ├── relay-client.test.ts
    ├── crypto.test.ts
    ├── key-storage.test.ts
    └── components/
        ├── terminal-view.test.ts
        ├── timeline-item.test.ts
        └── permission-modal.test.ts
```

### 2. Authentication Pages

#### Registration
- Email + password form
- Password strength meter (min 10 chars, must contain uppercase + number)
- Terms of service + privacy policy checkboxes
- POST `/api/auth/register` → success → redirect to "check your email"
- Email verification link → POST `/api/auth/verify-email` with token

#### Login
- Email + password form
- "Remember me" checkbox (extends JWT expiry)
- POST `/api/auth/login` → JWT stored in httpOnly cookie (same-site strict)
- Redirect to dashboard on success
- "Forgot password" link

#### Password Reset
- Enter email → POST `/api/auth/forgot-password` → sends reset link
- Click link → enter new password → POST `/api/auth/reset-password` with token
- Auto-login after reset

### 3. Agent Management

#### Agent List
- Fetch agents from all connected machines via relay
- Group by machine, sort by status (running first)
- Live status badges: running (green pulse), idle (grey), error (red), waiting permission (amber)
- Click agent → navigate to detail view

#### Agent Detail
- **Dual view mode** (matching F13.5):
  - **Structured view** (default): card-based timeline matching mobile Story 16
  - **Terminal view**: xterm.js rendering of PTY output for managed sessions
- Toggle between views with keyboard shortcut (Ctrl+T)
- Prompt input bar at bottom (multiline, Shift+Enter for newline)
- Permission request banner at top when pending

### 4. Terminal Rendering (xterm.js)

For managed sessions (F12.4), render real PTY output in the browser:

```typescript
// terminal-view.tsx
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';

// Connect to daemon's PTY stream via relay WebSocket
// User input forwarded back through relay → daemon → PTY
```

- Fit to container, resize events
- Search within terminal output (Ctrl+F)
- Copy selection to clipboard
- Web links clickable
- Font: JetBrains Mono or system monospace

### 5. Encryption Key Management

The web app needs the user's master key to decrypt session data.

#### Key Import via Passphrase
- User enters recovery passphrase
- Derive key via Argon2id (matching sync-client)
- Decrypt master key from backup (stored on sync server)
- Store decrypted key in IndexedDB, wrapped with Web Crypto API (AES-GCM with non-extractable CryptoKey)

#### Key Import via QR Scan
- Use browser camera API (navigator.mediaDevices.getUserMedia)
- Scan QR from desktop/mobile app showing ephemeral Curve25519 pubkey
- ECDH key exchange → receive encrypted master key
- Store same as passphrase flow

#### Key Lifecycle
- Key stays in IndexedDB until explicit logout or "Clear keys" action
- On logout: optionally clear key (user preference)
- "Lock" mode: key remains but requires passphrase re-entry to unlock

### 6. Billing / Account Management

#### Current Plan Page
- Show current tier (Free / Pro / Team)
- Usage bars: machines used/limit, storage used/limit, sync count/limit
- Next billing date, amount
- "Change Plan" button

#### Upgrade Flow
- Tier comparison table (Free vs Pro vs Team)
- Select tier → redirect to Stripe Checkout (server creates session)
- Return URL handles success/cancel
- Webhook updates tier in sync server (Story 20)

#### Account Settings
- Edit display name, email
- Change password
- Notification preferences
- Data export: trigger export → download `.json.enc` file → decrypt client-side
- Delete account: confirmation modal → type "DELETE" → crypto-shred

### 7. Responsive Design

| Breakpoint | Layout |
|------------|--------|
| < 768px (phone) | Single column, bottom nav, hamburger menu |
| 768-1024px (tablet) | Two-panel: sidebar + content |
| > 1024px (desktop) | Three-panel: sidebar + list + detail |

---

## Test Cases

### Authentication
- TC19.1: Registration with valid email/password succeeds
- TC19.2: Registration with weak password shows strength error
- TC19.3: Login with correct credentials returns JWT
- TC19.4: Login with wrong password shows error, rate limits after 5 attempts
- TC19.5: Password reset flow sends email and accepts new password
- TC19.6: Email verification token validates correctly
- TC19.7: Expired JWT redirects to login page
- TC19.8: Refresh token rotation works for long sessions

### Agent Management
- TC19.9: Agent list shows agents from multiple machines grouped correctly
- TC19.10: Agent status badges update in real-time via WebSocket
- TC19.11: Sending prompt via web input reaches daemon and produces response
- TC19.12: Permission approval from web triggers agent continuation
- TC19.13: Permission denial from web stops tool execution
- TC19.14: Dual view toggle switches between terminal and structured view

### Terminal Rendering
- TC19.15: xterm.js renders PTY output with ANSI colors correctly
- TC19.16: Terminal resize events propagate to daemon PTY
- TC19.17: User input in terminal is forwarded to daemon
- TC19.18: Terminal search (Ctrl+F) finds text in buffer
- TC19.19: Copy selection works with keyboard shortcut

### Encryption
- TC19.20: Key import via passphrase derives correct master key
- TC19.21: Imported key decrypts sample encrypted event correctly
- TC19.22: Key stored in IndexedDB is wrapped with Web Crypto AES-GCM
- TC19.23: Logout with "clear keys" removes key from IndexedDB
- TC19.24: Lock mode requires passphrase re-entry to unlock key

### Billing
- TC19.25: Free tier shows correct usage limits
- TC19.26: Upgrade redirects to Stripe Checkout with correct tier
- TC19.27: Account deletion requires typing "DELETE" and confirms crypto-shred

### Session History
- TC19.28: Session list loads and displays sessions sorted by date
- TC19.29: Search filters sessions by keyword across all fields
- TC19.30: Session detail renders all event types correctly
- TC19.31: Diff viewer shows syntax-highlighted unified diffs
- TC19.32: Timeline item for each tool type renders appropriate icon and content

---

## Dependencies

- Story 11 (Sync Server): auth API, sync endpoints
- Story 07 (Encrypted Sync): client-side crypto
- Story 12 (Security): key management patterns
- Story 01 (Session Attach): PTY streaming via relay
- Story 02 (CLI Rendering): timeline item types

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | React 19 + Vite | Fast builds, familiar ecosystem, Cloudflare Pages compatible |
| Routing | React Router 7 | File-based routing possible, nested layouts |
| State | Zustand | Same as mobile (Story 16), shared patterns |
| Server state | TanStack React Query | Same as mobile, caching + refetch |
| Terminal | @xterm/xterm | Industry standard browser terminal emulator |
| Crypto | libsodium-wrappers | Same as sync-client, WASM-based |
| Styling | Tailwind CSS | Utility-first, responsive, dark mode built-in |
| Payments | @stripe/stripe-js | Redirect to Checkout, no PCI scope |
| Deploy | Cloudflare Pages | Edge-deployed, fast globally, zero cold start |

## Acceptance Criteria

- [ ] User can register, verify email, and log in from browser
- [ ] User can view agents across all connected machines
- [ ] User can send prompts and approve permissions from browser
- [ ] User can view terminal output (xterm.js) for managed sessions
- [ ] User can view structured timeline for observed sessions
- [ ] User can import encryption key via passphrase or QR
- [ ] User can browse session history with search
- [ ] User can view and upgrade subscription tier
- [ ] User can export data and delete account
- [ ] Responsive design works on phone, tablet, and desktop browsers
- [ ] 30+ unit tests passing
- [ ] Deploys to Cloudflare Pages via CI/CD
