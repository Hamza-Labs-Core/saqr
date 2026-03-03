/**
 * Admin codeguard rules page — curated + popular rule management.
 */
import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { apiGet, apiPost, getAdminServerUrl } from "../lib/api";
import "../app.css";

interface CuratedRule {
  id: string;
  description: string;
  severity: "block" | "warn";
  enabled: boolean;
  file_patterns: string[];
  patterns: string[];
  suggestion: string;
  order: number;
  added_at: string;
}

interface PopularRule {
  rule: {
    id: string;
    description: string;
    severity: "block" | "warn";
  };
  total_installs: number;
  total_blocks: number;
  hidden: boolean;
}

type Tab = "curated" | "popular";

export default function AdminRulesPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("curated");
  const [curated, setCurated] = useState<CuratedRule[]>([]);
  const [popular, setPopular] = useState<PopularRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const token = localStorage.getItem("saqr_token");
  const adminUrl = getAdminUrl();

  useEffect(() => {
    if (!token) {
      navigate("/auth/login");
      return;
    }
    loadRules();
  }, [token, navigate]);

  async function loadRules() {
    setLoading(true);
    setError(null);
    try {
      const [curatedRes, popularRes] = await Promise.all([
        apiGet<{ rules: CuratedRule[] }>("/api/admin/codeguard/curated", token!, adminUrl),
        apiGet<{ rules: PopularRule[] }>("/api/admin/codeguard/popular", token!, adminUrl),
      ]);
      setCurated(curatedRes.data?.rules ?? []);
      setPopular(popularRes.data?.rules ?? []);
    } catch {
      setError("Failed to load rules");
    } finally {
      setLoading(false);
    }
  }

  const handleHide = useCallback(async (ruleId: string) => {
    if (!token) return;
    await apiPost(`/api/admin/codeguard/popular/${ruleId}/hide`, {}, token, adminUrl);
    setPopular(prev => prev.map(r => r.rule.id === ruleId ? { ...r, hidden: true } : r));
  }, [token, adminUrl]);

  const handleUnhide = useCallback(async (ruleId: string) => {
    if (!token) return;
    await apiPost(`/api/admin/codeguard/popular/${ruleId}/unhide`, {}, token, adminUrl);
    setPopular(prev => prev.map(r => r.rule.id === ruleId ? { ...r, hidden: false } : r));
  }, [token, adminUrl]);

  return (
    <div>
      <header className="container">
        <nav className="nav">
          <Link to="/" className="nav-brand">saqr</Link>
          <div className="nav-links">
            <Link to="/admin">Admin</Link>
            <Link to="/admin/users">Users</Link>
          </div>
        </nav>
      </header>

      <div className="container" style={{ padding: "48px 24px" }}>
        <h1 style={{ fontSize: "24px", marginBottom: "24px" }}>Codeguard Rules</h1>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "24px" }}>
          <button
            className={`btn ${tab === "curated" ? "btn-primary" : ""}`}
            onClick={() => setTab("curated")}
          >
            Curated ({curated.length})
          </button>
          <button
            className={`btn ${tab === "popular" ? "btn-primary" : ""}`}
            onClick={() => setTab("popular")}
          >
            Popular ({popular.length})
          </button>
        </div>

        {loading && <p style={{ color: "var(--color-muted)" }}>Loading rules...</p>}
        {error && <p style={{ color: "var(--color-error)" }}>{error}</p>}

        {/* Curated tab */}
        {tab === "curated" && !loading && (
          <div style={{ display: "grid", gap: "12px" }}>
            {curated.map(rule => (
              <div key={rule.id} className="card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <code style={{ fontSize: "13px", fontWeight: 600 }}>{rule.id}</code>
                    <span style={{
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      fontWeight: 600,
                      background: rule.severity === "block" ? "var(--color-error)" : "var(--color-warning)",
                      color: "#fff",
                    }}>
                      {rule.severity}
                    </span>
                    {!rule.enabled && (
                      <span style={{ fontSize: "11px", color: "var(--color-muted)" }}>disabled</span>
                    )}
                  </div>
                  <Link
                    to={`/admin/rules/${rule.id}`}
                    className="btn"
                    style={{ padding: "4px 10px", fontSize: "12px" }}
                  >
                    Edit
                  </Link>
                </div>
                <p style={{ fontSize: "14px", marginBottom: "4px" }}>{rule.description}</p>
                <p style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                  Patterns: {rule.file_patterns.join(", ")} · {rule.patterns.length} regex
                </p>
              </div>
            ))}
            {curated.length === 0 && (
              <p style={{ color: "var(--color-muted)" }}>No curated rules yet.</p>
            )}
          </div>
        )}

        {/* Popular tab */}
        {tab === "popular" && !loading && (
          <div style={{ display: "grid", gap: "12px" }}>
            {popular.map(entry => (
              <div
                key={entry.rule.id}
                className="card"
                style={{ opacity: entry.hidden ? 0.5 : 1 }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <code style={{ fontSize: "13px", fontWeight: 600 }}>{entry.rule.id}</code>
                    <span style={{
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      fontWeight: 600,
                      background: entry.rule.severity === "block" ? "var(--color-error)" : "var(--color-warning)",
                      color: "#fff",
                    }}>
                      {entry.rule.severity}
                    </span>
                    {entry.hidden && (
                      <span style={{ fontSize: "11px", color: "var(--color-error)" }}>hidden</span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                      {entry.total_installs} installs · {entry.total_blocks} blocks
                    </span>
                    {entry.hidden ? (
                      <button
                        className="btn"
                        style={{ padding: "4px 10px", fontSize: "12px" }}
                        onClick={() => handleUnhide(entry.rule.id)}
                      >
                        Unhide
                      </button>
                    ) : (
                      <button
                        className="btn"
                        style={{ padding: "4px 10px", fontSize: "12px" }}
                        onClick={() => handleHide(entry.rule.id)}
                      >
                        Hide
                      </button>
                    )}
                  </div>
                </div>
                <p style={{ fontSize: "14px" }}>{entry.rule.description}</p>
              </div>
            ))}
            {popular.length === 0 && (
              <p style={{ color: "var(--color-muted)" }}>No popular rules yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const getAdminUrl = getAdminServerUrl;
