# Story 15: Desktop App (Tauri)

## Overview

The Desktop App is a native cross-platform application built with Tauri 2 that wraps the AgentContext web dashboard in a native window and adds OS-level integrations that are impossible in a browser: system tray presence, native notifications with action buttons, secure key storage via platform credential managers, automatic delta updates, and multi-window support for side-by-side agent monitoring.

This application is the primary desktop interface for AgentContext. While the local dashboard (F4) serves as a browser-accessible fallback, the desktop app provides a first-class experience: it starts with the OS, lives in the system tray, pushes native notifications when agents need attention, and securely stores encryption keys for cloud sync (F5) without exposing them to the web layer.

The app is built on Tauri 2, which uses the OS's native WebView (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux) and a Rust backend for IPC, system integration, and performance-critical operations. This produces small binaries (~10MB) with low memory overhead compared to Electron alternatives.

**Guiding principle**: The Rust backend handles OS integration and security. The WebView frontend handles UI. All sensitive operations (key storage, notifications, tray management) go through typed IPC commands -- the frontend never accesses OS APIs directly.

---

## Scope

### In Scope

- Tauri 2 project structure and configuration
- WebView configuration for loading the dashboard frontend
- IPC command layer between Rust backend and web frontend
- System tray with daemon status and quick actions
- Native OS notifications with action buttons
- Secure key storage (macOS Keychain, Windows DPAPI, Linux Secret Service)
- Auto-update via Tauri's built-in updater
- Multi-window support with state persistence
- Build targets: macOS (.dmg), Windows (.msi), Linux (.AppImage, .deb)
- Platform-specific considerations (notarization, code signing, universal binaries)

### Out of Scope (Non-Goals)

- The dashboard frontend itself (F4 -- this story wraps it, does not build it)
- The daemon process (F3 -- the desktop app connects to it, does not replace it)
- Cloud sync implementation (F5 -- this story stores keys for it, does not implement sync)
- Mobile app (F6 -- separate Expo-based application)
- Custom window chrome or frameless windows (uses native title bar)
- Offline-only mode without a running daemon
- Plugin or extension system within the desktop app

---

## Requirements

### 1. Tauri 2 Wrapper (F7.1)

The core application wraps the AgentContext web dashboard in a native window using Tauri 2's WebView.

#### Project Structure

```
agentcontext-desktop/
├── src-tauri/
│   ├── Cargo.toml                    # Rust dependencies
│   ├── tauri.conf.json               # Tauri configuration
│   ├── build.rs                      # Build script
│   ├── icons/                        # App icons (all sizes)
│   │   ├── icon.icns                 # macOS
│   │   ├── icon.ico                  # Windows
│   │   ├── icon.png                  # Linux (512x512)
│   │   ├── 32x32.png
│   │   ├── 128x128.png
│   │   └── 128x128@2x.png
│   ├── src/
│   │   ├── main.rs                   # Entry point, app setup
│   │   ├── commands/                 # IPC command handlers
│   │   │   ├── mod.rs
│   │   │   ├── daemon.rs             # Daemon connection commands
│   │   │   ├── keystore.rs           # Secure key storage commands
│   │   │   ├── notifications.rs      # Notification commands
│   │   │   ├── tray.rs               # Tray state commands
│   │   │   └── windows.rs            # Window management commands
│   │   ├── tray.rs                   # System tray setup and handlers
│   │   ├── notifications.rs          # Notification dispatch
│   │   ├── keystore.rs               # Platform-specific key storage
│   │   ├── updater.rs                # Auto-update logic
│   │   ├── state.rs                  # Application state management
│   │   └── window_state.rs           # Window position/size persistence
│   └── capabilities/
│       └── default.json              # Permission capabilities
├── src/                              # Frontend (web dashboard)
│   ├── index.html
│   └── ...                           # Dashboard assets (from F4)
├── package.json                      # Frontend build tooling
└── README.md
```

