//! IPC commands for tray state management.
//!
//! Provides the update_tray_state command that recomputes and applies
//! the tray icon, tooltip, and menu based on current daemon/agent state.

use tauri::{AppHandle, State};

use crate::state::AppState;
use crate::tray::{self, compute_tray_state};

/// Recompute and update the tray state based on current daemon and agent status.
///
/// IPC: `update_tray_state` -> undefined
#[tauri::command]
pub async fn update_tray_state(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let client = state.daemon_client.lock().await;

    let daemon_status = client
        .health_check()
        .await
        .unwrap_or_default();

    let agents = client
        .get_agents()
        .await
        .unwrap_or_default();

    let needs_permission = agents.iter().any(|a| a.status == "waiting_permission");

    let tray_state = compute_tray_state(
        daemon_status.running,
        daemon_status.active_agents,
        needs_permission,
        false, // has_update is managed by the updater module
    );

    tray::update_tray(&app, tray_state, &agents, &daemon_status);

    Ok(())
}
