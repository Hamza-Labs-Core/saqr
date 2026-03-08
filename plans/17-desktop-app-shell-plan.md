# Implementation Plan: Story 17 -- Desktop App Shell (Tauri 2)

**Date**: 2026-02-24
**Story**: 17-desktop-app-shell
**Status**: Planning
**Estimated Total Effort**: ~14-18 days (112-144 hours)
**Prerequisites**: Story 09 (Desktop Data Layer) is complete -- 225 TypeScript tests passing. Story 06 (Local Dashboard) is implemented -- the dashboard server and HTML UI exist at `packages/dashboard/`. The Saqr daemon API contract (F3) is stable.

## Context

Story 09 implemented the TypeScript data layer for the desktop app at `packages/desktop/src/`. It provides typed IPC interfaces, tray state computation, window state management, notification mapping, key storage bridging, auto-update state management, app configuration, deep link parsing, and platform detection. All of this is pure TypeScript with 225 tests -- no native Rust code, no runnable application.

Story 17 builds the **actual Tauri 2 application** that consumes Story 09's data layer. It creates the Rust backend (`packages/desktop/src-tauri/`) that implements the IPC commands the TypeScript layer expects to call, wraps the Saqr dashboard in a native WebView, and produces real platform binaries.

### Relationship to Existing Code

| Existing (Story 09) | New (Story 17) |
|---------------------|----------------|
| `packages/desktop/src/ipc-types.ts` -- TypeScript types for all IPC commands | `packages/desktop/src-tauri/src/` -- Rust implementations matching these types |
| `packages/desktop/src/ipc-bridge.ts` -- `invoke()` wrappers | `packages/desktop/src-tauri/src/commands/` -- `#[tauri::command]` handlers |
| `packages/desktop/src/tray-state.ts` -- Tray state computation (TS) | `packages/desktop/src-tauri/src/tray.rs` -- Native tray icon + menu |
| `packages/desktop/src/window-state.ts` -- Window state persistence (TS) | `packages/desktop/src-tauri/src/window_state.rs` -- Native window management |
| `packages/desktop/src/key-storage-bridge.ts` -- Key storage bridge (TS) | `packages/desktop/src-tauri/src/keystore.rs` -- OS keychain integration |
| `packages/desktop/src/notification-manager.ts` -- Notification mapping (TS) | `packages/desktop/src-tauri/src/notifications.rs` -- OS notification dispatch |
| `packages/desktop/src/auto-update.ts` -- Update state management (TS) | `packages/desktop/src-tauri/src/updater.rs` -- Tauri updater plugin |
| `packages/desktop/src/daemon-client.ts` -- HTTP daemon client (TS) | `packages/desktop/src-tauri/src/state.rs` -- Rust HTTP client to daemon |
| `packages/dashboard/src/ui.ts` -- Single-file HTML dashboard | `packages/desktop/src-tauri/tauri.conf.json` -- frontendDist points to dashboard |

The Rust implementations must match the TypeScript type contracts exactly. The `IpcCommandMap` in `ipc-types.ts` is the source of truth for command names and parameter/return types.

---

## Task Dependency Graph

```
Task 1: Tauri 2 Project Scaffold (src-tauri/)
  |
  +---> Task 2: Application State & Daemon Client (Rust)
  |       |
  |       +---> Task 3: System Tray (Rust)
  |       |       |
  |       |       +---> Task 8: Platform Packaging (macOS, Windows, Linux)
  |       |
  |       +---> Task 4: Notifications (Rust)
  |       |       |
  |       |       +---> Task 8: Platform Packaging
  |       |
  |       +---> Task 5: Secure Key Storage (Rust)
  |       |       |
  |       |       +---> Task 8: Platform Packaging
  |       |
  |       +---> Task 6: Multi-Window & Window State (Rust)
  |               |
  |               +---> Task 8: Platform Packaging
  |
  +---> Task 7: Auto-Update System (Rust)
  |       |
  |       +---> Task 9: CI/CD Pipeline (GitHub Actions)
  |
  +---> Task 10: Dashboard Frontend Integration
  |       |
  |       +---> Task 11: Rust Unit Tests + TypeScript Test Updates
  |
  +---> Task 11: Rust Unit Tests + TypeScript Test Updates
```

---

## Task 1: Tauri 2 Project Scaffold

### Description