#### Tauri Configuration

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/schema.json",
  "productName": "AgentContext",
  "version": "1.0.0",
  "identifier": "com.agentcontext.desktop",
  "build": {
    "frontendDist": "../src/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "title": "AgentContext",
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
      "iconPath": "icons/tray-icon.png",
      "iconAsTemplate": true,
      "tooltip": "AgentContext"
    },
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; style-src 'self' 'unsafe-inline'",
      "dangerousDisableAssetCspModification": false
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
      "wix": {
        "language": "en-US"
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
      "endpoints": ["https://releases.agentcontext.dev/{{target}}/{{arch}}/{{current_version}}"],
      "pubkey": "<PUBLIC_KEY_FOR_UPDATE_VERIFICATION>"
    }
  }
}
```

#### WebView Configuration

The WebView must connect to the locally running daemon's HTTP server. On launch, the app checks whether the daemon is running and either connects to it or prompts the user to start it.

```rust
// src-tauri/src/main.rs
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::init())
        .setup(|app| {
            // Initialize system tray
            crate::tray::setup_tray(app)?;

            // Restore window state from previous session
            crate::window_state::restore(app)?;

            // Start daemon health check loop
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
            crate::commands::keystore::store_key,
            crate::commands::keystore::retrieve_key,
            crate::commands::keystore::delete_key,
            crate::commands::keystore::has_key,
            crate::commands::notifications::send_notification,
            crate::commands::notifications::get_notification_settings,
            crate::commands::notifications::set_notification_settings,
            crate::commands::tray::update_tray_state,
            crate::commands::windows::open_agent_window,
            crate::commands::windows::get_window_list,
            crate::commands::windows::close_window,
            crate::commands::windows::get_window_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentContext");
}
```

#### IPC Command Pattern

All IPC between the frontend and Rust backend uses Tauri's typed command system. Commands are async Rust functions annotated with `#[tauri::command]`.

```rust
// src-tauri/src/commands/daemon.rs
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::state::AppState;

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

#[tauri::command]
pub async fn get_daemon_status(state: State<'_, AppState>) -> Result<DaemonStatus, String> {
    let status = state.daemon_client.lock().await
        .health_check()
        .await
        .map_err(|e| format!("Failed to reach daemon: {}", e))?;
    Ok(status)
}

#[tauri::command]
pub async fn start_daemon() -> Result<DaemonStatus, String> {
    let output = tokio::process::Command::new("agentctx")
        .arg("daemon")
        .arg("start")
        .output()
        .await
        .map_err(|e| format!("Failed to start daemon: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Daemon failed to start: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Wait briefly for daemon to initialize, then check status
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    get_daemon_status_internal().await
}
```

Frontend invocation pattern:

```typescript
// src/lib/tauri-bridge.ts
import { invoke } from "@tauri-apps/api/core";

interface DaemonStatus {
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
```

#### Build Targets

| Platform | Format | Tool | Notes |
|----------|--------|------|-------|
| macOS | `.dmg` | `tauri build --target universal-apple-darwin` | Universal binary (arm64 + x86_64) |
| Windows | `.msi` | `tauri build` (WiX) | Requires WiX Toolset v3 |
| Windows | `.nsis` | `tauri build --bundles nsis` | Alternative NSIS installer |
| Linux | `.AppImage` | `tauri build --bundles appimage` | Portable, no install required |
| Linux | `.deb` | `tauri build --bundles deb` | Debian/Ubuntu package |

#### Acceptance Criteria

- [ ] Tauri 2 project structure is set up with the specified directory layout
- [ ] `tauri.conf.json` contains correct window, tray, security, and bundle configuration
- [ ] WebView loads the dashboard frontend from the bundled assets or dev server
- [ ] IPC commands are registered and callable from the frontend via `invoke()`
- [ ] CSP is configured to allow WebSocket connections to the local daemon
- [ ] Build produces valid artifacts for macOS (.dmg), Windows (.msi), and Linux (.AppImage, .deb)
- [ ] The app icon is displayed correctly on all platforms at all sizes
- [ ] App launches and shows the dashboard within 3 seconds on a modern system

---

### 2. System Tray (F7.2)

The system tray provides persistent presence in the OS taskbar. The app continues running when the main window is closed, accessible via the tray icon.

#### Tray Icon States

| State | Icon | Tooltip | Description |
|-------|------|---------|-------------|
| Idle | Gray circle | "AgentContext -- No active agents" | Daemon running, no agents active |
| Running | Green circle | "AgentContext -- 3 agents running" | One or more agents are active |
| Attention | Orange circle (pulsing) | "AgentContext -- Action required" | An agent needs permission approval |
| Error | Red circle | "AgentContext -- Daemon disconnected" | Cannot reach the daemon |
| Updating | Blue circle | "AgentContext -- Updating..." | Auto-update in progress |

#### Tray Menu

```
┌─────────────────────────────────┐
│  AgentContext v1.0.0            │  (header, non-clickable)
│  Daemon: Running (PID 12345)   │  (status, non-clickable)
│  ─────────────────────────────  │
│  3 agents running               │  (status, non-clickable)
│  ─────────────────────────────  │
│  Open Dashboard          ⌘D    │  → opens/focuses main window
│  Start New Agent...      ⌘N    │  → opens agent creation dialog
│  ─────────────────────────────  │
│  ▸ Running Agents              │  → submenu
│  │  feature-auth (claude-4)    │  → opens agent window
│  │  test-suite (claude-4)      │  → opens agent window
│  │  docs-update (claude-4)     │  → opens agent window
│  ─────────────────────────────  │
│  Start Daemon                  │  (shown when daemon is stopped)
│  Stop Daemon                   │  (shown when daemon is running)
│  ─────────────────────────────  │
│  Preferences...          ⌘,    │  → opens settings window
│  Check for Updates...          │  → triggers update check
│  ─────────────────────────────  │
│  Quit AgentContext       ⌘Q    │  → quits app (daemon keeps running)
│  Quit All                      │  → quits app AND stops daemon
└─────────────────────────────────┘
```

#### Tray Implementation

```rust
// src-tauri/src/tray.rs
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime,
};

#[derive(Clone, Copy, PartialEq)]
pub enum TrayState {
    Idle,
    Running,
    Attention,
    Error,
    Updating,
}

pub fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_tray_menu(app, TrayState::Idle, &[])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(get_tray_icon(TrayState::Idle))
        .tooltip("AgentContext")
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    // Left click: toggle main window visibility
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                _ => {}
            }
        })
        .on_menu_event(|app, event| {
            handle_tray_menu_event(app, &event.id);
        })
        .build(app)?;

    Ok(())
}

fn get_tray_icon(state: TrayState) -> tauri::image::Image<'static> {
    let icon_bytes = match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle.png"),
        TrayState::Running => include_bytes!("../icons/tray-running.png"),
        TrayState::Attention => include_bytes!("../icons/tray-attention.png"),
        TrayState::Error => include_bytes!("../icons/tray-error.png"),
        TrayState::Updating => include_bytes!("../icons/tray-updating.png"),
    };
    tauri::image::Image::from_bytes(icon_bytes)
        .expect("Failed to load tray icon")
}

pub fn update_tray(app: &tauri::AppHandle, state: TrayState, agents: &[AgentInfo]) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(get_tray_icon(state)));
        let _ = tray.set_tooltip(Some(&format_tooltip(state, agents)));
        if let Ok(menu) = build_tray_menu(app, state, agents) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
```

#### Platform-Specific Behavior

| Behavior | macOS | Windows | Linux |
|----------|-------|---------|-------|
| Location | Menu bar (top-right) | System tray (bottom-right) | Indicator area (varies by DE) |
| Left click | Toggle main window | Toggle main window | Show menu (some DEs) |
| Right click | Show menu | Show menu | Show menu |
| Close button | Hide to tray | Hide to tray | Hide to tray |
| `iconAsTemplate` | `true` (adapts to dark/light) | N/A | N/A |

#### Window Close Behavior

When the user clicks the window close button, the app hides to the system tray instead of quitting. The "Quit" menu item in the tray menu (or Cmd+Q / Alt+F4) actually quits the application.

```rust
// In setup, intercept the close event
let window = app.get_webview_window("main").unwrap();
window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // Prevent actual close, hide to tray instead
        api.prevent_close();
        let _ = window_clone.hide();
    }
});
```

#### Acceptance Criteria

- [ ] System tray icon appears on all three platforms when the app launches
- [ ] Tray icon changes to reflect current state (idle, running, attention, error, updating)
- [ ] Tray menu shows daemon status, running agents count, and all specified menu items
- [ ] "Running Agents" submenu dynamically lists active agents with their names and models
- [ ] Left-clicking the tray icon toggles the main window visibility
- [ ] Closing the main window hides to tray instead of quitting
- [ ] "Quit AgentContext" exits the app but leaves the daemon running
- [ ] "Quit All" exits the app and stops the daemon
- [ ] macOS: icon uses template mode for automatic dark/light adaptation
- [ ] Menu updates in real-time as agents start and stop (within 2 seconds)

---

### 3. Native Notifications (F7.3)

The app delivers OS-level notifications for agent events that need user attention. Notifications integrate with each platform's notification center and support action buttons for quick responses.

#### Notification Categories

| Category | Trigger | Priority | Actions | Sound |
|----------|---------|----------|---------|-------|
| Permission Request | Agent requests tool permission | High | Approve, Deny | Default alert |
| Agent Complete | Agent finishes a task | Normal | Open, Dismiss | Default |
| Agent Error | Agent encounters a fatal error | High | Open, Retry | Default alert |
| Update Available | New app version detected | Low | Update, Later | None |
| Daemon Stopped | Daemon process exits unexpectedly | High | Restart, Ignore | Default alert |

#### Notification Implementation

```rust
// src-tauri/src/notifications.rs
use tauri_plugin_notification::NotificationExt;
use serde::{Deserialize, Serialize};

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

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            permission_requests: true,
            agent_complete: true,
            agent_error: true,
            updates: true,
            daemon_status: true,
            sound: true,
        }
    }
}

pub fn send_permission_notification(
    app: &tauri::AppHandle,
    agent_name: &str,
    tool_name: &str,
    tool_input_summary: &str,
    request_id: &str,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&format!("{} needs permission", agent_name))
        .body(&format!("{}: {}", tool_name, tool_input_summary))
        .action_type_id("permission-request")
        .actions([
            tauri_plugin_notification::Action {
                id: format!("approve:{}", request_id),
                title: "Approve".into(),
                requires_authentication: false,
                foreground: false,
                destructive: false,
                input: None,
                input_placeholder: None,
            },
            tauri_plugin_notification::Action {
                id: format!("deny:{}", request_id),
                title: "Deny".into(),
                requires_authentication: false,
                foreground: false,
                destructive: true,
                input: None,
                input_placeholder: None,
            },
        ])
        .show()
        .map_err(|e| format!("Failed to send notification: {}", e))
}

pub fn send_agent_complete_notification(
    app: &tauri::AppHandle,
    agent_name: &str,
    summary: &str,
    agent_id: &str,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&format!("{} finished", agent_name))
        .body(summary)
        .action_type_id("agent-complete")
        .actions([
            tauri_plugin_notification::Action {
                id: format!("open:{}", agent_id),
                title: "Open".into(),
                requires_authentication: false,
                foreground: true,
                destructive: false,
                input: None,
                input_placeholder: None,
            },
        ])
        .show()
        .map_err(|e| format!("Failed to send notification: {}", e))
}

pub fn send_agent_error_notification(
    app: &tauri::AppHandle,
    agent_name: &str,
    error_message: &str,
    agent_id: &str,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&format!("{} encountered an error", agent_name))
        .body(error_message)
        .action_type_id("agent-error")
        .actions([
            tauri_plugin_notification::Action {
                id: format!("open:{}", agent_id),
                title: "Open".into(),
                requires_authentication: false,
                foreground: true,
                destructive: false,
                input: None,
                input_placeholder: None,
            },
            tauri_plugin_notification::Action {
                id: format!("retry:{}", agent_id),
                title: "Retry".into(),
                requires_authentication: false,
                foreground: false,
                destructive: false,
                input: None,
                input_placeholder: None,
            },
        ])
        .show()
        .map_err(|e| format!("Failed to send notification: {}", e))
}
```

#### Notification Action Handling

When a user interacts with a notification action button, the app must handle it even if the main window is not focused.

```rust
// In main.rs setup
app.notification()
    .on_action(|app, action| {
        let parts: Vec<&str> = action.action_id.splitn(2, ':').collect();
        match parts.as_slice() {
            ["approve", request_id] => {
                tauri::async_runtime::spawn({
                    let app = app.clone();
                    let request_id = request_id.to_string();
                    async move {
                        let _ = respond_to_permission(&app, &request_id, true).await;
                    }
                });
            }
            ["deny", request_id] => {
                tauri::async_runtime::spawn({
                    let app = app.clone();
                    let request_id = request_id.to_string();
                    async move {
                        let _ = respond_to_permission(&app, &request_id, false).await;
                    }
                });
            }
            ["open", agent_id] => {
                let _ = crate::commands::windows::open_agent_window_internal(&app, agent_id);
            }
            ["retry", agent_id] => {
                tauri::async_runtime::spawn({
                    let app = app.clone();
                    let agent_id = agent_id.to_string();
                    async move {
                        let _ = restart_agent(&app, &agent_id).await;
                    }
                });
            }
            _ => {
                log::warn!("Unknown notification action: {}", action.action_id);
            }
        }
    });
```

#### Do Not Disturb Respect

The app relies on the OS notification system, which automatically respects Do Not Disturb / Focus mode settings:

- **macOS**: Notifications are suppressed during Focus mode. They appear in Notification Center when Focus ends.
- **Windows**: Notifications are suppressed during Focus Assist. They appear in Action Center when Focus Assist ends.
- **Linux**: Behavior varies by desktop environment. GNOME and KDE respect their respective DND modes.

The app does not attempt to bypass or detect DND state. It sends notifications unconditionally and lets the OS decide delivery.

#### IPC Commands for Notification Settings

```rust
// src-tauri/src/commands/notifications.rs
#[tauri::command]
pub async fn get_notification_settings(
    state: State<'_, AppState>,
) -> Result<NotificationSettings, String> {
    Ok(state.notification_settings.lock().await.clone())
}

#[tauri::command]
pub async fn set_notification_settings(
    state: State<'_, AppState>,
    settings: NotificationSettings,
) -> Result<(), String> {
    *state.notification_settings.lock().await = settings.clone();
    save_notification_settings(&settings).await
        .map_err(|e| format!("Failed to save settings: {}", e))
}
```

#### Acceptance Criteria

- [ ] Permission request notifications display with "Approve" and "Deny" action buttons
- [ ] Clicking "Approve" on a permission notification sends the approval to the daemon without opening the app window
- [ ] Clicking "Deny" on a permission notification sends the denial to the daemon
- [ ] Agent completion notifications display with the agent name and a brief summary
- [ ] Agent error notifications display with "Open" and "Retry" action buttons
- [ ] Notifications are not sent for disabled categories (per user settings)
- [ ] Notification settings persist across app restarts
- [ ] macOS: Notifications appear in Notification Center and respect Focus mode
- [ ] Windows: Notifications appear in Action Center and respect Focus Assist
- [ ] Linux: Notifications use the system notification daemon (libnotify-compatible)
- [ ] Notification body text is truncated to 200 characters with an ellipsis for long messages

---

### 4. Secure Key Storage (F7.4)

The app stores encryption keys (used for cloud sync, F5) in the operating system's secure credential storage. Keys never touch the filesystem as plaintext.

#### Platform Backends

| Platform | Backend | API | Plugin |
|----------|---------|-----|--------|
| macOS | Keychain Services | Security.framework | `tauri-plugin-stronghold` or direct FFI |
| Windows | DPAPI + Credential Manager | `wincred` crate | `tauri-plugin-stronghold` or direct FFI |
| Linux | Secret Service (DBus) | `libsecret` / `keyring` crate | `tauri-plugin-stronghold` or direct FFI |

#### Key Storage API

```rust
// src-tauri/src/keystore.rs
use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "com.agentcontext.desktop";

#[derive(Serialize, Deserialize, Clone)]
pub struct KeyMetadata {
    pub key_id: String,
    pub created_at: String,
    pub algorithm: String,
    pub purpose: String,
}

pub struct KeyStore {
    service: String,
}

impl KeyStore {
    pub fn new() -> Self {
        Self {
            service: SERVICE_NAME.to_string(),
        }
    }

    /// Store a key in the OS credential manager.
    /// The key is stored as a base64-encoded string under a scoped account name.
    pub fn store_key(&self, key_id: &str, key_bytes: &[u8]) -> Result<(), KeyStoreError> {
        let account = format!("key:{}", key_id);
        let entry = Entry::new(&self.service, &account)
            .map_err(|e| KeyStoreError::BackendError(e.to_string()))?;

        let encoded = base64::engine::general_purpose::STANDARD.encode(key_bytes);
        entry.set_password(&encoded)
            .map_err(|e| KeyStoreError::StoreError(e.to_string()))?;

        Ok(())
    }

    /// Retrieve a key from the OS credential manager.
    /// Returns the raw key bytes.
    pub fn retrieve_key(&self, key_id: &str) -> Result<Vec<u8>, KeyStoreError> {
        let account = format!("key:{}", key_id);
        let entry = Entry::new(&self.service, &account)
            .map_err(|e| KeyStoreError::BackendError(e.to_string()))?;

        let encoded = entry.get_password()
            .map_err(|e| match e {
                keyring::Error::NoEntry => KeyStoreError::KeyNotFound(key_id.to_string()),
                other => KeyStoreError::RetrieveError(other.to_string()),
            })?;

        base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .map_err(|e| KeyStoreError::DecodeError(e.to_string()))
    }

    /// Delete a key from the OS credential manager.
    pub fn delete_key(&self, key_id: &str) -> Result<(), KeyStoreError> {
        let account = format!("key:{}", key_id);
        let entry = Entry::new(&self.service, &account)
            .map_err(|e| KeyStoreError::BackendError(e.to_string()))?;

        entry.delete_credential()
            .map_err(|e| KeyStoreError::DeleteError(e.to_string()))?;

        Ok(())
    }

    /// Check if a key exists without retrieving it.
    pub fn has_key(&self, key_id: &str) -> Result<bool, KeyStoreError> {
        match self.retrieve_key(key_id) {
            Ok(_) => Ok(true),
            Err(KeyStoreError::KeyNotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

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

#### IPC Commands

```rust
// src-tauri/src/commands/keystore.rs
use tauri::State;
use crate::keystore::{KeyStore, KeyStoreError};
use crate::state::AppState;

#[tauri::command]
pub async fn store_key(
    state: State<'_, AppState>,
    key_id: String,
    key_base64: String,
) -> Result<(), String> {
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(&key_base64)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    state.keystore.store_key(&key_id, &key_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retrieve_key(
    state: State<'_, AppState>,
    key_id: String,
) -> Result<String, String> {
    let key_bytes = state.keystore.retrieve_key(&key_id)
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&key_bytes))
}

#[tauri::command]
pub async fn delete_key(
    state: State<'_, AppState>,
    key_id: String,
) -> Result<(), String> {
    state.keystore.delete_key(&key_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn has_key(
    state: State<'_, AppState>,
    key_id: String,
) -> Result<bool, String> {
    state.keystore.has_key(&key_id)
        .map_err(|e| e.to_string())
}
```

#### Biometric Gating

On platforms that support it, key retrieval can be gated behind biometric authentication:

- **macOS**: Touch ID via the Keychain `kSecAccessControlBiometryCurrentSet` flag. When a key is stored with biometric protection, the OS prompts for Touch ID before releasing the key.
- **Windows**: Windows Hello via the Credential Manager's `CRED_FLAGS_REQUIRE_CONFIRMATION` flag.
- **Linux**: Not supported natively. The Secret Service API does not provide biometric gating. The key is accessible once the keyring is unlocked (typically at login).

Biometric gating is opt-in. Users configure it per key via a boolean flag at store time:

```rust
pub fn store_key_with_biometric(
    &self,
    key_id: &str,
    key_bytes: &[u8],
    require_biometric: bool,
) -> Result<(), KeyStoreError> {
    // Platform-specific implementation:
    // macOS: Use Security.framework with kSecAccessControlBiometryCurrentSet
    // Windows: Use CRED_FLAGS_REQUIRE_CONFIRMATION
    // Linux: Fall back to store_key (no biometric support)
    #[cfg(target_os = "macos")]
    if require_biometric {
        return self.store_key_macos_biometric(key_id, key_bytes);
    }

    #[cfg(target_os = "windows")]
    if require_biometric {
        return self.store_key_windows_biometric(key_id, key_bytes);
    }

    // Fallback: store without biometric
    self.store_key(key_id, key_bytes)
}
```

#### Acceptance Criteria

- [ ] Keys can be stored, retrieved, and deleted via IPC commands from the frontend
- [ ] macOS: Keys are stored in the login keychain under the `com.agentcontext.desktop` service
- [ ] Windows: Keys are stored in the Windows Credential Manager via DPAPI
- [ ] Linux: Keys are stored in the Secret Service (GNOME Keyring or KWallet)
- [ ] Key bytes are base64-encoded for IPC transport and decoded in the Rust backend
- [ ] `has_key` returns `true`/`false` without retrieving the full key material
- [ ] Deleting a non-existent key does not produce an error (idempotent)
- [ ] macOS: Biometric gating with Touch ID works when configured
- [ ] Windows: Biometric gating with Windows Hello works when configured
- [ ] Linux: Biometric gating is gracefully skipped (stored without biometric)
- [ ] Key material is zeroed from memory after use (use `zeroize` crate)
- [ ] Error messages do not leak key material in any platform

---

### 5. Auto-Update (F7.5)

The app checks for and applies updates automatically using Tauri's built-in updater plugin. Updates are delta-based where possible, minimizing download size.

#### Update Flow

```
┌───────────────┐
│  App launches  │
└───────┬───────┘
        │
        ▼
┌───────────────────┐    no update    ┌────────────────┐
│ Check for update  │───────────────►│ Schedule next   │
│ (GET /update)     │                 │ check (6 hours) │
└───────┬───────────┘                 └────────────────┘
        │ update available
        ▼
┌───────────────────┐
│ Notify user       │
│ "v1.1.0 available"│
└───────┬───────────┘
        │ user clicks "Update"
        ▼
┌───────────────────┐
│ Download update   │
│ (delta if avail)  │
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Verify signature  │
│ (Ed25519 pubkey)  │
└───────┬───────────┘
        │ valid
        ▼
┌───────────────────┐
│ Apply update      │
│ (install + restart│
│  or schedule)     │
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Restart app       │
│ (with new version)│
└───────────────────┘
```

#### Update Server Response Format

The update endpoint returns JSON that Tauri's updater consumes:

```json
{
  "version": "1.1.0",
  "notes": "Bug fixes and performance improvements.\n- Fixed notification actions on Linux\n- Improved tray icon rendering on HiDPI displays",
  "pub_date": "2026-03-15T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<Ed25519_SIGNATURE>",
      "url": "https://releases.agentcontext.dev/v1.1.0/AgentContext_1.1.0_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<Ed25519_SIGNATURE>",
      "url": "https://releases.agentcontext.dev/v1.1.0/AgentContext_1.1.0_x64.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "<Ed25519_SIGNATURE>",
      "url": "https://releases.agentcontext.dev/v1.1.0/AgentContext_1.1.0_amd64.AppImage.tar.gz"
    },
    "windows-x86_64": {
      "signature": "<Ed25519_SIGNATURE>",
      "url": "https://releases.agentcontext.dev/v1.1.0/AgentContext_1.1.0_x64-setup.nsis.zip"
    }
  }
}
```

#### Update Implementation

```rust
// src-tauri/src/updater.rs
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;
use std::time::Duration;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60); // 6 hours

