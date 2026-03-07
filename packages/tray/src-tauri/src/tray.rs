//! System tray setup, icon management, and menu building for SaqrNestUI.
//!
//! Adapted from packages/desktop/src-tauri/src/tray.rs — simplified for
//! daemon-only tray management without the full desktop window features.

use std::sync::Mutex;
use std::time::Instant;

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// Tray State
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Running,
    Error,
}

impl std::fmt::Display for TrayState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrayState::Idle => write!(f, "idle"),
            TrayState::Running => write!(f, "running"),
            TrayState::Error => write!(f, "error"),
        }
    }
}

/// Compute tray state from daemon health.
pub fn compute_tray_state(daemon_running: bool, active_sessions: usize) -> TrayState {
    if !daemon_running {
        return TrayState::Error;
    }
    if active_sessions > 0 {
        return TrayState::Running;
    }
    TrayState::Idle
}

// ---------------------------------------------------------------------------
// Icon Bytes
// ---------------------------------------------------------------------------

pub fn get_tray_icon_bytes(state: TrayState) -> &'static [u8] {
    match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle.png"),
        TrayState::Running => include_bytes!("../icons/tray-running.png"),
        TrayState::Error => include_bytes!("../icons/tray-error.png"),
    }
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

pub fn format_tooltip(state: TrayState, session_count: usize) -> String {
    match state {
        TrayState::Idle => "SaqrNest - Daemon idle".to_string(),
        TrayState::Running => {
            let plural = if session_count == 1 { "session" } else { "sessions" };
            format!("SaqrNest - {} {} active", session_count, plural)
        }
        TrayState::Error => "SaqrNest - Daemon stopped".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tray Setup
// ---------------------------------------------------------------------------

/// Create and configure the system tray icon.
pub fn setup_tray(app: &AppHandle) -> Result<TrayIcon, Box<dyn std::error::Error>> {
    let icon_bytes = get_tray_icon_bytes(TrayState::Idle);
    let icon = Image::from_bytes(icon_bytes)?;

    let menu = build_initial_menu(app)?;

    let tray = TrayIconBuilder::with_id("saqrnest")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("SaqrNest")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_popup(app);
            }
        })
        .build(app)?;

    Ok(tray)
}

fn build_initial_menu(
    app: &AppHandle,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mut builder = MenuBuilder::new(app);

    let header = MenuItemBuilder::with_id("header", "SaqrNest v0.1.0")
        .enabled(false)
        .build(app)?;
    builder = builder.item(&header);

    let status = MenuItemBuilder::with_id("daemon-status", "Daemon: Checking...")
        .enabled(false)
        .build(app)?;
    builder = builder.item(&status);

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    let open_panel = MenuItemBuilder::with_id("open-panel", "Open Status Panel").build(app)?;
    builder = builder.item(&open_panel);

    let start_daemon = MenuItemBuilder::with_id("start-daemon", "Start Daemon").build(app)?;
    builder = builder.item(&start_daemon);

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    let login = MenuItemBuilder::with_id("login", "Login to Saqr Cloud...").build(app)?;
    builder = builder.item(&login);

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    let quit = MenuItemBuilder::with_id("quit", "Quit SaqrNest").build(app)?;
    builder = builder.item(&quit);

    Ok(builder.build()?)
}

