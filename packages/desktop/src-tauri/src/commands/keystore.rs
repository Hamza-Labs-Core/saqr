//! IPC commands for secure key storage.
//!
//! Provides store_key, retrieve_key, delete_key, and has_key commands
//! matching the TypeScript IpcCommandMap contract.
//!
//! Note: Tauri 2 automatically converts camelCase JS parameters to
//! snake_case Rust parameters. So `{ keyId, keyBase64 }` in TypeScript
//! becomes `key_id: String, key_base64: String` in Rust.

use tauri::State;

use crate::state::AppState;

/// Store a key in the OS credential manager.
///
/// IPC: `store_key({ keyId, keyBase64 })` -> undefined
#[tauri::command]
pub fn store_key(
    state: State<'_, AppState>,
    key_id: String,
    key_base64: String,
) -> Result<(), String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    let key_bytes = BASE64
        .decode(&key_base64)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    state
        .keystore
        .store_key(&key_id, &key_bytes)
        .map_err(|e| e.to_string())
}

/// Retrieve a key from the OS credential manager as base64.
///
/// IPC: `retrieve_key({ keyId })` -> string (base64)
#[tauri::command]
pub fn retrieve_key(state: State<'_, AppState>, key_id: String) -> Result<String, String> {
    state
        .keystore
        .retrieve_key_base64(&key_id)
        .map_err(|e| e.to_string())
}

/// Delete a key from the OS credential manager. Idempotent.
///
/// IPC: `delete_key({ keyId })` -> undefined
#[tauri::command]
pub fn delete_key(state: State<'_, AppState>, key_id: String) -> Result<(), String> {
    state
        .keystore
        .delete_key(&key_id)
        .map_err(|e| e.to_string())
}

/// Check if a key exists in the OS credential manager.
///
/// IPC: `has_key({ keyId })` -> boolean
#[tauri::command]
pub fn has_key(state: State<'_, AppState>, key_id: String) -> Result<bool, String> {
    state
        .keystore
        .has_key(&key_id)
        .map_err(|e| e.to_string())
}
