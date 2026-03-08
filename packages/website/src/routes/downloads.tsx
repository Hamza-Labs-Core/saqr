/**
 * Downloads page — platform-specific download links + npm instructions.
 */
import { Link } from 'react-router';
import '../app.css';

interface DownloadCard {
  platform: string;
  icon: string;
  description: string;
  links: Array<{ label: string; href: string }>;
}

const DOWNLOADS: DownloadCard[] = [
  {
    platform: 'macOS',
    icon: '\u{F8FF}',
    description: 'Universal binary for Apple Silicon and Intel Macs.',
    links: [
      { label: 'Download .dmg (Universal)', href: 'https://github.com/Hamza-Labs-Core/saqr/releases/latest/download/Saqr_universal.dmg' },
      { label: 'Homebrew', href: '#homebrew' },
    ],
  },
  {
    platform: 'Windows',
    icon: '\u{2756}',
    description: 'Windows 10+ installer (x64).',
    links: [
      { label: 'Download .exe', href: 'https://github.com/Hamza-Labs-Core/saqr/releases/latest/download/Saqr_x64-setup.exe' },
      { label: 'Download .msi', href: 'https://github.com/Hamza-Labs-Core/saqr/releases/latest/download/Saqr_x64.msi' },
    ],
  },
  {
    platform: 'Linux',
    icon: '\u{1F427}',
    description: 'AppImage and .deb packages.',
    links: [
      { label: 'Download .AppImage', href: 'https://github.com/Hamza-Labs-Core/saqr/releases/latest/download/Saqr_amd64.AppImage' },
      { label: 'Download .deb', href: 'https://github.com/Hamza-Labs-Core/saqr/releases/latest/download/Saqr_amd64.deb' },
    ],
  },
];

export default function DownloadsPage() {
  return (
    <div>
      {/* Nav */}
      <header className="container">
        <nav className="nav">
          <Link to="/" className="nav-brand">saqr</Link>
          <div className="nav-links">
            <Link to="/auth/login">Login</Link>
          </div>
        </nav>
      </header>

      <div className="container" style={{ padding: '48px 24px' }}>
        <h1 style={{ textAlign: 'center', fontSize: '32px', marginBottom: '12px' }}>Downloads</h1>
        <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', marginBottom: '48px' }}>
          Desktop app for remote terminal access, or install the server CLI via npm.
        </p>

        {/* Desktop Apps */}
        <h2 style={{ fontSize: '20px', marginBottom: '24px' }}>Desktop App</h2>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '20px',
          marginBottom: '48px',
        }}>
          {DOWNLOADS.map((d) => (
            <div key={d.platform} className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <span style={{ fontSize: '24px' }}>{d.icon}</span>
                <h3 style={{ fontSize: '18px' }}>{d.platform}</h3>
              </div>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px', marginBottom: '16px' }}>
                {d.description}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {d.links.map((link) => (
                  <a key={link.label} href={link.href} className="btn btn-secondary" style={{ justifyContent: 'center' }}>
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* CLI Server */}
        <h2 style={{ fontSize: '20px', marginBottom: '24px' }}>Server (CLI)</h2>
        <div className="card" style={{ marginBottom: '48px' }}>
          <p style={{ marginBottom: '16px' }}>
            Install the Saqr daemon on your dev machine to enable remote access from the desktop app, mobile, or web.
          </p>

          <div style={{
            background: 'var(--color-bg)',
            borderRadius: '8px',
            padding: '16px 20px',
            fontFamily: 'var(--font-mono)',
            fontSize: '14px',
            marginBottom: '16px',
          }}>
            <div style={{ color: 'var(--color-muted)', marginBottom: '8px' }}># Install globally</div>
            <div>npm install -g @saqr/cli</div>
            <br />
            <div style={{ color: 'var(--color-muted)', marginBottom: '8px' }}># Login to your account</div>
            <div>saqr login</div>
            <br />
            <div style={{ color: 'var(--color-muted)', marginBottom: '8px' }}># Start the daemon</div>
            <div>saqr daemon start</div>
          </div>

          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
            Requires Node.js 22+. The daemon runs in the background and exposes your sessions to remote clients.
          </p>
        </div>

        {/* Mobile */}
        <h2 style={{ fontSize: '20px', marginBottom: '24px' }}>Mobile</h2>
        <div className="card">
          <p style={{ color: 'var(--color-text-secondary)' }}>
            Mobile apps for iOS and Android are coming soon. In the meantime, use the{' '}
            <Link to="/dashboard">web client</Link> from your mobile browser.
          </p>
        </div>
      </div>
    </div>
  );
}
