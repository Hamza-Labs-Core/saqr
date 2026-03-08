//! IPC commands for daemon management.
//!
//! Provides get_daemon_status, start_daemon, and stop_daemon commands
//! matching the TypeScript IpcCommandMap contract.

use tauri::State;

use crate::state::{AppState, DaemonStatus};

/// Get the current daemon status by calling the health check endpoint.
///
/// IPC: `get_daemon_status` -> DaemonStatus
#[tauri::command]
pub async fn get_daemon_status(state: State<'_, AppState>) -> Result<DaemonStatus, String> {
    let client = state.daemon_client.lock().await;
    match client.health_check().await {
        Ok(status) => Ok(status),
        Err(_) => {
            // Return a "stopped" status instead of an error
            Ok(DaemonStatus::default())
        }
    }
}

/// Start the daemon process by running `saqr daemon start`.
///
/// IPC: `start_daemon` -> DaemonStatus
#[tauri::command]
pub async fn start_daemon(state: State<'_, AppState>) -> Result<DaemonStatus, String> {
    // Run `saqr daemon start` via tokio::process::Command
    let output = tokio::process::Command::new("saqr")
        .args(["daemon", "start"])
        .output()
        .await
        .map_err(|e| format!("Failed to start daemon: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Daemon start failed: {}", stderr));
    }

    // Wait a moment for the daemon to start
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // Return current status
    let client = state.daemon_client.lock().await;
    match client.health_check().await {
        Ok(status) => Ok(status),
        Err(e) => Err(format!("Daemon started but health check failed: {}", e)),
    }
}

/// Stop the daemon process by running `saqr daemon stop`.
///
/// IPC: `stop_daemon` -> undefined
#[tauri::command]
pub async fn stop_daemon() -> Result<(), String> {
    let output = tokio::process::Command::new("saqr")
        .args(["daemon", "stop"])
        .output()
        .await
        .map_err(|e| format!("Failed to stop daemon: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Daemon stop failed: {}", stderr));
    }

    Ok(())
}
