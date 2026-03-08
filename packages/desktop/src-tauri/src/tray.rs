//! System tray setup, icon management, menu building, and event handling.
//!
//! Implements five tray states (Idle, Running, Attention, Error, Updating)
//! with corresponding icons and dynamic context menus showing agent status.
//! Matches the behavior defined in `packages/desktop/src/tray-state.ts`.

use std::sync::atomic::Ordering;
use std::time::Instant;

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};

use crate::state::{AgentInfo, AppState, DaemonStatus};

// ---------------------------------------------------------------------------
// Tray State
// ---------------------------------------------------------------------------

/// The five possible tray icon states.
/// Matches the TypeScript `TRAY_STATES` in `ipc-types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Running,
    Attention,
    Error,
    Updating,
}

impl std::fmt::Display for TrayState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrayState::Idle => write!(f, "idle"),
            TrayState::Running => write!(f, "running"),
            TrayState::Attention => write!(f, "attention"),
            TrayState::Error => write!(f, "error"),
            TrayState::Updating => write!(f, "updating"),
        }
    }
}

impl TrayState {
    /// Parse from string (matching TS TrayState union type).
    pub fn from_str(s: &str) -> Self {
        match s {
            "idle" => TrayState::Idle,
            "running" => TrayState::Running,
            "attention" => TrayState::Attention,
            "error" => TrayState::Error,
            "updating" => TrayState::Updating,
            _ => TrayState::Idle,
        }
    }
}

// ---------------------------------------------------------------------------
// Tray State Computation
// ---------------------------------------------------------------------------

/// Computes the tray state from individual flags.
/// Priority: error > attention > updating > running > idle
/// Matches the TypeScript `computeTrayState` function in `tray-state.ts`.
pub fn compute_tray_state(
    daemon_running: bool,
    active_agent_count: u32,
    needs_permission: bool,
    has_update: bool,
) -> TrayState {
    if !daemon_running {
        return TrayState::Error;
    }
    if needs_permission {
        return TrayState::Attention;
    }
    if has_update {
        return TrayState::Updating;
    }
    if active_agent_count > 0 {
        return TrayState::Running;
    }
    TrayState::Idle
}

// ---------------------------------------------------------------------------
// Icon Bytes
// ---------------------------------------------------------------------------

/// Get the tray icon bytes for a given state.
pub fn get_tray_icon_bytes(state: TrayState) -> &'static [u8] {
    match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle.png"),
        TrayState::Running => include_bytes!("../icons/tray-running.png"),
        TrayState::Attention => include_bytes!("../icons/tray-attention.png"),
        TrayState::Error => include_bytes!("../icons/tray-error.png"),
        TrayState::Updating => include_bytes!("../icons/tray-updating.png"),
    }
}

// ---------------------------------------------------------------------------
// Tooltip Formatting
// ---------------------------------------------------------------------------

/// Formats the tooltip text for the tray icon.
/// Matches the TypeScript `formatTooltip` function in `tray-state.ts`.
pub fn format_tooltip(state: TrayState, agent_count: usize) -> String {
    match state {
        TrayState::Idle => "Saqr - No active agents".to_string(),
        TrayState::Running => {
            let plural = if agent_count == 1 { "agent" } else { "agents" };
            format!("Saqr - {} {} running", agent_count, plural)
        }
        TrayState::Attention => "Saqr - Action required".to_string(),
        TrayState::Error => "Saqr - Daemon disconnected".to_string(),
        TrayState::Updating => "Saqr - Updating...".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tray Setup
// ---------------------------------------------------------------------------

/// Create and configure the system tray icon.
pub fn setup_tray(app: &AppHandle) -> Result<TrayIcon, Box<dyn std::error::Error>> {
    let icon_bytes = get_tray_icon_bytes(TrayState::Idle);
    let icon = Image::from_bytes(icon_bytes)?;

    let quit = MenuItemBuilder::with_id("quit", "Quit Saqr").build(app)?;
    let open_dashboard = MenuItemBuilder::with_id("open-dashboard", "Open Dashboard").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open_dashboard)
        .item(&separator)
        .item(&quit)
        .build()?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Saqr")
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
                toggle_main_window(app);
            }
        })
        .build(app)?;

    // Mark tray as available
    if let Some(state) = app.try_state::<AppState>() {
        state.tray_available.store(true, Ordering::Relaxed);
    }

    Ok(tray)
}

