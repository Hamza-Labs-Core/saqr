/**
 * Login page — email + password form, hits sync-server /api/auth/login.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { apiPost } from '../lib/api';
import '../app.css';

interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: { user_id: string; email: string; tier: string };
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await apiPost<LoginResponse>('/api/auth/login', { email, password });

    if (result.data) {
      // Store token in localStorage
      localStorage.setItem('saqr_token', result.data.access_token);
      localStorage.setItem('saqr_user', JSON.stringify(result.data.user));
      navigate(redirect || '/dashboard');
    } else {
      setError(result.error?.message ?? 'Login failed');
    }

    setLoading(false);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '400px', padding: '0 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <Link to="/" className="nav-brand" style={{ fontSize: '24px', textDecoration: 'none' }}>saqr</Link>
          <h1 style={{ fontSize: '24px', marginTop: '16px' }}>Welcome back</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>
            Sign in to your account
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card">
          {error && (
            <div style={{
              background: 'var(--color-error)',
              color: '#fff',
              padding: '10px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              marginBottom: '16px',
            }}>
              {error}
            </div>
          )}

          <div className="form-group">
            <label htmlFor="email" className="form-label">Email</label>
            <input
              id="email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password" className="form-label">Password</label>
            <input
              id="password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              minLength={12}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}
            disabled={loading}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '14px', color: 'var(--color-text-secondary)' }}>
          Don&apos;t have an account?{' '}
          <Link to={redirect ? `/auth/register?redirect=${encodeURIComponent(redirect)}` : '/auth/register'}>Create one</Link>
        </p>
      </div>
    </div>
  );
}
