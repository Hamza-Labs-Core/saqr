/**
 * Deletion Audit Log — GDPR Art. 17 compliance tracking.
 *
 * Logs all deletion requests with timestamps and tracks deletion status.
 * Deletion logs are retained for 90 days then auto-purged (minimum needed
 * to demonstrate compliance to auditors).
 */

import { jsonResponse, errorResponse, generateId } from '../helpers.js';
import type { AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeletionStatus = 'initiated' | 'processing' | 'completed' | 'failed';

export interface DeletionRecord {
  deletion_id: string;
  user_id: string;
  status: DeletionStatus;
  initiated_at: string;
  completed_at: string | null;
  details?: string;
}

/** Retention period for deletion logs: 90 days */
export const DELETION_LOG_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Deletion Audit Log
// ---------------------------------------------------------------------------

export class DeletionAuditLog {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    // Schema is already created in UserSyncDO.initSchema()
    // but we add details column if not present
    try {
      this.sql.exec(`
        ALTER TABLE deletion_log ADD COLUMN details TEXT
      `);
    } catch {
      // Column already exists — ignore
    }
  }

  /**
   * Log a new deletion request.
   */
  logDeletion(userId: string, details?: string): DeletionRecord {
    const now = new Date().toISOString();
    const deletionId = `del_${generateId(8)}`;

    this.sql.exec(
      `INSERT INTO deletion_log (deletion_id, user_id, status, initiated_at, details)
       VALUES (?, ?, 'initiated', ?, ?)`,
      deletionId,
      userId,
      now,
      details || null,
    );

    return {
      deletion_id: deletionId,
      user_id: userId,
      status: 'initiated',
      initiated_at: now,
      completed_at: null,
      details,
    };
  }

  /**
   * Update the status of a deletion record.
   */
  updateStatus(deletionId: string, status: DeletionStatus): void {
    const now = new Date().toISOString();

    if (status === 'completed' || status === 'failed') {
      this.sql.exec(
        `UPDATE deletion_log SET status = ?, completed_at = ? WHERE deletion_id = ?`,
        status,
        now,
        deletionId,
      );
    } else {
      this.sql.exec(
        `UPDATE deletion_log SET status = ? WHERE deletion_id = ?`,
        status,
        deletionId,
      );
    }
  }

  /**
   * Get the full deletion history for a user.
   */
  getDeletionHistory(userId: string): DeletionRecord[] {
    const rows = this.sql.exec(
      'SELECT * FROM deletion_log WHERE user_id = ? ORDER BY initiated_at DESC',
      userId,
    ).toArray();

    return rows.map((row) => {
      const r = row as unknown as {
        deletion_id: string;
        user_id: string;
        status: DeletionStatus;
        initiated_at: string;
        completed_at: string | null;
        details: string | null;
      };
      return {
        deletion_id: r.deletion_id,
        user_id: r.user_id,
        status: r.status,
        initiated_at: r.initiated_at,
        completed_at: r.completed_at,
        details: r.details || undefined,
      };
    });
  }

  /**
   * Get a specific deletion record.
   */
  getDeletion(deletionId: string): DeletionRecord | null {
    const rows = this.sql.exec(
      'SELECT * FROM deletion_log WHERE deletion_id = ?',
      deletionId,
    ).toArray();

    if (rows.length === 0) return null;

    const r = rows[0] as unknown as {
      deletion_id: string;
      user_id: string;
      status: DeletionStatus;
      initiated_at: string;
      completed_at: string | null;
      details: string | null;
    };

    return {
      deletion_id: r.deletion_id,
      user_id: r.user_id,
      status: r.status,
      initiated_at: r.initiated_at,
      completed_at: r.completed_at,
      details: r.details || undefined,
    };
  }

  /**
   * Purge deletion logs older than the retention period (90 days).
   * This should be called periodically (e.g., via DO alarm).
   */
  purgeExpiredLogs(): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DELETION_LOG_RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString();

    // Count before purge
    const countRows = this.sql.exec(
      'SELECT COUNT(*) as cnt FROM deletion_log WHERE initiated_at < ?',
      cutoffStr,
    ).toArray();
    const count = (countRows[0] as unknown as { cnt: number })?.cnt || 0;

    // Purge
    this.sql.exec(
      'DELETE FROM deletion_log WHERE initiated_at < ?',
      cutoffStr,
    );

    return count;
  }
}

// ---------------------------------------------------------------------------
// Convenience Functions
// ---------------------------------------------------------------------------

/**
 * Log a deletion event. Convenience wrapper around DeletionAuditLog.
 */
export function logDeletion(
  sql: SqlStorage,
  userId: string,
  details?: string,
): DeletionRecord {
  const log = new DeletionAuditLog(sql);
  return log.logDeletion(userId, details);
}

/**
 * Get deletion history. Convenience wrapper around DeletionAuditLog.
 */
export function getDeletionHistory(
  sql: SqlStorage,
  userId: string,
): DeletionRecord[] {
  const log = new DeletionAuditLog(sql);
  return log.getDeletionHistory(userId);
}

// ---------------------------------------------------------------------------
// Request Handler
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/account/deletions — get deletion audit history.
 */
export function handleGetDeletionHistory(
  sql: SqlStorage,
  authCtx: AuthContext,
): Response {
  const history = getDeletionHistory(sql, authCtx.userId);

  return jsonResponse(200, {
    user_id: authCtx.userId,
    deletions: history,
    total: history.length,
  });
}