Initialize the Tauri 2 project structure under `packages/desktop/src-tauri/`. This sits alongside the existing `packages/desktop/src/` TypeScript data layer. The scaffold must compile and open an empty window before any features are added.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/Cargo.toml` | Rust dependencies |
| `packages/desktop/src-tauri/tauri.conf.json` | Tauri configuration |
| `packages/desktop/src-tauri/build.rs` | Tauri build script |
| `packages/desktop/src-tauri/src/main.rs` | Entry point |
| `packages/desktop/src-tauri/src/lib.rs` | Library root |
| `packages/desktop/src-tauri/src/commands/mod.rs` | Command module declarations |
| `packages/desktop/src-tauri/capabilities/default.json` | Permission capabilities |
| `packages/desktop/src-tauri/icons/` | Icon placeholders (all sizes) |
| `packages/desktop/src-tauri/Entitlements.plist` | macOS entitlements |

### Files to Modify

| File | Change |
|------|--------|
| `packages/desktop/package.json` | Add `tauri` scripts, `@tauri-apps/cli` devDep, `@tauri-apps/api` dep |
| `packages/desktop/tsconfig.json` | No changes needed (existing config is correct) |

### Cargo.toml

```toml
[package]
name = "saqr-desktop"
version = "0.1.0"
description = "Saqr Desktop Application"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-plugin-shell = "2"
tauri-plugin-notification = "2"
tauri-plugin-updater = "2"
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
keyring = "3"
base64 = "0.22"
chrono = "0.4"
log = "0.4"
env_logger = "0.11"
dirs = "5"
once_cell = "1"
thiserror = "2"
zeroize = "1"
reqwest = { version = "0.12", features = ["json"] }

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

### tauri.conf.json

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/schema.json",
  "productName": "Saqr",
  "version": "0.1.0",
  "identifier": "dev.saqr.desktop",
  "build": {
    "frontendDist": "../../dashboard/dist",
    "devUrl": "http://localhost:7399"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "title": "Saqr",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false,
        "decorations": true,
        "center": true
      }
    ],
    "trayIcon": {
      "iconPath": "icons/tray-idle.png",
      "iconAsTemplate": true,
      "tooltip": "Saqr"
    },
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "frameworks": [],
      "minimumSystemVersion": "10.15",
      "signingIdentity": null,
      "providerShortName": null,
      "entitlements": "Entitlements.plist"
    },
    "windows": {
      "certificateThumbprint": null,
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com",
      "wix": { "language": "en-US" },
      "nsis": {
        "installMode": "currentUser",
        "displayLanguageSelector": false
      }
    },
    "linux": {
      "deb": {
        "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"],
        "section": "devel"
      },
      "appimage": {
        "bundleMediaFramework": false
      }
    }
  },
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/Hamza-Labs-Core/saqr/releases/latest/download/latest.json"
      ],
      "pubkey": "<UPDATER_PUBLIC_KEY>"
    }
  }
}
```

### capabilities/default.json

```json
{
  "identifier": "default",
  "description": "Default capability set for Saqr desktop",
  "windows": ["main", "agent-*", "settings"],
  "permissions": [
    "core:default",
    "core:window:default",
    "core:window:allow-create",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-set-size",
    "core:window:allow-set-position",
    "core:event:default",
    "core:event:allow-emit",
    "core:event:allow-listen",
    "shell:default",
    "notification:default",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "notification:allow-notify",
    "updater:default",
    "updater:allow-check",
    "updater:allow-download-and-install"
  ]
}
```

### build.rs

```rust
fn main() {
    tauri_build::build();
}
```

### Minimal main.rs (compiles and opens window)

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .run(tauri::generate_context!())
        .expect("error while running Saqr");
}
```

### package.json changes

Add to `packages/desktop/package.json`:

```json
{
  "scripts": {
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  },
  "dependencies": {
    "@saqr/shared": "workspace:*",
    "@tauri-apps/api": "^2.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0"
  }
}
```

### Entitlements.plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.keychain-access-groups</key>
    <array>
        <string>$(TeamIdentifierPrefix)dev.saqr.desktop</string>
    </array>
</dict>
</plist>
```

### Dashboard Frontend Note

The dashboard (Story 06) currently generates HTML inline via `packages/dashboard/src/ui.ts` as a Node.js HTTP server. For Tauri, we need a static HTML file that the WebView can load. Two options:

**Option A (Recommended)**: Create a minimal `packages/desktop/src-tauri/../index.html` that loads the dashboard's inline HTML via fetch from the running dashboard server (`http://localhost:7399`). The `devUrl` in `tauri.conf.json` already points there.

**Option B**: Extract the dashboard HTML into a static file that can be served from `frontendDist`. This requires refactoring the dashboard, which is out of scope.

For `tauri.conf.json`, set `devUrl` to `http://localhost:7399` (dashboard server port) and `frontendDist` to a static HTML directory with a redirect. The dashboard server must be running for the desktop app to show content.

### Acceptance Criteria

- `cargo tauri dev` compiles the Rust backend and opens a native window
- `cargo tauri build` produces a distributable binary for the current platform
- Single-instance plugin prevents duplicate launches
- All Cargo dependencies resolve without conflicts
- Icon placeholders exist in all required sizes

### Estimated Effort: L (8-10 hours)

---

## Task 2: Application State & Daemon Client (Rust)

### Description

