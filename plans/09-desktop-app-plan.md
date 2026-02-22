# Implementation Plan: Story 09 -- Desktop App (Tauri)

**Date**: 2026-02-22
**Story**: 15-desktop-app
**Status**: Planning
**Estimated Total Effort**: ~12-15 days (96-120 hours)
**Prerequisites**: Story 06 (Local Dashboard / F4) must be implemented -- the desktop app wraps the dashboard frontend. Story 05 (Agent Process Orchestration / F3) must be implemented -- the app connects to the running daemon. Story 07 (Encrypted Cloud Sync / F5) design must be stable -- the key storage IPC serves F5's encryption keys.
**Platform Evaluation**: See `docs/PLATFORM-EVALUATION.md` for Tauri 2 selection rationale.

### Relationship to Other Stories

This is the **native desktop wrapper** story. It produces a cross-platform Tauri 2 application (`agentcontext-desktop/`) that integrates with the operating system at a level impossible in a browser:

- **Story 06** (Local Dashboard / F4): The dashboard frontend is loaded inside the Tauri WebView. This story wraps it; it does not build it.
- **Story 05** (Agent Process Orchestration / F3): The desktop app connects to the daemon's HTTP/WS server for agent status, lifecycle management, and streaming. The `DaemonClient` in Rust hits the daemon's REST API.
- **Story 07** (Encrypted Cloud Sync / F5): The desktop app provides secure key storage (macOS Keychain, Windows DPAPI, Linux Secret Service) for F5's encryption keys. F5 calls the key storage IPC commands.
- **Story 08** (Mobile App / F6): Shares the same daemon API contract and notification event types. No direct code dependency, but consistent IPC semantics.
- **Story 12** (Security & Encryption / F10): Key storage backend aligns with F10.6 (Desktop keychain). Biometric gating aligns with F10 design.

### Amendment Impacts on This Plan

None. This is a new story with no prior amendments.

---

## Task Dependency Graph

```
Task 1: Tauri 2 Project Scaffold
  |
  +---> Task 2: Application State & Daemon Client
  |       |
  |       +---> Task 3: System Tray (needs 2)
  |       |       |
  |       |       +---> Task 7: Platform-Specific Packaging (needs 3, 4, 5, 6)
  |       |
  |       +---> Task 4: Native Notifications (needs 2)
  |       |       |
  |       |       +---> Task 7: Platform-Specific Packaging (needs 3, 4, 5, 6)
  |       |
  |       +---> Task 5: Secure Key Storage (needs 2)
  |       |       |
  |       |       +---> Task 7: Platform-Specific Packaging (needs 3, 4, 5, 6)
  |       |
  |       +---> Task 6: Multi-Window & Window State (needs 2)
  |               |
  |               +---> Task 7: Platform-Specific Packaging (needs 3, 4, 5, 6)
  |
  +---> Task 8: Auto-Update System (needs 1, 2)
  |       |
  |       +---> Task 9: CI/CD Build Pipeline (needs 7, 8)
  |
  +---> Task 10: Frontend IPC Bridge (needs 2, 3, 4, 5, 6)
  |       |
  |       +---> Task 11: Integration & Platform Tests (needs all)
  |
  +---> Task 11: Integration & Platform Tests (needs all)
```

---

## Tasks

### Task 1: Tauri 2 Project Scaffold

**Description**

Initialize the Tauri 2 project structure under `agentcontext-desktop/` at the repository root. This establishes the Rust backend skeleton, Cargo.toml with all dependencies, tauri.conf.json, capabilities configuration, build script, and icon placeholders. The scaffold must compile and open an empty window before any features are added.

**Prerequisites/Inputs**