pub async fn check_for_updates(app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater()
        .map_err(|e| format!("Updater not configured: {}", e))?;

    match updater.check().await {
        Ok(Some(update)) => {
            Ok(Some(UpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
                date: update.date.map(|d| d.to_string()),
            }))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Update check failed: {}", e)),
    }
}

pub async fn download_and_install(app: &tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater()
        .map_err(|e| format!("Updater not configured: {}", e))?;

    let update = updater.check().await
        .map_err(|e| format!("Update check failed: {}", e))?
        .ok_or("No update available")?;

    // Download with progress tracking
    let mut downloaded = 0;
    let total = update.download_size();

    update.download_and_install(
        |chunk_length, content_length| {
            downloaded += chunk_length;
            let progress = if let Some(total) = content_length {
                (downloaded as f64 / total as f64) * 100.0
            } else {
                -1.0
            };
            // Emit progress to frontend
            let _ = app.emit("update-progress", UpdateProgress {
                downloaded,
                total: content_length,
                percent: progress,
            });
        },
        || {
            // Download complete, app will restart
            log::info!("Update downloaded, preparing to install...");
        },
    ).await
    .map_err(|e| format!("Update install failed: {}", e))?;

    Ok(())
}

/// Periodic update check loop. Runs on a background thread.
pub async fn update_check_loop(app: tauri::AppHandle) {
    // Initial check after 30 seconds (let the app settle)
    tokio::time::sleep(Duration::from_secs(30)).await;

    loop {
        match check_for_updates(&app).await {
            Ok(Some(update_info)) => {
                // Notify user via tray and/or notification
                crate::notifications::send_update_notification(
                    &app,
                    &update_info.version,
                    update_info.notes.as_deref().unwrap_or(""),
                );
                // Update tray to show update available
                crate::tray::set_update_available(&app, true);
            }
            Ok(None) => {
                log::debug!("No updates available");
            }
            Err(e) => {
                log::warn!("Update check failed: {}", e);
            }
        }

        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    downloaded: usize,
    total: Option<u64>,
    percent: f64,
}

#[derive(Clone, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}
```

#### Rollback on Failed Update

If an update fails during installation:

1. **macOS**: Tauri replaces the `.app` bundle atomically. If the new binary fails to launch (crashes on startup), the OS keeps the old version in the Trash and the user can restore it manually. The app detects a failed launch by writing a "launch success" marker 10 seconds after startup. If the marker from the previous launch is missing, a rollback is triggered.
2. **Windows**: The NSIS installer creates a backup before updating. If the new version crashes on first launch, the user is prompted to roll back.
3. **Linux**: The AppImage is replaced in-place. A backup of the previous AppImage is stored at `~/.local/share/agentcontext/backup/` before updating.

```rust
const LAUNCH_MARKER_FILE: &str = "last_launch_success";

pub async fn check_launch_health(app: &tauri::AppHandle) {
    let data_dir = app.path().app_data_dir().expect("No app data dir");
    let marker_path = data_dir.join(LAUNCH_MARKER_FILE);

    // Check if previous launch succeeded
    if marker_path.exists() {
        // Previous launch was healthy, remove marker
        let _ = std::fs::remove_file(&marker_path);
    }

    // Write marker after a delay (proves this launch is stable)
    let marker = marker_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let _ = std::fs::write(&marker, format!("{}", chrono::Utc::now()));
    });
}

