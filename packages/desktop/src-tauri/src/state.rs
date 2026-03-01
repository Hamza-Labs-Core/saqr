//! Application state management and daemon client.
//!
//! Provides the central `AppState` struct shared across all IPC commands
//! and the `DaemonClient` for communicating with the local daemon process.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::keystore::KeyStore;
use crate::notifications::NotificationSettings;

// ---------------------------------------------------------------------------
// Daemon Status
// ---------------------------------------------------------------------------

/// Status of the locally running AgentContext daemon.
/// Matches the TypeScript `DaemonStatus` interface in `ipc-types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub active_agents: u32,
    pub version: Option<String>,
    pub http_port: u16,
    pub ws_port: u16,
}

impl Default for DaemonStatus {
    fn default() -> Self {
        Self {
            running: false,
            pid: None,
            uptime_secs: None,
            active_agents: 0,
            version: None,
            http_port: 7399,
            ws_port: 7400,
        }
    }
}

// ---------------------------------------------------------------------------
// Agent Info
// ---------------------------------------------------------------------------

/// Information about a running agent from the daemon API.
/// Matches the TypeScript `AgentInfo` interface in `ipc-types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub model: String,
    pub status: String,
    pub project: String,
}

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------

/// Central application state shared across all Tauri commands.
pub struct AppState {
    pub daemon_client: Arc<Mutex<DaemonClient>>,
    pub keystore: KeyStore,
    pub notification_settings: Arc<Mutex<NotificationSettings>>,
    pub tray_available: Arc<AtomicBool>,
}

impl AppState {
    /// Create a new AppState with default settings.
    pub fn new() -> Self {
        Self {
            daemon_client: Arc::new(Mutex::new(DaemonClient::new())),
            keystore: KeyStore::new(),
            notification_settings: Arc::new(Mutex::new(NotificationSettings::default())),
            tray_available: Arc::new(AtomicBool::new(false)),
        }
    }
}

// ---------------------------------------------------------------------------
// Daemon Client
// ---------------------------------------------------------------------------

/// HTTP client for communicating with the local AgentContext daemon.
pub struct DaemonClient {
    base_url: String,
    http_client: reqwest::Client,
}

impl DaemonClient {
    /// Create a new DaemonClient connecting to the default daemon URL.
    pub fn new() -> Self {
        Self::new_with_url("http://localhost:7399")
    }

    /// Create a new DaemonClient connecting to a specific URL.
    pub fn new_with_url(url: &str) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            base_url: url.to_string(),
            http_client,
        }
    }

    /// Check daemon health. GET /api/health with 3s timeout.
    pub async fn health_check(&self) -> Result<DaemonStatus, DaemonClientError> {
        let url = format!("{}/api/health", self.base_url);
        let response = self
            .http_client
            .get(&url)
            .send()
            .await
            .map_err(|e| DaemonClientError::ConnectionFailed(e.to_string()))?;

        if !response.status().is_success() {
            return Err(DaemonClientError::BadResponse(format!(
                "HTTP {}",
                response.status()
            )));
        }

        let status: DaemonStatus = response
            .json()
            .await
            .map_err(|e| DaemonClientError::ParseError(e.to_string()))?;

        Ok(status)
    }

    /// Get list of running agents. GET /api/agents.
    pub async fn get_agents(&self) -> Result<Vec<AgentInfo>, DaemonClientError> {
        let url = format!("{}/api/agents", self.base_url);
        let response = self
            .http_client
            .get(&url)
            .send()
            .await
            .map_err(|e| DaemonClientError::ConnectionFailed(e.to_string()))?;

        if !response.status().is_success() {
            return Err(DaemonClientError::BadResponse(format!(
                "HTTP {}",
                response.status()
            )));
        }

        let agents: Vec<AgentInfo> = response
            .json()
            .await
            .map_err(|e| DaemonClientError::ParseError(e.to_string()))?;

        Ok(agents)
    }

    /// Respond to a permission request. POST /api/permissions/{requestId}.
    pub async fn respond_to_permission(
        &self,
        request_id: &str,
        approved: bool,
    ) -> Result<(), DaemonClientError> {
        let url = format!("{}/api/permissions/{}", self.base_url, request_id);
        let response = self
            .http_client
            .post(&url)
            .json(&serde_json::json!({ "approved": approved }))
            .send()
            .await
            .map_err(|e| DaemonClientError::ConnectionFailed(e.to_string()))?;

        if !response.status().is_success() {
            return Err(DaemonClientError::BadResponse(format!(
                "HTTP {}",
                response.status()
            )));
        }

        Ok(())
    }

    /// Restart an agent. POST /api/agents/{agentId}/restart.
    pub async fn restart_agent(&self, agent_id: &str) -> Result<(), DaemonClientError> {
        let url = format!("{}/api/agents/{}/restart", self.base_url, agent_id);
        let response = self
            .http_client
            .post(&url)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| DaemonClientError::ConnectionFailed(e.to_string()))?;

        if !response.status().is_success() {
            return Err(DaemonClientError::BadResponse(format!(
                "HTTP {}",
                response.status()
            )));
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors from the daemon client.
#[derive(Debug, thiserror::Error)]
pub enum DaemonClientError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Bad response: {0}")]
    BadResponse(String),

    #[error("Parse error: {0}")]
    ParseError(String),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_status_default() {
        let status = DaemonStatus::default();
        assert!(!status.running);
        assert!(status.pid.is_none());
        assert!(status.uptime_secs.is_none());
        assert_eq!(status.active_agents, 0);
        assert!(status.version.is_none());
        assert_eq!(status.http_port, 7399);
        assert_eq!(status.ws_port, 7400);
    }

    #[test]
    fn daemon_status_serialization() {
        let status = DaemonStatus {
            running: true,
            pid: Some(12345),
            uptime_secs: Some(3600),
            active_agents: 3,
            version: Some("0.1.0".to_string()),
            http_port: 7399,
            ws_port: 7400,
        };

        let json = serde_json::to_string(&status).unwrap();
        let deserialized: DaemonStatus = serde_json::from_str(&json).unwrap();

        assert!(deserialized.running);
        assert_eq!(deserialized.pid, Some(12345));
        assert_eq!(deserialized.uptime_secs, Some(3600));
        assert_eq!(deserialized.active_agents, 3);
        assert_eq!(deserialized.version, Some("0.1.0".to_string()));
    }

    #[tokio::test]
    async fn daemon_health_check_unreachable() {
        // Use an unused port to simulate unreachable daemon
        let client = DaemonClient::new_with_url("http://127.0.0.1:1");
        let result = client.health_check().await;
        assert!(result.is_err());
    }

    #[test]
    fn agent_info_serialization() {
        let agent = AgentInfo {
            id: "abc123".to_string(),
            name: "feature-auth".to_string(),
            model: "claude-4".to_string(),
            status: "running".to_string(),
            project: "/home/user/project".to_string(),
        };

        let json = serde_json::to_string(&agent).unwrap();
        assert!(json.contains("abc123"));
        assert!(json.contains("feature-auth"));
    }
}
