import React from "react";
import {
  Timeline,
  useSession,
  useTimeline,
} from "@saqr/terminal-ui";
import { getStoredToken } from "../App.js";

interface TerminalPageProps {
  serverId: string;
  sessionId: string;
  onBack: () => void;
}

/**
 * Terminal page — full-screen terminal-faithful rendering of a remote session.
 *
 * Uses @saqr/terminal-ui components for a cm-by-cm replica of Claude Code's
 * terminal output, but in a browser/Tauri WebView.
 */
export function TerminalPage({ serverId, sessionId, onBack }: TerminalPageProps): React.ReactElement {
  // Determine daemon WebSocket URL
  const daemonWsUrl = serverId === "local"
    ? `ws://localhost:3100/ws/session/${sessionId}`
    : `wss://${serverId}/ws/session/${sessionId}`;

  const daemonHttpUrl = serverId === "local"
    ? "http://localhost:3100"
    : `https://${serverId}`;

  const token = getStoredToken() ?? undefined;

  const { connectionState, sessionInfo, sendInput, sendPermissionResponse } = useSession({
    url: daemonWsUrl,
    token,
    autoReconnect: true,
    reconnectInterval: 3000,
    maxReconnectAttempts: 10,
  });

  const { timeline } = useTimeline();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Header bar */}
      <div className="session-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn" onClick={onBack} style={{ padding: "4px 8px" }}>
            ← Back
          </button>
          <span className="session-header-title">
            {sessionInfo?.projectId || sessionId}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className={`status-dot ${connectionState}`} />
          <span className="session-header-model">
            {sessionInfo?.model || "connecting..."}
          </span>
        </div>
      </div>

      {/* Terminal timeline */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {connectionState === "connecting" && (
          <div className="empty-state">
            <div className="spinner" />
            <p>Connecting to session...</p>
          </div>
        )}

        {connectionState === "error" && (
          <div className="empty-state">
            <div className="empty-state-title">Connection Error</div>
            <p className="error-text">Failed to connect to the daemon.</p>
            <button className="btn" onClick={onBack} style={{ marginTop: 16 }}>
              Back to Servers
            </button>
          </div>
        )}

        {(connectionState === "connected" || connectionState === "disconnected") && (
          <Timeline
            items={timeline}
            onPermissionResponse={sendPermissionResponse}
          />
        )}
      </div>

      {/* Input bar */}
      {connectionState === "connected" && (
        <PromptInput onSubmit={sendInput} />
      )}
    </div>
  );
}

/** Simple prompt input bar at the bottom. */
function PromptInput({ onSubmit }: { onSubmit: (text: string) => void }): React.ReactElement {
  const [value, setValue] = React.useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        padding: "8px 12px",
        gap: 8,
        borderTop: "1px solid var(--saqr-border)",
        background: "var(--saqr-surface)",
      }}
    >
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Send a message..."
        style={{
          flex: 1,
          padding: "8px 12px",
          background: "var(--saqr-card-bg)",
          border: "1px solid var(--saqr-border)",
          borderRadius: 6,
          color: "var(--saqr-text-primary)",
          fontSize: 14,
          fontFamily: "var(--saqr-font-system)",
          outline: "none",
        }}
      />
      <button type="submit" className="btn btn-primary">
        Send
      </button>
    </form>
  );
}
