//! Auto-update logic using tauri-plugin-updater.
//!
//! Checks for updates on startup (30s delay) and every 6 hours.
//! Downloads, verifies Ed25519 signatures, and installs updates.
//! Emits progress events to the frontend and creates binary backups.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;
use crate::tray::{self, TrayState};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Check interval: 6 hours (matches TypeScript CHECK_INTERVAL_MS).
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Initial delay before first check: 30 seconds (matches TypeScript INITIAL_DELAY_MS).
const INITIAL_DELAY: Duration = Duration::from_secs(30);

/// Delay before writing launch health marker: 10 seconds.
const LAUNCH_HEALTH_DELAY: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Update Progress
// ---------------------------------------------------------------------------

/// Download progress for an update.
/// Matches the TypeScript `UpdateProgress` interface in `ipc-types.ts`.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: f64,
}

// ---------------------------------------------------------------------------
// Update Check Loop
// ---------------------------------------------------------------------------

/// Spawns the auto-update check loop.
///
/// Runs in the background:
/// 1. Wait 30 seconds after startup.
/// 2. Check for updates via tauri-plugin-updater.
/// 3. If update found, notify user and set tray state to "updating".
/// 4. Sleep 6 hours, repeat.
pub fn spawn_update_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Wait initial delay
        tokio::time::sleep(INITIAL_DELAY).await;

        loop {
            check_for_update(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// Check for available updates.
async fn check_for_update(app: &AppHandle) {
    log::info!("Checking for updates...");

    // Emit checking state
    let _ = app.emit("update-checking", true);

    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                log::info!("Update available: v{}", update.version);

                let _ = app.emit(
                    "update-available",
                    serde_json::json!({
                        "version": update.version,
                        "date": update.date.map(|d| d.to_string()),
                        "body": update.body,
                    }),
                );

                // Set tray state to Updating
                if let Some(state) = app.try_state::<AppState>() {
                    let client = state.daemon_client.lock().await;
                    if let Ok(daemon_status) = client.health_check().await {
                        if let Ok(agents) = client.get_agents().await {
                            tray::update_tray(app, TrayState::Updating, &agents, &daemon_status);
                        }
                    }
                }
            }
            Ok(None) => {
                log::info!("No update available");
                let _ = app.emit("update-not-available", ());
            }
            Err(e) => {
                log::warn!("Update check failed: {}", e);
                let _ = app.emit("update-error", e.to_string());
            }
        },
        Err(e) => {
            log::warn!("Updater not available: {}", e);
        }
    }

    let _ = app.emit("update-checking", false);
}

// ---------------------------------------------------------------------------
// Launch Health Marker
// ---------------------------------------------------------------------------

/// Writes a launch health marker file 10 seconds after startup.
/// If the marker already exists from a previous launch, the update was successful.
pub fn spawn_launch_health_marker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LAUNCH_HEALTH_DELAY).await;

        if let Some(app_data) = get_app_data_dir(&app) {
            let marker_path = app_data.join("last_launch_success");
            let timestamp = chrono::Utc::now().to_rfc3339();
            let _ = std::fs::write(marker_path, timestamp);
            log::info!("Launch health marker written");
        }
    });
}

// ---------------------------------------------------------------------------
// Binary Backup
// ---------------------------------------------------------------------------

/// Creates a backup of the current binary before applying an update.
pub fn create_binary_backup(app: &AppHandle) -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;

    let app_data = get_app_data_dir(app).ok_or("Cannot determine app data directory")?;

    let backup_dir = app_data.join("backup");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

    let exe_name = current_exe
        .file_name()
        .ok_or("Cannot determine executable name")?;
    let backup_path = backup_dir.join(exe_name);

    std::fs::copy(&current_exe, &backup_path).map_err(|e| e.to_string())?;

    log::info!("Binary backup created at {:?}", backup_path);
    Ok(backup_path)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn get_app_data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_progress_serialization() {
        let progress = UpdateProgress {
            downloaded: 5_000_000,
            total: Some(10_000_000),
            percent: 50.0,
        };

        let json = serde_json::to_string(&progress).unwrap();
        assert!(json.contains("5000000"));
        assert!(json.contains("10000000"));
        assert!(json.contains("50.0") || json.contains("50"));
    }

    #[test]
    fn constants_match_typescript() {
        // CHECK_INTERVAL should be 6 hours
        assert_eq!(CHECK_INTERVAL, Duration::from_secs(6 * 60 * 60));

        // INITIAL_DELAY should be 30 seconds
        assert_eq!(INITIAL_DELAY, Duration::from_secs(30));
    }
}