Implement the `AppState` struct and `DaemonClient` in Rust. This is the Rust counterpart to `packages/desktop/src/daemon-client.ts`. The IPC commands `get_daemon_status`, `start_daemon`, `stop_daemon` must match the TypeScript `IpcCommandMap` contract exactly.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/state.rs` | `AppState`, `DaemonClient`, `DaemonStatus`, `AgentInfo`, `daemon_health_loop` |
| `packages/desktop/src-tauri/src/commands/daemon.rs` | IPC commands |
| `packages/desktop/src-tauri/src/commands/mod.rs` | Module declarations |

### Files to Modify

| File | Change |
|------|--------|
| `packages/desktop/src-tauri/src/main.rs` | Register `AppState`, daemon commands, spawn health loop |
| `packages/desktop/src-tauri/src/lib.rs` | Declare modules |

### Type Contract (from ipc-types.ts)

The Rust `DaemonStatus` struct must serialize to JSON that matches this TypeScript interface exactly:

```typescript
// From packages/desktop/src/ipc-types.ts lines 48-56
interface DaemonStatus {
  running: boolean;
  pid: number | null;
  uptime_secs: number | null;
  active_agents: number;
  version: string | null;
  http_port: number;
  ws_port: number;
}
```

Rust equivalent:

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub active_agents: u32,
    pub version: Option<String>,
    pub http_port: u16,
    pub ws_port: u16,
}
```

### AppState

```rust
pub struct AppState {
    pub daemon_client: Arc<Mutex<DaemonClient>>,
    pub keystore: KeyStore,
    pub notification_settings: Arc<Mutex<NotificationSettings>>,
    pub tray_available: Arc<std::sync::atomic::AtomicBool>,
}
```

### DaemonClient

```rust
pub struct DaemonClient {
    base_url: String,           // default "http://localhost:7399"
    http_client: reqwest::Client,
}

impl DaemonClient {
    pub fn new() -> Self { /* ... */ }
    pub async fn health_check(&self) -> Result<DaemonStatus, Box<dyn std::error::Error>> { /* GET /api/health with 3s timeout */ }
    pub async fn get_agents(&self) -> Result<Vec<AgentInfo>, Box<dyn std::error::Error>> { /* GET /api/agents */ }
    pub async fn respond_to_permission(&self, request_id: &str, approved: bool) -> Result<(), Box<dyn std::error::Error>> { /* POST */ }
    pub async fn restart_agent(&self, agent_id: &str) -> Result<(), Box<dyn std::error::Error>> { /* POST */ }
}
```

### IPC Commands

```rust
#[tauri::command]
pub async fn get_daemon_status(state: State<'_, AppState>) -> Result<DaemonStatus, String>;

#[tauri::command]
pub async fn start_daemon() -> Result<DaemonStatus, String>;
// Runs `saqr daemon start` via tokio::process::Command

#[tauri::command]
pub async fn stop_daemon() -> Result<(), String>;
// Runs `saqr daemon stop` via tokio::process::Command
```

### daemon_health_loop

Spawned in `setup()`:
- Every 5 seconds, calls `health_check()`
- Emits `daemon-status` event to all windows
- Updates tray state: Running/Idle/Error

### Estimated Effort: M (4-6 hours)

---

## Task 3: System Tray (Rust)

### Description

Implement the native system tray with state-based icons, dynamic context menu, and hide-to-tray behavior. The tray state logic already exists in TypeScript (`packages/desktop/src/tray-state.ts`). The Rust implementation handles the actual OS tray API.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/tray.rs` | Tray setup, icon management, menu building, event handling, debouncer |
| `packages/desktop/src-tauri/src/commands/tray.rs` | IPC command: `update_tray_state` |
| `packages/desktop/src-tauri/icons/tray-idle.png` | Gray circle (22x22 template) |
| `packages/desktop/src-tauri/icons/tray-running.png` | Green circle |
| `packages/desktop/src-tauri/icons/tray-attention.png` | Orange circle |
| `packages/desktop/src-tauri/icons/tray-error.png` | Red circle |
| `packages/desktop/src-tauri/icons/tray-updating.png` | Blue circle |

### Key Implementation Details

**TrayState enum** (5 states matching TS `TRAY_STATES`):

```rust
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TrayState {
    Idle,
    Running,
    Attention,
    Error,
    Updating,
}
```

**TrayDebouncer**: Coalesces rapid updates within 500ms.

**Menu structure** (matches `buildTrayMenuItems` in `tray-state.ts`):
- Header: "Saqr v0.1.x"
- Daemon status
- Agent count
- "Open Dashboard"
- Running agents submenu
- Start/Stop Daemon
- Preferences, Check for Updates
- Quit Saqr, Quit All

**Window close interception**: When tray is available, `CloseRequested` event hides to tray. When tray is unavailable (Linux fallback), close quits the app.

**Left-click toggle**: Toggle main window visibility.

### Estimated Effort: L (8-10 hours)

---

## Task 4: Notifications (Rust)

### Description

Implement OS-level notifications via `tauri-plugin-notification`. The notification categories and event-to-notification mapping already exist in `packages/desktop/src/notification-manager.ts`. The Rust side dispatches actual OS notifications and handles action callbacks.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/notifications.rs` | Notification dispatch, settings persistence |
| `packages/desktop/src-tauri/src/commands/notifications.rs` | IPC commands |