pub fn backup_current_binary() -> Result<std::path::PathBuf, String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Cannot determine current exe: {}", e))?;

    let backup_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("agentcontext")
        .join("backup");

    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Cannot create backup dir: {}", e))?;

    let backup_path = backup_dir.join(
        current_exe.file_name().unwrap_or_default()
    );

    std::fs::copy(&current_exe, &backup_path)
        .map_err(|e| format!("Backup failed: {}", e))?;

    Ok(backup_path)
}
```

#### Update Server Configuration

The update server is a static file host (Cloudflare R2 or S3-compatible) with the following structure:

```
releases.agentcontext.dev/
├── darwin-aarch64/
│   └── 1.0.0                  # JSON response for arch/version query
├── darwin-x86_64/
│   └── 1.0.0
├── linux-x86_64/
│   └── 1.0.0
├── windows-x86_64/
│   └── 1.0.0
└── v1.1.0/                    # Actual binaries
    ├── AgentContext_1.1.0_aarch64.app.tar.gz
    ├── AgentContext_1.1.0_aarch64.app.tar.gz.sig
    ├── AgentContext_1.1.0_x64.app.tar.gz
    ├── AgentContext_1.1.0_x64.app.tar.gz.sig
    ├── AgentContext_1.1.0_amd64.AppImage.tar.gz
    ├── AgentContext_1.1.0_amd64.AppImage.tar.gz.sig
    ├── AgentContext_1.1.0_x64-setup.nsis.zip
    └── AgentContext_1.1.0_x64-setup.nsis.zip.sig