- Rust toolchain (rustup, cargo) installed with `stable` channel.
- Node.js 18+ for frontend build tooling.
- Tauri CLI: `cargo install tauri-cli@2`.
- Platform dependencies: WebKitGTK (Linux), Xcode CLT (macOS), Visual Studio Build Tools + WebView2 (Windows).

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/Cargo.toml` | Rust dependencies (see below) |
| `agentcontext-desktop/src-tauri/tauri.conf.json` | Tauri configuration (window, tray, security, bundle) |
| `agentcontext-desktop/src-tauri/build.rs` | Tauri build script (`tauri_build::build()`) |
| `agentcontext-desktop/src-tauri/src/main.rs` | Entry point with plugin registration and invoke handler |
| `agentcontext-desktop/src-tauri/src/lib.rs` | Library root re-exporting modules |
| `agentcontext-desktop/src-tauri/src/commands/mod.rs` | Command module declarations |
| `agentcontext-desktop/src-tauri/capabilities/default.json` | Permission capabilities |
| `agentcontext-desktop/src-tauri/icons/` | Placeholder icon files (all required sizes) |
| `agentcontext-desktop/src-tauri/Entitlements.plist` | macOS entitlements (Keychain, networking) |
| `agentcontext-desktop/src/index.html` | Minimal HTML that loads the dashboard |
| `agentcontext-desktop/package.json` | Frontend build tooling (npm scripts for dev/build) |

Cargo.toml dependencies:

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
env_logger = "0.11"
dirs = "5"
once_cell = "1"
thiserror = "2"
zeroize = "1"
reqwest = { version = "0.12", features = ["json"] }

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

`tauri.conf.json` key settings:

- `productName`: "AgentContext"
- `identifier`: "com.agentcontext.desktop"
- `build.frontendDist`: "../src/dist"
- `build.devUrl`: "http://localhost:5173"
- `app.windows[0]`: 1200x800, min 800x600, centered, decorated, resizable
- `app.trayIcon.iconPath`: "icons/tray-icon.png", `iconAsTemplate`: true
- `app.security.csp`: `"default-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; style-src 'self' 'unsafe-inline'"`
- Bundle config for macOS (.dmg), Windows (.msi, .nsis), Linux (.AppImage, .deb)

`capabilities/default.json` permissions:

```json
{
  "identifier": "default",
  "description": "Default capability set",
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

Minimal `main.rs` (compiles and opens a window):

```rust
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
        .expect("error while running AgentContext");
}
```

Entitlements.plist:

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
        <string>$(TeamIdentifierPrefix)com.agentcontext.desktop</string>
    </array>
</dict>
</plist>
```

**Acceptance Criteria**

- [ ] `cargo tauri dev` compiles the Rust backend and opens a native window showing the placeholder HTML
- [ ] `cargo tauri build` produces a distributable binary for the current platform
- [ ] The single-instance plugin prevents opening a second instance (second launch focuses existing window)
- [ ] All Cargo dependencies resolve without conflicts
- [ ] `tauri.conf.json` passes Tauri schema validation
- [ ] `capabilities/default.json` grants all required permissions
- [ ] Icon placeholders are present in all required sizes (32x32, 128x128, 128x128@2x, .icns, .ico, 512x512 .png)

**Edge Cases**

- Missing platform dependencies (WebKitGTK on Linux): `cargo tauri build` fails with a clear error message pointing to the missing library.
- Running on Wayland vs X11: Tauri 2 handles this transparently via WebKitGTK.
- M1/M2 Mac building x86_64 target: requires Rosetta or cross-compilation setup; documented in README.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 2: Application State & Daemon Client

**Description**

Implement the `AppState` struct that holds shared application state (daemon client, keystore, notification settings, tray availability) and the `DaemonClient` that communicates with the locally running AgentContext daemon over HTTP. This is the foundation all IPC commands depend on.

**Prerequisites/Inputs**

- Task 1 (project scaffold) complete.
- Daemon HTTP API contract from Story 05 (F3): `GET /api/health` returns `DaemonStatus`.
- Daemon default port: 7399 (HTTP), configurable via environment or config file.

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/src/state.rs` | `AppState` struct, `DaemonClient`, `daemon_health_loop` |
| `agentcontext-desktop/src-tauri/src/commands/daemon.rs` | IPC commands: `get_daemon_status`, `start_daemon`, `stop_daemon` |
| `agentcontext-desktop/src-tauri/src/commands/mod.rs` | Module declarations for daemon, keystore, notifications, tray, windows |
| `agentcontext-desktop/src-tauri/src/main.rs` | Register `AppState` as managed state, register daemon commands |

`AppState` struct:

```rust
pub struct AppState {
    pub daemon_client: Arc<Mutex<DaemonClient>>,
    pub keystore: KeyStore,
    pub notification_settings: Arc<Mutex<NotificationSettings>>,
    pub tray_available: Arc<std::sync::atomic::AtomicBool>,
}
```

`DaemonClient` struct:

```rust
pub struct DaemonClient {
    base_url: String,           // "http://localhost:7399"
    http_client: reqwest::Client,
}
```

Key methods on `DaemonClient`:

- `health_check(&self) -> Result<DaemonStatus, Box<dyn Error>>` -- GET `/api/health` with 3-second timeout
- `get_agents(&self) -> Result<Vec<AgentInfo>, Box<dyn Error>>` -- GET `/api/agents`
- `respond_to_permission(&self, request_id: &str, approved: bool) -> Result<(), Box<dyn Error>>` -- POST `/api/permissions/{request_id}`

`DaemonStatus` struct:

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

`daemon_health_loop` -- spawned as an async task in `setup()`:

- Runs every 5 seconds.
- Calls `health_check()` and emits the result to all windows via `app.emit("daemon-status", status)`.
- Updates tray state based on result: `Ok(active_agents > 0)` -> Running, `Ok(0)` -> Idle, `Err` -> Error.
- On first connection failure after a previous success, sends a "Daemon Stopped" notification (if notifications enabled).

IPC commands:

```rust
#[tauri::command]
pub async fn get_daemon_status(state: State<'_, AppState>) -> Result<DaemonStatus, String>;

#[tauri::command]
pub async fn start_daemon() -> Result<DaemonStatus, String>;
// Runs `agentctx daemon start` via tokio::process::Command

#[tauri::command]
pub async fn stop_daemon() -> Result<(), String>;
// Runs `agentctx daemon stop` via tokio::process::Command
```

Registration in `main.rs`:

```rust
.manage(AppState::new())
.setup(|app| {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        crate::state::daemon_health_loop(handle).await;
    });
    Ok(())
})
.invoke_handler(tauri::generate_handler![
    crate::commands::daemon::get_daemon_status,
    crate::commands::daemon::start_daemon,
    crate::commands::daemon::stop_daemon,
])
```

**Acceptance Criteria**

- [ ] `AppState` is registered as managed Tauri state and accessible from all IPC commands via `State<'_, AppState>`
- [ ] `get_daemon_status` returns a `DaemonStatus` JSON object when the daemon is running
- [ ] `get_daemon_status` returns a descriptive error string when the daemon is unreachable
- [ ] `start_daemon` launches the daemon process and waits up to 5 seconds for it to become healthy
- [ ] `stop_daemon` sends the stop command and confirms the daemon has stopped
- [ ] `daemon_health_loop` emits `daemon-status` events to all windows every 5 seconds
- [ ] Health check has a 3-second timeout to avoid blocking
- [ ] `DaemonClient.base_url` can be overridden via `AGENTCTX_DAEMON_URL` environment variable

**Edge Cases**

- E-1 (Daemon Not Running on App Launch): `health_check` returns `Err`, health loop sets tray to Error state, frontend receives `daemon-status` event with `running: false`.
- Daemon port conflict: `start_daemon` reports the stderr output from `agentctx daemon start` which includes port-in-use errors.
- Network interface changes (VPN connects/disconnects): Health loop uses `localhost` which is unaffected by network changes.

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 3: System Tray

**Description**

Implement the system tray icon with state-based icons, a dynamic context menu showing daemon status and running agents, and hide-to-tray behavior on window close. The tray is the persistent UI element that keeps the app running in the background.

**Prerequisites/Inputs**

- Task 2 (AppState and DaemonClient) complete.
- Tray icon image files: 5 state variants (idle, running, attention, error, updating) as PNG files at appropriate sizes for each platform.
- Agent list from daemon API: `GET /api/agents` returning `Vec<AgentInfo>`.

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/src/tray.rs` | Tray setup, icon state management, menu building, event handlers |
| `agentcontext-desktop/src-tauri/src/main.rs` | Call `tray::setup_tray(app)` in setup, intercept window close event |
| `agentcontext-desktop/src-tauri/icons/tray-idle.png` | Gray circle icon (22x22 for macOS template, 32x32 for others) |
| `agentcontext-desktop/src-tauri/icons/tray-running.png` | Green circle icon |
| `agentcontext-desktop/src-tauri/icons/tray-attention.png` | Orange circle icon |
| `agentcontext-desktop/src-tauri/icons/tray-error.png` | Red circle icon |
| `agentcontext-desktop/src-tauri/icons/tray-updating.png` | Blue circle icon |

`TrayState` enum:

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

`AgentInfo` struct (matches daemon API):

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub model: String,
    pub status: String,  // "running", "idle", "error"
    pub project: String,
}
```

`TrayDebouncer` -- prevents rapid tray rebuilds when multiple agents change status within 500ms:

```rust
pub struct TrayDebouncer {
    pending: Arc<Mutex<Option<(TrayState, Vec<AgentInfo>)>>>,
    debounce_ms: u64,  // 500
}
```

Key functions:

- `setup_tray(app: &App) -> Result<(), Box<dyn Error>>` -- Creates tray icon, registers menu, sets event handlers. If tray creation fails (e.g., no tray support on Sway/i3), logs a warning and sets `tray_available = false` in AppState.
- `build_tray_menu(app, state, agents) -> Result<Menu, Error>` -- Constructs the full menu (header, daemon status, separator, agent count, separator, "Open Dashboard", "Start New Agent...", separator, "Running Agents" submenu with per-agent items, separator, "Start/Stop Daemon", separator, "Preferences...", "Check for Updates...", separator, "Quit AgentContext", "Quit All").
- `update_tray(app, state, agents)` -- Updates icon, tooltip, and menu. Called by `daemon_health_loop` and `TrayDebouncer`.
- `get_tray_icon(state) -> Image` -- Returns the appropriate icon using `include_bytes!()`.
- `format_tooltip(state, agents) -> String` -- e.g., "AgentContext -- 3 agents running".
- `handle_tray_menu_event(app, event_id)` -- Dispatches menu actions: "open-dashboard" shows/focuses main window, "agent-{id}" opens agent window, "start-daemon"/"stop-daemon" calls daemon commands, "preferences" opens settings window, "check-updates" triggers update check, "quit" exits app, "quit-all" stops daemon then exits.

Window close interception (in `setup()`):

```rust
let window = app.get_webview_window("main").unwrap();
let window_clone = window.clone();
window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if app_state.is_tray_available() {
            api.prevent_close();
            let _ = window_clone.hide();
        }
        // If tray not available, let the close proceed (quits the app)
    }
});
```

**Acceptance Criteria**

- [ ] System tray icon appears on all three platforms when the app launches
- [ ] Tray icon changes to reflect current state (idle/running/attention/error/updating)
- [ ] Tray menu shows daemon status line (e.g., "Daemon: Running (PID 12345)")
- [ ] Tray menu shows running agent count
- [ ] "Running Agents" submenu dynamically lists active agents with names and models
- [ ] Clicking an agent in the submenu opens (or focuses) that agent's window
- [ ] Left-clicking the tray icon toggles main window visibility
- [ ] Closing the main window hides to tray instead of quitting (when tray is available)
- [ ] Closing the main window quits the app when no tray is available (Linux fallback)
- [ ] "Quit AgentContext" exits the app but leaves the daemon running
- [ ] "Quit All" stops the daemon and then exits the app
- [ ] macOS: tray icon uses template mode (`iconAsTemplate: true`) for dark/light menu bar adaptation
- [ ] Tray updates are debounced: multiple status changes within 500ms result in one tray rebuild
- [ ] Menu updates within 2 seconds of an agent starting or stopping

**Edge Cases**

- E-8 (Rapid Agent Status Changes): `TrayDebouncer` coalesces multiple updates within 500ms.
- Linux without tray support (Sway/i3): `setup_tray` catches the error, sets `tray_available = false`, app quits on window close instead of hiding.
- macOS menu bar conventions: left-click shows menu (not toggle) on macOS; Tauri handles this automatically.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 4: Native Notifications

**Description**

Implement OS-level notifications for agent events (permission requests, agent completion, agent errors, update availability, daemon status) with action buttons. Handle notification action callbacks to respond to permission requests and open agent windows without requiring the main window to be focused.

**Prerequisites/Inputs**

- Task 2 (AppState and DaemonClient) complete.
- `tauri-plugin-notification` initialized in main.rs.
- Daemon WebSocket API: subscribe to agent events to trigger notifications in real time.

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/src/notifications.rs` | Notification dispatch functions, settings management, settings persistence |
| `agentcontext-desktop/src-tauri/src/commands/notifications.rs` | IPC commands: `send_notification`, `get_notification_settings`, `set_notification_settings` |
| `agentcontext-desktop/src-tauri/src/main.rs` | Register notification action handler in setup, register notification IPC commands |

`NotificationSettings` struct:

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub permission_requests: bool,
    pub agent_complete: bool,
    pub agent_error: bool,
    pub updates: bool,
    pub daemon_status: bool,
    pub sound: bool,
}
```

Settings persistence:
- Load from `{app_data_dir}/notification-settings.json` on startup.
- Save to the same file on change via `set_notification_settings` IPC.
- Default: all categories enabled, sound enabled.

Notification dispatch functions:

- `send_permission_notification(app, agent_name, tool_name, tool_input_summary, request_id) -> Result<(), String>` -- Title: "{agent_name} needs permission". Body: "{tool_name}: {tool_input_summary}". Actions: "Approve" (`approve:{request_id}`), "Deny" (`deny:{request_id}`).
- `send_agent_complete_notification(app, agent_name, summary, agent_id) -> Result<(), String>` -- Title: "{agent_name} finished". Body: summary (truncated to 200 chars). Actions: "Open" (`open:{agent_id}`).
- `send_agent_error_notification(app, agent_name, error_message, agent_id) -> Result<(), String>` -- Title: "{agent_name} encountered an error". Body: error_message (truncated to 200 chars). Actions: "Open" (`open:{agent_id}`), "Retry" (`retry:{agent_id}`).
- `send_update_notification(app, version, notes) -> Result<(), String>` -- Title: "Update Available: v{version}". Body: notes (truncated to 200 chars). Actions: "Update" (`update`), "Later" (dismiss).
- `send_daemon_stopped_notification(app) -> Result<(), String>` -- Title: "Daemon Disconnected". Body: "The AgentContext daemon has stopped unexpectedly." Actions: "Restart" (`restart-daemon`), "Ignore" (dismiss).

Each function checks `NotificationSettings` before sending; if the relevant category is disabled, returns `Ok(())` silently.

Body text truncation: if body length exceeds 200 characters, truncate to 197 + "...".

Notification action handler (in `setup()`):

```rust
app.notification().on_action(|app, action| {
    let parts: Vec<&str> = action.action_id.splitn(2, ':').collect();
    match parts.as_slice() {
        ["approve", request_id] => { /* POST /api/permissions/{id} approved=true */ }
        ["deny", request_id]   => { /* POST /api/permissions/{id} approved=false */ }
        ["open", agent_id]     => { /* open_agent_window_internal(app, agent_id) */ }
        ["retry", agent_id]    => { /* POST /api/agents/{id}/restart */ }
        ["update"]             => { /* trigger download_and_install() */ }
        ["restart-daemon"]     => { /* run agentctx daemon start */ }
        _ => { log::warn!("Unknown notification action: {}", action.action_id); }
    }
});
```

IPC commands:

```rust
#[tauri::command]
pub async fn get_notification_settings(state: State<'_, AppState>) -> Result<NotificationSettings, String>;

#[tauri::command]
pub async fn set_notification_settings(state: State<'_, AppState>, settings: NotificationSettings) -> Result<(), String>;

#[tauri::command]
pub async fn send_notification(app: AppHandle, category: String, title: String, body: String) -> Result<(), String>;
// For frontend-triggered notifications (e.g., custom alerts)
```

**Acceptance Criteria**

- [ ] Permission request notifications display with "Approve" and "Deny" action buttons
- [ ] Clicking "Approve" sends the approval to the daemon via REST API without opening the app window
- [ ] Clicking "Deny" sends the denial to the daemon via REST API
- [ ] Agent completion notifications show agent name and truncated summary
- [ ] Agent error notifications show "Open" and "Retry" action buttons
- [ ] "Retry" action button triggers agent restart via daemon API
- [ ] Daemon stopped notification shows "Restart" and "Ignore" buttons
- [ ] Notifications are not sent for disabled categories (per `NotificationSettings`)
- [ ] Notification settings persist to `{app_data_dir}/notification-settings.json` across restarts
- [ ] Body text longer than 200 characters is truncated with ellipsis
- [ ] macOS: notifications appear in Notification Center and respect Focus mode
- [ ] Windows: notifications appear in Action Center and respect Focus Assist
- [ ] Linux: notifications use the system notification daemon (libnotify-compatible)

**Edge Cases**

- E-4 (Notification Permissions Denied): The app sends notifications unconditionally via the Tauri plugin. If the OS blocks them, the tray icon "Attention" state still works as a fallback visual indicator. The frontend can check `notification:allow-is-permission-granted` to show an in-app indicator.
- Rapid permission requests: Multiple notifications may stack in the notification center; each has a unique `request_id` so actions route correctly.
- App backgrounded when action is triggered: `on_action` runs in the Rust backend regardless of window focus state.

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 5: Secure Key Storage

**Description**

Implement platform-specific secure key storage using the `keyring` crate for cross-platform credential management. Keys are stored as base64-encoded strings in the OS credential manager (macOS Keychain, Windows DPAPI/Credential Manager, Linux Secret Service). Expose store, retrieve, delete, and has_key operations via IPC commands. Add biometric gating support for macOS Touch ID and Windows Hello. Implement a file-based fallback for Linux systems without Secret Service.

**Prerequisites/Inputs**

- Task 2 (AppState with `keystore` field) complete.
- `keyring` crate v3 in Cargo.toml.
- `base64` crate v0.22 for encoding/decoding.
- `zeroize` crate v1 for secure memory clearing.
- Story 07 (F5) defines the key IDs and usage patterns for encryption keys.

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/src/keystore.rs` | `KeyStore` struct, `KeyStoreError` enum, platform-specific storage logic, biometric gating, file fallback |
| `agentcontext-desktop/src-tauri/src/commands/keystore.rs` | IPC commands: `store_key`, `retrieve_key`, `delete_key`, `has_key` |
| `agentcontext-desktop/src-tauri/src/main.rs` | Register keystore IPC commands in invoke handler |

`KeyStore` struct:

```rust
const SERVICE_NAME: &str = "com.agentcontext.desktop";

pub struct KeyStore {
    service: String,
}
```

Core methods:

- `store_key(&self, key_id: &str, key_bytes: &[u8]) -> Result<(), KeyStoreError>` -- Base64-encodes `key_bytes`, stores under account `key:{key_id}` via `keyring::Entry`.
- `retrieve_key(&self, key_id: &str) -> Result<Vec<u8>, KeyStoreError>` -- Retrieves base64 string, decodes to bytes. Uses `zeroize` to clear the base64 string from memory after decoding.
- `delete_key(&self, key_id: &str) -> Result<(), KeyStoreError>` -- Deletes the credential. If key does not exist, returns `Ok(())` (idempotent).
- `has_key(&self, key_id: &str) -> Result<bool, KeyStoreError>` -- Attempts retrieval; returns `true` if found, `false` if `KeyNotFound`, propagates other errors.

`KeyStoreError` enum:

```rust
#[derive(Debug, thiserror::Error)]
pub enum KeyStoreError {
    #[error("Key not found: {0}")]
    KeyNotFound(String),
    #[error("Backend error: {0}")]
    BackendError(String),
    #[error("Store error: {0}")]
    StoreError(String),
    #[error("Retrieve error: {0}")]
    RetrieveError(String),
    #[error("Delete error: {0}")]
    DeleteError(String),
    #[error("Decode error: {0}")]
    DecodeError(String),
    #[error("Biometric authentication failed: {0}")]
    BiometricFailed(String),
}
```

Biometric gating (`store_key_with_biometric`):

```rust
pub fn store_key_with_biometric(
    &self, key_id: &str, key_bytes: &[u8], require_biometric: bool,
) -> Result<(), KeyStoreError> {
    #[cfg(target_os = "macos")]
    if require_biometric {
        return self.store_key_macos_biometric(key_id, key_bytes);
        // Uses Security.framework with kSecAccessControlBiometryCurrentSet
    }
    #[cfg(target_os = "windows")]
    if require_biometric {
        return self.store_key_windows_biometric(key_id, key_bytes);
        // Uses CRED_FLAGS_REQUIRE_CONFIRMATION
    }
    // Linux and fallback: store without biometric
    self.store_key(key_id, key_bytes)
}
```

Linux fallback (E-5 handling):

```rust
fn store_key_file_fallback(&self, key_id: &str, key_bytes: &[u8]) -> Result<(), KeyStoreError> {
    // Derive machine-specific key from /etc/machine-id + uid
    // Encrypt key_bytes with XChaCha20-Poly1305 using derived key
    // Write to ~/.local/share/agentcontext/keys.enc (JSON map of key_id -> encrypted_value)
    // Log warning: "Secure key storage unavailable. Using encrypted file fallback."
}
```

IPC commands:

```rust
#[tauri::command]
pub async fn store_key(state: State<'_, AppState>, key_id: String, key_base64: String) -> Result<(), String>;

#[tauri::command]
pub async fn retrieve_key(state: State<'_, AppState>, key_id: String) -> Result<String, String>;
// Returns base64-encoded key bytes

#[tauri::command]
pub async fn delete_key(state: State<'_, AppState>, key_id: String) -> Result<(), String>;

#[tauri::command]
pub async fn has_key(state: State<'_, AppState>, key_id: String) -> Result<bool, String>;
```

Memory safety:
- After base64 decoding, use `zeroize::Zeroize` trait to clear temporary strings and byte vectors.
- Error messages must never include key material or base64-encoded values.

**Acceptance Criteria**

- [ ] Keys can be stored, retrieved, and deleted via IPC commands from the frontend
- [ ] `store_key` + `retrieve_key` round-trip produces identical bytes (tested with 32-byte and 64-byte keys)
- [ ] macOS: keys stored in login keychain under `com.agentcontext.desktop` service
- [ ] Windows: keys stored in Windows Credential Manager via DPAPI
- [ ] Linux: keys stored in Secret Service (GNOME Keyring or KWallet) when available
- [ ] `has_key` returns `true` for existing keys, `false` for non-existent keys, without retrieving key material
- [ ] `delete_key` on a non-existent key returns `Ok(())` (idempotent)
- [ ] macOS: biometric gating with Touch ID works when `require_biometric` is true
- [ ] Windows: biometric gating with Windows Hello works when `require_biometric` is true
- [ ] Linux: biometric gating is gracefully skipped (stored without biometric, no error)
- [ ] Linux without Secret Service: file-based fallback is used, warning is logged
- [ ] Key material is zeroed from memory after use (`zeroize` crate)
- [ ] Error messages never contain key material or base64 values

**Edge Cases**

- E-5 (Key Storage Backend Unavailable on Linux): `keyring::Entry::new()` returns an error. Catch this and fall back to encrypted file storage at `~/.local/share/agentcontext/keys.enc`. Log warning. Show fallback indicator in settings UI.
- Keychain locked (macOS): User is prompted by OS to unlock; `keyring` crate surfaces this as an error if the user cancels.
- Key too large: `keyring` has platform-specific limits. Document that keys should be < 2048 bytes. Validate in `store_key` IPC command.

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 6: Multi-Window & Window State Persistence

**Description**

Implement support for multiple native windows (main dashboard, per-agent views, settings panel) with persistent window positions and sizes. Windows communicate via Tauri's event system. Implement keyboard shortcuts for window management.

**Prerequisites/Inputs**

- Task 2 (AppState) complete.
- Dashboard frontend supports URL-based routing: `/` for main dashboard, `/agent/{id}` for agent detail, `/settings` for preferences.

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/src/window_state.rs` | Window position/size persistence (load, save, validate) |
| `agentcontext-desktop/src-tauri/src/commands/windows.rs` | IPC commands: `open_agent_window`, `get_window_list`, `close_window`, `get_window_state` |
| `agentcontext-desktop/src-tauri/src/main.rs` | Register window commands, add window event listeners for state persistence |

Window types:

| Window | Label Pattern | Default Size | Min Size | Content URL |
|--------|---------------|-------------|----------|-------------|
| Main | `main` | 1200x800 | 800x600 | `/` |
| Agent | `agent-{id}` | 900x700 | 600x400 | `/agent/{id}` |
| Settings | `settings` | 700x500 | 500x400 | `/settings` |

`WindowState` struct:

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}
```

Persistence file: `{app_data_dir}/window-states.json` -- a JSON map of `label -> WindowState`.

State persistence implementation:

- Uses `once_cell::sync::Lazy<Mutex<HashMap<String, WindowState>>>` for in-memory cache.
- `load_all_states()` reads from disk on first access.
- `save_position(label, x, y)` and `save_size(label, width, height)` update in-memory and persist to disk.
- `persist_states()` writes the full HashMap to JSON. Debounced: does not write more than once per second (uses last-write timestamp check).
- `mark_closed(label)` -- keeps state for later reopening, does not remove from map.

Window position validation (`validate_window_position`):

```rust
pub fn validate_window_position(state: &WindowState, monitors: &[Monitor]) -> WindowState {
    // Check if (state.x, state.y) is within any monitor bounds
    // If not, return state with x/y centered on primary monitor
    // Handles E-6 (window restored to invalid position after monitor disconnect)
}
```

Uses `app.available_monitors()` Tauri API for multi-monitor detection.

`open_agent_window` IPC command:

```rust
#[tauri::command]
pub async fn open_agent_window(
    app: tauri::AppHandle,
    agent_id: String,
    agent_name: String,
) -> Result<WindowInfo, String>
```

Logic:
1. Compute label: `format!("agent-{}", agent_id)`.
2. If window with this label exists: `show()` + `set_focus()`, return its info.
3. Load saved state for this label (or use defaults 900x700).
4. Validate position against available monitors.
5. Create `WebviewWindowBuilder` with URL `/agent/{agent_id}`, title "Agent: {agent_name}".
6. Register `on_window_event` for `Moved`, `Resized`, `Destroyed` to persist state.
7. Return `WindowInfo`.

Window-to-window communication:

```rust
// Rust-side: emit to all windows
app.emit("agent-status-changed", payload)?;

// Frontend-side: listen in any window
listen<T>("agent-status-changed", callback);

// Frontend-side: emit from any window
emit("navigate-to-agent", { agentId: "abc123" });
```

Keyboard shortcuts (registered via Tauri's global shortcut or menu accelerators):

| Shortcut | macOS | Windows/Linux | Action |
|----------|-------|---------------|--------|
| New Agent | Cmd+N | Ctrl+N | Emit "new-agent" event to main window |
| Close Window | Cmd+W | Ctrl+W | Close current window (hide if main) |
| Dashboard | Cmd+D | Ctrl+D | Show/focus main window |
| Preferences | Cmd+, | Ctrl+, | Open settings window |
| Quit | Cmd+Q | Alt+F4 | Quit application |

**Acceptance Criteria**

- [ ] Opening an agent window creates a new native window showing `/agent/{id}` content
- [ ] Opening the same agent twice focuses the existing window instead of creating a duplicate
- [ ] Window position and size are saved on move/resize events
- [ ] Window position and size are restored when the same window label is reopened
- [ ] Saved position is validated against available monitors; off-screen windows are re-centered (E-6)
- [ ] Closing an agent window actually closes it (not hide-to-tray like the main window)
- [ ] `get_window_list` returns all open windows with their labels, titles, sizes, positions, and focus states
- [ ] Events emitted from one window (via `app.emit()`) are received by all other windows
- [ ] Keyboard shortcuts work on all platforms with correct modifier keys
- [ ] The main window cannot be closed, only hidden (close button hides to tray)
- [ ] Settings window is a singleton (opening twice focuses existing)
- [ ] Up to 10 agent windows can be open simultaneously without performance degradation
- [ ] Window state file persists at `{app_data_dir}/window-states.json` and survives app restarts

**Edge Cases**

- E-6 (Window Restored to Invalid Position): `validate_window_position` checks all monitors. If position is off-screen, centers on primary monitor. If `available_monitors()` fails, falls back to centering.
- E-2 (Multiple App Instances): Handled by `tauri-plugin-single-instance` (Task 1). Second instance focuses first instance's main window.
- Many windows open (>10): No hard limit, but test for WebView memory usage per window (~50-80MB each).

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 7: Platform-Specific Packaging

**Description**

Configure Tauri's bundler for production builds on all three platforms. Set up macOS entitlements, code signing placeholders, and universal binary config. Configure Windows NSIS and WiX installers with WebView2 bootstrapping. Configure Linux .deb and .AppImage with desktop entry files and XDG icon installation. Handle platform-specific edge cases.

**Prerequisites/Inputs**

- Tasks 3, 4, 5, 6 complete (all features must be functional before packaging).
- Final icon assets in all required sizes.
- macOS: Developer ID certificate (for signing) and Apple ID (for notarization) -- can be placeholder values for now.
- Windows: Authenticode certificate thumbprint -- can be placeholder for now.
- Linux: No special prerequisites beyond the build dependencies.

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/tauri.conf.json` | Update bundle section with platform-specific config |
| `agentcontext-desktop/src-tauri/Entitlements.plist` | macOS entitlements (created in Task 1, verified here) |
| `agentcontext-desktop/agentcontext.desktop` | Linux .desktop file for application launchers |
| `agentcontext-desktop/src-tauri/icons/` | Final production icons at all sizes |

macOS configuration (`tauri.conf.json` bundle.macOS section):

```json
{
  "frameworks": [],
  "minimumSystemVersion": "10.15",
  "signingIdentity": null,
  "providerShortName": null,
  "entitlements": "Entitlements.plist"
}
```

Build commands:
- Universal binary: `cargo tauri build --target universal-apple-darwin`
- Notarization environment variables: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`

Windows configuration (`tauri.conf.json` bundle.windows section):

```json
{
  "certificateThumbprint": null,
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com",
  "wix": { "language": "en-US" },
  "nsis": {
    "installMode": "currentUser",
    "displayLanguageSelector": false
  }
}
```

NSIS installer includes WebView2 bootstrapper automatically when Tauri detects it's missing. No additional configuration needed.

Build commands:
- NSIS: `cargo tauri build --bundles nsis`
- WiX: `cargo tauri build --bundles msi`
- Code signing environment variables: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Linux configuration (`tauri.conf.json` bundle.linux section):

```json
{
  "deb": {
    "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"],
    "section": "devel",
    "desktopEntry": {
      "Name": "AgentContext",
      "Comment": "Agent management and session history",
      "Exec": "agentcontext",
      "Icon": "agentcontext",
      "Type": "Application",
      "Categories": "Development;IDE;",
      "StartupNotify": "true",
      "StartupWMClass": "agentcontext"
    }
  },
  "appimage": {
    "bundleMediaFramework": false
  }
}
```

Build commands:
- AppImage: `cargo tauri build --bundles appimage`
- Deb: `cargo tauri build --bundles deb`

Icon sizes required:

| File | Size | Used By |
|------|------|---------|
| `32x32.png` | 32x32 | Windows taskbar, Linux |
| `128x128.png` | 128x128 | macOS Dock, Linux |
| `128x128@2x.png` | 256x256 | macOS Retina |
| `icon.icns` | Multi-size | macOS bundle |
| `icon.ico` | Multi-size | Windows exe |
| `icon.png` | 512x512 | Linux hicolor |

**Acceptance Criteria**

- [ ] macOS: `cargo tauri build --target universal-apple-darwin` produces a `.dmg` that runs on both Apple Silicon and Intel
- [ ] macOS: Entitlements.plist allows Keychain access and network connections
- [ ] macOS: Build with signing identity produces a notarizable .dmg (when certificate is provided)
- [ ] Windows: NSIS installer bootstraps WebView2 if not present (E-3 handling)
- [ ] Windows: WiX installer is available as an alternative build target
- [ ] Windows: Signed installer does not trigger SmartScreen (when certificate is provided)
- [ ] Linux: .deb package installs and creates a .desktop entry in application launchers
- [ ] Linux: .AppImage is fully self-contained and runs on Ubuntu 22.04+ without extra dependencies
- [ ] Linux: Icons are installed to XDG hicolor icon directories at 32, 128, 256, and 512px
- [ ] All platform builds include the correct app icon in the window title bar and taskbar

**Edge Cases**

- E-3 (WebView2 Missing on Windows): NSIS bootstrapper downloads and installs it. If offline, shows clear error with manual install instructions.
- macOS Gatekeeper on unsigned builds: Development builds trigger Gatekeeper; documented as expected behavior for unsigned builds.
- Linux ARM (aarch64): Not in scope for initial release; documented as future target.

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 8: Auto-Update System

**Description**

Implement automatic update checking, download, verification, installation, and rollback using Tauri's built-in updater plugin. Configure the update check loop, progress reporting, launch health detection, and pre-update backup.

**Prerequisites/Inputs**

- Task 1 (project scaffold with `tauri-plugin-updater`) complete.
- Task 2 (AppState for state management) complete.
- Update server endpoint URL (can be placeholder for development).
- Ed25519 key pair for update signing (generated via `tauri signer generate`).

**Implementation Details**

Files to create/modify:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/src/updater.rs` | Update check loop, download/install, launch health marker, binary backup |
| `agentcontext-desktop/src-tauri/src/main.rs` | Initialize updater plugin, spawn update check loop in setup |
| `agentcontext-desktop/src-tauri/tauri.conf.json` | Configure updater plugin endpoints and pubkey |

`tauri.conf.json` updater plugin:

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://releases.agentcontext.dev/{{target}}/{{arch}}/{{current_version}}"
      ],
      "pubkey": "<ED25519_PUBLIC_KEY>"
    }
  }
}
```

Key functions:

`check_for_updates(app) -> Result<Option<UpdateInfo>, String>`:
- Calls `app.updater().check().await`.
- Returns `Some(UpdateInfo { version, notes, date })` if update available, `None` otherwise.
- 10-second timeout on the HTTP request.

`download_and_install(app) -> Result<(), String>`:
- Calls `update.download_and_install()` with progress callback.
- Emits `update-progress` events to frontend: `{ downloaded: usize, total: Option<u64>, percent: f64 }`.
- Before download: calls `backup_current_binary()` to save current binary.
- On completion callback: logs "Update downloaded, preparing to install..."

`update_check_loop(app: AppHandle)`:
- Initial delay: 30 seconds (let the app settle after launch).
- Loop interval: 6 hours (`CHECK_INTERVAL = Duration::from_secs(6 * 60 * 60)`).
- On update found: send notification via `send_update_notification()` and set tray "update available" indicator.
- On check failure: log at debug level, no user-visible error.
- On manual trigger (from tray "Check for Updates..."): if check fails, show in-app toast "Could not check for updates."

`check_launch_health(app)`:
- On startup: check for `{app_data_dir}/last_launch_success` marker file.
- If marker exists: previous launch was healthy; remove it.
- If marker does not exist and version changed since last known version: previous launch may have crashed after update (potential rollback trigger).
- After 10-second delay: write new marker file with current timestamp.

`backup_current_binary() -> Result<PathBuf, String>`:
- Gets current exe path via `std::env::current_exe()`.
- Copies to `{app_data_dir}/backup/{exe_name}`.
- Creates backup dir if needed.
- Returns backup path.

Update server response format (Tauri standard):

```json
{
  "version": "1.1.0",
  "notes": "Bug fixes...",
  "pub_date": "2026-03-15T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "...", "url": "https://..." },
    "darwin-x86_64":  { "signature": "...", "url": "https://..." },
    "linux-x86_64":   { "signature": "...", "url": "https://..." },
    "windows-x86_64": { "signature": "...", "url": "https://..." }
  }
}
```

**Acceptance Criteria**

- [ ] App checks for updates 30 seconds after launch and every 6 hours thereafter
- [ ] When an update is available, a notification is shown with version and release notes
- [ ] User can trigger an update check from the tray menu ("Check for Updates...")
- [ ] Download progress is reported to the frontend via `update-progress` events
- [ ] Updates are verified using Ed25519 signature before installation
- [ ] After successful update, the app restarts with the new version
- [ ] If an update download fails (network error, timeout), the current version continues unaffected
- [ ] A backup of the current binary is created at `{app_data_dir}/backup/` before applying update
- [ ] A launch health marker is written 10 seconds after startup to detect post-update crashes
- [ ] The update check loop does not block app startup or the main thread
- [ ] Update check failures are logged at debug level, not shown to the user (except manual trigger)
- [ ] Manual "Check for Updates..." failure shows an in-app toast message (E-7)
- [ ] Tray icon changes to "Updating" state during download/install

**Edge Cases**

- E-7 (Update Server Unreachable): Check times out after 10 seconds. Logged as debug. Next check in 6 hours. Manual trigger shows toast "Could not check for updates. Please check your internet connection."
- Update signature mismatch: Tauri updater rejects the download. Error logged. Current version continues running.
- Disk full during download: `download_and_install` returns error. Current version unaffected.
- App killed during update install: On macOS the .app bundle replacement is atomic. On Windows/Linux the backup allows manual recovery.

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 9: CI/CD Build Pipeline

**Description**

Create GitHub Actions workflows to build, sign, and publish desktop app artifacts for all three platforms. The pipeline produces distributable installers and uploads them to the update server (or GitHub Releases as initial target).

**Prerequisites/Inputs**

- Task 7 (platform packaging) complete.
- Task 8 (auto-update) complete with signing key.
- GitHub repository with Actions enabled.
- Code signing certificates as GitHub Secrets (or placeholder configuration).
- Tauri updater signing key pair as GitHub Secrets.

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/.github/workflows/build-desktop.yml` | Multi-platform build workflow |
| `agentcontext-desktop/.github/workflows/release-desktop.yml` | Release workflow (tag-triggered) |