/// Update the tray icon and tooltip based on current state.
pub fn update_tray(
    app: &AppHandle,
    tray_state: TrayState,
    agents: &[AgentInfo],
    daemon_status: &DaemonStatus,
) {
    let icon_bytes = get_tray_icon_bytes(tray_state);
    let tooltip = format_tooltip(tray_state, agents.len());

    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(icon) = Image::from_bytes(icon_bytes) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(&tooltip));

        // Rebuild menu with current state
        if let Ok(menu) = build_tray_menu(app, tray_state, agents, daemon_status) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Build the full tray context menu matching the TypeScript `buildTrayMenuItems`.
fn build_tray_menu(
    app: &AppHandle,
    _tray_state: TrayState,
    agents: &[AgentInfo],
    daemon_status: &DaemonStatus,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mut builder = MenuBuilder::new(app);

    // Header
    let header = MenuItemBuilder::with_id("header", "Saqr v0.1.0")
        .enabled(false)
        .build(app)?;
    builder = builder.item(&header);

    // Daemon status
    let daemon_label = if daemon_status.running {
        format!(
            "Daemon: Running (PID {})",
            daemon_status.pid.map_or("?".to_string(), |p| p.to_string())
        )
    } else {
        "Daemon: Stopped".to_string()
    };
    let daemon_item = MenuItemBuilder::with_id("daemon-status", daemon_label)
        .enabled(false)
        .build(app)?;
    builder = builder.item(&daemon_item);

    // Separator
    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Agent count
    let agent_count = agents.len();
    let agent_plural = if agent_count == 1 { "agent" } else { "agents" };
    let count_item = MenuItemBuilder::with_id(
        "agent-count",
        format!("{} {} running", agent_count, agent_plural),
    )
    .enabled(false)
    .build(app)?;
    builder = builder.item(&count_item);

    // Separator
    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Open Dashboard
    let open = MenuItemBuilder::with_id("open-dashboard", "Open Dashboard").build(app)?;
    builder = builder.item(&open);

    // Start New Agent
    let new_agent = MenuItemBuilder::with_id("start-new-agent", "Start New Agent...")
        .enabled(daemon_status.running)
        .build(app)?;
    builder = builder.item(&new_agent);

    // Separator
    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Running agents
    for agent in agents {
        let label = format!("{} ({})", agent.name, agent.model);
        let agent_item =
            MenuItemBuilder::with_id(format!("agent-{}", agent.id), label).build(app)?;
        builder = builder.item(&agent_item);
    }

    // Separator if there are agents
    if !agents.is_empty() {
        builder = builder.item(&PredefinedMenuItem::separator(app)?);
    }

    // Start/Stop Daemon
    if daemon_status.running {
        let stop = MenuItemBuilder::with_id("stop-daemon", "Stop Daemon").build(app)?;
        builder = builder.item(&stop);
    } else {
        let start = MenuItemBuilder::with_id("start-daemon", "Start Daemon").build(app)?;
        builder = builder.item(&start);
    }

    // Separator
    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Preferences and Updates
    let prefs = MenuItemBuilder::with_id("preferences", "Preferences...").build(app)?;
    builder = builder.item(&prefs);

    let check_updates =
        MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?;
    builder = builder.item(&check_updates);

    // Separator
    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Quit
    let quit = MenuItemBuilder::with_id("quit", "Quit Saqr").build(app)?;
    builder = builder.item(&quit);

    let quit_all = MenuItemBuilder::with_id("quit-all", "Quit All").build(app)?;
    builder = builder.item(&quit_all);

    Ok(builder.build()?)
}

// ---------------------------------------------------------------------------
// Event Handling
// ---------------------------------------------------------------------------

/// Handle tray menu item click events.
fn handle_menu_event(app: &AppHandle, event_id: &str) {
    match event_id {
        "open-dashboard" => {
            toggle_main_window(app);
        }
        "quit" => {
            app.exit(0);
        }
        "quit-all" => {
            // Stop daemon then quit
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = app.try_state::<AppState>() {
                    let client = state.daemon_client.lock().await;
                    // Best effort to stop daemon
                    let _ = tokio::process::Command::new("saqr")
                        .args(["daemon", "stop"])
                        .output()
                        .await;
                    drop(client);
                }
                app.exit(0);
            });
        }
        "start-daemon" => {
            let _app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::process::Command::new("saqr")
                    .args(["daemon", "start"])
                    .output()
                    .await;
            });
        }
        "stop-daemon" => {
            let _app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::process::Command::new("saqr")
                    .args(["daemon", "stop"])
                    .output()
                    .await;
            });
        }
        id if id.starts_with("agent-") => {
            let agent_id = id.strip_prefix("agent-").unwrap_or("");
            let app = app.clone();
            let agent_id = agent_id.to_string();
            tauri::async_runtime::spawn(async move {
                let label = format!("agent-{}", agent_id);
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }
        _ => {}
    }
}

