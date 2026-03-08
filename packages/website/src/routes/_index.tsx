/**
 * Landing page — hero, features, download links.
 */
import { Link } from 'react-router';
import '../app.css';

const FEATURES = [
  {
    title: 'Terminal-Faithful UI',
    description: 'See exactly what Claude Code sees — same colors, same layout, every tool call rendered faithfully.',
  },
  {
    title: 'Multi-Agent Control',
    description: 'Manage Claude Code, OpenCode, Codex, and custom agents from a single dashboard.',
  },
  {
    title: 'Voice Input',
    description: 'Talk to your agents with voice input on desktop, mobile, and web.',
  },
  {
    title: 'End-to-End Encrypted',
    description: 'XChaCha20-Poly1305 encryption. Your code never touches our servers in plaintext.',
  },
  {
    title: 'Remote Access',
    description: 'Connect to your dev machine from anywhere — phone, tablet, or another computer.',
  },
  {
    title: 'Open Source',
    description: 'MIT licensed. Self-host the server, use our cloud, or both.',
  },
];

export default function LandingPage() {
  return (
    <div>
      {/* Navigation */}
      <header className="container">
        <nav className="nav">
          <span className="nav-brand">saqr</span>
          <div className="nav-links">
            <Link to="/downloads">Downloads</Link>
            <Link to="/auth/login">Login</Link>
            <Link to="/auth/register" className="btn btn-primary" style={{ padding: '8px 16px' }}>
              Get Started
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section style={{ textAlign: 'center', padding: '80px 24px 60px' }}>
        <h1 style={{ fontSize: '48px', fontWeight: 800, lineHeight: 1.1, marginBottom: '20px' }}>
          Your AI agents,{' '}
          <span style={{ color: 'var(--color-accent)' }}>everywhere</span>
        </h1>
        <p style={{ fontSize: '18px', color: 'var(--color-text-secondary)', maxWidth: '600px', margin: '0 auto 32px' }}>
          Saqr brings Claude Code&apos;s terminal to your phone, tablet, and browser.
          Manage multiple agents, approve permissions remotely, and never miss a tool call.
        </p>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/downloads" className="btn btn-primary" style={{ fontSize: '16px', padding: '14px 28px' }}>
            Download for Free
          </Link>
          <a href="#features" className="btn btn-secondary" style={{ fontSize: '16px', padding: '14px 28px' }}>
            Learn More
          </a>
        </div>

        {/* Install command */}
        <div style={{
          marginTop: '32px',
          display: 'inline-block',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: '8px',
          padding: '12px 20px',
          fontFamily: 'var(--font-mono)',
          fontSize: '14px',
        }}>
          <span style={{ color: 'var(--color-muted)' }}>$</span>{' '}
          npm install -g @saqr/cli
        </div>
      </section>

      {/* Features */}
      <section id="features" className="container" style={{ padding: '60px 24px' }}>
        <h2 style={{ textAlign: 'center', fontSize: '32px', marginBottom: '48px' }}>
          Everything you need
        </h2>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '24px',
        }}>
          {FEATURES.map((feature) => (
            <div key={feature.title} className="card">
              <h3 style={{ fontSize: '18px', marginBottom: '8px' }}>{feature.title}</h3>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{
        borderTop: '1px solid var(--color-border)',
        padding: '32px 24px',
        textAlign: 'center',
        color: 'var(--color-muted)',
        fontSize: '13px',
      }}>
        <div className="container">
          Saqr by Hamza Labs &mdash; MIT License
        </div>
      </footer>
    </div>
  );
}
