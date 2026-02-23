/**
 * Tests for Consent Manager — Art. 7 GDPR consent tracking.
 *
 * Covers:
 * - Consent tracking with version numbering
 * - Required consent enforcement for sync endpoints
 * - Consent CRUD operations
 * - Consent middleware blocking
 * - Default consent state
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConsentManager,
  consentMiddleware,
  handleGetConsent,
  handleUpdateConsent,
  DEFAULT_CONSENT,
  REQUIRED_FOR_SYNC,
  type ConsentPreferences,
} from '../middleware/consent-manager.js';
import { createMockAuthCtx } from './helpers/mock-env.js';

// ---------------------------------------------------------------------------
// Mock SqlStorage for consent tests
// ---------------------------------------------------------------------------

class MockConsentSqlStorage {
  private rows: Record<string, Record<string, unknown>> = {};
  public execCalls: string[] = [];

  exec(query: string, ...params: unknown[]): { toArray: () => unknown[] } {
    this.execCalls.push(query);
    const q = query.toLowerCase().trim();

    if (q.startsWith('create table')) {
      return { toArray: () => [] };
    }

    if (q.includes('select') && q.includes('from consent')) {
      const userId = params[0] as string;
      const row = this.rows[userId];
      return { toArray: () => (row ? [row] : []) };
    }

    if (q.includes('insert into consent')) {
      const userId = params[0] as string;
      this.rows[userId] = {
        user_id: userId,
        data_sync: params[1],
        analytics: params[2],
        crash_reports: params[3],
        version: params[4],
        updated_at: params[5],
        ip_country: params[6],
      };
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }
}

describe('Consent Manager', () => {
  let sql: MockConsentSqlStorage;
  let manager: ConsentManager;

  beforeEach(() => {
    sql = new MockConsentSqlStorage();
    manager = new ConsentManager(sql as unknown as SqlStorage);
  });

  // -----------------------------------------------------------------------
  // Schema Initialization
  // -----------------------------------------------------------------------

  describe('initialization', () => {
    it('should create consent table on construction', () => {
      expect(sql.execCalls.some(q => q.toLowerCase().includes('create table'))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getConsent
  // -----------------------------------------------------------------------

  describe('getConsent', () => {
    it('should return null when no consent record exists', () => {
      const record = manager.getConsent('usr_new');
      expect(record).toBeNull();
    });

    it('should return consent record when it exists', () => {
      manager.updateConsent('usr_test', { data_sync: true });

      const record = manager.getConsent('usr_test');
      expect(record).not.toBeNull();
      expect(record!.user_id).toBe('usr_test');
      expect(record!.preferences.data_sync).toBe(true);
      expect(record!.preferences.analytics).toBe(false);
      expect(record!.preferences.crash_reports).toBe(false);
      expect(record!.version).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // updateConsent
  // -----------------------------------------------------------------------

  describe('updateConsent', () => {
    it('should create consent record with version 1', () => {
      const record = manager.updateConsent('usr_test', {
        data_sync: true,
        analytics: true,
      });

      expect(record.version).toBe(1);
      expect(record.preferences.data_sync).toBe(true);
      expect(record.preferences.analytics).toBe(true);
      expect(record.preferences.crash_reports).toBe(false);
    });

    it('should increment version on update', () => {
      manager.updateConsent('usr_test', { data_sync: true });
      const record = manager.updateConsent('usr_test', { analytics: true });

      expect(record.version).toBe(2);
      expect(record.preferences.data_sync).toBe(true);
      expect(record.preferences.analytics).toBe(true);
    });

    it('should merge with existing preferences', () => {
      manager.updateConsent('usr_test', { data_sync: true, analytics: false });
      const record = manager.updateConsent('usr_test', { analytics: true });

      expect(record.preferences.data_sync).toBe(true);
      expect(record.preferences.analytics).toBe(true);
    });

    it('should record IP country when provided', () => {
      const record = manager.updateConsent('usr_test', { data_sync: true }, 'DE');
      expect(record.ip_country).toBe('DE');
    });

    it('should set updated_at timestamp', () => {
      const record = manager.updateConsent('usr_test', { data_sync: true });
      expect(record.updated_at).toBeDefined();
      expect(new Date(record.updated_at).getTime()).not.toBeNaN();
    });
  });

  // -----------------------------------------------------------------------
  // hasRequiredConsent
  // -----------------------------------------------------------------------

  describe('hasRequiredConsent', () => {
    it('should return not allowed when no consent exists', () => {
      const { allowed, missing } = manager.hasRequiredConsent('usr_new');
      expect(allowed).toBe(false);
      expect(missing).toContain('data_sync');
    });

    it('should return not allowed when data_sync is not consented', () => {
      manager.updateConsent('usr_test', { analytics: true, crash_reports: true });
      const { allowed, missing } = manager.hasRequiredConsent('usr_test');
      expect(allowed).toBe(false);
      expect(missing).toContain('data_sync');
    });

    it('should return allowed when data_sync is consented', () => {
      manager.updateConsent('usr_test', { data_sync: true });
      const { allowed, missing } = manager.hasRequiredConsent('usr_test');
      expect(allowed).toBe(true);
      expect(missing).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // consentMiddleware
  // -----------------------------------------------------------------------

  describe('consentMiddleware', () => {
    it('should block sync requests when consent is missing', () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_no_consent' });
      const response = consentMiddleware(manager, authCtx, '/api/sync/push');

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
    });

    it('should allow sync requests when consent is granted', () => {
      manager.updateConsent('usr_consented', { data_sync: true });
      const authCtx = createMockAuthCtx({ userId: 'usr_consented' });
      const response = consentMiddleware(manager, authCtx, '/api/sync/push');

      expect(response).toBeNull();
    });

    it('should not block non-sync endpoints', () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_no_consent' });
      const response = consentMiddleware(manager, authCtx, '/api/account');

      expect(response).toBeNull();
    });

    it('should not block consent endpoint itself', () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_no_consent' });
      const response = consentMiddleware(manager, authCtx, '/api/consent');

      expect(response).toBeNull();
    });

    it('should include missing categories in error response', async () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_missing' });
      const response = consentMiddleware(manager, authCtx, '/api/sync/pull');

      expect(response).not.toBeNull();
      const body = await response!.json() as Record<string, unknown>;
      expect(body.error).toBe('consent_required');
      expect(body.message).toContain('data_sync');
    });
  });

  // -----------------------------------------------------------------------
  // handleGetConsent
  // -----------------------------------------------------------------------

  describe('handleGetConsent', () => {
    it('should return default consent when no record exists', async () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_new' });
      const response = handleGetConsent(manager, authCtx);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.consent_required).toBe(true);
      expect(body.version).toBe(0);
      const prefs = body.preferences as ConsentPreferences;
      expect(prefs.data_sync).toBe(false);
      expect(prefs.analytics).toBe(false);
      expect(prefs.crash_reports).toBe(false);
    });

    it('should return existing consent record', async () => {
      manager.updateConsent('usr_existing', { data_sync: true, analytics: true });
      const authCtx = createMockAuthCtx({ userId: 'usr_existing' });
      const response = handleGetConsent(manager, authCtx);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.consent_required).toBe(false);
      expect(body.version).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // handleUpdateConsent
  // -----------------------------------------------------------------------

  describe('handleUpdateConsent', () => {
    it('should update consent preferences', async () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_update' });
      const request = new Request('https://sync.test.dev/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: { data_sync: true, analytics: true },
        }),
      });

      const response = await handleUpdateConsent(request, manager, authCtx);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.user_id).toBe('usr_update');
      expect(body.version).toBe(1);
      const prefs = body.preferences as ConsentPreferences;
      expect(prefs.data_sync).toBe(true);
      expect(prefs.analytics).toBe(true);
    });

    it('should reject invalid JSON body', async () => {
      const authCtx = createMockAuthCtx();
      const request = new Request('https://sync.test.dev/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      const response = await handleUpdateConsent(request, manager, authCtx);
      expect(response.status).toBe(400);
    });

    it('should reject body without preferences object', async () => {
      const authCtx = createMockAuthCtx();
      const request = new Request('https://sync.test.dev/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_sync: true }),
      });

      const response = await handleUpdateConsent(request, manager, authCtx);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_preferences');
    });

    it('should reject invalid consent categories', async () => {
      const authCtx = createMockAuthCtx();
      const request = new Request('https://sync.test.dev/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: { data_sync: true, tracking: true },
        }),
      });

      const response = await handleUpdateConsent(request, manager, authCtx);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_category');
    });
  });

  // -----------------------------------------------------------------------
  // Default Consent
  // -----------------------------------------------------------------------

  describe('DEFAULT_CONSENT', () => {
    it('should default all categories to false (opt-in)', () => {
      expect(DEFAULT_CONSENT.data_sync).toBe(false);
      expect(DEFAULT_CONSENT.analytics).toBe(false);
      expect(DEFAULT_CONSENT.crash_reports).toBe(false);
    });
  });

  describe('REQUIRED_FOR_SYNC', () => {
    it('should require data_sync for sync operations', () => {
      expect(REQUIRED_FOR_SYNC).toContain('data_sync');
    });
  });
});
