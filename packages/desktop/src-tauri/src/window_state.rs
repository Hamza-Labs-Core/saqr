//! Window position/size persistence and off-screen validation.
//!
//! Saves and restores window positions to a JSON file. Validates that
//! restored positions are visible on at least one monitor to prevent
//! windows from appearing off-screen after display changes.
//!
//! Matches the behavior defined in `packages/desktop/src/window-state.ts`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default window width.
const DEFAULT_WIDTH: f64 = 900.0;

/// Default window height.
const DEFAULT_HEIGHT: f64 = 700.0;

/// Filename for persisted window states.
const STATES_FILENAME: &str = "window-states.json";

// ---------------------------------------------------------------------------
// Window State
// ---------------------------------------------------------------------------

/// Persisted window position/size state.
/// Matches the TypeScript `WindowState` interface in `ipc-types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            maximized: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Window Info
// ---------------------------------------------------------------------------

/// Information about an open window.
/// Matches the TypeScript `WindowInfo` interface in `ipc-types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub label: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub is_focused: bool,
    pub is_visible: bool,
}

// ---------------------------------------------------------------------------
// Monitor Info
// ---------------------------------------------------------------------------

/// Information about a display monitor.
/// Matches the TypeScript `MonitorInfo` interface in `window-state.ts`.
#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// ---------------------------------------------------------------------------
// In-Memory Cache
// ---------------------------------------------------------------------------

/// Global in-memory cache for window states.
static WINDOW_STATES: Lazy<Mutex<HashMap<String, WindowState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ---------------------------------------------------------------------------
// Window State Management
// ---------------------------------------------------------------------------

/// Save a window state to the in-memory cache.
pub fn save_state(label: &str, state: WindowState) {
    let mut states = WINDOW_STATES.lock().unwrap();
    states.insert(label.to_string(), state);
}

/// Load a window state from the in-memory cache.
pub fn load_state(label: &str) -> Option<WindowState> {
    let states = WINDOW_STATES.lock().unwrap();
    states.get(label).cloned()
}

/// Remove a window state from the in-memory cache.
pub fn remove_state(label: &str) {
    let mut states = WINDOW_STATES.lock().unwrap();
    states.remove(label);
}

/// Get all window states from the in-memory cache.
pub fn get_all_states() -> HashMap<String, WindowState> {
    let states = WINDOW_STATES.lock().unwrap();
    states.clone()
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Load window states from disk into the in-memory cache.
pub fn load_from_disk(app_data_dir: &PathBuf) {
    let path = app_data_dir.join(STATES_FILENAME);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if let Ok(loaded) = serde_json::from_str::<HashMap<String, WindowState>>(&contents) {
            let mut states = WINDOW_STATES.lock().unwrap();
            for (label, state) in loaded {
                states.insert(label, state);
            }
        }
    }
}

