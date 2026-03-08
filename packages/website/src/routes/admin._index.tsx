/**
 * Admin dashboard — overview with user count, rule stats.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { apiGet, getAdminServerUrl } from "../lib/api";
import "../app.css";

interface AdminStats {
  userCount: number;
  curatedRuleCount: number;
  popularRuleCount: number;
  hiddenRuleCount: number;
}

export default function AdminDashboardPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const token = localStorage.getItem("saqr_token");

  useEffect(() => {
    if (!token) {
      navigate("/auth/login");
      return;
    }
    loadStats();
  }, [token, navigate]);

  async function loadStats() {
    setLoading(true);
    setError(null);

    try {
      const adminUrl = getAdminUrl();

      const [usersRes, curatedRes, popularRes] = await Promise.all([
        apiGet<{ users: unknown[]; total: number }>("/api/admin/users?limit=1", token!, adminUrl),
        apiGet<{ rules: unknown[] }>("/api/admin/codeguard/curated", token!, adminUrl),
        apiGet<{ rules: unknown[]; total: number; hidden_count: number }>("/api/admin/codeguard/popular", token!, adminUrl),
      ]);

      setStats({
        userCount: usersRes.data?.total ?? 0,
        curatedRuleCount: usersRes.data ? (curatedRes.data?.rules?.length ?? 0) : 0,
        popularRuleCount: popularRes.data?.total ?? 0,
        hiddenRuleCount: popularRes.data?.hidden_count ?? 0,
      });
    } catch {
      setError("Failed to load admin stats. Are you an admin?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <header className="container">
        <nav className="nav">
          <Link to="/" className="nav-brand">saqr</Link>
          <div className="nav-links">
            <Link to="/admin/users">Users</Link>
            <Link to="/admin/rules">Rules</Link>
            <Link to="/dashboard">Dashboard</Link>
          </div>
        </nav>
      </header>

      <div className="container" style={{ padding: "48px 24px" }}>
        <h1 style={{ fontSize: "24px", marginBottom: "32px" }}>Admin Panel</h1>

        {loading && <p style={{ color: "var(--color-muted)" }}>Loading stats...</p>}
        {error && <p style={{ color: "var(--color-error)" }}>{error}</p>}

        {stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
            <StatCard label="Users" value={stats.userCount} link="/admin/users" />
            <StatCard label="Curated Rules" value={stats.curatedRuleCount} link="/admin/rules" />
            <StatCard label="Popular Rules" value={stats.popularRuleCount} link="/admin/rules" />
            <StatCard label="Hidden Rules" value={stats.hiddenRuleCount} link="/admin/rules" />
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, link }: { label: string; value: number; link: string }) {
  return (
    <Link to={link} className="card" style={{ textDecoration: "none", color: "inherit", textAlign: "center" }}>
      <div style={{ fontSize: "32px", fontWeight: 700, marginBottom: "4px" }}>{value}</div>
      <div style={{ color: "var(--color-text-secondary)", fontSize: "14px" }}>{label}</div>
    </Link>
  );
}

const getAdminUrl = getAdminServerUrl;