### Type Contract (from ipc-types.ts)

```typescript
// From packages/desktop/src/ipc-types.ts lines 76-84
interface NotificationSettings {
  enabled: boolean;
  permission_requests: boolean;
  agent_complete: boolean;
  agent_error: boolean;
  updates: boolean;
  daemon_status: boolean;
  sound: boolean;
}
```

### IPC Commands

- `send_notification(category, title, body)` -- Dispatch OS notification
- `get_notification_settings()` -- Load from `{app_data}/notification-settings.json`
- `set_notification_settings(settings)` -- Save to disk

### Notification Action Handling

Register `on_action` in setup for:
- `approve:{requestId}` -- POST to daemon
- `deny:{requestId}` -- POST to daemon
- `open:{agentId}` -- Open agent window
- `retry:{agentId}` -- Restart agent
- `update` -- Trigger download_and_install
- `restart-daemon` -- Start daemon

Body truncation: max 200 chars with "..." (matching `truncateBody` in `notification-manager.ts`).

### Estimated Effort: M (6-8 hours)

---

## Task 5: Secure Key Storage (Rust)

### Description

Implement platform key storage using `keyring` crate. The TypeScript bridge (`packages/desktop/src/key-storage-bridge.ts`) expects these exact IPC commands.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/keystore.rs` | `KeyStore`, `KeyStoreError`, platform backends |
| `packages/desktop/src-tauri/src/commands/keystore.rs` | IPC commands |

### Type Contract (from ipc-types.ts)

```typescript
// IPC command names and signatures from IpcCommandMap:
store_key: { request: KeyStoreRequest; response: undefined }  // KeyStoreRequest = { keyId, keyBase64 }
retrieve_key: { request: { keyId: string }; response: string }  // returns base64
delete_key: { request: { keyId: string }; response: undefined }
has_key: { request: { keyId: string }; response: boolean }
```

### Implementation

**Service name**: `dev.saqr.desktop` (matching `identifier` in tauri.conf.json)

**Key operations**:
- Store: base64 encode, store via `keyring::Entry`
- Retrieve: get from keyring, decode base64, return bytes as base64 over IPC
- Delete: `delete_credential()`, return `Ok(())` even if not found (idempotent)
- Has: attempt retrieve, return true/false

**Memory safety**: Use `zeroize` crate to clear temporary base64 strings.

**Linux fallback**: If `keyring::Entry::new()` fails (no Secret Service), fall back to encrypted file at `~/.local/share/saqr/keys.enc`.

### Estimated Effort: M (6-8 hours)

---

## Task 6: Multi-Window & Window State (Rust)

### Description

Implement native multi-window support. The TypeScript `WindowStateManager` (`packages/desktop/src/window-state.ts`) handles state serialization/deserialization; the Rust side handles actual window creation and OS-level state persistence.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/window_state.rs` | Window state persistence, position validation |
| `packages/desktop/src-tauri/src/commands/windows.rs` | IPC commands |

### Type Contract (from ipc-types.ts)

```typescript
// From IpcCommandMap:
open_agent_window: { request: { agentId, agentName }; response: WindowInfo }
get_window_list: { request: undefined; response: WindowInfo[] }
close_window: { request: { label }; response: undefined }
get_window_state: { request: { label }; response: WindowState | null }
```

```typescript
interface WindowInfo {
  label: string; title: string; width: number; height: number;
  x: number; y: number; is_focused: boolean; is_visible: boolean;
}

interface WindowState {
  x: number; y: number; width: number; height: number; maximized: boolean;
}
```

### Implementation

- `open_agent_window`: Check if window exists (focus it), else create with label `agent-{id}`, URL `/agent/{id}`, restore saved state, register move/resize listeners
- Position validation: Use `available_monitors()` API (matches `validateWindowPosition` in `window-state.ts`)
- State file: `{app_data}/window-states.json` (JSON map of label -> WindowState)
- Uses `once_cell::sync::Lazy<Mutex<HashMap<String, WindowState>>>` for in-memory cache

### Estimated Effort: L (8-10 hours)

---

## Task 7: Auto-Update System (Rust)

### Description