/// Save window states from the in-memory cache to disk.
pub fn save_to_disk(app_data_dir: &PathBuf) -> Result<(), String> {
    let path = app_data_dir.join(STATES_FILENAME);

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let states = WINDOW_STATES.lock().unwrap();
    let json = serde_json::to_string_pretty(&*states).map_err(|e| e.to_string())?;

    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Position Validation
// ---------------------------------------------------------------------------

/// Validates a window position against available monitors.
///
/// If the window's top-left corner is off-screen (not within any monitor),
/// it is re-centered on the primary monitor (first in the array).
///
/// Matches the TypeScript `validateWindowPosition` function in `window-state.ts`.
pub fn validate_window_position(state: &WindowState, monitors: &[MonitorInfo]) -> WindowState {
    if monitors.is_empty() {
        // No monitor info available -- reset to origin
        return WindowState {
            x: 0.0,
            y: 0.0,
            ..state.clone()
        };
    }

    // Check if the window's top-left corner is within any monitor
    let is_on_screen = monitors.iter().any(|m| {
        state.x >= m.x
            && state.x < m.x + m.width
            && state.y >= m.y
            && state.y < m.y + m.height
    });

    if is_on_screen {
        return state.clone();
    }

    // Re-center on primary monitor (first in array)
    let primary = &monitors[0];
    WindowState {
        x: primary.x + ((primary.width - state.width) / 2.0).floor(),
        y: primary.y + ((primary.height - state.height) / 2.0).floor(),
        ..state.clone()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_state_serde_roundtrip() {
        let state = WindowState {
            x: 100.0,
            y: 200.0,
            width: 900.0,
            height: 700.0,
            maximized: false,
        };
        let json = serde_json::to_string(&state).unwrap();
        let deserialized: WindowState = serde_json::from_str(&json).unwrap();
        assert_eq!(state.x, deserialized.x);
        assert_eq!(state.y, deserialized.y);
        assert_eq!(state.width, deserialized.width);
        assert_eq!(state.height, deserialized.height);
        assert_eq!(state.maximized, deserialized.maximized);
    }

    #[test]
    fn window_state_default() {
        let state = WindowState::default();
        assert_eq!(state.x, 0.0);
        assert_eq!(state.y, 0.0);
        assert_eq!(state.width, 900.0);
        assert_eq!(state.height, 700.0);
        assert!(!state.maximized);
    }

    #[test]
    fn validate_offscreen_position() {
        let state = WindowState {
            x: 5000.0,
            y: 5000.0,
            width: 900.0,
            height: 700.0,
            maximized: false,
        };
        let monitors = vec![MonitorInfo {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        }];
        let validated = validate_window_position(&state, &monitors);

        // Should be re-centered on the primary monitor
        assert!(validated.x >= 0.0 && validated.x < 1920.0);
        assert!(validated.y >= 0.0 && validated.y < 1080.0);

        // Check exact centering: (1920 - 900) / 2 = 510
        assert_eq!(validated.x, 510.0);
        // (1080 - 700) / 2 = 190
        assert_eq!(validated.y, 190.0);
    }

    #[test]
    fn validate_onscreen_position() {
        let state = WindowState {
            x: 100.0,
            y: 100.0,
            width: 900.0,
            height: 700.0,
            maximized: false,
        };
        let monitors = vec![MonitorInfo {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        }];
        let validated = validate_window_position(&state, &monitors);
        assert_eq!(validated.x, 100.0);
        assert_eq!(validated.y, 100.0);
    }

    #[test]
    fn validate_no_monitors() {
        let state = WindowState {
            x: 500.0,
            y: 300.0,
            width: 900.0,
            height: 700.0,
            maximized: false,
        };
        let validated = validate_window_position(&state, &[]);
        assert_eq!(validated.x, 0.0);
        assert_eq!(validated.y, 0.0);
    }

    #[test]
    fn validate_multi_monitor_second_screen() {
        let state = WindowState {
            x: 2000.0,
            y: 100.0,
            width: 900.0,
            height: 700.0,
            maximized: false,
        };
        let monitors = vec![
            MonitorInfo {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            MonitorInfo {
                x: 1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        ];
        let validated = validate_window_position(&state, &monitors);
        // Should stay on second monitor
        assert_eq!(validated.x, 2000.0);
        assert_eq!(validated.y, 100.0);
    }

    #[test]
    fn window_info_serialization() {
        let info = WindowInfo {
            label: "main".to_string(),
            title: "Saqr".to_string(),
            width: 1200.0,
            height: 800.0,
            x: 0.0,
            y: 0.0,
            is_focused: true,
            is_visible: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("main"));
        assert!(json.contains("Saqr"));
    }

    #[test]
    fn save_and_load_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();

        // Clear any existing state
        {
            let mut states = WINDOW_STATES.lock().unwrap();
            states.clear();
        }

        // Save a state
        save_state(
            "test-window",
            WindowState {
                x: 42.0,
                y: 84.0,
                width: 800.0,
                height: 600.0,
                maximized: true,
            },
        );

        // Persist to disk
        save_to_disk(&path).unwrap();

        // Clear in-memory cache
        {
            let mut states = WINDOW_STATES.lock().unwrap();
            states.clear();
        }

        // Load from disk
        load_from_disk(&path);

        // Verify
        let loaded = load_state("test-window").unwrap();
        assert_eq!(loaded.x, 42.0);
        assert_eq!(loaded.y, 84.0);
        assert_eq!(loaded.width, 800.0);
        assert_eq!(loaded.height, 600.0);
        assert!(loaded.maximized);
    }
}
