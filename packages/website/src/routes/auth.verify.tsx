/**
 * Email verification handler.
 *
 * URL: /auth/verify?token=<verification_token>
 *
 * When a user registers, they receive an email with a verification link
 * that points here. We call the sync-server to verify the token.
 */
import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiPost } from '../lib/api';
import '../app.css';

type VerifyStatus = 'verifying' | 'success' | 'error';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<VerifyStatus>('verifying');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setError('No verification token provided.');
      setStatus('error');
      return;
    }

    verifyEmail(token);
  }, [token]);

  async function verifyEmail(verificationToken: string) {
    setStatus('verifying');

    const result = await apiPost<{ verified: boolean }>(
      '/api/auth/verify-email',
      { token: verificationToken },
    );

    if (result.data?.verified) {
      setStatus('success');
    } else {
      setError(result.error?.message ?? 'Verification failed. The link may have expired.');
      setStatus('error');
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '400px', padding: '0 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <Link to="/" className="nav-brand" style={{ fontSize: '24px', textDecoration: 'none' }}>saqr</Link>
          <h1 style={{ fontSize: '24px', marginTop: '16px' }}>Email Verification</h1>
        </div>

        {status === 'verifying' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '16px auto' }} />
            <p style={{ color: 'var(--color-text-secondary)' }}>Verifying your email...</p>
          </div>
        )}

        {status === 'success' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#10003;</div>
            <h2 style={{ color: 'var(--color-success)' }}>Email Verified</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginTop: '8px' }}>
              Your email has been verified. You can now sign in.
            </p>
            <Link
              to="/auth/login"
              className="btn btn-primary"
              style={{ justifyContent: 'center', marginTop: '16px' }}
            >
              Sign in
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <h2 style={{ color: 'var(--color-error)' }}>Verification Failed</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginTop: '8px' }}>{error}</p>
            <Link
              to="/auth/register"
              className="btn btn-secondary"
              style={{ justifyContent: 'center', marginTop: '16px' }}
            >
              Register again
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
