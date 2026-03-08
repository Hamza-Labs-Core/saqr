/**
 * Dashboard page — authenticated redirect into the web remote client.
 * Shows server list for selecting which dev machine to connect to.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiGet } from '../lib/api';
import '../app.css';

interface Machine {
  machine_id: string;
  name: string;
  os: string;
  hostname: string;
  last_seen_at: string | null;
  is_active: number;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<{ email: string; tier: string } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('saqr_token');
    const userStr = localStorage.getItem('saqr_user');

    if (!token) {
      navigate('/auth/login');
      return;
    }

    if (userStr) {
      try {
        setUser(JSON.parse(userStr));
      } catch {
        // ignore
      }
    }

    apiGet<{ machines: Machine[] }>('/api/machines', token)
      .then((result) => {
        if (result.data?.machines) {
          setMachines(result.data.machines);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [navigate]);

  function handleLogout() {
    localStorage.removeItem('saqr_token');
    localStorage.removeItem('saqr_user');
    navigate('/auth/login');
  }

  return (
    <div>
      <header className="container">
        <nav className="nav">
          <Link to="/" className="nav-brand">saqr</Link>
          <div className="nav-links">
            {user && (
              <span style={{ color: 'var(--color-text-secondary)', fontSize: '13px' }}>
                {user.email} ({user.tier})
              </span>
            )}
            <button onClick={handleLogout} className="btn btn-secondary" style={{ padding: '6px 14px', fontSize: '13px' }}>
              Logout
            </button>
          </div>
        </nav>
      </header>

      <div className="container" style={{ padding: '48px 24px' }}>
        <h1 style={{ fontSize: '24px', marginBottom: '8px' }}>Your Servers</h1>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: '32px' }}>
          Select a server to connect to its terminal remotely.
        </p>

        {loading && <p style={{ color: 'var(--color-muted)' }}>Loading servers...</p>}

        {!loading && machines.length === 0 && (
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ marginBottom: '16px' }}>No servers registered yet.</p>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>
              Install the Saqr CLI on your dev machine and run{' '}
              <code style={{ background: 'var(--color-bg)', padding: '2px 6px', borderRadius: '4px' }}>
                saqr login && saqr daemon start
              </code>
            </p>
            <Link to="/downloads" className="btn btn-primary" style={{ marginTop: '16px' }}>
              Download CLI
            </Link>
          </div>
        )}

        {!loading && machines.length > 0 && (
          <div style={{ display: 'grid', gap: '12px' }}>
            {machines.map((m) => (
              <Link
                key={m.machine_id}
                to={`/remote/${m.machine_id}`}
                className="card"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', textDecoration: 'none', color: 'inherit' }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{m.name || m.hostname}</div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                    {m.os} &middot; {m.hostname}
                  </div>
                </div>
                <div style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: m.is_active ? 'var(--color-success)' : 'var(--color-muted)',
                }} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