```

#### Acceptance Criteria

- [ ] App checks for updates on startup (after 30-second delay) and every 6 hours thereafter
- [ ] When an update is available, a notification is shown with version and release notes
- [ ] User can trigger an update from the tray menu ("Check for Updates...")
- [ ] Download progress is reported to the frontend via events
- [ ] Updates are verified using Ed25519 signature before installation
- [ ] After successful update, the app restarts with the new version
- [ ] If an update download fails, the current version continues to run unaffected
- [ ] A backup of the current binary is created before applying an update (Linux/Windows)
- [ ] A launch health marker is written 10 seconds after startup to detect post-update crashes
- [ ] The update check does not block app startup or the main thread
- [ ] Update check failures are logged but do not produce user-visible errors

---

### 6. Multi-Window (F7.6)

The app supports opening multiple windows, each showing a different agent's view. This enables side-by-side monitoring of parallel agents (UC7.2).

#### Window Types

| Window | Label Pattern | Content | Use Case |
|--------|---------------|---------|----------|
| Main | `main` | Full dashboard | Primary interface |
| Agent | `agent-{id}` | Single agent view | Monitor a specific agent |
| Settings | `settings` | Preferences panel | App configuration |

#### Window Management Commands

```rust
// src-tauri/src/commands/windows.rs
use tauri::{Manager, WebviewWindowBuilder, WebviewUrl};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct WindowInfo {
    pub label: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub is_focused: bool,
    pub is_visible: bool,
}

#[tauri::command]
pub async fn open_agent_window(
    app: tauri::AppHandle,
    agent_id: String,
    agent_name: String,
) -> Result<WindowInfo, String> {
    let label = format!("agent-{}", agent_id);

    // If the window already exists, focus it
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return get_window_info(&window);
    }

    // Restore saved position or use defaults
    let saved_state = crate::window_state::load_window_state(&label);
    let (width, height) = saved_state
        .as_ref()
        .map(|s| (s.width, s.height))
        .unwrap_or((900.0, 700.0));

    let url = WebviewUrl::App(format!("/agent/{}", agent_id).into());

    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(&format!("Agent: {}", agent_name))
        .inner_size(width, height)
        .min_inner_size(600.0, 400.0)
        .resizable(true)
        .decorations(true);

    // Restore position if saved
    if let Some(state) = &saved_state {
        builder = builder.position(state.x, state.y);
    } else {
        builder = builder.center();
    }

    let window = builder.build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    // Save window state on move/resize
    let label_clone = label.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(position) => {
                crate::window_state::save_position(&label_clone, position.x as f64, position.y as f64);
            }
            tauri::WindowEvent::Resized(size) => {
                crate::window_state::save_size(&label_clone, size.width as f64, size.height as f64);
            }
            tauri::WindowEvent::Destroyed => {
                crate::window_state::mark_closed(&label_clone);
            }
            _ => {}
        }
    });

    get_window_info(&window)
}

#[tauri::command]
pub async fn get_window_list(app: tauri::AppHandle) -> Result<Vec<WindowInfo>, String> {
    let windows = app.webview_windows();
    let mut infos = Vec::new();
    for (_, window) in windows {
        if let Ok(info) = get_window_info(&window) {
            infos.push(info);
        }
    }
    Ok(infos)
}

