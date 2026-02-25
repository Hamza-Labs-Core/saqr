//! IPC commands for window management.
//!
//! Provides open_agent_window, get_window_list, close_window, and
//! get_window_state commands matching the TypeScript IpcCommandMap.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::window_state::{self, WindowInfo, WindowState};

/// Open a new window for a specific agent, or focus it if already open.
///
/// IPC: `open_agent_window({ agentId, agentName })` -> WindowInfo
#[tauri::command]
pub async fn open_agent_window(
    app: AppHandle,
    agent_id: String,
    agent_name: String,
) -> Result<WindowInfo, String> {
    let label = format!("agent-{}", agent_id);

    // Check if window already exists
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();

        return window_to_info(&window);
    }

    // Load saved state or use defaults
    let saved_state = window_state::load_state(&label);
    let (width, height) = saved_state
        .as_ref()
        .map(|s| (s.width, s.height))
        .unwrap_or((900.0, 700.0));

    // Create URL for the agent view
    let url = format!("http://localhost:7399/agent/{}", agent_id);

    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External(url.parse::<Url>().map_err(|e| e.to_string())?),
    )
    .title(format!("Saqr - {}", agent_name))
    .inner_size(width, height)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .decorations(true);

    // Apply saved position if available
    if let Some(ref state) = saved_state {
        builder = builder.position(state.x, state.y);
        if state.maximized {
            builder = builder.maximized(true);
        }
    } else {
        builder = builder.center();
    }

    let window = builder.build().map_err(|e| e.to_string())?;

    window_to_info(&window)
}

/// Get a list of all open windows.
///
/// IPC: `get_window_list` -> WindowInfo[]
#[tauri::command]
pub async fn get_window_list(app: AppHandle) -> Result<Vec<WindowInfo>, String> {
    let windows = app.webview_windows();
    let mut infos = Vec::new();

    for (_, window) in windows {
        if let Ok(info) = window_to_info(&window) {
            infos.push(info);
        }
    }

    Ok(infos)
}

/// Close a window by label.
///
/// IPC: `close_window({ label })` -> undefined
#[tauri::command]
pub async fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        // Save state before closing
        let position = window.outer_position().unwrap_or_default();
        let size = window.inner_size().unwrap_or_default();
        let maximized = window.is_maximized().unwrap_or(false);

        window_state::save_state(
            &label,
            WindowState {
                x: position.x as f64,
                y: position.y as f64,
                width: size.width as f64,
                height: size.height as f64,
                maximized,
            },
        );

        window.close().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Get the persisted state for a window.
///
/// IPC: `get_window_state({ label })` -> WindowState | null
#[tauri::command]
pub fn get_window_state(label: String) -> Result<Option<WindowState>, String> {
    Ok(window_state::load_state(&label))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a Tauri window to a WindowInfo struct.
fn window_to_info(
    window: &tauri::WebviewWindow,
) -> Result<WindowInfo, String> {
    let position = window.outer_position().unwrap_or_default();
    let size = window.inner_size().unwrap_or_default();
    let is_focused = window.is_focused().unwrap_or(false);
    let is_visible = window.is_visible().unwrap_or(false);

    Ok(WindowInfo {
        label: window.label().to_string(),
        title: window.title().unwrap_or_default(),
        width: size.width as f64,
        height: size.height as f64,
        x: position.x as f64,
        y: position.y as f64,
        is_focused,
        is_visible,
    })
}
