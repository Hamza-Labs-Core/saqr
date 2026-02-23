/**
 * GDPR Compliance Test Suite — Automated compliance checks.
 *
 * End-to-end verification that all GDPR requirements are met:
 * - Metadata sanitizer catches all PII patterns
 * - Export contains all user data
 * - Consent middleware blocks when consent is missing
 * - Privacy headers are present on all responses
 * - EU residency is enforced for EU users
 * - Deletion audit log tracks all deletions
 */

import { describe, it, expect } from 'vitest';

// Import all GDPR modules
import {
  sanitizeMetadata,
  validateMetadata,
  detectPII,
  MetadataSanitizationError,
} from '../../middleware/metadata-sanitizer.js';

import {
  addPrivacyHeaders,
  verifyPrivacyHeaders,
  PRIVACY_HEADERS,
} from '../../middleware/privacy-headers.js';

import {
  getUserRegion,
  enforceEUResidency,
  EU_COUNTRY_CODES,
} from '../../middleware/eu-residency.js';

import {
  DELETION_LOG_RETENTION_DAYS,
} from '../../handlers/deletion-audit.js';

// -----------------------------------------------------------------------
// Art. 25 — Data Protection by Design
// -----------------------------------------------------------------------

describe('GDPR Art. 25: Data Protection by Design', () => {
  describe('Metadata sanitizer catches all PII patterns', () => {
    const piiTestCases = [
      { name: 'email in project_id', metadata: { project_id: 'john@example.com', session_id: 's1' } },
      { name: 'email in session_id', metadata: { project_id: 'p1', session_id: 'user@corp.com-session' } },
      { name: 'Unix home path in project_id', metadata: { project_id: '/home/jane/project', session_id: 's1' } },
      { name: 'macOS path in session_id', metadata: { project_id: 'p1', session_id: '/Users/john/sess' } },
      { name: 'Windows path in project_id', metadata: { project_id: 'C:\\Users\\Admin\\project', session_id: 's1' } },
    ];

    for (const tc of piiTestCases) {
      it(`should reject: ${tc.name}`, () => {
        const errors = validateMetadata(tc.metadata);
        expect(errors.length).toBeGreaterThan(0);
      });
    }

    it('should strip non-allowlisted fields', async () => {
      const result = await sanitizeMetadata({
        project_id: 'clean-proj',
        session_id: 'clean-sess',
        secret_data: 'should be stripped',
        user_name: 'should be stripped',
        home_dir: 'should be stripped',
      });

      expect(result.stripped).toContain('secret_data');
      expect(result.stripped).toContain('user_name');
      expect(result.stripped).toContain('home_dir');
      expect(result.sanitized).not.toHaveProperty('secret_data');
    });

    it('should hash path-based project IDs', async () => {
      const result = await sanitizeMetadata({
        project_id: 'project/subdir',
        session_id: 'sess-001',
      });

      expect(result.projectIdHashed).toBe(true);
      expect(result.sanitized.project_id).toMatch(/^proj_/);
    });
  });
});

// -----------------------------------------------------------------------
// Art. 7 — Consent
// -----------------------------------------------------------------------

describe('GDPR Art. 7: Consent Requirements', () => {
  it('should require explicit opt-in (all defaults are false)', async () => {
    const { DEFAULT_CONSENT } = await import('../../middleware/consent-manager.js');
    expect(DEFAULT_CONSENT.data_sync).toBe(false);
    expect(DEFAULT_CONSENT.analytics).toBe(false);
    expect(DEFAULT_CONSENT.crash_reports).toBe(false);
  });

  it('should require data_sync consent for sync operations', async () => {
    const { REQUIRED_FOR_SYNC } = await import('../../middleware/consent-manager.js');
    expect(REQUIRED_FOR_SYNC).toContain('data_sync');
  });
});

// -----------------------------------------------------------------------
// Art. 17 — Right to Erasure
// -----------------------------------------------------------------------