Implement auto-update using `tauri-plugin-updater`. The TypeScript `AutoUpdateManager` (`packages/desktop/src/auto-update.ts`) manages frontend state; the Rust side handles actual checking, downloading, and installing.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/updater.rs` | Update check loop, download/install, launch health, backup |

### Implementation

**Constants** (matching TypeScript):
- `CHECK_INTERVAL`: 6 hours (from `auto-update.ts` `CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000`)
- `INITIAL_DELAY`: 30 seconds (from `auto-update.ts` `INITIAL_DELAY_MS = 30 * 1000`)

**Update check loop**: Spawned in setup, runs forever:
1. Wait 30 seconds
2. Check for updates via `app.updater().check()`
3. If update found: notify user, set tray state to "updating"
4. Sleep 6 hours, repeat

**Download and install**: Progress emitted via `app.emit("update-progress", ...)` matching TypeScript `UpdateProgress { downloaded, total, percent }`.

**Launch health marker**: `{app_data}/last_launch_success` written 10 seconds after startup.

**Binary backup**: `{app_data}/backup/{exe_name}` before applying update.

### Estimated Effort: M (6-8 hours)

---

## Task 8: Platform-Specific Packaging

### Description

Configure Tauri's bundler for production builds on all three platforms. Create icon assets and platform-specific configuration files.

### Files to Create/Modify

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/icons/icon.icns` | macOS app icon |
| `packages/desktop/src-tauri/icons/icon.ico` | Windows app icon |
| `packages/desktop/src-tauri/icons/icon.png` | Linux app icon (512x512) |
| `packages/desktop/src-tauri/icons/32x32.png` | Taskbar icon |
| `packages/desktop/src-tauri/icons/128x128.png` | Dock/launcher icon |
| `packages/desktop/src-tauri/icons/128x128@2x.png` | Retina icon |

### macOS Build

```bash
cargo tauri build --target universal-apple-darwin
```

Produces: `.dmg` + `.app.tar.gz` + `.sig`

Required for notarization:
- `APPLE_CERTIFICATE` (base64 .p12)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`

### Windows Build

```bash
cargo tauri build
```

Produces: `.msi` (WiX) + `.exe` (NSIS)

NSIS installer automatically bootstraps WebView2 if missing.

### Linux Build

```bash
# Requires: libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
cargo tauri build
```

Produces: `.AppImage` + `.deb`

### Estimated Effort: M (6-8 hours)

---

## Task 9: CI/CD Build Pipeline (GitHub Actions)

### Description

Create GitHub Actions workflows for building desktop artifacts on all three platforms using `tauri-apps/tauri-action`.

### Files to Create

| File | Purpose |
|------|---------|
| `.github/workflows/build-desktop.yml` | Multi-platform build on push/PR |
| `.github/workflows/release-desktop.yml` | Release builds on tag push |

### build-desktop.yml Structure

```yaml
name: Build Desktop

on:
  push:
    branches: [main]
    paths:
      - 'packages/desktop/**'
      - 'packages/dashboard/**'
  pull_request:
    paths:
      - 'packages/desktop/**'
      - 'packages/dashboard/**'
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target universal-apple-darwin
          - platform: windows-latest
            args: ''
          - platform: ubuntu-22.04
            args: ''

    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - name: Install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build dashboard
        run: pnpm --filter dashboard run build

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: packages/desktop/src-tauri -> target

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          projectPath: packages/desktop
          args: ${{ matrix.args }}
```

### release-desktop.yml Structure

Triggered by `v*.*.*` tags. Same build matrix but with signing enabled:

```yaml
name: Release Desktop

on:
  push:
    tags:
      - 'v*.*.*'

jobs:
  build-and-release:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target universal-apple-darwin
          - platform: windows-latest
            args: ''
          - platform: ubuntu-22.04
            args: ''

    runs-on: ${{ matrix.platform }}
    steps:
      # ... (same as build + signing env vars + upload to GitHub Release)

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: packages/desktop
          args: ${{ matrix.args }}
          tagName: ${{ github.ref_name }}
          releaseName: 'Saqr Desktop ${{ github.ref_name }}'
          releaseBody: 'See full changelog in the GitHub Release notes.'
          releaseDraft: true
          prerelease: false
          includeUpdaterJson: true
```

### GitHub Secrets Required

| Secret | Platform | Purpose |
|--------|----------|---------|
| `APPLE_CERTIFICATE` | macOS | Base64 .p12 |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | Certificate password |
| `APPLE_SIGNING_IDENTITY` | macOS | Developer ID string |
| `APPLE_ID` | macOS | Apple ID email |
| `APPLE_PASSWORD` | macOS | App-specific password |
| `APPLE_TEAM_ID` | macOS | Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | All | Ed25519 key for update signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | All | Key password |

### Estimated Effort: L (10-12 hours)

---

## Task 10: Dashboard Frontend Integration

### Description

Connect the Saqr dashboard to the Tauri WebView. The dashboard currently runs as a Node.js HTTP server (`packages/dashboard/src/server.ts`). The desktop app loads it via `devUrl` during development, and for production builds, we need a static frontend that can be bundled.

### Approach

**Development mode**: Dashboard runs as a Node.js server on port 7399. Tauri's `devUrl: "http://localhost:7399"` loads it.

**Production mode**: Two options:
1. **Proxy approach (recommended for v0.1)**: Ship a minimal `index.html` that redirects to `http://localhost:7399`. The daemon must be running.
2. **Static build approach (future)**: Refactor dashboard into a static SPA. Out of scope for Story 17.

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/../frontend/index.html` | Minimal HTML for production builds |

The `index.html` for production:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Saqr</title>
  <script>
    // Redirect to the running dashboard server
    // In Tauri, this connects to the local daemon
    window.location.href = 'http://localhost:7399';
  </script>
</head>
<body>
  <p>Connecting to Saqr Dashboard...</p>
</body>
</html>
```

