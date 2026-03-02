import React, { useState, useEffect, useRef } from "react";

interface LoginPageProps {
  onLogin: (accessToken: string) => void;
}

interface DeviceCodeState {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

const SYNC_SERVER = import.meta.env.VITE_SYNC_SERVER || "https://sync.saqr.dev";

/**
 * Device-code login page.
 *
 * 1. Request a device code from the sync server
 * 2. Show the user code to the user
 * 3. Open the verification URL in the default browser
 * 4. Poll for approval
 */
export function LoginPage({ onLogin }: LoginPageProps): React.ReactElement {
  const [state, setState] = useState<"idle" | "loading" | "polling" | "error">("idle");
  const [deviceCode, setDeviceCode] = useState<DeviceCodeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function requestDeviceCode() {
    setState("loading");
    setError(null);

    try {
      const res = await fetch(`${SYNC_SERVER}/api/auth/device-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "saqr-desktop" }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const dc: DeviceCodeState = {
        userCode: data.user_code,
        deviceCode: data.device_code,
        verificationUri: data.verification_uri_complete || data.verification_uri,
        expiresIn: data.expires_in,
        interval: data.interval || 5,
      };

      setDeviceCode(dc);
      setState("polling");
      startPolling(dc);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request device code");
      setState("error");
    }
  }

  function startPolling(dc: DeviceCodeState) {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${SYNC_SERVER}/api/auth/device-poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_code: dc.deviceCode,
            client_id: "saqr-desktop",
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.access_token) {
            if (pollRef.current) clearInterval(pollRef.current);
            onLogin(data.access_token);
            return;
          }
        }

        const body = await res.json().catch(() => ({ error: "unknown" }));
        if (body.error === "expired_token" || body.error === "access_denied") {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(body.error === "expired_token" ? "Code expired. Please try again." : "Access denied.");
          setState("error");
        }
        // "authorization_pending" and "slow_down" continue polling
      } catch {
        // Network error — keep polling
      }
    }, dc.interval * 1000);
  }

  function openVerificationUrl() {
    if (!deviceCode) return;
    // In Tauri, use shell.open; fallback to window.open
    if (window.__TAURI__) {
      window.__TAURI__.shell.open(deviceCode.verificationUri).catch(() => {
        window.open(deviceCode.verificationUri, "_blank");
      });
    } else {
      window.open(deviceCode.verificationUri, "_blank");
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">Saqr</div>
        <p className="login-subtitle">Manage your dev servers from anywhere</p>

        {state === "idle" && (
          <>
            <p className="login-status" style={{ marginBottom: 20 }}>
              Sign in with your Saqr account to get started.
            </p>
            <button className="btn btn-primary" onClick={requestDeviceCode}>
              Sign In
            </button>
          </>
        )}

        {state === "loading" && (
          <>
            <div className="spinner" />
            <p className="login-status">Connecting...</p>
          </>
        )}

        {state === "polling" && deviceCode && (
          <>
            <p className="login-status">Enter this code in your browser:</p>
            <div className="login-code">{deviceCode.userCode}</div>
            <button className="btn btn-primary" onClick={openVerificationUrl} style={{ marginBottom: 12 }}>
              Open Browser to Sign In
            </button>
            <div className="spinner" />
            <p className="login-status">Waiting for approval...</p>
          </>
        )}

        {state === "error" && (
          <>
            <p className="error-text" style={{ marginBottom: 16 }}>{error}</p>
            <button className="btn" onClick={requestDeviceCode}>Try Again</button>
          </>
        )}
      </div>
    </div>
  );
}

// Augment window for Tauri globals
declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      shell: { open: (url: string) => Promise<void> };
    };
  }
}
