/**
 * SaqrNestUI popup frontend — tab-based status panel.
 *
 * Three tabs:
 * - Status: Daemon health, uptime, version
 * - Login: Device-code login flow or logged-in status
 * - Agents: Active session list
 */

const DAEMON_URL = "http://127.0.0.1:3100";
const SYNC_SERVER = "https://sync.saqr.dev";
const CLIENT_ID = "saqr-tray";
const POLL_INTERVAL = 5000;

// ---------------------------------------------------------------------------
// Tab Switching
// ---------------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    const target = (tab as HTMLElement).dataset.tab!;
    document.getElementById(`tab-${target}`)!.classList.add("active");

    // Refresh data when switching tabs
    if (target === "agents") refreshAgents();
    if (target === "login") refreshLogin();
  });
});

// ---------------------------------------------------------------------------
// Status Tab
// ---------------------------------------------------------------------------

const daemonIndicator = document.getElementById("daemon-indicator")!;
const daemonVersion = document.getElementById("daemon-version")!;
const daemonUptime = document.getElementById("daemon-uptime")!;
const sessionCount = document.getElementById("session-count")!;
const syncStatus = document.getElementById("sync-status")!;
const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

async function refreshStatus() {
  try {
    const res = await fetch(`${DAEMON_URL}/api/health`);
    if (res.ok) {
      const data = await res.json();
      daemonIndicator.textContent = "Running";
      daemonIndicator.className = "indicator running";
      daemonVersion.textContent = data.version || "0.1.0";
      daemonUptime.textContent = formatUptime(data.uptime || 0);
      btnStart.disabled = true;
      btnStop.disabled = false;

      // Fetch session count
      try {
        const sessRes = await fetch(`${DAEMON_URL}/api/sessions`);
        if (sessRes.ok) {
          const sessData = await sessRes.json();
          sessionCount.textContent = String(sessData.sessions?.length ?? 0);
        }
      } catch {
        sessionCount.textContent = "?";
      }
    } else {
      setDaemonStopped();
    }
  } catch {
    setDaemonStopped();
  }
}

function setDaemonStopped() {
  daemonIndicator.textContent = "Stopped";
  daemonIndicator.className = "indicator stopped";
  daemonVersion.textContent = "—";
  daemonUptime.textContent = "—";
  sessionCount.textContent = "0";
  btnStart.disabled = false;
  btnStop.disabled = true;
}

// Daemon start/stop buttons use the invoke API if available, otherwise fetch
btnStart.addEventListener("click", async () => {
  btnStart.disabled = true;
  btnStart.textContent = "Starting...";
  // Invoke saqrnest start via shell (non-blocking)
  try {
    if ((window as any).__TAURI__) {
      const { Command } = await import("@tauri-apps/plugin-shell");
      const cmd = Command.sidecar("binaries/SaqrNest", ["start", "--foreground"]);
      await cmd.spawn();
    }
  } catch {
    // Fallback: just refresh after delay
  }
  setTimeout(() => {
    btnStart.textContent = "Start Daemon";
    refreshStatus();
  }, 3000);
});

btnStop.addEventListener("click", async () => {
  btnStop.disabled = true;
  btnStop.textContent = "Stopping...";
  try {
    if ((window as any).__TAURI__) {
      const { Command } = await import("@tauri-apps/plugin-shell");
      const cmd = Command.sidecar("binaries/SaqrNest", ["stop"]);
      await cmd.execute();
    }
  } catch {
    // Fallback
  }
  setTimeout(() => {
    btnStop.textContent = "Stop Daemon";
    refreshStatus();
  }, 2000);
});

// ---------------------------------------------------------------------------
// Login Tab
// ---------------------------------------------------------------------------

const loginStatus = document.getElementById("login-status")!;

async function refreshLogin() {
  // Check if logged in by reading sync config (via daemon API or local file)
  try {
    const res = await fetch(`${DAEMON_URL}/api/health`);
    if (res.ok) {
      // Daemon running — check login via status
      loginStatus.innerHTML = `
        <p class="login-message">Login management available via CLI:</p>
        <code style="color: #7c83ff; display: block; margin: 12px 0; font-size: 13px;">saqrnest login</code>
        <p class="login-message">Or use the device-code flow below:</p>
        <button class="btn-login" id="btn-device-login">Login to Saqr Cloud</button>
      `;
      document.getElementById("btn-device-login")?.addEventListener("click", startDeviceLogin);
    } else {
      loginStatus.innerHTML = `
        <p class="login-message">Start the daemon first to manage login.</p>
      `;
    }
  } catch {
    loginStatus.innerHTML = `
      <p class="login-message">Daemon not running. Start it to manage login.</p>
      <button class="btn-login" onclick="document.querySelector('[data-tab=status]').click()">Go to Status</button>
    `;
  }
}