Update `tauri.conf.json`:
```json
{
  "build": {
    "frontendDist": "../frontend",
    "devUrl": "http://localhost:7399"
  }
}
```

### Tauri Bridge Connection

The existing `packages/desktop/src/ipc-bridge.ts` creates invoke wrappers. In production, the dashboard HTML needs to include a script that creates the bridge and makes it available. Since the dashboard is loaded from the daemon server, we inject Tauri detection:

```typescript
// In dashboard frontend code (if Tauri is detected)
import { isTauri } from '@saqr/desktop';
if (isTauri()) {
  // Enable native features: tray, notifications, key storage
}
```

### Estimated Effort: S (2-4 hours)

---

## Task 11: Rust Unit Tests + TypeScript Test Updates

### Description

Add Rust unit tests for all new Rust modules. Ensure the existing 225 TypeScript tests continue to pass. Add 2 new TypeScript tests for the Tauri bridge connection.

### Rust Test Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/keystore.rs` (inline tests) | KeyStore unit tests (T-1 through T-3) |
| `packages/desktop/src-tauri/src/window_state.rs` (inline tests) | WindowState tests (T-4, T-5) |
| `packages/desktop/src-tauri/src/tray.rs` (inline tests) | TrayState icon selection (T-6) |
| `packages/desktop/src-tauri/src/notifications.rs` (inline tests) | Notification settings defaults (T-7) |
| `packages/desktop/src-tauri/src/state.rs` (inline tests) | DaemonClient health check error (T-8) |

### Rust Unit Tests

```rust
// T-1: KeyStore store + retrieve round-trip
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_retrieve_roundtrip() {
        let ks = KeyStore::new_with_test_backend();
        let key_bytes = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x42; 32];
        ks.store_key("test-key-1", &key_bytes).unwrap();
        let retrieved = ks.retrieve_key("test-key-1").unwrap();
        assert_eq!(key_bytes, retrieved);
    }

    // T-2: has_key returns false for non-existent
    #[test]
    fn has_key_nonexistent() {
        let ks = KeyStore::new_with_test_backend();
        assert_eq!(ks.has_key("nonexistent").unwrap(), false);
    }

    // T-3: delete non-existent key is idempotent
    #[test]
    fn delete_idempotent() {
        let ks = KeyStore::new_with_test_backend();
        assert!(ks.delete_key("nonexistent").is_ok());
    }
}
```

```rust
// T-4: WindowState serialization round-trip
#[test]
fn window_state_serde_roundtrip() {
    let state = WindowState { x: 100.0, y: 200.0, width: 900.0, height: 700.0, maximized: false };
    let json = serde_json::to_string(&state).unwrap();
    let deserialized: WindowState = serde_json::from_str(&json).unwrap();
    assert_eq!(state.x, deserialized.x);
    assert_eq!(state.width, deserialized.width);
}

// T-5: validate off-screen positions
#[test]
fn validate_offscreen_position() {
    let state = WindowState { x: 5000.0, y: 5000.0, width: 900.0, height: 700.0, maximized: false };
    let monitors = vec![MonitorInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 }];
    let validated = validate_window_position(&state, &monitors);
    assert!(validated.x >= 0.0 && validated.x < 1920.0);
    assert!(validated.y >= 0.0 && validated.y < 1080.0);
}
```

```rust
// T-6: TrayState icon selection
#[test]
fn tray_icon_selection() {
    // Each state returns a different icon (verified by size or content)
    assert_ne!(get_tray_icon_bytes(TrayState::Idle), get_tray_icon_bytes(TrayState::Running));
    assert_ne!(get_tray_icon_bytes(TrayState::Running), get_tray_icon_bytes(TrayState::Error));
}

// T-7: NotificationSettings default
#[test]
fn notification_settings_default() {
    let settings = NotificationSettings::default();
    assert!(settings.enabled);
    assert!(settings.permission_requests);
    assert!(settings.agent_complete);
    assert!(settings.agent_error);
    assert!(settings.updates);
    assert!(settings.daemon_status);
    assert!(settings.sound);
}

// T-8: DaemonClient health_check unreachable
#[tokio::test]
async fn daemon_health_check_unreachable() {
    let client = DaemonClient::new_with_url("http://127.0.0.1:1"); // unused port
    let result = client.health_check().await;
    assert!(result.is_err());
}
```

### TypeScript Test Updates

The existing 225 tests in `packages/desktop/src/__tests__/` test the TypeScript data layer and should continue to pass without modification. They mock `invoke()` and test the pure TypeScript logic.