Build workflow (`build-desktop.yml`):

- Trigger: push to `main`, pull request to `main`, manual dispatch.
- Matrix: `[macos-latest, windows-latest, ubuntu-22.04]`.
- Steps per platform:
  1. Checkout code.
  2. Install Rust stable toolchain.
  3. Install Node.js 20.
  4. Install platform dependencies:
     - macOS: Xcode CLT (pre-installed on runners), `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
     - Windows: Visual Studio Build Tools (pre-installed), WebView2 SDK.
     - Linux: `sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.
  5. `npm ci` (frontend dependencies).
  6. `npm run build` (frontend production build).
  7. `cargo tauri build` (per-platform targets).
  8. Upload artifacts.

Release workflow (`release-desktop.yml`):

- Trigger: tag push matching `v*.*.*`.
- Same build matrix as above, plus:
  - macOS: build universal binary, sign with Developer ID, notarize with Apple.
  - Windows: sign with Authenticode certificate.
  - All: sign update bundles with Tauri updater key.
- Upload signed artifacts to GitHub Releases.
- Generate and upload update server JSON manifests.

GitHub Secrets required:

| Secret | Platform | Purpose |
|--------|----------|---------|
| `APPLE_CERTIFICATE` | macOS | Base64 .p12 certificate |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | Certificate password |
| `APPLE_SIGNING_IDENTITY` | macOS | Developer ID identity string |
| `APPLE_ID` | macOS | Apple ID for notarization |
| `APPLE_PASSWORD` | macOS | App-specific password |
| `APPLE_TEAM_ID` | macOS | Developer team ID |
| `WINDOWS_CERTIFICATE` | Windows | Base64 PFX certificate |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows | Certificate password |
| `TAURI_SIGNING_PRIVATE_KEY` | All | Ed25519 private key for update signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | All | Key password |

