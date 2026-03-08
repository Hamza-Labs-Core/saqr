//! HTTP client for communicating with the local SaqrNest daemon.
//!
//! Manages the daemon sidecar lifecycle and provides API methods
//! for health checks, agent listing, and session queries.

use serde::{Deserialize, Serialize};

const DAEMON_URL: &str = "http://127.0.0.1:3100";
const TIMEOUT_SECS: u64 = 3;

/// Daemon health check response.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DaemonHealth {
    pub status: String,
    pub version: String,
    pub uptime: u64,
}

/// Agent/session info from the daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "agentProvider")]
    pub agent_provider: String,
    pub status: String,
    pub model: Option<String>,
}

/// Sessions response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsResponse {
    pub sessions: Vec<SessionInfo>,
}

/// HTTP client for daemon communication.
pub struct DaemonClient {
    client: reqwest::Client,
}

impl DaemonClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Check daemon health.
    pub async fn health_check(&self) -> Result<DaemonHealth, reqwest::Error> {
        let resp = self
            .client
            .get(format!("{}/api/health", DAEMON_URL))
            .send()
            .await?
            .json::<DaemonHealth>()
            .await?;
        Ok(resp)
    }

    /// Get active sessions.
    pub async fn get_sessions(&self) -> Result<Vec<SessionInfo>, reqwest::Error> {
        let resp = self
            .client
            .get(format!("{}/api/sessions", DAEMON_URL))
            .send()
            .await?
            .json::<SessionsResponse>()
            .await?;
        Ok(resp.sessions)
    }
}

impl Default for DaemonClient {
    fn default() -> Self {
        Self::new()
    }
}