Add 2 new tests (T-9, T-10):

```typescript
// T-9: Tauri bridge invoke wrappers call correct commands
// Already covered extensively by existing ipc-bridge.test.ts
// Verify the test count hasn't regressed

// T-10: Window state persistence save/restore cycle
// Already covered by window-state.test.ts
// Verify the test count hasn't regressed
```

These are essentially regression checks. The 225 existing tests already cover T-9 and T-10 comprehensively.

### Running Tests

```bash
# Rust tests
cd packages/desktop/src-tauri && cargo test

# TypeScript tests (existing 225)
pnpm --filter desktop run test
```

### Estimated Effort: M (6-8 hours)

---

## Complete File Manifest

All paths relative to `/home/meywd/Saqr/`.

### Files to CREATE (Rust backend)

| File | Task |
|------|------|
| `packages/desktop/src-tauri/Cargo.toml` | 1 |
| `packages/desktop/src-tauri/tauri.conf.json` | 1 |
| `packages/desktop/src-tauri/build.rs` | 1 |
| `packages/desktop/src-tauri/Entitlements.plist` | 1 |
| `packages/desktop/src-tauri/capabilities/default.json` | 1 |
| `packages/desktop/src-tauri/src/main.rs` | 1, 2, 3, 4, 7 |
| `packages/desktop/src-tauri/src/lib.rs` | 1 |
| `packages/desktop/src-tauri/src/state.rs` | 2 |
| `packages/desktop/src-tauri/src/tray.rs` | 3 |
| `packages/desktop/src-tauri/src/notifications.rs` | 4 |
| `packages/desktop/src-tauri/src/keystore.rs` | 5 |
| `packages/desktop/src-tauri/src/window_state.rs` | 6 |
| `packages/desktop/src-tauri/src/updater.rs` | 7 |
| `packages/desktop/src-tauri/src/commands/mod.rs` | 2 |
| `packages/desktop/src-tauri/src/commands/daemon.rs` | 2 |
| `packages/desktop/src-tauri/src/commands/keystore.rs` | 5 |
| `packages/desktop/src-tauri/src/commands/notifications.rs` | 4 |
| `packages/desktop/src-tauri/src/commands/tray.rs` | 3 |
| `packages/desktop/src-tauri/src/commands/windows.rs` | 6 |
| `packages/desktop/src-tauri/icons/icon.icns` | 1 |
| `packages/desktop/src-tauri/icons/icon.ico` | 1 |
| `packages/desktop/src-tauri/icons/icon.png` | 1 |
| `packages/desktop/src-tauri/icons/32x32.png` | 1 |
| `packages/desktop/src-tauri/icons/128x128.png` | 1 |
| `packages/desktop/src-tauri/icons/128x128@2x.png` | 1 |
| `packages/desktop/src-tauri/icons/tray-idle.png` | 3 |
| `packages/desktop/src-tauri/icons/tray-running.png` | 3 |
| `packages/desktop/src-tauri/icons/tray-attention.png` | 3 |
| `packages/desktop/src-tauri/icons/tray-error.png` | 3 |
| `packages/desktop/src-tauri/icons/tray-updating.png` | 3 |

### Files to CREATE (Frontend integration)

| File | Task |
|------|------|
| `packages/desktop/frontend/index.html` | 10 |

### Files to CREATE (CI/CD)

| File | Task |
|------|------|
| `.github/workflows/build-desktop.yml` | 9 |
| `.github/workflows/release-desktop.yml` | 9 |

### Files to MODIFY

| File | Change | Task |
|------|--------|------|
| `packages/desktop/package.json` | Add tauri scripts and @tauri-apps deps | 1 |
| `.github/workflows/ci.yml` | Add `cargo test` step for desktop Rust tests | 11 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Duration | Milestone |
|-------|-------|----------|-----------|
| **Phase 1: Scaffold** | Task 1 | 1-2 days | Empty Tauri window opens |
| **Phase 2: Core** | Task 2 | 1 day | App connects to daemon |
| **Phase 3: OS Integration** | Tasks 3, 4, 5, 6 (parallelizable) | 3-4 days | Full native features |
| **Phase 4: Updates** | Task 7 | 1 day | Auto-update works |
| **Phase 5: Frontend** | Task 10 | 0.5 day | Dashboard loads in WebView |
| **Phase 6: Packaging** | Task 8 | 1-2 days | Platform binaries |
| **Phase 7: CI/CD** | Task 9 | 1-2 days | Automated builds |
| **Phase 8: Tests** | Task 11 | 1-2 days | All tests pass |

Tasks 3, 4, 5, and 6 can be parallelized since they share only `AppState` (Task 2).

---

## IPC Command Contract Reference

This table maps every TypeScript IPC command to its Rust implementation. The TypeScript side is already implemented (Story 09). Story 17 implements the Rust side.

