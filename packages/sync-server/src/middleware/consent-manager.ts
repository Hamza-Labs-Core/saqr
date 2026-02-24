/**
 * Consent Manager — Art. 7 GDPR consent tracking.
 *
 * Tracks user consent with version numbering. Consent is required
 * for data_sync, analytics, and crash_reports. The middleware blocks
 * sync requests when required consent (data_sync) is missing.
 */

import { jsonResponse, errorResponse } from '../helpers.js';
import type { AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Consent Types
// ---------------------------------------------------------------------------

export type ConsentCategory = 'data_sync' | 'analytics' | 'crash_reports' | 'rule_telemetry';

export interface ConsentPreferences {
  data_sync: boolean;
  analytics: boolean;
  crash_reports: boolean;
  rule_telemetry: boolean;
}

export interface ConsentRecord {
  user_id: string;
  preferences: ConsentPreferences;
  version: number;
  updated_at: string;
  ip_country?: string;
}

/** Default consent (all false — opt-in required) */
export const DEFAULT_CONSENT: ConsentPreferences = {
  data_sync: false,
  analytics: false,
  crash_reports: false,
  rule_telemetry: false,
};

/** Categories that must be consented to for sync operations */
export const REQUIRED_FOR_SYNC: ConsentCategory[] = ['data_sync'];

// Current consent policy version
export const CONSENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Consent Manager Class
// ---------------------------------------------------------------------------

export class ConsentManager {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS consent (
        user_id     TEXT PRIMARY KEY,
        data_sync   INTEGER DEFAULT 0,
        analytics   INTEGER DEFAULT 0,
        crash_reports INTEGER DEFAULT 0,
        rule_telemetry INTEGER DEFAULT 0,
        version     INTEGER DEFAULT 1,
        updated_at  TEXT NOT NULL,
        ip_country  TEXT
      )
    `);
  }

  /**
   * Get the current consent state for a user.
   */
  getConsent(userId: string): ConsentRecord | null {
    const rows = this.sql.exec(
      'SELECT * FROM consent WHERE user_id = ?',
      userId,
    ).toArray();

    if (rows.length === 0) return null;

    const row = rows[0] as unknown as {
      user_id: string;
      data_sync: number;
      analytics: number;
      crash_reports: number;
      rule_telemetry: number;
      version: number;
      updated_at: string;
      ip_country: string | null;
    };

    return {
      user_id: row.user_id,
      preferences: {
        data_sync: row.data_sync === 1,
        analytics: row.analytics === 1,
        crash_reports: row.crash_reports === 1,
        rule_telemetry: row.rule_telemetry === 1,
      },
      version: row.version,
      updated_at: row.updated_at,
      ip_country: row.ip_country || undefined,
    };
  }

  /**
   * Update consent preferences for a user.
   */
  updateConsent(
    userId: string,
    preferences: Partial<ConsentPreferences>,
    ipCountry?: string,
  ): ConsentRecord {
    const now = new Date().toISOString();
    const existing = this.getConsent(userId);

    const merged: ConsentPreferences = {
      ...(existing?.preferences || DEFAULT_CONSENT),
      ...preferences,
    };

    const newVersion = (existing?.version || 0) + 1;

    this.sql.exec(
      `INSERT INTO consent (user_id, data_sync, analytics, crash_reports, rule_telemetry, version, updated_at, ip_country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         data_sync = excluded.data_sync,
         analytics = excluded.analytics,
         crash_reports = excluded.crash_reports,
         rule_telemetry = excluded.rule_telemetry,
         version = excluded.version,
         updated_at = excluded.updated_at,
         ip_country = excluded.ip_country`,
      userId,
      merged.data_sync ? 1 : 0,
      merged.analytics ? 1 : 0,
      merged.crash_reports ? 1 : 0,
      merged.rule_telemetry ? 1 : 0,
      newVersion,
      now,
      ipCountry || null,
    );

    return {
      user_id: userId,
      preferences: merged,
      version: newVersion,
      updated_at: now,
      ip_country: ipCountry,
    };
  }

  /**
   * Check if a user has all required consent for sync operations.
   */
  hasRequiredConsent(userId: string): { allowed: boolean; missing: ConsentCategory[] } {
    const record = this.getConsent(userId);
    if (!record) {
      return { allowed: false, missing: [...REQUIRED_FOR_SYNC] };
    }

    const missing: ConsentCategory[] = [];
    for (const category of REQUIRED_FOR_SYNC) {
      if (!record.preferences[category]) {
        missing.push(category);
      }
    }

    return { allowed: missing.length === 0, missing };
  }
}

// ---------------------------------------------------------------------------
// Consent Middleware
// ---------------------------------------------------------------------------

/**
 * Middleware that blocks sync requests when required consent is missing.
 * Returns null if consent is valid, or a Response to block the request.
 */
export function consentMiddleware(
  consentManager: ConsentManager,
  authCtx: AuthContext,
  pathname: string,
): Response | null {
  // Only enforce consent for sync endpoints
  if (!pathname.startsWith('/api/sync/')) {
    return null;
  }

  const { allowed, missing } = consentManager.hasRequiredConsent(authCtx.userId);

  if (!allowed) {
    return errorResponse(
      403,
      'consent_required',
      `Missing required consent: ${missing.join(', ')}. Please update consent at POST /api/consent.`,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Consent Request Handlers
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/consent — get current consent state.
 */
export function handleGetConsent(
  consentManager: ConsentManager,
  authCtx: AuthContext,
): Response {
  const record = consentManager.getConsent(authCtx.userId);

  if (!record) {
    return jsonResponse(200, {
      user_id: authCtx.userId,
      preferences: DEFAULT_CONSENT,
      version: 0,
      consent_required: true,
    });
  }

  return jsonResponse(200, {
    user_id: record.user_id,
    preferences: record.preferences,
    version: record.version,
    updated_at: record.updated_at,
    consent_required: false,
  });
}

/**
 * Handle POST /api/consent — update consent preferences.
 */
export async function handleUpdateConsent(
  request: Request,
  consentManager: ConsentManager,
  authCtx: AuthContext,
): Promise<Response> {
  let body: { preferences?: Partial<ConsentPreferences> };
  try {
    body = await request.json() as { preferences?: Partial<ConsentPreferences> };
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  if (!body.preferences || typeof body.preferences !== 'object') {
    return errorResponse(
      400,
      'invalid_preferences',
      'Body must contain a "preferences" object with consent categories',
    );
  }

  // Validate categories
  const validCategories: ConsentCategory[] = ['data_sync', 'analytics', 'crash_reports', 'rule_telemetry'];
  for (const key of Object.keys(body.preferences)) {
    if (!validCategories.includes(key as ConsentCategory)) {
      return errorResponse(
        400,
        'invalid_category',
        `Unknown consent category: "${key}". Valid categories: ${validCategories.join(', ')}`,
      );
    }
  }

  const ipCountry = request.headers.get('CF-IPCountry') || undefined;
  const record = consentManager.updateConsent(
    authCtx.userId,
    body.preferences,
    ipCountry,
  );

  return jsonResponse(200, {
    user_id: record.user_id,
    preferences: record.preferences,
    version: record.version,
    updated_at: record.updated_at,
  });
}
