/**
 * Remote terminal — server list page.
 *
 * Authenticated route that shows a list of registered servers and their
 * active sessions. Selecting a session opens the terminal view.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { apiGet } from "../lib/api";
import "../app.css";

interface Machine {
  machine_id: string;
  name: string;
  os: string;
  hostname: string;
  last_seen_at: string | null;
  is_active: number;
}

export default function RemotePage() {
  const navigate = useNavigate();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("saqr_token");
    if (!token) {
      navigate("/auth/login");
      return;
    }

    apiGet<{ machines: Machine[] }>("/api/machines", token)
      .then((result) => {
        if (result.data?.machines) {
          setMachines(result.data.machines);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [navigate]);

  return (
    <div>
      <header className="container">
        <nav className="nav">
          <Link to="/" className="nav-brand">saqr</Link>
          <div className="nav-links">
            <Link to="/dashboard" className="btn btn-secondary" style={{ padding: "6px 14px", fontSize: "13px" }}>
              Dashboard
            </Link>
          </div>
        </nav>
      </header>

      <div className="container" style={{ padding: "48px 24px" }}>
        <h1 style={{ fontSize: "24px", marginBottom: "8px" }}>Remote Terminal</h1>
        <p style={{ color: "var(--color-text-secondary)", marginBottom: "32px" }}>
          Select a server to open its terminal remotely.
        </p>

        {loading && <p style={{ color: "var(--color-muted)" }}>Loading servers...</p>}

        {!loading && machines.length === 0 && (
          <div className="card" style={{ textAlign: "center" }}>
            <p style={{ marginBottom: "16px" }}>No servers available.</p>
            <Link to="/downloads" className="btn btn-primary">
              Install Server
            </Link>
          </div>
        )}

        {!loading && machines.length > 0 && (
          <div style={{ display: "grid", gap: "12px" }}>
            {machines.map((m) => (
              <Link
                key={m.machine_id}
                to={`/remote/${m.machine_id}`}
                className="card"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", textDecoration: "none", color: "inherit" }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{m.name || m.hostname}</div>
                  <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
                    {m.os} &middot; {m.hostname}
                  </div>
                </div>
                <div style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: m.is_active ? "var(--color-success)" : "var(--color-muted)",
                }} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
