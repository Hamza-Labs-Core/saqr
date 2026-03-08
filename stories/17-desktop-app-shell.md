# Story 17: Desktop App Shell (Tauri 2)

## Overview

Story 09 implemented the desktop data layer — TypeScript types, services, and 225 unit tests for IPC bridge, tray state, notification management, key storage, auto-update, and multi-window support. That data layer has no native code and no runnable application.

This story builds the **actual Tauri 2 desktop application** that consumes Story 09's data layer. It creates the Rust backend (system tray, secure key storage, notifications, auto-update) and wraps the Saqr dashboard (Story 06) in a native window — producing real .dmg, .msi, and .AppImage binaries.

The implementation follows Paseo's desktop architecture: Tauri 2 with Rust backend for OS integration, the web dashboard as the frontend, and GitHub Actions (tauri-action) for cross-platform builds.

**Guiding principle**: The Rust backend handles OS integration and security. The WebView frontend handles UI. All sensitive operations go through typed IPC commands — the frontend never accesses OS APIs directly.

---

## Scope

### In Scope

- Tauri 2 project structure (`packages/desktop/src-tauri/`)
- Rust backend: IPC commands, system tray, notifications, key storage, auto-update
- WebView configuration loading the dashboard frontend
- System tray with daemon status, agent list, quick actions
- Native OS notifications with action buttons (approve/deny permissions)
- Secure key storage (macOS Keychain, Windows DPAPI, Linux Secret Service)
- Auto-update via Tauri updater plugin (checks GitHub Releases)
- Multi-window support (main dashboard + per-agent windows)
- Single-instance detection
- Platform-specific builds:
  - macOS: .dmg (universal binary arm64 + x86_64), notarization
  - Windows: .msi (WiX) + .exe (NSIS), code signing
  - Linux: .AppImage + .deb
- GitHub Actions build pipeline (tauri-action)

### Out of Scope

- The dashboard frontend itself (Story 06 — this story wraps it)
- The daemon process (Stories 03-05 — the desktop app connects to it)
- Mobile app (Story 16)
- Custom window chrome or frameless windows (uses native title bar)

---

## Requirements

### 1. Tauri 2 Project Structure

```
packages/desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/
│   │   ├── icon.icns              # macOS
│   │   ├── icon.ico               # Windows
│   │   ├── icon.png               # Linux (512x512)
│   │   ├── 32x32.png
│   │   ├── 128x128.png
│   │   ├── 128x128@2x.png
│   │   ├── tray-idle.png
│   │   ├── tray-running.png
│   │   ├── tray-attention.png
│   │   └── tray-error.png
│   ├── src/
│   │   ├── main.rs                # Entry point
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── daemon.rs          # Daemon connection
│   │   │   ├── keystore.rs        # Secure key storage
│   │   │   ├── notifications.rs   # Notification dispatch
│   │   │   ├── tray.rs            # Tray state updates
│   │   │   └── windows.rs         # Window management
│   │   ├── tray.rs                # System tray setup
│   │   ├── notifications.rs       # OS notification dispatch
│   │   ├── keystore.rs            # Platform key storage
│   │   ├── updater.rs             # Auto-update logic
│   │   ├── state.rs               # Application state
│   │   └── window_state.rs        # Window persistence
│   └── capabilities/
│       └── default.json
├── src/                           # Frontend bridge (TypeScript)
│   ├── lib/
│   │   └── tauri-bridge.ts        # invoke() wrappers
│   └── ...
├── src/                           # Existing data layer (Story 09)
│   ├── types/
│   └── services/
├── package.json
└── tsconfig.json
```

### 2. Tauri Configuration

```json
{
  "productName": "Saqr",
  "version": "0.1.0",
  "identifier": "dev.saqr.desktop",
  "build": {
    "frontendDist": "../dashboard/dist",
    "devUrl": "http://localhost:7399"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [{
      "title": "Saqr",
      "width": 1200,
      "height": 800,
      "minWidth": 800,
      "minHeight": 600
    }],
    "trayIcon": {
      "iconPath": "icons/tray-idle.png",
      "iconAsTemplate": true
    },
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "macOS": { "minimumSystemVersion": "10.15" },
    "windows": { "digestAlgorithm": "sha256" }
  },
  "plugins": {
    "updater": {
      "endpoints": ["https://github.com/Hamza-Labs-Core/saqr/releases/latest/download/latest.json"],
      "pubkey": "<UPDATER_PUBLIC_KEY>"
    }
  }
}
```

### 3. System Tray

Five states: Idle, Running, Attention, Error, Updating.

Tray menu structure:
```
Saqr v0.1.x
Daemon: Running (PID 12345)
─────────────────────────
3 agents running
─────────────────────────
Open Dashboard          ⌘D
▸ Running Agents
  feature-auth (claude-4)
  test-suite (claude-4)
─────────────────────────
Start/Stop Daemon
─────────────────────────
Preferences...          ⌘,
Check for Updates...
─────────────────────────
Quit Saqr               ⌘Q
```

