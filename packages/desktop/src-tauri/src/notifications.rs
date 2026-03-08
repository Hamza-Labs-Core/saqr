//! OS notification dispatch and settings management.
//!
//! Handles sending native OS notifications via tauri-plugin-notification
//! and persisting user notification preferences to disk.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum body text length before truncation.
const MAX_BODY_LENGTH: usize = 200;

/// Settings filename within the app data directory.
const SETTINGS_FILENAME: &str = "notification-settings.json";

// ---------------------------------------------------------------------------
// Notification Settings
// ---------------------------------------------------------------------------

/// User preferences for notification categories.
/// Matches the TypeScript `NotificationSettings` interface in `ipc-types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

impl NotificationSettings {
    /// Check if notifications should be sent for a given category.
    pub fn is_category_enabled(&self, category: &str) -> bool {
        if !self.enabled {
            return false;
        }
        match category {
            "permission_requests" => self.permission_requests,
            "agent_complete" => self.agent_complete,
            "agent_error" => self.agent_error,
            "updates" => self.updates,
            "daemon_status" => self.daemon_status,
            _ => false,
        }
    }

    /// Load settings from disk. Returns default settings if file doesn't exist.
    pub fn load(app_data_dir: &PathBuf) -> Self {
        let path = app_data_dir.join(SETTINGS_FILENAME);
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Save settings to disk.
    pub fn save(&self, app_data_dir: &PathBuf) -> Result<(), NotificationError> {
        let path = app_data_dir.join(SETTINGS_FILENAME);

        // Ensure directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| NotificationError::IoError(e.to_string()))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| NotificationError::SerializationError(e.to_string()))?;

        std::fs::write(&path, json).map_err(|e| NotificationError::IoError(e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Body Truncation
// ---------------------------------------------------------------------------

/// Truncates body text to 200 characters with ellipsis if needed.
/// Matches the TypeScript `truncateBody` function in `notification-manager.ts`.
pub fn truncate_body(text: &str) -> String {
    if text.len() <= MAX_BODY_LENGTH {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(MAX_BODY_LENGTH - 3).collect();
        format!("{}...", truncated)
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors from notification operations.
#[derive(Debug, thiserror::Error)]
pub enum NotificationError {
    #[error("IO error: {0}")]
    IoError(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Notification dispatch failed: {0}")]
    DispatchFailed(String),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_settings_default_all_enabled() {
        let settings = NotificationSettings::default();
        assert!(settings.enabled);
        assert!(settings.permission_requests);
        assert!(settings.agent_complete);
        assert!(settings.agent_error);
        assert!(settings.updates);
        assert!(settings.daemon_status);
        assert!(settings.sound);
    }

    #[test]
    fn category_check_when_enabled() {
        let settings = NotificationSettings::default();
        assert!(settings.is_category_enabled("permission_requests"));
        assert!(settings.is_category_enabled("agent_complete"));
        assert!(settings.is_category_enabled("agent_error"));
        assert!(settings.is_category_enabled("updates"));
        assert!(settings.is_category_enabled("daemon_status"));
    }

    #[test]
    fn category_check_when_globally_disabled() {
        let settings = NotificationSettings {
            enabled: false,
            ..Default::default()
        };
        assert!(!settings.is_category_enabled("permission_requests"));
        assert!(!settings.is_category_enabled("agent_complete"));
    }

    #[test]
    fn category_check_individual_disabled() {
        let settings = NotificationSettings {
            permission_requests: false,
            ..Default::default()
        };
        assert!(!settings.is_category_enabled("permission_requests"));
        assert!(settings.is_category_enabled("agent_complete"));
    }

    #[test]
    fn unknown_category_returns_false() {
        let settings = NotificationSettings::default();
        assert!(!settings.is_category_enabled("unknown_category"));
    }

    #[test]
    fn truncate_body_short_text() {
        let text = "Hello, world!";
        assert_eq!(truncate_body(text), "Hello, world!");
    }

    #[test]
    fn truncate_body_exact_limit() {
        let text = "a".repeat(200);
        assert_eq!(truncate_body(&text), text);
    }

    #[test]
    fn truncate_body_over_limit() {
        let text = "a".repeat(250);
        let result = truncate_body(&text);
        assert_eq!(result.len(), 200);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn settings_serialization_roundtrip() {
        let settings = NotificationSettings {
            enabled: true,
            permission_requests: false,
            agent_complete: true,
            agent_error: false,
            updates: true,
            daemon_status: true,
            sound: false,
        };

        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: NotificationSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings, deserialized);
    }

    #[test]
    fn settings_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();

        let settings = NotificationSettings {
            enabled: true,
            permission_requests: false,
            agent_complete: true,
            agent_error: true,
            updates: false,
            daemon_status: true,
            sound: false,
        };

        settings.save(&path).unwrap();
        let loaded = NotificationSettings::load(&path);
        assert_eq!(settings, loaded);
    }

    #[test]
    fn settings_load_missing_file_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent_subdir").to_path_buf();

        let loaded = NotificationSettings::load(&path);
        assert_eq!(loaded, NotificationSettings::default());
    }
}
