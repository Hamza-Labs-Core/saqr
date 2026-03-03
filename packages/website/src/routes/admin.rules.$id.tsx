/**
 * Admin rule detail/edit page.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiGet, getAdminServerUrl } from "../lib/api";
import "../app.css";

interface CuratedRule {
  id: string;
  description: string;
  severity: "block" | "warn";
  enabled: boolean;
  file_patterns: string[];
  patterns: string[];
  exclude_patterns: string[];
  suggestion: string;
  order: number;
  added_at: string;
  added_by: string;
}

export default function AdminRuleDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [rule, setRule] = useState<CuratedRule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const token = localStorage.getItem("saqr_token");
  const adminUrl = getAdminUrl();

  useEffect(() => {
    if (!token) {
      navigate("/auth/login");
      return;
    }
    loadRule();
  }, [id, token, navigate]);

  async function loadRule() {
    setLoading(true);
    try {
      const result = await apiGet<{ rules: CuratedRule[] }>("/api/admin/codeguard/curated", token!, adminUrl);
      const found = result.data?.rules?.find(r => r.id === id);
      if (found) {
        setRule(found);
      } else {
        setError("Rule not found");
      }
    } catch {
      setError("Failed to load rule");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!rule || !token) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`${adminUrl}/api/admin/codeguard/curated/${rule.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          description: rule.description,
          severity: rule.severity,
          enabled: rule.enabled,
          file_patterns: rule.file_patterns,
          patterns: rule.patterns,
          exclude_patterns: rule.exclude_patterns,
          suggestion: rule.suggestion,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Save failed" }));
        setError(body.error || "Save failed");
      } else {
        navigate("/admin/rules");
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!rule || !token) return;

    try {
      const res = await fetch(`${adminUrl}/api/admin/codeguard/curated/${rule.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        navigate("/admin/rules");
      } else {
        const body = await res.json().catch(() => ({ error: "Delete failed" }));
        setError(body.error || "Delete failed");
      }
    } catch {
      setError("Network error");
    }
  }

  function updateField<K extends keyof CuratedRule>(key: K, value: CuratedRule[K]) {
    if (rule) setRule({ ...rule, [key]: value });
  }

  return (
    <div>
      <header className="container">
        <nav className="nav">
          <Link to="/" className="nav-brand">saqr</Link>
          <div className="nav-links">
            <Link to="/admin">Admin</Link>
            <Link to="/admin/rules">Rules</Link>
          </div>
        </nav>
      </header>

      <div className="container" style={{ padding: "48px 24px", maxWidth: "640px" }}>
        {loading && <p style={{ color: "var(--color-muted)" }}>Loading...</p>}
        {error && <p style={{ color: "var(--color-error)", marginBottom: "16px" }}>{error}</p>}

        {rule && (
          <>
            <h1 style={{ fontSize: "20px", marginBottom: "24px" }}>
              Edit Rule: <code>{rule.id}</code>
            </h1>

            <div style={{ display: "grid", gap: "16px" }}>
              <Field label="Description">
                <textarea
                  value={rule.description}
                  onChange={e => updateField("description", e.target.value)}
                  rows={3}
                  style={inputStyle}
                />
              </Field>

              <Field label="Severity">
                <select
                  value={rule.severity}
                  onChange={e => updateField("severity", e.target.value as "block" | "warn")}
                  style={inputStyle}
                >
                  <option value="block">block</option>
                  <option value="warn">warn</option>
                </select>
              </Field>

              <Field label="Enabled">
                <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={e => updateField("enabled", e.target.checked)}
                  />
                  {rule.enabled ? "Enabled" : "Disabled"}
                </label>
              </Field>

              <Field label="File Patterns (one per line)">
                <textarea
                  value={rule.file_patterns.join("\n")}
                  onChange={e => updateField("file_patterns", e.target.value.split("\n").filter(Boolean))}
                  rows={3}
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                />
              </Field>

              <Field label="Regex Patterns (one per line)">
                <textarea
                  value={rule.patterns.join("\n")}
                  onChange={e => updateField("patterns", e.target.value.split("\n").filter(Boolean))}
                  rows={4}
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                />
              </Field>

              <Field label="Suggestion">
                <textarea
                  value={rule.suggestion}
                  onChange={e => updateField("suggestion", e.target.value)}
                  rows={3}
                  style={inputStyle}
                />
              </Field>

              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : "Save Changes"}
                </button>
                <button className="btn" onClick={() => navigate("/admin/rules")}>
                  Cancel
                </button>
                <button
                  className="btn"
                  style={{ marginLeft: "auto", color: "var(--color-error)" }}
                  onClick={handleDelete}
                >
                  Delete Rule
                </button>
              </div>
            </div>

            <div style={{ marginTop: "24px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
              Added: {rule.added_at} · Order: {rule.order}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 600 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  color: "var(--color-text)",
  fontSize: "14px",
};

const getAdminUrl = getAdminServerUrl;
