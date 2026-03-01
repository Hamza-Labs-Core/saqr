/**
 * Admin user management page.
 */
import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { apiGet, apiPost } from "../lib/api";
import "../app.css";

interface UserInfo {
  userId: string;
  email: string;
  tier: string;
  role: "admin" | "user";
  createdAt: string;
}

export default function AdminUsersPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const token = localStorage.getItem("saqr_token");
  const adminUrl = getAdminUrl();

  useEffect(() => {
    if (!token) {
      navigate("/auth/login");
      return;
    }
    loadUsers();
  }, [token, navigate]);

  async function loadUsers() {
    setLoading(true);
    try {
      const result = await apiGet<{ users: UserInfo[] }>("/api/admin/users", token!, adminUrl);
      setUsers(result.data?.users ?? []);
    } catch {
      setError("Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  const handlePromote = useCallback(async (userId: string) => {
    if (!token) return;
    const result = await apiPost(`/api/admin/users/${userId}/promote`, {}, token, adminUrl);
    if (result.data) {
      setUsers(prev => prev.map(u => u.userId === userId ? { ...u, role: "admin" } : u));
    }
  }, [token, adminUrl]);

  const handleDemote = useCallback(async (userId: string) => {
    if (!token) return;
    const result = await apiPost(`/api/admin/users/${userId}/demote`, {}, token, adminUrl);
    if (result.data) {
      setUsers(prev => prev.map(u => u.userId === userId ? { ...u, role: "user" } : u));
    }
  }, [token, adminUrl]);

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

      <div className="container" style={{ padding: "48px 24px" }}>
        <h1 style={{ fontSize: "24px", marginBottom: "8px" }}>User Management</h1>
        <p style={{ color: "var(--color-text-secondary)", marginBottom: "24px" }}>
          {users.length} users registered
        </p>

        {loading && <p style={{ color: "var(--color-muted)" }}>Loading users...</p>}
        {error && <p style={{ color: "var(--color-error)" }}>{error}</p>}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Tier</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>Created</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.userId} style={{ borderBottom: "1px solid var(--color-border)" }}>
                <td style={tdStyle}>{user.email}</td>
                <td style={tdStyle}>
                  <span className={`badge badge-${user.tier}`}>{user.tier}</span>
                </td>
                <td style={tdStyle}>
                  <span style={{
                    color: user.role === "admin" ? "var(--color-warning)" : "var(--color-text-secondary)",
                    fontWeight: user.role === "admin" ? 600 : 400,
                  }}>
                    {user.role}
                  </span>
                </td>
                <td style={tdStyle}>{formatDate(user.createdAt)}</td>
                <td style={tdStyle}>
                  {user.role === "user" ? (
                    <button className="btn" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => handlePromote(user.userId)}>
                      Promote
                    </button>
                  ) : (
                    <button className="btn" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => handleDemote(user.userId)}>
                      Demote
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: "13px",
  color: "var(--color-text-secondary)",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "14px",
};

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function getAdminUrl(): string {
  return import.meta.env.VITE_ADMIN_SERVER_URL ?? "https://admin.saqr.dev";
}