**Acceptance Criteria**

- [ ] Push to `main` triggers builds on all three platforms
- [ ] Build artifacts are uploaded and downloadable from GitHub Actions
- [ ] Tag push triggers release workflow with signing and notarization
- [ ] macOS: universal binary (.dmg) is produced and signed
- [ ] Windows: NSIS installer is produced and signed
- [ ] Linux: .AppImage and .deb are produced
- [ ] Update manifest JSON is generated for the Tauri updater endpoint
- [ ] Build failures on one platform do not block artifacts from other platforms
- [ ] Build completes within 30 minutes per platform
- [ ] Artifacts are named with version and platform (e.g., `AgentContext_1.0.0_aarch64.dmg`)

**Edge Cases**

- macOS notarization queue delays: Apple's notarization service can take 5-30 minutes. Workflow has a polling step with 30-minute timeout.
- Windows runner out of disk space: WebView2 SDK and Rust cache can be large. Use `actions/cache` for Cargo registry and target directory.
- Linux dependency resolution failures: Pin `libwebkit2gtk-4.1-dev` version in apt-get to avoid breaking changes.

**Estimated Effort**: L (Large) -- 10-12 hours

---

### Task 10: Frontend IPC Bridge

**Description**

Create the TypeScript bridge layer that the dashboard frontend uses to communicate with the Tauri Rust backend via `invoke()` and Tauri events. This layer provides typed wrappers around all IPC commands and event listeners, enabling the dashboard (F4) to leverage native features when running inside the Tauri WebView.

