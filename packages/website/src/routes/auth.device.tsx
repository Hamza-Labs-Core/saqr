/**
 * Device code approval page.
 *
 * When a CLI/Desktop/Mobile app initiates a device-code login,
 * the user is directed here to approve the device.
 *
 * URL: /auth/device?code=ABCD-1234
 */
import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiPost } from '../lib/api';
import '../app.css';

export default function DeviceApprovePage() {
  const [searchParams] = useSearchParams();
  const codeFromUrl = searchParams.get('code') ?? '';

  const [userCode, setUserCode] = useState(codeFromUrl);
  const [status, setStatus] = useState<'input' | 'confirming' | 'approved' | 'denied' | 'error'>('input');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Check if user is logged in
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  useEffect(() => {
    const token = localStorage.getItem('saqr_token');
    setIsLoggedIn(!!token);
  }, []);

  async function handleApprove() {
    const token = localStorage.getItem('saqr_token');
    if (!token) {
      setError('You must be logged in to approve a device');
      return;
    }

    setLoading(true);
    setError('');

    const result = await apiPost<{ status: string }>(
      '/api/auth/device-approve',
      { user_code: userCode, action: 'approve' },
      token,
    );

    if (result.data?.status === 'approved') {
      setStatus('approved');
    } else {
      setError(result.error?.message ?? 'Failed to approve device');
      setStatus('error');
    }
    setLoading(false);
  }

  async function handleDeny() {
    const token = localStorage.getItem('saqr_token');
    if (!token) return;

    setLoading(true);
    await apiPost('/api/auth/device-approve', { user_code: userCode, action: 'deny' }, token);
    setStatus('denied');
    setLoading(false);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '400px', padding: '0 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <Link to="/" className="nav-brand" style={{ fontSize: '24px', textDecoration: 'none' }}>saqr</Link>
          <h1 style={{ fontSize: '24px', marginTop: '16px' }}>Approve Device</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>
            A device is requesting access to your account
          </p>
        </div>

        {!isLoggedIn && (
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ marginBottom: '16px' }}>You need to sign in first to approve this device.</p>
            <Link
              to={`/auth/login?redirect=/auth/device?code=${encodeURIComponent(userCode)}`}
              className="btn btn-primary"
              style={{ justifyContent: 'center' }}
            >
              Sign in
            </Link>
          </div>
        )}

        {isLoggedIn && status === 'input' && (
          <div className="card">
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
              <label htmlFor="code" className="form-label">Device Code</label>
              <input
                id="code"
                type="text"
                className="form-input"
                value={userCode}
                onChange={(e) => setUserCode(e.target.value.toUpperCase())}
                placeholder="ABCD-1234"
                style={{ textAlign: 'center', fontSize: '20px', fontFamily: 'var(--font-mono)', letterSpacing: '2px' }}
              />
            </div>

            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
              Verify this code matches the one shown on your device before approving.
            </p>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleApprove}
                disabled={loading || !userCode}
              >
                {loading ? 'Approving...' : 'Approve'}
              </button>
              <button
                className="btn btn-secondary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleDeny}
                disabled={loading}
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {status === 'approved' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#10003;</div>
            <h2 style={{ color: 'var(--color-success)' }}>Device Approved</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginTop: '8px' }}>
              You can close this page. The device will automatically sign in.
            </p>
          </div>
        )}

        {status === 'denied' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <h2 style={{ color: 'var(--color-error)' }}>Device Denied</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginTop: '8px' }}>
              The device login request was denied.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <h2 style={{ color: 'var(--color-error)' }}>Error</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginTop: '8px' }}>{error}</p>
            <button
              className="btn btn-secondary"
              style={{ marginTop: '16px' }}
              onClick={() => setStatus('input')}
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
