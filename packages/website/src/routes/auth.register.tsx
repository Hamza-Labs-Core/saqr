/**
 * Register page — email + password form, hits sync-server /api/auth/register.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiPost } from '../lib/api';
import '../app.css';

interface RegisterResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: { user_id: string; email: string; tier: string };
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    setLoading(true);

    const result = await apiPost<RegisterResponse>('/api/auth/register', { email, password });

    if (result.data) {
      localStorage.setItem('saqr_token', result.data.access_token);
      localStorage.setItem('saqr_user', JSON.stringify(result.data.user));
      navigate('/dashboard');
    } else {
      setError(result.error?.message ?? 'Registration failed');
    }

    setLoading(false);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '400px', padding: '0 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <Link to="/" className="nav-brand" style={{ fontSize: '24px', textDecoration: 'none' }}>saqr</Link>
          <h1 style={{ fontSize: '24px', marginTop: '16px' }}>Create your account</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>
            Free tier includes 2 machines and 5MB sync storage
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
              autoComplete="new-password"
              minLength={12}
            />
            <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>
              Minimum 12 characters
            </span>
          </div>

          <div className="form-group">
            <label htmlFor="confirm" className="form-label">Confirm Password</label>
            <input
              id="confirm"
              type="password"
              className="form-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}
            disabled={loading}
          >
            {loading ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '14px', color: 'var(--color-text-secondary)' }}>
          Already have an account?{' '}
          <Link to="/auth/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