**Prerequisites/Inputs**

- Tasks 2-6 complete (all IPC commands implemented in Rust).
- Dashboard frontend (F4) exists and is loadable in a WebView.
- Tauri's `@tauri-apps/api` npm package.

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src/lib/tauri-bridge.ts` | Typed invoke wrappers for all IPC commands |
| `agentcontext-desktop/src/lib/tauri-events.ts` | Typed event listeners and emitters |
| `agentcontext-desktop/src/lib/platform.ts` | Platform detection (is running in Tauri vs browser) |

`platform.ts`:

```typescript
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}
```

The dashboard uses `isTauri()` to conditionally call native features. When running in a browser (F4 local dashboard), the bridge functions return fallback values or throw "Not available in browser mode" errors.

`tauri-bridge.ts` -- typed wrappers:

```typescript
import { invoke } from "@tauri-apps/api/core";

// Daemon
export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  uptime_secs: number | null;
  active_agents: number;
  version: string | null;
  http_port: number;
  ws_port: number;
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  return invoke<DaemonStatus>("get_daemon_status");
}

export async function startDaemon(): Promise<DaemonStatus> {
  return invoke<DaemonStatus>("start_daemon");
}

export async function stopDaemon(): Promise<void> {
  return invoke<void>("stop_daemon");
}