/// Toggle the main window visibility.
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

// ---------------------------------------------------------------------------
// Tray Debouncer
// ---------------------------------------------------------------------------

/// Debounces rapid tray updates. Coalesces updates within 500ms.
pub struct TrayDebouncer {
    last_update: Option<Instant>,
    debounce_ms: u64,
}

impl TrayDebouncer {
    pub fn new() -> Self {
        Self {
            last_update: None,
            debounce_ms: 500,
        }
    }

    /// Returns true if enough time has passed since the last update.
    pub fn should_update(&mut self) -> bool {
        let now = Instant::now();
        if let Some(last) = self.last_update {
            if now.duration_since(last).as_millis() < self.debounce_ms as u128 {
                return false;
            }
        }
        self.last_update = Some(now);
        true
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_state_error_when_daemon_not_running() {
        assert_eq!(compute_tray_state(false, 0, false, false), TrayState::Error);
        assert_eq!(compute_tray_state(false, 5, true, true), TrayState::Error);
    }

    #[test]
    fn compute_state_attention_when_needs_permission() {
        assert_eq!(
            compute_tray_state(true, 1, true, false),
            TrayState::Attention
        );
    }

    #[test]
    fn compute_state_updating_when_has_update() {
        assert_eq!(
            compute_tray_state(true, 1, false, true),
            TrayState::Updating
        );
    }

    #[test]
    fn compute_state_running_with_agents() {
        assert_eq!(
            compute_tray_state(true, 3, false, false),
            TrayState::Running
        );
    }

    #[test]
    fn compute_state_idle_no_agents() {
        assert_eq!(compute_tray_state(true, 0, false, false), TrayState::Idle);
    }

    #[test]
    fn tray_icon_selection_returns_different_bytes_for_each_state() {
        let idle = get_tray_icon_bytes(TrayState::Idle);
        let running = get_tray_icon_bytes(TrayState::Running);
        let attention = get_tray_icon_bytes(TrayState::Attention);
        let error = get_tray_icon_bytes(TrayState::Error);
        let updating = get_tray_icon_bytes(TrayState::Updating);

        assert_ne!(idle, running);
        assert_ne!(running, error);
        assert_ne!(attention, updating);
        assert_ne!(idle, error);
    }

    #[test]
    fn format_tooltip_all_states() {
        assert_eq!(
            format_tooltip(TrayState::Idle, 0),
            "Saqr - No active agents"
        );
        assert_eq!(
            format_tooltip(TrayState::Running, 1),
            "Saqr - 1 agent running"
        );
        assert_eq!(
            format_tooltip(TrayState::Running, 3),
            "Saqr - 3 agents running"
        );
        assert_eq!(
            format_tooltip(TrayState::Attention, 0),
            "Saqr - Action required"
        );
        assert_eq!(
            format_tooltip(TrayState::Error, 0),
            "Saqr - Daemon disconnected"
        );
        assert_eq!(
            format_tooltip(TrayState::Updating, 0),
            "Saqr - Updating..."
        );
    }

    #[test]
    fn tray_state_from_str() {
        assert_eq!(TrayState::from_str("idle"), TrayState::Idle);
        assert_eq!(TrayState::from_str("running"), TrayState::Running);
        assert_eq!(TrayState::from_str("attention"), TrayState::Attention);
        assert_eq!(TrayState::from_str("error"), TrayState::Error);
        assert_eq!(TrayState::from_str("updating"), TrayState::Updating);
        assert_eq!(TrayState::from_str("unknown"), TrayState::Idle);
    }

    #[test]
    fn tray_state_display() {
        assert_eq!(format!("{}", TrayState::Idle), "idle");
        assert_eq!(format!("{}", TrayState::Running), "running");
        assert_eq!(format!("{}", TrayState::Attention), "attention");
        assert_eq!(format!("{}", TrayState::Error), "error");
        assert_eq!(format!("{}", TrayState::Updating), "updating");
    }

    #[test]
    fn debouncer_allows_first_update() {
        let mut debouncer = TrayDebouncer::new();
        assert!(debouncer.should_update());
    }

    #[test]
    fn debouncer_blocks_rapid_updates() {
        let mut debouncer = TrayDebouncer::new();
        assert!(debouncer.should_update());
        assert!(!debouncer.should_update()); // Too soon
    }
}