async function startDeviceLogin() {
  loginStatus.innerHTML = `<p class="login-message">Requesting code...</p>`;

  try {
    const res = await fetch(`${SYNC_SERVER}/api/auth/device-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });

    if (!res.ok) {
      loginStatus.innerHTML = `<p class="login-message" style="color: #f87171;">Failed to request device code.</p>`;
      return;
    }

    const data = await res.json();
    loginStatus.innerHTML = `
      <p class="login-message">Enter this code in your browser:</p>
      <div class="user-code">${data.user_code}</div>
      <p class="login-message" style="font-size: 11px; margin-top: 8px;">
        <a href="${data.verification_uri_complete}" target="_blank" style="color: #7c83ff;">${data.verification_uri}</a>
      </p>
      <p class="login-message" style="margin-top: 16px;">Waiting for approval...</p>
    `;

    // Poll for approval
    pollForApproval(data.device_code, data.expires_in);
  } catch (err) {
    loginStatus.innerHTML = `<p class="login-message" style="color: #f87171;">Connection error. Check your network.</p>`;
  }
}

async function pollForApproval(deviceCode: string, expiresIn: number) {
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    try {
      const res = await fetch(`${SYNC_SERVER}/api/auth/device-poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode, client_id: CLIENT_ID }),
      });

      if (res.ok) {
        const data = await res.json();
        loginStatus.innerHTML = `
          <p class="login-message" style="color: #4ade80;">Login successful!</p>
          <p class="login-message">Token saved. You can close this panel.</p>
        `;
        syncStatus.textContent = "Connected";
        return;
      }

      const errData = await res.json();
      if (errData.error === "authorization_pending") continue;
      if (errData.error === "access_denied") {
        loginStatus.innerHTML = `<p class="login-message" style="color: #f87171;">Login denied.</p>`;
        return;
      }
      if (errData.error === "expired_token") {
        loginStatus.innerHTML = `<p class="login-message" style="color: #f87171;">Code expired. Try again.</p>`;
        return;
      }
    } catch {
      // Network error — keep polling
    }
  }

  loginStatus.innerHTML = `<p class="login-message" style="color: #f87171;">Code expired. Try again.</p>`;
}

// ---------------------------------------------------------------------------
// Agents Tab
// ---------------------------------------------------------------------------

const agentsList = document.getElementById("agents-list")!;

async function refreshAgents() {
  try {
    const res = await fetch(`${DAEMON_URL}/api/sessions`);
    if (res.ok) {
      const data = await res.json();
      const sessions = data.sessions || [];

      if (sessions.length === 0) {
        agentsList.innerHTML = `<p class="empty-state">No active sessions</p>`;
        return;
      }

      agentsList.innerHTML = sessions
        .map(
          (s: any) => `
        <div class="session-item">
          <div class="session-provider">${escapeHtml(s.agentProvider)}</div>
          <div class="session-model">${escapeHtml(s.model || "unknown model")}</div>
          <span class="session-status ${s.status === "active" ? "active" : "closed"}">${escapeHtml(s.status)}</span>
        </div>
      `,
        )
        .join("");
    } else {
      agentsList.innerHTML = `<p class="empty-state">Daemon not responding</p>`;
    }
  } catch {
    agentsList.innerHTML = `<p class="empty-state">Daemon not running</p>`;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Listen for Tauri events
// ---------------------------------------------------------------------------

async function setupTauriEvents() {
  try {
    if ((window as any).__TAURI__) {
      const { listen } = await import("@tauri-apps/api/event");
      listen("daemon-status", () => {
        refreshStatus();
      });
    }
  } catch {
    // Not in Tauri context — poll instead
    setInterval(refreshStatus, 5000);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

refreshStatus();
refreshLogin();
setupTauriEvents();

// Refresh status periodically
setInterval(refreshStatus, 5000);