// Key Storage
export async function storeKey(keyId: string, keyBase64: string): Promise<void> {
  return invoke<void>("store_key", { keyId, keyBase64 });
}

export async function retrieveKey(keyId: string): Promise<string> {
  return invoke<string>("retrieve_key", { keyId });
}

export async function deleteKey(keyId: string): Promise<void> {
  return invoke<void>("delete_key", { keyId });
}

export async function hasKey(keyId: string): Promise<boolean> {
  return invoke<boolean>("has_key", { keyId });
}

// Notifications
export interface NotificationSettings { /* ... */ }
export async function getNotificationSettings(): Promise<NotificationSettings> { /* ... */ }
export async function setNotificationSettings(settings: NotificationSettings): Promise<void> { /* ... */ }

// Windows
export interface WindowInfo { /* ... */ }
export async function openAgentWindow(agentId: string, agentName: string): Promise<WindowInfo> { /* ... */ }
export async function getWindowList(): Promise<WindowInfo[]> { /* ... */ }
export async function closeWindow(label: string): Promise<void> { /* ... */ }
```

`tauri-events.ts` -- event listeners:

```typescript
import { listen, emit } from "@tauri-apps/api/event";

export interface DaemonStatusEvent {
  running: boolean;
  active_agents: number;
  // ...
}