#[tauri::command]
pub async fn close_window(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    if label == "main" {
        // Hide main window to tray instead of closing
        if let Some(window) = app.get_webview_window("main") {
            window.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn get_window_info(window: &tauri::WebviewWindow) -> Result<WindowInfo, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(WindowInfo {
        label: window.label().to_string(),
        title: window.title().unwrap_or_default(),
        width: size.width as f64,
        height: size.height as f64,
        x: position.x as f64,
        y: position.y as f64,
        is_focused: window.is_focused().unwrap_or(false),
        is_visible: window.is_visible().unwrap_or(false),
    })
}
```

#### Window State Persistence

Window positions and sizes are saved to a JSON file in the app data directory and restored on next launch.

```rust
// src-tauri/src/window_state.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

static WINDOW_STATES: once_cell::sync::Lazy<Mutex<HashMap<String, WindowState>>> =
    once_cell::sync::Lazy::new(|| {
        let states = load_all_states().unwrap_or_default();
        Mutex::new(states)
    });

#[derive(Serialize, Deserialize, Clone)]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

const STATE_FILE: &str = "window-states.json";

pub fn load_window_state(label: &str) -> Option<WindowState> {
    WINDOW_STATES.lock().ok()?.get(label).cloned()
}

pub fn save_position(label: &str, x: f64, y: f64) {
    if let Ok(mut states) = WINDOW_STATES.lock() {
        let state = states.entry(label.to_string()).or_insert(WindowState {
            x, y, width: 900.0, height: 700.0, maximized: false,
        });
        state.x = x;
        state.y = y;
        persist_states(&states);
    }
}

pub fn save_size(label: &str, width: f64, height: f64) {
    if let Ok(mut states) = WINDOW_STATES.lock() {
        let state = states.entry(label.to_string()).or_insert(WindowState {
            x: 0.0, y: 0.0, width, height, maximized: false,
        });
        state.width = width;
        state.height = height;
        persist_states(&states);
    }
}

pub fn mark_closed(label: &str) {
    // Keep state for reopening, do not remove
}

pub fn restore(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(state) = load_window_state("main") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition::new(state.x as i32, state.y as i32)
            ));
            let _ = window.set_size(tauri::Size::Physical(
                tauri::PhysicalSize::new(state.width as u32, state.height as u32)
            ));
        }
    }
    Ok(())
}

fn persist_states(states: &HashMap<String, WindowState>) {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("agentcontext");
    let _ = std::fs::create_dir_all(&data_dir);
    let path = data_dir.join(STATE_FILE);
    if let Ok(json) = serde_json::to_string_pretty(states) {
        let _ = std::fs::write(path, json);
    }
}

fn load_all_states() -> Result<HashMap<String, WindowState>, Box<dyn std::error::Error>> {
    let data_dir = dirs::data_dir()
        .ok_or("No data dir")?
        .join("agentcontext");
    let path = data_dir.join(STATE_FILE);
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}
```

#### Window-to-Window Communication

Windows communicate through the Tauri event system. Any window can emit an event, and all windows receive it.

```rust
// Emit from Rust to all windows
app.emit("agent-status-changed", AgentStatusPayload {
    agent_id: "abc123".to_string(),
    status: "completed".to_string(),
}).unwrap();
```

```typescript
// Frontend: listen in any window
import { listen } from "@tauri-apps/api/event";

listen<AgentStatusPayload>("agent-status-changed", (event) => {
  console.log("Agent status:", event.payload);
});

// Frontend: emit from any window
import { emit } from "@tauri-apps/api/event";

emit("navigate-to-agent", { agentId: "abc123" });
```

#### Keyboard Shortcuts

| Shortcut | macOS | Windows/Linux | Action |
|----------|-------|---------------|--------|
| New window | Cmd+N | Ctrl+N | Open new agent creation dialog |
| Close window | Cmd+W | Ctrl+W | Close current window (hide if main) |
| Dashboard | Cmd+D | Ctrl+D | Focus main dashboard window |
| Preferences | Cmd+, | Ctrl+, | Open settings window |
| Cycle windows | Cmd+` | Alt+` | Cycle between open AgentContext windows |
| Quit | Cmd+Q | Alt+F4 | Quit application |

#### Acceptance Criteria

- [ ] Opening an agent window creates a new native window with the agent's view
- [ ] Opening the same agent twice focuses the existing window instead of creating a duplicate
- [ ] Window position and size are saved when the window is moved or resized
- [ ] Window position and size are restored when the same window is reopened
- [ ] Closing an agent window actually closes it (unlike the main window which hides to tray)
- [ ] `get_window_list` returns all open windows with their current state
- [ ] Events emitted from one window are received by all other windows
- [ ] Keyboard shortcuts work on all platforms with correct modifier keys
- [ ] The main window cannot be closed, only hidden (close button hides to tray)
- [ ] Up to 10 agent windows can be open simultaneously without performance degradation

---

### 7. Platform-Specific Considerations

#### macOS

**Universal Binary**: The app must be compiled as a universal binary supporting both arm64 (Apple Silicon) and x86_64 (Intel).

```bash
# Build universal binary
cargo tauri build --target universal-apple-darwin
```

**Notarization**: All macOS builds must be notarized with Apple to avoid Gatekeeper warnings.

```bash
# Notarization is handled by tauri-cli when configured:
# 1. Sign with Developer ID Application certificate
# 2. Submit to Apple's notarization service
# 3. Staple the notarization ticket to the .dmg

# Required environment variables for CI:
# APPLE_CERTIFICATE - Base64-encoded .p12 certificate
# APPLE_CERTIFICATE_PASSWORD - Certificate password
# APPLE_SIGNING_IDENTITY - e.g., "Developer ID Application: Company Name (TEAM_ID)"
# APPLE_ID - Apple ID email
# APPLE_PASSWORD - App-specific password
# APPLE_TEAM_ID - Developer team ID
```

**Entitlements**: The app requires specific entitlements for Keychain access and networking.

```xml
<!-- Entitlements.plist -->
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

**Menu Bar Behavior**: On macOS, the tray icon sits in the menu bar. The app should follow macOS conventions:
- Use a template icon (monochrome, adapts to dark mode)
- Clicking the tray icon shows the menu (not toggle behavior -- macOS convention)
- The app menu bar (File, Edit, etc.) should be present when the window is focused

#### Windows

**Code Signing**: All Windows builds must be signed with an Authenticode certificate to avoid SmartScreen warnings.

```bash
# Code signing is configured in tauri.conf.json:
# bundle.windows.certificateThumbprint = "..."
# bundle.windows.timestampUrl = "http://timestamp.digicert.com"

# For CI, the certificate is provided via environment:
# TAURI_SIGNING_PRIVATE_KEY - PFX certificate (base64)
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD - Certificate password
```

**Installer Options**: Two installer formats are supported:

| Installer | Pros | Cons |
|-----------|------|------|
| WiX (.msi) | Enterprise-friendly, Group Policy support | More complex to customize |
| NSIS (.exe) | More customizable UI, smaller installer | Less enterprise-friendly |

Default to NSIS for consumer distribution. Provide WiX as an option for enterprise deployments.

**WebView2 Runtime**: Windows builds depend on the Edge WebView2 runtime. Tauri's NSIS installer can bootstrap WebView2 if it is not already installed. The WiX installer requires it as a prerequisite.

#### Linux

**Desktop Entry**: The app installs a `.desktop` file for integration with application launchers.

```ini
# agentcontext.desktop
[Desktop Entry]
Name=AgentContext
Comment=Agent management and session history
Exec=agentcontext
Icon=agentcontext
Type=Application
Categories=Development;IDE;
StartupNotify=true
StartupWMClass=agentcontext
```

**Icon Installation**: Icons are installed to the standard XDG icon directories:

```
~/.local/share/icons/hicolor/32x32/apps/agentcontext.png
~/.local/share/icons/hicolor/128x128/apps/agentcontext.png
~/.local/share/icons/hicolor/256x256/apps/agentcontext.png
~/.local/share/icons/hicolor/512x512/apps/agentcontext.png
```

**AppImage Portability**: The AppImage build is fully self-contained. It bundles WebKitGTK and all dependencies. Users download and `chmod +x` the AppImage to run it -- no installation required.

**Tray Icon on Linux**: Linux tray support varies by desktop environment:

