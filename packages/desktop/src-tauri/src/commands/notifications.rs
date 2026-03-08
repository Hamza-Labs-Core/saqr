//! IPC commands for notification management.
//!
//! Provides send_notification, get_notification_settings, and
//! set_notification_settings commands matching the TypeScript IpcCommandMap.

use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::notifications::{truncate_body, NotificationSettings};
use crate::state::AppState;

/// Send an OS notification if the category is enabled.
///
/// IPC: `send_notification({ category, title, body })` -> undefined
#[tauri::command]
pub async fn send_notification(
    app: AppHandle,
    state: State<'_, AppState>,
    category: String,
    title: String,
    body: String,
) -> Result<(), String> {
    let settings = state.notification_settings.lock().await;

    if !settings.is_category_enabled(&category) {
        return Ok(()); // Silently skip disabled categories
    }

    let truncated_body = truncate_body(&body);

    app.notification()
        .builder()
        .title(&title)
        .body(&truncated_body)
        .show()
        .map_err(|e| format!("Failed to send notification: {}", e))?;

    Ok(())
}

/// Get notification settings from disk.
///
/// IPC: `get_notification_settings` -> NotificationSettings
#[tauri::command]
pub async fn get_notification_settings(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NotificationSettings, String> {
    let settings = state.notification_settings.lock().await;
    Ok(settings.clone())
}

/// Save notification settings to disk and update in-memory state.
///
/// IPC: `set_notification_settings(settings)` -> undefined
#[tauri::command]
pub async fn set_notification_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: NotificationSettings,
) -> Result<(), String> {
    // Persist to disk
    if let Ok(app_data) = app.path().app_data_dir() {
        settings.save(&app_data).map_err(|e| e.to_string())?;
    }

    // Update in-memory state
    let mut current = state.notification_settings.lock().await;
    *current = settings;

    Ok(())
}