export function onDaemonStatus(callback: (status: DaemonStatusEvent) => void): Promise<() => void> {
  return listen<DaemonStatusEvent>("daemon-status", (event) => callback(event.payload));
}

export interface AgentStatusEvent {
  agent_id: string;
  status: string;
}

export function onAgentStatusChanged(callback: (event: AgentStatusEvent) => void): Promise<() => void> {
  return listen<AgentStatusEvent>("agent-status-changed", (event) => callback(event.payload));
}

export interface UpdateProgressEvent {
  downloaded: number;
  total: number | null;
  percent: number;
}

export function onUpdateProgress(callback: (event: UpdateProgressEvent) => void): Promise<() => void> {
  return listen<UpdateProgressEvent>("update-progress", (event) => callback(event.payload));
}

export function emitNavigateToAgent(agentId: string): Promise<void> {
  return emit("navigate-to-agent", { agentId });
}
```

**Acceptance Criteria**

- [ ] All IPC commands are callable via typed TypeScript functions
- [ ] Return types match the Rust command signatures exactly
- [ ] Event listeners are typed and return unsubscribe functions
- [ ] `isTauri()` correctly detects whether the app is running in Tauri or a browser
- [ ] Bridge functions throw clear errors when called outside Tauri (browser fallback)
- [ ] All TypeScript types are exported for use by the dashboard frontend
- [ ] No `any` types in the bridge layer

**Edge Cases**

- Running dashboard in browser (not Tauri): `isTauri()` returns false, bridge functions throw "Not available in browser" errors or return sensible defaults.
- IPC command failure (Rust returns `Err`): Promise rejects with the error string from Rust.
- Tauri API version mismatch: `@tauri-apps/api` version must match `tauri` crate version. Lock both in package.json and Cargo.toml.

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 11: Integration & Platform Tests

**Description**

Create a comprehensive test suite covering Rust unit tests, IPC integration tests, and platform-specific manual verification checklists. Tests are organized by subsystem and include cross-platform compatibility checks.

**Prerequisites/Inputs**

- All tasks (1-10) complete.
- Test infrastructure: `cargo test` for Rust, `cargo tauri build` for integration.

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `agentcontext-desktop/src-tauri/src/keystore_test.rs` | KeyStore unit tests |
| `agentcontext-desktop/src-tauri/src/window_state_test.rs` | WindowState unit tests |
| `agentcontext-desktop/src-tauri/src/tray_test.rs` | Tray state and icon tests |
| `agentcontext-desktop/src-tauri/src/notifications_test.rs` | Notification settings tests |
| `agentcontext-desktop/src-tauri/src/updater_test.rs` | UpdateInfo deserialization tests |
| `agentcontext-desktop/src-tauri/src/state_test.rs` | DaemonClient and AppState tests |
| `agentcontext-desktop/tests/platform-checklist.md` | Manual verification checklist |

**Rust Unit Tests**

| ID | Test | Module | Description |
|----|------|--------|-------------|
| T-1 | `keystore_roundtrip` | keystore | `store_key` + `retrieve_key` round-trip produces identical bytes (32-byte key) |
| T-2 | `keystore_has_key_nonexistent` | keystore | `has_key` returns `false` for non-existent key |
| T-3 | `keystore_delete_idempotent` | keystore | `delete_key` on non-existent key returns `Ok(())` |
| T-4 | `keystore_retrieve_deleted` | keystore | `retrieve_key` returns `KeyNotFound` after `delete_key` |
| T-5 | `window_state_serde_roundtrip` | window_state | Serialize + deserialize WindowState produces identical struct |
| T-6 | `window_position_offscreen` | window_state | `validate_window_position` re-centers window when position is off all monitors |
| T-7 | `tray_icon_selection` | tray | `get_tray_icon` returns distinct icons for each TrayState variant |
| T-8 | `notification_settings_defaults` | notifications | `NotificationSettings::default()` has all categories enabled |
| T-9 | `update_info_deserialize` | updater | `UpdateInfo` correctly deserializes from Tauri update server JSON format |
| T-10 | `daemon_client_health_check_timeout` | state | `DaemonClient::health_check` returns error within 5 seconds when daemon is unreachable |

**Integration Tests (require app to be built)**

| ID | Test | Description |
|----|------|-------------|
| T-11 | App launch time | App launches and displays main window within 3 seconds |
| T-12 | Tray icon appears | System tray icon is visible after launch |
| T-13 | Tray menu items | Tray menu shows all specified items and submenus |
| T-14 | Agent window creation | `open_agent_window` creates a new native window |
| T-15 | Agent window dedup | Opening same agent twice focuses existing window |
| T-16 | Window state persistence | Window position persists after close and reopen |
| T-17 | IPC daemon status | `get_daemon_status` returns valid response or error |
| T-18 | IPC key round-trip | `store_key` + `retrieve_key` works from frontend invoke |
| T-19 | Notification approve action | "Approve" notification action sends approval to daemon |
| T-20 | Single instance | Second launch focuses first instance |
| T-21 | Close hides to tray | Close button hides window (when tray available) |
| T-22 | Close quits without tray | Close button quits app (when tray unavailable) |

**Platform-Specific Tests**

| ID | Platform | Test |
|----|----------|------|
| T-23 | macOS | Universal binary runs on both arm64 and x86_64 |
| T-24 | macOS | Notarized .dmg installs without Gatekeeper warnings |
| T-25 | macOS | Tray icon adapts to dark/light menu bar |
| T-26 | Windows | NSIS installer installs WebView2 if missing |
| T-27 | Windows | Signed installer passes SmartScreen |
| T-28 | Linux | .AppImage runs on Ubuntu 22.04 without extra deps |
| T-29 | Linux | .deb creates desktop entry and installs icons |
| T-30 | Linux | App degrades gracefully without tray support (e.g., Sway) |

**Manual Verification Checklist** (documented in `tests/platform-checklist.md`):

| ID | Test |
|----|------|
| M-1 | Install .dmg on macOS, launch, verify tray, open dashboard, quit from tray |
| M-2 | Install .msi on Windows, launch, verify tray, verify WebView2 |
| M-3 | Run .AppImage on Ubuntu, verify tray, verify notifications |
| M-4 | Launch with daemon stopped, verify error state, start daemon, verify transition |
| M-5 | Trigger permission request, verify notification with Approve/Deny |
| M-6 | Open two agent windows side by side, verify independent updates |
| M-7 | Trigger auto-update (test server), verify download, install, restart |
| M-8 | Store and retrieve encryption key, verify round-trip |
| M-9 | Disconnect monitor, relaunch, verify window re-centers |
| M-10 | Enable DND, trigger notification, verify suppressed, disable DND, verify in Notification Center |

**Acceptance Criteria**

- [ ] All 10 Rust unit tests pass via `cargo test`
- [ ] Integration test harness documents are created with clear pass/fail criteria
- [ ] Platform-specific test checklist covers all 3 platforms
- [ ] Manual verification checklist covers all 10 scenarios from the story
- [ ] Test files are organized by module and discoverable by `cargo test`
- [ ] Tests do not require network access (mock daemon responses where needed)
- [ ] CI build includes `cargo test` step that runs unit tests

**Edge Cases**

- CI test environment differences: Unit tests should not depend on OS-specific APIs (use feature flags to skip keyring tests on CI without Secret Service).
- Flaky integration tests: Tray appearance and window positioning tests are inherently visual; document as manual verification.

**Estimated Effort**: L (Large) -- 8-10 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/agentcontext-desktop/`.