/// Update the tray icon, tooltip, and menu based on current state.
pub fn update_tray(
    app: &AppHandle,
    daemon_running: bool,
    session_count: usize,
) {
    let state = compute_tray_state(daemon_running, session_count);
    let icon_bytes = get_tray_icon_bytes(state);
    let tooltip = format_tooltip(state, session_count);

    if let Some(tray) = app.tray_by_id("saqrnest") {
        if let Ok(icon) = Image::from_bytes(icon_bytes) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(&tooltip));

        // Rebuild menu
        if let Ok(menu) = build_status_menu(app, daemon_running, session_count) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn build_status_menu(
    app: &AppHandle,
    daemon_running: bool,
    session_count: usize,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mut builder = MenuBuilder::new(app);

    let header = MenuItemBuilder::with_id("header", "SaqrNest v0.1.0")
        .enabled(false)
        .build(app)?;
    builder = builder.item(&header);

    let daemon_label = if daemon_running {
        "Daemon: Running".to_string()
    } else {
        "Daemon: Stopped".to_string()
    };
    let daemon_item = MenuItemBuilder::with_id("daemon-status", daemon_label)
        .enabled(false)
        .build(app)?;
    builder = builder.item(&daemon_item);

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    let open_panel = MenuItemBuilder::with_id("open-panel", "Open Status Panel").build(app)?;
    builder = builder.item(&open_panel);

    if daemon_running {
        let stop = MenuItemBuilder::with_id("stop-daemon", "Stop Daemon").build(app)?;
        builder = builder.item(&stop);
    } else {
        let start = MenuItemBuilder::with_id("start-daemon", "Start Daemon").build(app)?;
        builder = builder.item(&start);
    }

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    let login = MenuItemBuilder::with_id("login", "Login to Saqr Cloud...").build(app)?;
    builder = builder.item(&login);

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    let quit = MenuItemBuilder::with_id("quit", "Quit SaqrNest").build(app)?;
    builder = builder.item(&quit);

    Ok(builder.build()?)
}

// ---------------------------------------------------------------------------
// Event Handling
// ---------------------------------------------------------------------------

fn handle_menu_event(app: &AppHandle, event_id: &str) {
    match event_id {
        "open-panel" => {
            toggle_popup(app);
        }
        "login" => {
            toggle_popup(app);
        }
        "start-daemon" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::process::Command::new("saqrnest")
                    .args(["start"])
                    .output()
                    .await;
            });
        }
        "stop-daemon" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::process::Command::new("saqrnest")
                    .args(["stop"])
                    .output()
                    .await;
            });
        }
        "quit" => {
            // Stop daemon sidecar then exit
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                app.exit(0);
            });
        }
        _ => {}
    }
}

/// Toggle the popup window near the tray icon.
fn toggle_popup(app: &AppHandle) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("popup") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        // Create popup window
        let _window = tauri::WebviewWindowBuilder::new(
            app,
            "popup",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("SaqrNest")
        .inner_size(350.0, 500.0)
        .resizable(false)
        .decorations(true)
        .always_on_top(true)
        .center()
        .build();
    }
}

// ---------------------------------------------------------------------------
// Debouncer
// ---------------------------------------------------------------------------

pub struct TrayDebouncer {
    last_update: Mutex<Option<Instant>>,
    debounce_ms: u64,
}

impl TrayDebouncer {
    pub fn new() -> Self {
        Self {
            last_update: Mutex::new(None),
            debounce_ms: 500,
        }
    }

    pub fn should_update(&self) -> bool {
        let now = Instant::now();
        let mut last = self.last_update.lock().unwrap();
        if let Some(prev) = *last {
            if now.duration_since(prev).as_millis() < self.debounce_ms as u128 {
                return false;
            }
        }
        *last = Some(now);
        true
    }
}

impl Default for TrayDebouncer {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_state_error_when_not_running() {
        assert_eq!(compute_tray_state(false, 0), TrayState::Error);
        assert_eq!(compute_tray_state(false, 5), TrayState::Error);
    }

    #[test]
    fn compute_state_running_with_sessions() {
        assert_eq!(compute_tray_state(true, 3), TrayState::Running);
    }

    #[test]
    fn compute_state_idle_no_sessions() {
        assert_eq!(compute_tray_state(true, 0), TrayState::Idle);
    }

    #[test]
    fn tooltip_formatting() {
        assert_eq!(format_tooltip(TrayState::Idle, 0), "SaqrNest - Daemon idle");
        assert_eq!(format_tooltip(TrayState::Running, 1), "SaqrNest - 1 session active");
        assert_eq!(format_tooltip(TrayState::Running, 3), "SaqrNest - 3 sessions active");
        assert_eq!(format_tooltip(TrayState::Error, 0), "SaqrNest - Daemon stopped");
    }

    #[test]
    fn debouncer_allows_first_update() {
        let debouncer = TrayDebouncer::new();
        assert!(debouncer.should_update());
    }

    #[test]
    fn debouncer_blocks_rapid_updates() {
        let debouncer = TrayDebouncer::new();
        assert!(debouncer.should_update());
        assert!(!debouncer.should_update());
    }
}
