import React, { useState, useEffect } from "react";
import { getStoredToken } from "../App.js";

interface ServerListPageProps {
  onSelectSession: (serverId: string, sessionId: string) => void;
  onLogout: () => void;
}

interface Server {
  id: string;
  name: string;
  hostname: string;
  status: "online" | "offline" | "connecting";
  daemonUrl: string;
  lastSeen: string;
}

interface Session {
  sessionId: string;
  projectId: string;
  agentProvider: string;
  model: string;
  status: string;
  startedAt: string;
}

/**
 * Server list page — shows connected dev machines and their sessions.
 *
 * Left sidebar: servers from sync-server
 * Main area: sessions for the selected server
 */
export function ServerListPage({ onSelectSession, onLogout }: ServerListPageProps): React.ReactElement {
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch servers on mount
  useEffect(() => {
    fetchServers();
  }, []);

  // Fetch sessions when server changes
  useEffect(() => {
    if (selectedServer) {
      const server = servers.find(s => s.id === selectedServer);
      if (server && server.status === "online") {
        fetchSessions(server);
      }
    }
  }, [selectedServer, servers]);

  async function fetchServers() {
    setLoading(true);
    setError(null);

    try {
      // For now, check local daemon
      const localDaemon = await checkLocalDaemon();
      const serverList: Server[] = [];

      if (localDaemon) {
        serverList.push({
          id: "local",
          name: "Local Machine",
          hostname: "localhost",
          status: "online",
          daemonUrl: "http://localhost:3100",
          lastSeen: new Date().toISOString(),
        });
      } else {
        serverList.push({
          id: "local",
          name: "Local Machine",
          hostname: "localhost",
          status: "offline",
          daemonUrl: "http://localhost:3100",
          lastSeen: "",
        });
      }

      setServers(serverList);
      if (serverList.length > 0 && !selectedServer) {
        setSelectedServer(serverList[0].id);
      }
    } catch {
      setError("Failed to fetch servers");
    } finally {
      setLoading(false);
    }
  }

  async function checkLocalDaemon(): Promise<boolean> {
    try {
      const res = await fetch("http://localhost:3100/api/health", { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function fetchSessions(server: Server) {
    try {
      const res = await fetch(`${server.daemonUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${getStoredToken()}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch {
      setSessions([]);
    }
  }

  const currentServer = servers.find(s => s.id === selectedServer);

  return (
    <div className="app-layout">
      {/* Sidebar — Server list */}
      <div className="sidebar">
        <div className="sidebar-header">
          <span>Servers</span>
          <button
            className="btn"
            onClick={onLogout}
            style={{ float: "right", padding: "4px 8px", fontSize: 12 }}
          >
            Logout
          </button>
        </div>

        {loading && (
          <div style={{ padding: 16 }}>
            <div className="spinner" />
          </div>
        )}

        {servers.map(server => (
          <div
            key={server.id}
            className={`sidebar-item ${selectedServer === server.id ? "active" : ""}`}
            onClick={() => setSelectedServer(server.id)}
          >
            <div className="sidebar-item-name">
              <span className={`status-dot ${server.status === "online" ? "connected" : "disconnected"}`} />
              {server.name}
            </div>
            <div className="sidebar-item-status">{server.hostname}</div>
          </div>
        ))}

        <div style={{ padding: 16 }}>
          <button className="btn" onClick={fetchServers} style={{ width: "100%" }}>
            Refresh
          </button>
        </div>
      </div>

      {/* Main area — Sessions */}
      <div className="main-content">
        {error && (
          <div style={{ padding: 16 }}>
            <p className="error-text">{error}</p>
          </div>
        )}

        {currentServer && currentServer.status === "online" ? (
          <>
            <div className="session-header">
              <span className="session-header-title">
                Sessions — {currentServer.name}
              </span>
            </div>

            {sessions.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-title">No active sessions</div>
                <p>Start a Claude Code session on this machine to see it here.</p>
              </div>
            ) : (
              <div style={{ flex: 1, overflowY: "auto" }}>
                {sessions.map(session => (
                  <div
                    key={session.sessionId}
                    className="sidebar-item"
                    onClick={() => onSelectSession(currentServer.id, session.sessionId)}
                  >
                    <div className="sidebar-item-name">
                      {session.projectId || "Unnamed Project"}
                    </div>
                    <div className="sidebar-item-status">
                      {session.model} · {session.status} · {formatTime(session.startedAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : currentServer && currentServer.status === "offline" ? (
          <div className="empty-state">
            <div className="empty-state-title">Server Offline</div>
            <p>The daemon on {currentServer.hostname} is not responding.</p>
            <p style={{ marginTop: 8, fontSize: 13 }}>
              Start it with: <code style={{ background: "var(--saqr-card-bg)", padding: "2px 6px", borderRadius: 4 }}>saqr daemon start</code>
            </p>
            <button className="btn" onClick={fetchServers} style={{ marginTop: 16 }}>
              Retry
            </button>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-title">Select a server</div>
            <p>Choose a server from the sidebar to view sessions.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}