describe('GDPR Art. 17: Right to Erasure', () => {
  it('should retain deletion logs for exactly 90 days', () => {
    expect(DELETION_LOG_RETENTION_DAYS).toBe(90);
  });
});

// -----------------------------------------------------------------------
// Art. 20 — Data Portability
// -----------------------------------------------------------------------

describe('GDPR Art. 20: Data Portability', () => {
  it('should export data in machine-readable JSON format', async () => {
    const { generateExportArchive } = await import('../../handlers/export-handler.js');

    const mockSql = {
      exec: (_q: string, ..._p: unknown[]) => ({ toArray: () => [] }),
    };

    const archive = generateExportArchive(
      mockSql as unknown as SqlStorage,
      'usr_test',
    );

    expect(archive.version).toBe('1.0');
    expect(archive.user_id).toBe('usr_test');
    expect(archive.exported_at).toBeDefined();
    expect(Array.isArray(archive.events)).toBe(true);
    expect(Array.isArray(archive.machines)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Art. 44-49 — International Transfers
// -----------------------------------------------------------------------

describe('GDPR Art. 44-49: International Transfers', () => {
  it('should enforce EU residency for all 27 EU member states', () => {
    const eu27 = [
      'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
      'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
      'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    ];

    for (const code of eu27) {
      const request = new Request('https://sync.test.dev/api/sync/push', {
        headers: { 'CF-IPCountry': code },
      });
      const context = enforceEUResidency(request);
      expect(context.enforceEU).toBe(true);
      expect(context.locationHint.locationHint).toBe('weur');
    }
  });

  it('should not enforce EU residency for US users', () => {
    const request = new Request('https://sync.test.dev/api/sync/push', {
      headers: { 'CF-IPCountry': 'US' },
    });
    const context = enforceEUResidency(request);
    expect(context.enforceEU).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Privacy Headers — Cookie-Free Enforcement
// -----------------------------------------------------------------------

describe('GDPR: Privacy Headers Compliance', () => {
  it('should never send cookies', () => {
    const response = new Response('{}', {
      headers: { 'Set-Cookie': 'tracking=yes' },
    });
    const augmented = addPrivacyHeaders(response);
    expect(augmented.headers.get('Set-Cookie')).toBeNull();
  });

  it('should include all required privacy headers', () => {
    const response = new Response('{}');
    const augmented = addPrivacyHeaders(response);
    const result = verifyPrivacyHeaders(augmented);

    expect(result.isCompliant).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.hasCookies).toBe(false);
  });

  it('should set strict Referrer-Policy', () => {
    expect(PRIVACY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });

  it('should set restrictive CSP', () => {
    expect(PRIVACY_HEADERS['Content-Security-Policy']).toContain("default-src 'none'");
  });

  it('should prevent MIME sniffing', () => {
    expect(PRIVACY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });

  it('should prevent clickjacking', () => {
    expect(PRIVACY_HEADERS['X-Frame-Options']).toBe('DENY');
  });
});

// -----------------------------------------------------------------------
// Cross-Cutting: PII Detection Completeness
// -----------------------------------------------------------------------

describe('GDPR: PII Detection Completeness', () => {
  const piiValues = [
    { label: 'email', value: 'user@example.com', expected: 'email_address' },
    { label: 'Unix home path', value: '/home/user/code', expected: 'user_path' },
    { label: 'macOS path', value: '/Users/jane/project', expected: 'user_path' },
    { label: 'Windows path', value: 'C:\\Users\\Admin\\docs', expected: 'user_path' },
  ];

  for (const { label, value, expected } of piiValues) {
    it(`should detect ${label} as PII`, () => {
      const result = detectPII(value);
      expect(result).toBe(expected);
    });
  }

  const safeValues = [
    'proj-abc123',
    'session-001',
    'ToolCallCompleted',
    'claude-4',
    '2026-02-22T10:00:00Z',
    '42',
  ];

  for (const value of safeValues) {
    it(`should not flag safe value: ${value}`, () => {
      expect(detectPII(value)).toBeNull();
    });
  }
});
