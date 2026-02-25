//! Saqr Desktop Application entry point.
//!
//! Initializes the Tauri 2 application with all plugins, IPC command
//! handlers, system tray, daemon health monitoring, and auto-update.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use tauri::{Emitter, Manager};

use saqr_desktop::commands;
use saqr_desktop::notifications::NotificationSettings;
use saqr_desktop::state::AppState;
use saqr_desktop::tray::{self, compute_tray_state};
use saqr_desktop::updater;
use saqr_desktop::window_state;

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window on duplicate launch
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Daemon commands
            commands::daemon::get_daemon_status,
            commands::daemon::start_daemon,
            commands::daemon::stop_daemon,
            // Key storage commands
            commands::keystore::store_key,
            commands::keystore::retrieve_key,
            commands::keystore::delete_key,
            commands::keystore::has_key,
            // Notification commands
            commands::notifications::send_notification,
            commands::notifications::get_notification_settings,
            commands::notifications::set_notification_settings,
            // Window commands
            commands::windows::open_agent_window,
            commands::windows::get_window_list,
            commands::windows::close_window,
            commands::windows::get_window_state,
            // Tray commands
            commands::tray::update_tray_state,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Load persisted notification settings
            if let Ok(app_data) = app_handle.path().app_data_dir() {
                let settings = NotificationSettings::load(&app_data);
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let notification_settings = state.notification_settings.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut ns = notification_settings.lock().await;
                        *ns = settings;
                    });
                }

                // Load persisted window states
                window_state::load_from_disk(&app_data);
            }

            // Set up system tray
            match tray::setup_tray(&app_handle) {
                Ok(_tray) => {
                    log::info!("System tray initialized");
                }
                Err(e) => {
                    log::warn!("System tray not available: {}", e);
                }
            }

            // Spawn daemon health check loop
            let health_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                daemon_health_loop(health_handle).await;
            });

            // Spawn auto-update check loop
            updater::spawn_update_loop(app_handle.clone());

            // Spawn launch health marker
            updater::spawn_launch_health_marker(app_handle.clone());

            // Register window close interception for hide-to-tray
            let close_handle = app_handle.clone();
            if let Some(window) = app_handle.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if let Some(state) = close_handle.try_state::<AppState>() {
                            let tray_available = state
                                .tray_available
                                .load(std::sync::atomic::Ordering::Relaxed);

                            if tray_available {
                                // Hide to tray instead of closing
                                api.prevent_close();
                                if let Some(window) =
                                    close_handle.get_webview_window("main")
                                {
                                    let _ = window.hide();
                                }
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Moved(position) => {
                    // Save window position
                    let label = window.label().to_string();
                    let size = window.inner_size().unwrap_or_default();
                    let maximized = window.is_maximized().unwrap_or(false);

                    window_state::save_state(
                        &label,
                        window_state::WindowState {
                            x: position.x as f64,
                            y: position.y as f64,
                            width: size.width as f64,
                            height: size.height as f64,
                            maximized,
                        },
                    );
                }
                tauri::WindowEvent::Resized(size) => {
                    // Save window size
                    let label = window.label().to_string();
                    let position = window.outer_position().unwrap_or_default();
                    let maximized = window.is_maximized().unwrap_or(false);

                    window_state::save_state(
                        &label,
                        window_state::WindowState {
                            x: position.x as f64,
                            y: position.y as f64,
                            width: size.width as f64,
                            height: size.height as f64,
                            maximized,
                        },
                    );
                }
                tauri::WindowEvent::Destroyed => {
                    // Persist all window states to disk on any window close
                    if let Ok(app_data) = window.app_handle().path().app_data_dir() {
                        let _ = window_state::save_to_disk(&app_data);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Saqr");
}

/// Background loop that checks daemon health every 5 seconds
/// and updates the tray icon and emits status events.
async fn daemon_health_loop(app: tauri::AppHandle) {
    let mut debouncer = tray::TrayDebouncer::new();

    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;

        if let Some(state) = app.try_state::<AppState>() {
            let client = state.daemon_client.lock().await;

            let daemon_status = client.health_check().await.unwrap_or_default();
            let agents = client.get_agents().await.unwrap_or_default();

            // Emit daemon-status event to all windows
            let _ = app.emit("daemon-status", &daemon_status);

            // Update tray
            if debouncer.should_update() {
                let needs_permission =
                    agents.iter().any(|a| a.status == "waiting_permission");

                let tray_state = compute_tray_state(
                    daemon_status.running,
                    daemon_status.active_agents,
                    needs_permission,
                    false,
                );

                tray::update_tray(&app, tray_state, &agents, &daemon_status);
            }
        }
    }
}