| File | Action | Task(s) |
|------|--------|---------|
| `src-tauri/Cargo.toml` | Create | 1 |
| `src-tauri/tauri.conf.json` | Create | 1, 7, 8 |
| `src-tauri/build.rs` | Create | 1 |
| `src-tauri/Entitlements.plist` | Create | 1, 7 |
| `src-tauri/capabilities/default.json` | Create | 1 |
| `src-tauri/icons/` (all icon files) | Create | 1, 7 |
| `src-tauri/src/main.rs` | Create | 1, 2, 3, 4, 6, 8 |
| `src-tauri/src/lib.rs` | Create | 1 |
| `src-tauri/src/state.rs` | Create | 2 |
| `src-tauri/src/tray.rs` | Create | 3 |
| `src-tauri/src/notifications.rs` | Create | 4 |
| `src-tauri/src/keystore.rs` | Create | 5 |
| `src-tauri/src/window_state.rs` | Create | 6 |
| `src-tauri/src/updater.rs` | Create | 8 |
| `src-tauri/src/commands/mod.rs` | Create | 2 |
| `src-tauri/src/commands/daemon.rs` | Create | 2 |
| `src-tauri/src/commands/keystore.rs` | Create | 5 |
| `src-tauri/src/commands/notifications.rs` | Create | 4 |
| `src-tauri/src/commands/tray.rs` | Create | 3 |
| `src-tauri/src/commands/windows.rs` | Create | 6 |
| `src/index.html` | Create | 1 |
| `src/lib/tauri-bridge.ts` | Create | 10 |
| `src/lib/tauri-events.ts` | Create | 10 |
| `src/lib/platform.ts` | Create | 10 |
| `package.json` | Create | 1 |
| `agentcontext.desktop` | Create | 7 |
| `.github/workflows/build-desktop.yml` | Create | 9 |
| `.github/workflows/release-desktop.yml` | Create | 9 |
| `src-tauri/src/keystore_test.rs` | Create | 11 |
| `src-tauri/src/window_state_test.rs` | Create | 11 |
| `src-tauri/src/tray_test.rs` | Create | 11 |
| `src-tauri/src/notifications_test.rs` | Create | 11 |
| `src-tauri/src/updater_test.rs` | Create | 11 |
| `src-tauri/src/state_test.rs` | Create | 11 |
| `tests/platform-checklist.md` | Create | 11 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone |
|-------|-------|-----------|
| **Phase 1: Scaffold** | Task 1 (Tauri 2 Project Scaffold) | Empty window opens on all platforms |
| **Phase 2: Core** | Task 2 (AppState & Daemon Client) | App connects to daemon, health loop runs |
| **Phase 3: OS Integration** | Task 3 (System Tray), Task 4 (Notifications), Task 5 (Key Storage), Task 6 (Multi-Window) -- can be partially parallelized | Full native OS integration |
| **Phase 4: Updates** | Task 8 (Auto-Update) | App can self-update |
| **Phase 5: Frontend** | Task 10 (IPC Bridge) | Dashboard frontend can call all native features |
| **Phase 6: Packaging** | Task 7 (Platform Packaging) | Production-ready installers for all platforms |
| **Phase 7: CI/CD** | Task 9 (Build Pipeline) | Automated builds and releases |
| **Phase 8: Validation** | Task 11 (Tests) | All tests pass, manual verification complete |

Tasks 3, 4, 5, and 6 can be parallelized in Phase 3 since they are independent features that share only the AppState (Task 2). Task 10 depends on all command implementations but can start as soon as the IPC command signatures are finalized.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Tauri 2 API breaking changes | Low | High | Pin exact Tauri crate versions in Cargo.toml. Monitor Tauri release notes. |
| WebKitGTK version mismatch on Linux | Medium | Medium | Document minimum WebKitGTK version (4.1). Test on Ubuntu 22.04 and 24.04. |
| macOS notarization failures in CI | Medium | Medium | Use `tauri-action` GitHub Action which handles notarization automatically. Cache Apple tools. |
| `keyring` crate failures on headless Linux | High | Medium | Implement file-based fallback (E-5). Detect Secret Service availability at startup. |
| System tray not supported on all Linux DEs | High | Low | Graceful degradation (E-8): log warning, set `tray_available = false`, quit-on-close behavior. |
| WebView2 not installed on older Windows 10 | Medium | Medium | NSIS bootstrapper handles this (E-3). Document offline installer as enterprise option. |
| Large binary size from Rust compilation | Low | Low | Tauri 2 binaries are ~10MB. Strip debug symbols in release builds. |
| Cross-compilation complexity for universal binary | Medium | Medium | Use GitHub Actions macOS runner which supports both targets. Document local build steps. |
| Notification permissions denied by user | Medium | Low | Fall back to tray icon "Attention" state (E-4). Show in-app indicator. |
| Window state file corruption | Low | Low | If `window-states.json` fails to parse, log warning, use default positions, overwrite file on next save. |
| Update server downtime | Low | Low | 10-second timeout, debug-level logging, retry in 6 hours (E-7). No user-visible error for background checks. |

---

## Effort Estimates

| Task | Complexity | Estimate |
|------|------------|----------|
| Task 1: Tauri 2 Project Scaffold | L | 8-10 hours |
| Task 2: Application State & Daemon Client | M | 4-6 hours |
| Task 3: System Tray | L | 8-10 hours |
| Task 4: Native Notifications | M | 6-8 hours |
| Task 5: Secure Key Storage | L | 8-10 hours |
| Task 6: Multi-Window & Window State | L | 8-10 hours |
| Task 7: Platform-Specific Packaging | M | 6-8 hours |
| Task 8: Auto-Update System | M | 6-8 hours |
| Task 9: CI/CD Build Pipeline | L | 10-12 hours |
| Task 10: Frontend IPC Bridge | M | 4-6 hours |
| Task 11: Integration & Platform Tests | L | 8-10 hours |
| **Total** | | **~77-98 hours (~10-13 working days)** |

---

## Notes for Implementation

1. **The dashboard frontend (F4) is a prerequisite, not part of this story.** This plan wraps an existing web application in a native window. The `src/` directory holds the dashboard build output; the Rust backend provides native OS integration.

2. **All sensitive operations go through the Rust backend.** The frontend never accesses OS APIs directly. Key storage, notifications, tray management, and daemon communication are all mediated by typed IPC commands. The CSP in `tauri.conf.json` enforces this boundary.

3. **Graceful degradation is required on Linux.** System tray support, Secret Service availability, and notification daemon presence vary across Linux desktop environments. Every feature must have a fallback path that keeps the app functional.

4. **The app is not a replacement for the daemon.** If the daemon is not running, the app shows a disconnected state and offers to start it. The daemon owns all agent orchestration, event capture, and data storage. The desktop app is a client that provides native OS integration.

5. **Single-instance enforcement is critical.** Two instances of the app would fight over the system tray, window state file, and notification handlers. The `tauri-plugin-single-instance` plugin prevents this on all platforms.

6. **Icon assets require a designer.** The tray icons (5 states x 2 sizes for template/non-template) and app icons (7 files across 3 platforms) are listed as placeholders in Task 1. A designer should produce these before Task 7 (packaging).

7. **Update signing keys must be generated before first release.** Run `tauri signer generate -w ~/.tauri/agentcontext.key` to create the Ed25519 key pair. The public key goes in `tauri.conf.json`, the private key in CI secrets.

8. **The `agentctx` CLI must be on PATH for `start_daemon` and `stop_daemon` commands.** The desktop app calls `agentctx daemon start/stop` as subprocess commands. Document this dependency in the app's system requirements.
