/**
 * Remote terminal — server-specific session view.
 *
 * Full-screen terminal UI using @saqr/terminal-ui. Shows session list
 * on the left and terminal timeline on the right.
 */
import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  Timeline,
  useSession,
  useTimeline,
} from "@saqr/terminal-ui";
import { apiGet } from "../lib/api";
import "../app.css";

interface Session {
  sessionId: string;
  projectId: string;
  agentProvider: string;
  model: string;
  status: string;
  startedAt: string;
}

export default function RemoteServerPage() {
  const navigate = useNavigate();
  const { serverId } = useParams<{ serverId: string }>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const token = localStorage.getItem("saqr_token") ?? undefined;

  useEffect(() => {
    if (!token) {
      navigate("/auth/login");
      return;
    }

    // Fetch machine info to get its URL
    apiGet<{ machine: { daemon_url?: string; hostname: string } }>(`/api/machines/${serverId}`, token)
      .then((result) => {
        if (result.data?.machine) {
          const url = result.data.machine.daemon_url ?? `https://${result.data.machine.hostname}:3100`;
          setServerUrl(url);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [serverId, token, navigate]);

  useEffect(() => {
    if (!serverUrl || !token) return;

    fetch(`${serverUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.ok ? res.json() : Promise.reject())
      .then((data) => {
        const list = Array.isArray(data.sessions) ? data.sessions : [];
        setSessions(list);
        if (list.length > 0 && !selectedSession) {
          setSelectedSession(list[0].sessionId);
        }
      })
      .catch(() => setSessions([]));
  }, [serverUrl, token, selectedSession]);

  const wsUrl = selectedSession && serverUrl
    ? `${serverUrl.replace(/^http/, "ws")}/ws/session/${selectedSession}`
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Top bar */}
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Link to="/remote" style={{ color: "var(--color-text-secondary)", textDecoration: "none" }}>
            ← Servers
          </Link>
          <span style={{ fontWeight: 600, color: "var(--color-text)" }}>
            {serverId}
          </span>
        </div>
      </header>

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Session sidebar */}
        <div style={{
          width: "240px",
          borderRight: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          overflowY: "auto",
          flexShrink: 0,
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", fontWeight: 600, fontSize: "14px" }}>
            Sessions
          </div>

          {loading && <div style={{ padding: "16px", color: "var(--color-muted)" }}>Loading...</div>}

          {sessions.map((s) => (
            <div
              key={s.sessionId}
              onClick={() => setSelectedSession(s.sessionId)}
              style={{
                padding: "10px 16px",
                cursor: "pointer",
                borderBottom: "1px solid var(--color-border)",
                background: selectedSession === s.sessionId ? "var(--color-bg-hover)" : "transparent",
              }}
            >
              <div style={{ fontWeight: 500, fontSize: "13px" }}>
                {s.projectId || "Unnamed"}
              </div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
                {s.model} · {s.status}
              </div>
            </div>
          ))}

          {!loading && sessions.length === 0 && (
            <div style={{ padding: "16px", color: "var(--color-muted)", fontSize: "13px" }}>
              No active sessions.
            </div>
          )}
        </div>

        {/* Terminal view */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {wsUrl && token ? (
            <TerminalView wsUrl={wsUrl} token={token} />
          ) : (
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-muted)",
            }}>
              {loading ? "Loading..." : "Select a session to view its terminal."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Embedded terminal view using @saqr/terminal-ui components.
 */
function TerminalView({ wsUrl, token }: { wsUrl: string; token: string }) {
  const { connectionState, sessionInfo, sendInput, sendPermissionResponse } = useSession({
    url: wsUrl,
    token,
    autoReconnect: true,
    reconnectInterval: 3000,
    maxReconnectAttempts: 10,
  });

  const { timeline } = useTimeline();
  const [inputValue, setInputValue] = useState("");

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text) return;
    sendInput(text);
    setInputValue("");
  }, [inputValue, sendInput]);

  return (
    <>
      {/* Session header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
      }}>
        <span style={{ fontWeight: 600 }}>{sessionInfo?.projectId ?? "Session"}</span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: connectionState === "connected" ? "var(--color-success)"
              : connectionState === "connecting" ? "var(--color-warning)"
              : "var(--color-muted)",
          }} />
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {sessionInfo?.model ?? connectionState}
          </span>
        </div>
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Timeline items={timeline} onPermissionResponse={sendPermissionResponse} />
      </div>

      {/* Input bar */}
      {connectionState === "connected" && (
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            gap: "8px",
            padding: "8px 16px",
            borderTop: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Send a message..."
            style={{
              flex: 1,
              padding: "8px 12px",
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              borderRadius: "6px",
              color: "var(--color-text)",
              fontSize: "14px",
              outline: "none",
            }}
          />
          <button type="submit" className="btn btn-primary" style={{ padding: "8px 16px" }}>
            Send
          </button>
        </form>
      )}
    </>
  );
}