### 4. IPC Commands

All frontend ↔ Rust communication uses typed `invoke()` commands:

| Command | Parameters | Returns | Purpose |
|---------|-----------|---------|---------|
| `get_daemon_status` | — | `DaemonStatus` | Health check |
| `start_daemon` | — | `DaemonStatus` | Start daemon process |
| `stop_daemon` | — | `()` | Stop daemon process |
| `store_key` | `key_id, key_base64` | `()` | Store in OS keychain |
| `retrieve_key` | `key_id` | `String` (base64) | Read from OS keychain |
| `delete_key` | `key_id` | `()` | Remove from OS keychain |
| `has_key` | `key_id` | `bool` | Check key existence |
| `send_notification` | `title, body, actions` | `()` | OS notification |
| `update_tray_state` | `state, agents` | `()` | Update tray icon/menu |
| `open_agent_window` | `agent_id, agent_name` | `WindowInfo` | Open agent window |
| `get_window_list` | — | `Vec<WindowInfo>` | List open windows |
| `close_window` | `label` | `()` | Close window |

### 5. Secure Key Storage

Platform backends:
- **macOS**: Keychain Services via `keyring` crate
- **Windows**: DPAPI + Credential Manager via `keyring` crate
- **Linux**: Secret Service (GNOME Keyring / KWallet) via `keyring` crate

Keys are stored as base64 strings, decoded in Rust, and zeroed from memory after use (`zeroize` crate).

### 6. Auto-Update

Uses Tauri's built-in updater plugin. Checks GitHub Releases for a `latest.json` manifest. Downloads, verifies Ed25519 signature, installs, and restarts.

Update check: on startup (30s delay) + every 6 hours.

### 7. Rust Dependencies

```toml
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
dirs = "5"
thiserror = "2"
zeroize = "1"
reqwest = { version = "0.12", features = ["json"] }
```

---

## CI/CD — GitHub Actions Build

Desktop builds use `tauri-apps/tauri-action` in GitHub Actions, triggered by version tags.

### macOS Build

```yaml
# Runs on macos-latest
# 1. Setup Node.js 22 + Rust stable + aarch64-apple-darwin target
# 2. pnpm install, build dashboard frontend
# 3. tauri-action → .dmg + .app.tar.gz + .sig
# 4. Attach to GitHub Release
```

Requires for notarization:
- `APPLE_CERTIFICATE` (base64 .p12)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`

### Windows Build

```yaml
# Runs on windows-latest
# 1. Setup Node.js 22 + Rust stable
# 2. pnpm install, build dashboard frontend
# 3. tauri-action → .msi + .nsis + .exe
# 4. Attach to GitHub Release
```

### Linux Build

```yaml
# Runs on ubuntu-22.04
# 1. apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
# 2. Setup Node.js 22 + Rust stable
# 3. pnpm install, build dashboard frontend
# 4. tauri-action → .AppImage + .deb
# 5. Attach to GitHub Release
```

---

## Testing Plan

### Unit Tests (Rust)

| Test | Description |
|------|-------------|
| T-1 | KeyStore: store + retrieve round-trip produces identical bytes |
| T-2 | KeyStore: has_key returns false for non-existent key |
| T-3 | KeyStore: delete non-existent key is idempotent |
| T-4 | WindowState: serialization/deserialization round-trip |
| T-5 | WindowState: validates off-screen positions |
| T-6 | TrayState: icon selection returns correct variant |
| T-7 | NotificationSettings: default has all enabled |
| T-8 | DaemonClient: health_check returns error when unreachable |

### Unit Tests (TypeScript — extend existing 225)

| Test | Description |
|------|-------------|
| T-9 | Tauri bridge: invoke wrappers call correct commands |
| T-10 | Window state persistence: save/restore cycle |

### Integration Tests

| Test | Description |
|------|-------------|
| T-11 | App launches and displays main window within 3 seconds |
| T-12 | Tray icon appears and responds to click |
| T-13 | Opening agent window creates new native window |
| T-14 | IPC store_key + retrieve_key round-trip from frontend |
| T-15 | Single-instance: second launch focuses first |

---

## Definition of Done

- [ ] `cargo tauri dev` launches the app with the dashboard frontend
- [ ] System tray shows daemon status with correct icon states
- [ ] Tray menu lists running agents dynamically
- [ ] IPC commands work for all 12 defined commands
- [ ] Keys stored/retrieved via OS keychain on all 3 platforms
- [ ] Auto-updater checks GitHub Releases for updates
- [ ] Multi-window: agent windows open/close/persist position
- [ ] Single-instance detection prevents duplicate launches
- [ ] macOS: .dmg builds with universal binary
- [ ] Windows: .msi + .exe installer builds
- [ ] Linux: .AppImage + .deb builds
- [ ] GitHub Actions pipeline builds all 3 platforms on tag push
- [ ] Existing 225 data layer tests still pass
- [ ] 8 new Rust unit tests pass
- [ ] Release assets attached to GitHub Release automatically