| TypeScript Command Name | TS Request Type | TS Response Type | Rust File | Rust Return Type |
|--------------------------|-----------------|------------------|-----------|------------------|
| `get_daemon_status` | `undefined` | `DaemonStatus` | `commands/daemon.rs` | `Result<DaemonStatus, String>` |
| `start_daemon` | `undefined` | `DaemonStatus` | `commands/daemon.rs` | `Result<DaemonStatus, String>` |
| `stop_daemon` | `undefined` | `undefined` | `commands/daemon.rs` | `Result<(), String>` |
| `store_key` | `{ keyId, keyBase64 }` | `undefined` | `commands/keystore.rs` | `Result<(), String>` |
| `retrieve_key` | `{ keyId }` | `string` | `commands/keystore.rs` | `Result<String, String>` |
| `delete_key` | `{ keyId }` | `undefined` | `commands/keystore.rs` | `Result<(), String>` |
| `has_key` | `{ keyId }` | `boolean` | `commands/keystore.rs` | `Result<bool, String>` |
| `send_notification` | `{ category, title, body }` | `undefined` | `commands/notifications.rs` | `Result<(), String>` |
| `get_notification_settings` | `undefined` | `NotificationSettings` | `commands/notifications.rs` | `Result<NotificationSettings, String>` |
| `set_notification_settings` | `NotificationSettings` | `undefined` | `commands/notifications.rs` | `Result<(), String>` |
| `open_agent_window` | `{ agentId, agentName }` | `WindowInfo` | `commands/windows.rs` | `Result<WindowInfo, String>` |
| `get_window_list` | `undefined` | `WindowInfo[]` | `commands/windows.rs` | `Result<Vec<WindowInfo>, String>` |
| `close_window` | `{ label }` | `undefined` | `commands/windows.rs` | `Result<(), String>` |
| `get_window_state` | `{ label }` | `WindowState \| null` | `commands/windows.rs` | `Result<Option<WindowState>, String>` |
| `update_tray_state` | `undefined` | `undefined` | `commands/tray.rs` | `Result<(), String>` |

**Critical**: Tauri 2 uses `camelCase` for IPC parameter names by default. The TypeScript bridge passes `{ keyId, keyBase64 }` (camelCase). The Rust `#[tauri::command]` must use matching parameter names with `#[serde(rename_all = "camelCase")]` or use `snake_case` parameters with Tauri's automatic `camelCase` to `snake_case` conversion (which is the default behavior in Tauri 2). Verify this during Task 2 implementation.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Dashboard requires Node.js server, not static files | High | Medium | Use `devUrl` in dev, proxy `index.html` in production. Document that daemon must run. |
| `keyring` crate failures on headless Linux/CI | High | Medium | Implement file-based fallback. Use `#[cfg(test)]` in-memory backend for tests. |
| Tauri 2 API version drift | Low | High | Pin exact crate versions. Monitor Tauri release notes. |
| System tray not supported on some Linux DEs | Medium | Low | Graceful degradation: log warning, quit-on-close. |
| WebView2 missing on Windows 10 LTSC | Medium | Medium | NSIS bootstrapper handles it automatically. |
| Cross-compilation for universal macOS binary | Medium | Medium | Use GitHub Actions macOS runner. Document local build steps. |
| IPC parameter name mismatch (camelCase vs snake_case) | Medium | High | Verify Tauri 2's automatic conversion in Task 2. Add integration test. |

---

## Notes for Implementer

1. **Do not modify existing TypeScript files.** The 225 tests in `packages/desktop/src/__tests__/` must continue to pass unmodified. The Rust backend is the new code.

2. **The TypeScript `IpcCommandMap` in `ipc-types.ts` is the source of truth.** Every Rust command must match the parameter names and types exactly. Reference lines 230-252 of `packages/desktop/src/ipc-types.ts`.

3. **The dashboard is a server-rendered HTML page**, not a static SPA. The Tauri app must connect to the running dashboard server (`http://localhost:7399`) during both development and production. This is a known limitation; a future story can extract the dashboard into a static build.

4. **Icon assets need a designer.** Use placeholder PNGs (solid colored circles) for development. Replace with designed assets before release packaging (Task 8).

5. **Generate the Tauri updater key pair early** (Task 1): `npx @tauri-apps/cli signer generate -w ~/.tauri/saqr.key`. The public key goes in `tauri.conf.json`, the private key in CI secrets.

6. **The `saqr` CLI binary must be on PATH** for `start_daemon` and `stop_daemon` IPC commands. Document this as a system requirement.

7. **Rust tests should not depend on OS keychain in CI.** Use an in-memory backend for keystore tests. The `keyring` crate supports a mock credential store for testing.

8. **Parameter naming convention**: Tauri 2 automatically converts `camelCase` JavaScript parameters to `snake_case` Rust parameters. So `{ keyId: "abc" }` in TypeScript becomes `key_id: String` in Rust. Verify this works correctly in Task 2 and add a test.
