//! SaqrNestUI — System tray application for managing the SaqrNest daemon.
//!
//! This is a minimal Tauri 2 tray-only app. It has no main window on launch;
//! instead it runs as a system tray icon that manages the daemon sidecar,
//! monitors its health, and provides a popup status panel.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent};

use saqrnest_ui::daemon::DaemonClient;
use saqrnest_ui::tray;

fn main() {
    env_logger::init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Set up system tray
            match tray::setup_tray(&app_handle) {
                Ok(_tray) => {
                    log::info!("System tray initialized");
                }
                Err(e) => {
                    log::error!("Failed to initialize system tray: {}", e);
                    return Err(e);
                }
            }

            // Spawn daemon health check loop
            let health_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                daemon_health_loop(health_handle).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building SaqrNestUI");

    // Run with prevent_exit to stay alive as a tray app
    app.run(|_app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
        }
    });
}

/// Background loop that checks daemon health every 5 seconds
/// and updates the tray icon accordingly.
async fn daemon_health_loop(app: tauri::AppHandle) {
    let client = DaemonClient::new();
    let debouncer = tray::TrayDebouncer::new();

    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;

        let daemon_running;
        let session_count;

        match client.health_check().await {
            Ok(_health) => {
                daemon_running = true;
                // Try to get sessions
                session_count = client
                    .get_sessions()
                    .await
                    .map(|s| s.len())
                    .unwrap_or(0);
            }
            Err(_) => {
                daemon_running = false;
                session_count = 0;
            }
        }

        // Emit status to any popup window
        let _ = app.emit(
            "daemon-status",
            serde_json::json!({
                "running": daemon_running,
                "sessions": session_count,
            }),
        );

        // Update tray (debounced)
        if debouncer.should_update() {
            tray::update_tray(&app, daemon_running, session_count);
        }
    }
}