| DE | Tray Protocol | Notes |
|----|---------------|-------|
| GNOME | StatusNotifier (via extension) | Requires "AppIndicator" GNOME Shell extension |
| KDE | StatusNotifier (native) | Works out of the box |
| XFCE | StatusNotifier or legacy systray | Usually works |
| Sway/i3 | Not supported | Falls back to no tray icon |

The app must handle the case where no tray is available: if the tray icon fails to create, log a warning and continue without tray functionality. The main window close button should quit the app (not hide to tray) when no tray is available.

```rust
pub fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    match TrayIconBuilder::with_id("main-tray")
        .icon(get_tray_icon(TrayState::Idle))
        .build(app)
    {
        Ok(_) => {
            log::info!("System tray initialized");
            // Set flag: tray is available, hide-to-tray behavior enabled
            app.state::<AppState>().set_tray_available(true);
            Ok(())
        }
        Err(e) => {
            log::warn!("System tray not available: {}. App will quit on close.", e);
            app.state::<AppState>().set_tray_available(false);
            Ok(()) // Not a fatal error
        }
    }
}
```

#### Acceptance Criteria

- [ ] macOS: Universal binary runs natively on both Apple Silicon and Intel Macs
- [ ] macOS: App is notarized and does not trigger Gatekeeper warnings
- [ ] macOS: Entitlements allow Keychain access and network connections
- [ ] macOS: Tray icon uses template mode and adapts to light/dark menu bar
- [ ] Windows: App is code-signed and does not trigger SmartScreen warnings
- [ ] Windows: NSIS installer bootstraps WebView2 if not present
- [ ] Windows: WiX installer is available as an alternative build target
- [ ] Linux: `.desktop` file integrates with application launchers
- [ ] Linux: Icons are installed to XDG icon directories
- [ ] Linux: AppImage is fully self-contained and portable
- [ ] Linux: App degrades gracefully when tray icon is not supported (e.g., Sway/i3)
- [ ] Linux: When no tray is available, closing the window quits the app

---

## Edge Cases

### E-1: Daemon Not Running on App Launch

**Scenario**: The user launches the desktop app but the AgentContext daemon is not running.

**Expected behavior**: The app launches successfully and displays a "Daemon not connected" state in the dashboard. The tray icon shows the Error state (red). A banner in the dashboard offers a "Start Daemon" button. The app periodically retries connecting (every 5 seconds). When the daemon starts, the app transitions to the connected state automatically.

**Risk**: The frontend may show stale or empty data if it assumes the daemon is always available.

**Mitigation**: The frontend must handle the disconnected state explicitly. All daemon API calls return a typed error, and the UI shows a clear "offline" state rather than broken widgets.

---

### E-2: Multiple App Instances

**Scenario**: The user tries to launch AgentContext Desktop a second time while it is already running.

