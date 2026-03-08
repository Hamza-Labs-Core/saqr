//! Platform key storage using OS credential managers.
//!
//! Wraps the `keyring` crate to provide secure key storage across platforms:
//! - macOS: Keychain Services
//! - Windows: DPAPI + Credential Manager
//! - Linux: Secret Service (GNOME Keyring / KWallet)
//!
//! Keys are stored as base64 strings. The `zeroize` crate clears sensitive
//! data from memory after use.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use zeroize::Zeroize;

// ---------------------------------------------------------------------------
// Service Name
// ---------------------------------------------------------------------------

const SERVICE_NAME: &str = "dev.saqr.desktop";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors from key storage operations.
#[derive(Debug, thiserror::Error)]
pub enum KeyStoreError {
    #[error("Key not found: {0}")]
    NotFound(String),

    #[error("Storage error: {0}")]
    StorageError(String),

    #[error("Encoding error: {0}")]
    EncodingError(String),
}

// ---------------------------------------------------------------------------
// Backend Trait
// ---------------------------------------------------------------------------

/// Trait for credential storage backends, allowing test injection.
pub trait CredentialBackend: Send + Sync {
    fn set_password(&self, service: &str, key: &str, value: &str) -> Result<(), String>;
    fn get_password(&self, service: &str, key: &str) -> Result<String, String>;
    fn delete_password(&self, service: &str, key: &str) -> Result<(), String>;
}

/// Production backend using the `keyring` crate.
pub struct KeyringBackend;

impl CredentialBackend for KeyringBackend {
    fn set_password(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }

    fn get_password(&self, service: &str, key: &str) -> Result<String, String> {
        let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
        entry.get_password().map_err(|e| e.to_string())
    }

    fn delete_password(&self, service: &str, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // Idempotent delete
            Err(e) => Err(e.to_string()),
        }
    }
}

