/**
 * Tests for Deletion Audit Log — GDPR compliance tracking.
 *
 * Covers:
 * - Logging deletion requests
 * - Tracking deletion status transitions
 * - Deletion history retrieval
 * - Log purging after retention period
 * - Convenience functions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeletionAuditLog,
  logDeletion,
  getDeletionHistory,
  handleGetDeletionHistory,
  DELETION_LOG_RETENTION_DAYS,
  type DeletionStatus,
} from '../handlers/deletion-audit.js';
import { createMockAuthCtx } from './helpers/mock-env.js';

// ---------------------------------------------------------------------------
// Mock SqlStorage for deletion audit tests
// ---------------------------------------------------------------------------

class MockDeletionSqlStorage {
  private rows: Record<string, Record<string, unknown>> = {};
  public execCalls: string[] = [];

  exec(query: string, ...params: unknown[]): { toArray: () => unknown[] } {
    this.execCalls.push(query);
    const q = query.toLowerCase().trim();

    // Handle ALTER TABLE (ignore silently)
    if (q.startsWith('alter table')) {
      throw new Error('Column already exists');
    }

    // INSERT into deletion_log
    if (q.includes('insert into deletion_log')) {
      const deletionId = params[0] as string;
      this.rows[deletionId] = {
        deletion_id: deletionId,
        user_id: params[1],
        status: 'initiated',
        initiated_at: params[2],
        completed_at: null,
        details: params[3] || null,
      };
      return { toArray: () => [] };
    }

    // UPDATE deletion_log status
    if (q.includes('update deletion_log set status')) {
      if (q.includes('completed_at')) {
        // status + completed_at update
        const status = params[0] as string;
        const completedAt = params[1] as string;
        const deletionId = params[2] as string;
        if (this.rows[deletionId]) {
          this.rows[deletionId].status = status;
          this.rows[deletionId].completed_at = completedAt;
        }
      } else {
        // status only update
        const status = params[0] as string;
        const deletionId = params[1] as string;
        if (this.rows[deletionId]) {
          this.rows[deletionId].status = status;
        }
      }
      return { toArray: () => [] };
    }

    // SELECT by user_id
    if (q.includes('select') && q.includes('where user_id')) {
      const userId = params[0] as string;
      const matches = Object.values(this.rows).filter(
        (r) => r.user_id === userId,
      );
      return { toArray: () => matches };
    }

    // SELECT by deletion_id
    if (q.includes('select') && q.includes('where deletion_id')) {
      const deletionId = params[0] as string;
      const row = this.rows[deletionId];
      return { toArray: () => (row ? [row] : []) };
    }

    // SELECT COUNT for purge check
    if (q.includes('count') && q.includes('initiated_at <')) {
      const cutoff = params[0] as string;
      const count = Object.values(this.rows).filter(
        (r) => (r.initiated_at as string) < cutoff,
      ).length;
      return { toArray: () => [{ cnt: count }] };
    }

    // DELETE for purge
    if (q.includes('delete from deletion_log') && q.includes('initiated_at <')) {
      const cutoff = params[0] as string;
      const toDelete = Object.entries(this.rows).filter(
        ([_, r]) => (r.initiated_at as string) < cutoff,
      );
      for (const [key] of toDelete) {
        delete this.rows[key];
      }
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }
}

describe('Deletion Audit Log', () => {
  let sql: MockDeletionSqlStorage;
  let auditLog: DeletionAuditLog;

  beforeEach(() => {
    sql = new MockDeletionSqlStorage();
    auditLog = new DeletionAuditLog(sql as unknown as SqlStorage);
  });

  // -----------------------------------------------------------------------
  // logDeletion
  // -----------------------------------------------------------------------

  describe('logDeletion', () => {
    it('should create a deletion record with initiated status', () => {
      const record = auditLog.logDeletion('usr_test');

      expect(record.deletion_id).toMatch(/^del_/);
      expect(record.user_id).toBe('usr_test');
      expect(record.status).toBe('initiated');
      expect(record.initiated_at).toBeDefined();
      expect(record.completed_at).toBeNull();
    });

    it('should include details when provided', () => {
      const record = auditLog.logDeletion('usr_test', 'User requested via settings');

      expect(record.details).toBe('User requested via settings');
    });

    it('should generate unique deletion IDs', () => {
      const record1 = auditLog.logDeletion('usr_test');
      const record2 = auditLog.logDeletion('usr_test');

      expect(record1.deletion_id).not.toBe(record2.deletion_id);
    });
  });

  // -----------------------------------------------------------------------
  // updateStatus
  // -----------------------------------------------------------------------

  describe('updateStatus', () => {
    it('should update status to processing', () => {
      const record = auditLog.logDeletion('usr_test');
      auditLog.updateStatus(record.deletion_id, 'processing');

      const updated = auditLog.getDeletion(record.deletion_id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('processing');
    });

    it('should set completed_at when status is completed', () => {
      const record = auditLog.logDeletion('usr_test');
      auditLog.updateStatus(record.deletion_id, 'completed');

      const updated = auditLog.getDeletion(record.deletion_id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.completed_at).not.toBeNull();
    });

    it('should set completed_at when status is failed', () => {
      const record = auditLog.logDeletion('usr_test');
      auditLog.updateStatus(record.deletion_id, 'failed');

      const updated = auditLog.getDeletion(record.deletion_id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('failed');
      expect(updated!.completed_at).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getDeletionHistory
  // -----------------------------------------------------------------------

  describe('getDeletionHistory', () => {
    it('should return empty array when no deletions exist', () => {
      const history = auditLog.getDeletionHistory('usr_new');
      expect(history).toEqual([]);
    });

    it('should return all deletions for a user', () => {
      auditLog.logDeletion('usr_test');
      auditLog.logDeletion('usr_test');
      auditLog.logDeletion('usr_other');

      const history = auditLog.getDeletionHistory('usr_test');
      expect(history).toHaveLength(2);
      expect(history.every((r) => r.user_id === 'usr_test')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getDeletion
  // -----------------------------------------------------------------------

  describe('getDeletion', () => {
    it('should return null for non-existent deletion', () => {
      const record = auditLog.getDeletion('del_nonexistent');
      expect(record).toBeNull();
    });

    it('should return the deletion record by ID', () => {
      const created = auditLog.logDeletion('usr_test');
      const record = auditLog.getDeletion(created.deletion_id);

      expect(record).not.toBeNull();
      expect(record!.deletion_id).toBe(created.deletion_id);
      expect(record!.user_id).toBe('usr_test');
    });
  });

  // -----------------------------------------------------------------------
  // purgeExpiredLogs
  // -----------------------------------------------------------------------

  describe('purgeExpiredLogs', () => {
    it('should purge logs older than retention period', () => {
      // Create old deletion record (simulate 100 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      const oldDateStr = oldDate.toISOString();

      // Manually insert old record
      sql.exec(
        'INSERT INTO deletion_log (deletion_id, user_id, status, initiated_at, details) VALUES (?, ?, ?, ?, ?)',
        'del_old_001',
        'usr_test',
        oldDateStr,
        null,
      );
      // Make it old
      sql.rows = sql.rows || {};
      (sql as any).rows['del_old_001'] = {
        deletion_id: 'del_old_001',
        user_id: 'usr_test',
        status: 'completed',
        initiated_at: oldDateStr,
        completed_at: oldDateStr,
        details: null,
      };

      // Create recent record
      auditLog.logDeletion('usr_test');

      const purged = auditLog.purgeExpiredLogs();
      expect(purged).toBe(1);
    });

    it('should not purge recent logs', () => {
      auditLog.logDeletion('usr_test');
      auditLog.logDeletion('usr_test');

      const purged = auditLog.purgeExpiredLogs();
      expect(purged).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // DELETION_LOG_RETENTION_DAYS
  // -----------------------------------------------------------------------

  describe('DELETION_LOG_RETENTION_DAYS', () => {
    it('should be 90 days', () => {
      expect(DELETION_LOG_RETENTION_DAYS).toBe(90);
    });
  });

  // -----------------------------------------------------------------------
  // Convenience Functions
  // -----------------------------------------------------------------------

  describe('convenience functions', () => {
    it('logDeletion should create a record', () => {
      const record = logDeletion(
        sql as unknown as SqlStorage,
        'usr_convenience',
        'test deletion',
      );
      expect(record.user_id).toBe('usr_convenience');
    });

    it('getDeletionHistory should return records', () => {
      logDeletion(sql as unknown as SqlStorage, 'usr_history');
      const history = getDeletionHistory(
        sql as unknown as SqlStorage,
        'usr_history',
      );
      expect(history).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // handleGetDeletionHistory
  // -----------------------------------------------------------------------

  describe('handleGetDeletionHistory', () => {
    it('should return 200 with deletion history', async () => {
      auditLog.logDeletion('usr_handler');

      const authCtx = createMockAuthCtx({ userId: 'usr_handler' });
      const response = handleGetDeletionHistory(
        sql as unknown as SqlStorage,
        authCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.user_id).toBe('usr_handler');
      expect(body.total).toBe(1);
      expect(Array.isArray(body.deletions)).toBe(true);
    });

    it('should return empty history for new users', async () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_new' });
      const response = handleGetDeletionHistory(
        sql as unknown as SqlStorage,
        authCtx,
      );

      const body = await response.json() as Record<string, unknown>;
      expect(body.total).toBe(0);
      expect(body.deletions).toEqual([]);
    });
  });
});