**Expected behavior**: The second instance detects the first (via a single-instance lock file or Tauri's built-in single-instance plugin) and sends a signal to the first instance to show its main window. The second instance then exits.

```rust
// In main.rs
.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    // Another instance tried to launch -- focus our window
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}))
```

**Risk**: On Linux, some desktop environments may not support single-instance detection reliably.

**Mitigation**: Use a filesystem lock file at `~/.local/share/agentcontext/app.lock` as a fallback. If the lock file exists and the PID within it is still running, refuse to start and attempt to focus the existing instance via DBus.

---

### E-3: WebView2 Missing on Windows

**Scenario**: The user is on Windows 10 without the Edge WebView2 runtime installed (rare but possible on LTSC or heavily customized Windows installs).

**Expected behavior**: The NSIS installer detects the missing runtime and downloads the WebView2 Evergreen Bootstrapper from Microsoft. It installs the runtime before proceeding with the app installation. If the runtime installation fails (no internet, corporate firewall), the installer shows a clear error with instructions to install WebView2 manually.

**Mitigation**: Bundling the WebView2 runtime directly in the installer (offline mode) adds ~150MB to the installer size. The default is the bootstrapper approach. An offline installer variant can be provided for enterprise deployments.

---

### E-4: Notification Permissions Denied

**Scenario**: The user has denied notification permissions for AgentContext at the OS level (macOS System Settings > Notifications, Windows Settings > Notifications).

**Expected behavior**: The app detects that notifications are blocked and shows a subtle in-app indicator (e.g., a bell icon with a line through it). Permission requests from agents are shown as in-app alerts instead. The tray icon "Attention" state (orange pulsing) still works since it does not require notification permissions.

**Risk**: On macOS, the app cannot programmatically check if notifications are allowed without attempting to send one (there is no "check permission" API for the notification plugin).

**Mitigation**: On the first launch, the app sends a test notification. If it is delivered, notifications are working. If not, the app falls back to in-app alerts and logs a warning.

---

### E-5: Key Storage Backend Unavailable

**Scenario**: On Linux, the Secret Service (GNOME Keyring or KWallet) is not running. This happens on minimal Linux installs, headless setups, or window managers without a keyring daemon.

**Expected behavior**: The `keyring` crate returns an error when attempting to store or retrieve keys. The app detects this and falls back to encrypted file-based storage at `~/.local/share/agentcontext/keys.enc`. The file is encrypted with a machine-specific key derived from `/etc/machine-id` and the user's UID.

**Risk**: File-based storage is less secure than a proper keyring. The machine-specific key can be derived by any process running as the same user.

**Mitigation**: Log a warning at startup: "Secure key storage unavailable. Using encrypted file fallback. For better security, install gnome-keyring or kwallet." Document the fallback in the user-facing settings panel.

---

### E-6: Window Restored to Invalid Position

**Scenario**: The user had the app window on a second monitor. They disconnect the monitor and relaunch the app. The saved position is now off-screen.

**Expected behavior**: On restore, the app checks whether the saved position is within the bounds of any currently connected monitor. If not, it resets the window to the center of the primary monitor.

```rust
pub fn validate_window_position(state: &WindowState) -> WindowState {
    // Get available monitors
    // Check if (state.x, state.y) is within any monitor bounds
    // If not, return centered position on primary monitor
    // Otherwise, return the original state
    ...
}
```

**Risk**: Multi-monitor detection APIs vary by platform and may not be 100% reliable on Linux (especially Wayland).

**Mitigation**: Use Tauri's `available_monitors()` API, which abstracts platform differences. If the API fails, fall back to centering on the primary display.

---

### E-7: Update Server Unreachable

**Scenario**: The update server is down or the user has no internet connection.

**Expected behavior**: The update check times out after 10 seconds and logs a debug-level message. The app continues to function normally. The next periodic check (6 hours later) will try again. There is no user-visible error for routine update check failures.

**Mitigation**: If the user manually triggers "Check for Updates..." from the tray menu, a failure is shown as a brief in-app toast: "Could not check for updates. Please check your internet connection."

---

### E-8: Rapid Agent Status Changes Overwhelming Tray

**Scenario**: 10 agents start and stop in rapid succession, each triggering a tray menu rebuild and icon change.

**Expected behavior**: Tray updates are debounced. When multiple status changes arrive within a 500ms window, only the final state is applied to the tray.

```rust
pub struct TrayDebouncer {
    pending: Arc<Mutex<Option<(TrayState, Vec<AgentInfo>)>>>,
    debounce_ms: u64,
}

impl TrayDebouncer {
    pub fn update(&self, app: &tauri::AppHandle, state: TrayState, agents: Vec<AgentInfo>) {
        let pending = self.pending.clone();
        let app = app.clone();
        let delay = self.debounce_ms;

        *pending.lock().unwrap() = Some((state, agents));

        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if let Some((state, agents)) = pending.lock().unwrap().take() {
                update_tray(&app, state, &agents);
            }
        });
    }
}
```

---

## Technical Specification Summary

### Rust Dependencies (Cargo.toml)

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

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

### Capabilities Configuration

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

### Application State

```rust
// src-tauri/src/state.rs
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::keystore::KeyStore;
use crate::notifications::NotificationSettings;

pub struct AppState {
    pub daemon_client: Arc<Mutex<DaemonClient>>,
    pub keystore: KeyStore,
    pub notification_settings: Arc<Mutex<NotificationSettings>>,
    pub tray_available: Arc<std::sync::atomic::AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            daemon_client: Arc::new(Mutex::new(DaemonClient::new())),
            keystore: KeyStore::new(),
            notification_settings: Arc::new(Mutex::new(NotificationSettings::default())),
            tray_available: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn set_tray_available(&self, available: bool) {
        self.tray_available.store(available, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_tray_available(&self) -> bool {
        self.tray_available.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub struct DaemonClient {
    base_url: String,
    http_client: reqwest::Client,
}

impl DaemonClient {
    pub fn new() -> Self {
        Self {
            base_url: "http://localhost:7399".to_string(),
            http_client: reqwest::Client::new(),
        }
    }

    pub async fn health_check(&self) -> Result<DaemonStatus, Box<dyn std::error::Error>> {
        let resp = self.http_client
            .get(format!("{}/api/health", self.base_url))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await?;
        Ok(resp.json().await?)
    }
}

/// Periodically check daemon health and update tray state accordingly.
pub async fn daemon_health_loop(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    loop {
        let status = state.daemon_client.lock().await.health_check().await;
        match status {
            Ok(s) if s.active_agents > 0 => {
                crate::tray::update_tray(&app, crate::tray::TrayState::Running, &[]);
            }
            Ok(_) => {
                crate::tray::update_tray(&app, crate::tray::TrayState::Idle, &[]);
            }
            Err(_) => {
                crate::tray::update_tray(&app, crate::tray::TrayState::Error, &[]);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
```

### File Locations

| File | Path | Purpose |
|------|------|---------|
| App data | `~/.local/share/agentcontext/` (Linux), `~/Library/Application Support/agentcontext/` (macOS), `%APPDATA%\agentcontext\` (Windows) | Settings, window state, backups |
| Window states | `{app_data}/window-states.json` | Persisted window positions and sizes |
| Notification settings | `{app_data}/notification-settings.json` | User notification preferences |
| Update backups | `{app_data}/backup/` | Pre-update binary backups |
| Launch marker | `{app_data}/last_launch_success` | Post-update health check |
| Logs | `{app_data}/logs/` | Application logs |

---

## Testing Plan

### Unit Tests (Rust)

| Test | Description |
|------|-------------|
| T-1 | `KeyStore::store_key` and `KeyStore::retrieve_key` round-trip produces identical bytes |
| T-2 | `KeyStore::has_key` returns `false` for non-existent key |
| T-3 | `KeyStore::delete_key` on non-existent key does not error |
| T-4 | `KeyStore::retrieve_key` returns `KeyNotFound` for deleted key |
| T-5 | `WindowState` serialization/deserialization round-trip |
| T-6 | `validate_window_position` centers window when position is off-screen |
| T-7 | `TrayState` icon selection returns correct icon for each state |
| T-8 | `NotificationSettings::default()` has all categories enabled |
| T-9 | `UpdateInfo` deserialization from update server JSON format |
| T-10 | `DaemonClient::health_check` returns Error state when daemon is unreachable |

### Integration Tests

| Test | Description |
|------|-------------|
| T-11 | App launches and displays the main window within 3 seconds |
| T-12 | System tray icon appears and responds to left-click |
| T-13 | Tray menu shows correct items and submenus |
| T-14 | Opening an agent window creates a new native window |
| T-15 | Opening the same agent twice focuses the existing window |
| T-16 | Window position persists after close and reopen |
| T-17 | IPC `get_daemon_status` command returns a valid response (or error) |
| T-18 | IPC `store_key` and `retrieve_key` round-trip works from frontend |
| T-19 | Notification action "approve" sends approval to daemon |
| T-20 | Single-instance detection: second launch focuses first instance |
| T-21 | Close button hides to tray (when tray is available) |
| T-22 | Close button quits app (when tray is not available) |

### Platform-Specific Tests

| Test | Description |
|------|-------------|
| T-23 | macOS: Universal binary runs on both arm64 and x86_64 |
| T-24 | macOS: Notarized .dmg installs without Gatekeeper warnings |
| T-25 | macOS: Tray icon adapts to dark/light menu bar mode |
| T-26 | Windows: NSIS installer installs WebView2 if missing |
| T-27 | Windows: Signed installer does not trigger SmartScreen |
| T-28 | Linux: .AppImage runs on Ubuntu 22.04 without additional dependencies |
| T-29 | Linux: .deb installs and creates a desktop entry |
| T-30 | Linux: App degrades gracefully without tray support (Sway) |

### Manual Verification

| Test | Description |
|------|-------------|
| M-1 | Install .dmg on macOS, launch, verify tray icon, open dashboard, quit from tray |
| M-2 | Install .msi on Windows, launch, verify tray, verify WebView2 is present |
| M-3 | Run .AppImage on Ubuntu, verify tray, verify notifications |
| M-4 | Launch with daemon stopped, verify error state, start daemon, verify transition |
| M-5 | Trigger a permission request from an agent, verify notification with Approve/Deny buttons |
| M-6 | Open two agent windows side by side, verify they update independently |
| M-7 | Trigger an auto-update (with a test update server), verify download, install, and restart |
| M-8 | Store and retrieve an encryption key, verify round-trip via the frontend |
| M-9 | Disconnect external monitor, relaunch app, verify window centers on primary display |
| M-10 | Enable Do Not Disturb, trigger notification, verify it is suppressed, disable DND, verify it appears in Notification Center |

---

## Definition of Done

- [ ] Tauri 2 project compiles and produces valid binaries for macOS, Windows, and Linux
- [ ] WebView loads the dashboard frontend and IPC commands are functional
- [ ] System tray icon appears on all three platforms with correct state transitions
- [ ] Tray menu shows daemon status, agent list, and all specified menu items
- [ ] Native notifications are delivered with action buttons for permission requests
- [ ] Notification actions (approve/deny) work without opening the main window
- [ ] Keys can be stored and retrieved via the OS credential manager on all three platforms
- [ ] Biometric gating works on macOS (Touch ID) and Windows (Windows Hello)
- [ ] Auto-updater checks for updates, downloads, verifies signatures, and installs
- [ ] Pre-update backup is created; post-update health check detects crashed launches
- [ ] Multiple agent windows can be opened, positioned, and their state persists across restarts
- [ ] Window-to-window event communication works across all open windows
- [ ] Single-instance detection prevents duplicate app instances
- [ ] macOS build is a notarized universal binary with correct entitlements
- [ ] Windows build is code-signed with WebView2 bootstrapping in the NSIS installer
- [ ] Linux build includes .AppImage (portable) and .deb (installable) with desktop entry
- [ ] Linux app degrades gracefully when tray icon is not supported
- [ ] All 30 test cases from the testing plan pass
- [ ] Edge cases E-1 through E-8 are handled as specified