/// In-memory backend for testing (no OS keychain required).
#[cfg(test)]
pub struct InMemoryBackend {
    store: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl InMemoryBackend {
    pub fn new() -> Self {
        Self {
            store: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

#[cfg(test)]
impl CredentialBackend for InMemoryBackend {
    fn set_password(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
        let compound_key = format!("{}:{}", service, key);
        self.store
            .lock()
            .unwrap()
            .insert(compound_key, value.to_string());
        Ok(())
    }

    fn get_password(&self, service: &str, key: &str) -> Result<String, String> {
        let compound_key = format!("{}:{}", service, key);
        self.store
            .lock()
            .unwrap()
            .get(&compound_key)
            .cloned()
            .ok_or_else(|| "No entry".to_string())
    }

    fn delete_password(&self, service: &str, key: &str) -> Result<(), String> {
        let compound_key = format!("{}:{}", service, key);
        self.store.lock().unwrap().remove(&compound_key);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// KeyStore
// ---------------------------------------------------------------------------

/// Platform key storage wrapper.
///
/// Stores and retrieves keys as base64-encoded strings in the OS credential
/// manager. Uses `zeroize` to clear temporary base64 strings from memory.
pub struct KeyStore {
    backend: Box<dyn CredentialBackend>,
}

impl KeyStore {
    /// Create a new KeyStore using the OS keyring backend.
    pub fn new() -> Self {
        Self {
            backend: Box::new(KeyringBackend),
        }
    }

    /// Create a new KeyStore with a custom backend (for testing).
    #[cfg(test)]
    pub fn new_with_test_backend() -> Self {
        Self {
            backend: Box::new(InMemoryBackend::new()),
        }
    }

    /// Store a key as base64 in the OS credential manager.
    pub fn store_key(&self, key_id: &str, key_bytes: &[u8]) -> Result<(), KeyStoreError> {
        let mut encoded = BASE64.encode(key_bytes);

        let result = self
            .backend
            .set_password(SERVICE_NAME, key_id, &encoded)
            .map_err(|e| KeyStoreError::StorageError(e));

        encoded.zeroize();
        result
    }

    /// Retrieve a key from the OS credential manager.
    /// Returns the raw key bytes.
    pub fn retrieve_key(&self, key_id: &str) -> Result<Vec<u8>, KeyStoreError> {
        let mut encoded = self
            .backend
            .get_password(SERVICE_NAME, key_id)
            .map_err(|_| KeyStoreError::NotFound(key_id.to_string()))?;

        let decoded = BASE64
            .decode(&encoded)
            .map_err(|e| KeyStoreError::EncodingError(e.to_string()));

        encoded.zeroize();
        decoded
    }

    /// Retrieve a key as base64 string (for IPC transport).
    pub fn retrieve_key_base64(&self, key_id: &str) -> Result<String, KeyStoreError> {
        self.backend
            .get_password(SERVICE_NAME, key_id)
            .map_err(|_| KeyStoreError::NotFound(key_id.to_string()))
    }

    /// Delete a key from the OS credential manager.
    /// Idempotent: returns Ok(()) even if the key doesn't exist.
    pub fn delete_key(&self, key_id: &str) -> Result<(), KeyStoreError> {
        self.backend
            .delete_password(SERVICE_NAME, key_id)
            .map_err(|e| KeyStoreError::StorageError(e))
    }

    /// Check if a key exists without retrieving it.
    pub fn has_key(&self, key_id: &str) -> Result<bool, KeyStoreError> {
        match self.backend.get_password(SERVICE_NAME, key_id) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_retrieve_roundtrip() {
        let ks = KeyStore::new_with_test_backend();
        let key_bytes = vec![
            0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x00, 0xFF, 0x01,
            0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x00, 0xFF, 0x01,
            0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x00, 0xFF, 0x01,
            0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x00, 0xFF, 0x01,
        ];
        ks.store_key("test-key-1", &key_bytes).unwrap();
        let retrieved = ks.retrieve_key("test-key-1").unwrap();
        assert_eq!(key_bytes, retrieved);
    }

    #[test]
    fn store_retrieve_base64_roundtrip() {
        let ks = KeyStore::new_with_test_backend();
        let key_bytes = vec![0x01, 0x02, 0x03, 0x04, 0x05];
        let original_b64 = BASE64.encode(&key_bytes);

        ks.store_key("test-key-b64", &key_bytes).unwrap();
        let retrieved_b64 = ks.retrieve_key_base64("test-key-b64").unwrap();
        assert_eq!(original_b64, retrieved_b64);
    }

    #[test]
    fn has_key_nonexistent() {
        let ks = KeyStore::new_with_test_backend();
        assert!(!ks.has_key("nonexistent").unwrap());
    }

    #[test]
    fn has_key_after_store() {
        let ks = KeyStore::new_with_test_backend();
        ks.store_key("exists", &[1, 2, 3]).unwrap();
        assert!(ks.has_key("exists").unwrap());
    }

    #[test]
    fn delete_idempotent() {
        let ks = KeyStore::new_with_test_backend();
        // Deleting a non-existent key should not error
        assert!(ks.delete_key("nonexistent").is_ok());
    }

    #[test]
    fn delete_removes_key() {
        let ks = KeyStore::new_with_test_backend();
        ks.store_key("to-delete", &[0xAA, 0xBB]).unwrap();
        assert!(ks.has_key("to-delete").unwrap());

        ks.delete_key("to-delete").unwrap();
        assert!(!ks.has_key("to-delete").unwrap());
    }

    #[test]
    fn retrieve_nonexistent_returns_error() {
        let ks = KeyStore::new_with_test_backend();
        let result = ks.retrieve_key("nonexistent");
        assert!(result.is_err());
        match result {
            Err(KeyStoreError::NotFound(id)) => assert_eq!(id, "nonexistent"),
            _ => panic!("Expected NotFound error"),
        }
    }
}
