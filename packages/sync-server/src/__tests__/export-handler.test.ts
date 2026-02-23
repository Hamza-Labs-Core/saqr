/**
 * Tests for Data Export Handler — Art. 20 data portability.
 *
 * Covers:
 * - Export archive generation with correct format
 * - Export with events, machines, and account data
 * - Export with empty data
 * - Export request handler response format
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateExportArchive,
  handleExportRequest,
  type ExportArchive,
} from '../handlers/export-handler.js';
import { createMockAuthCtx } from './helpers/mock-env.js';

// ---------------------------------------------------------------------------
// Mock SqlStorage for export tests
// ---------------------------------------------------------------------------

class MockExportSqlStorage {
  private tables: Record<string, unknown[]> = {
    account: [],
    events_meta: [],
    machines: [],
  };

  addAccount(account: Record<string, unknown>): void {
    this.tables.account.push(account);
  }

  addEvent(event: Record<string, unknown>): void {
    this.tables.events_meta.push(event);
  }

  addMachine(machine: Record<string, unknown>): void {
    this.tables.machines.push(machine);
  }

  exec(query: string, ..._params: unknown[]): { toArray: () => unknown[] } {
    const q = query.toLowerCase().trim();

    if (q.includes('from account')) {
      return { toArray: () => [...this.tables.account] };
    }
    if (q.includes('from events_meta')) {
      return { toArray: () => [...this.tables.events_meta] };
    }
    if (q.includes('from machines')) {
      return { toArray: () => [...this.tables.machines] };
    }

    return { toArray: () => [] };
  }
}

describe('Export Handler', () => {
  let sql: MockExportSqlStorage;

  beforeEach(() => {
    sql = new MockExportSqlStorage();
  });

  // -----------------------------------------------------------------------
  // generateExportArchive
  // -----------------------------------------------------------------------

  describe('generateExportArchive', () => {
    it('should return archive with correct version and format', () => {
      const archive = generateExportArchive(
        sql as unknown as SqlStorage,
        'usr_test123',
      );

      expect(archive.version).toBe('1.0');
      expect(archive.user_id).toBe('usr_test123');
      expect(archive.exported_at).toBeDefined();
      expect(new Date(archive.exported_at).getTime()).not.toBeNaN();
      expect(archive.events).toEqual([]);
      expect(archive.machines).toEqual([]);
      expect(archive.account).toBeNull();
    });

    it('should include account data when present', () => {
      sql.addAccount({
        user_id: 'usr_test123',
        email: 'test@example.com',
        tier: 'pro',
        created_at: '2026-01-01T00:00:00Z',
        storage_used_bytes: 1024,
      });

      const archive = generateExportArchive(
        sql as unknown as SqlStorage,
        'usr_test123',
      );

      expect(archive.account).not.toBeNull();
      expect(archive.account!.email).toBe('test@example.com');
      expect(archive.account!.tier).toBe('pro');
      expect(archive.account!.created_at).toBe('2026-01-01T00:00:00Z');
      expect(archive.account!.storage_used_bytes).toBe(1024);
    });

    it('should include all events', () => {
      sql.addEvent({
        id: 1,
        machine_id: 'mach_001',
        project_id: 'proj-abc',
        session_id: 'sess-001',
        sequence: 1,
        event_type: 'ToolCallCompleted',
        timestamp: '2026-02-22T10:00:00Z',
        encrypted_size_bytes: 512,
        token_count_input: 100,
        token_count_output: 200,
        model: 'claude-4',
        tool_name: 'read_file',
        synced_at: '2026-02-22T10:00:01Z',
      });

      sql.addEvent({
        id: 2,
        machine_id: 'mach_001',
        project_id: 'proj-abc',
        session_id: 'sess-001',
        sequence: 2,
        event_type: 'SessionEnd',
        timestamp: '2026-02-22T10:05:00Z',
        encrypted_size_bytes: 128,
        token_count_input: 0,
        token_count_output: 0,
        model: null,
        tool_name: null,
        synced_at: '2026-02-22T10:05:01Z',
      });

      const archive = generateExportArchive(
        sql as unknown as SqlStorage,
        'usr_test123',
      );

      expect(archive.events).toHaveLength(2);
      expect(archive.events[0].event_id).toBe(1);
      expect(archive.events[0].machine_id).toBe('mach_001');
      expect(archive.events[0].project_id).toBe('proj-abc');
      expect(archive.events[0].event_type).toBe('ToolCallCompleted');
      expect(archive.events[0].model).toBe('claude-4');
      expect(archive.events[1].event_id).toBe(2);
      expect(archive.events[1].model).toBeNull();
    });

    it('should include all machines', () => {
      sql.addMachine({
        machine_id: 'mach_001',
        name: 'MacBook Pro',
        os: 'darwin',
        arch: 'arm64',
        hostname: 'localhost',
        registered_at: '2026-01-15T00:00:00Z',
        last_sync_at: '2026-02-22T10:00:00Z',
        agent_version: '1.0.0',
      });

      sql.addMachine({
        machine_id: 'mach_002',
        name: 'Linux Server',
        os: 'linux',
        arch: 'x64',
        hostname: 'server1',
        registered_at: '2026-02-01T00:00:00Z',
        last_sync_at: null,
        agent_version: null,
      });

      const archive = generateExportArchive(
        sql as unknown as SqlStorage,
        'usr_test123',
      );

      expect(archive.machines).toHaveLength(2);
      expect(archive.machines[0].machine_id).toBe('mach_001');
      expect(archive.machines[0].name).toBe('MacBook Pro');
      expect(archive.machines[1].machine_id).toBe('mach_002');
      expect(archive.machines[1].last_sync_at).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // handleExportRequest
  // -----------------------------------------------------------------------

  describe('handleExportRequest', () => {
    it('should return 200 with export archive', async () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_export_test' });

      sql.addAccount({
        user_id: 'usr_export_test',
        email: 'export@example.com',
        tier: 'free',
        created_at: '2026-01-01T00:00:00Z',
        storage_used_bytes: 0,
      });

      const response = handleExportRequest(
        sql as unknown as SqlStorage,
        authCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.export_id).toBeDefined();
      expect(body.status).toBe('completed');
      expect(body.download_url).toBeDefined();
      expect(body.expires_at).toBeDefined();
      expect(body.archive).toBeDefined();

      const archive = body.archive as ExportArchive;
      expect(archive.version).toBe('1.0');
      expect(archive.user_id).toBe('usr_export_test');
    });

    it('should include full archive in response', async () => {
      const authCtx = createMockAuthCtx({ userId: 'usr_full_export' });

      sql.addEvent({
        id: 1,
        machine_id: 'mach_001',
        project_id: 'proj-1',
        session_id: 'sess-1',
        sequence: 1,
        event_type: 'ToolCallCompleted',
        timestamp: '2026-02-22T10:00:00Z',
        encrypted_size_bytes: 256,
        token_count_input: 50,
        token_count_output: 100,
        model: 'claude-4',
        tool_name: 'bash',
        synced_at: '2026-02-22T10:00:01Z',
      });

      const response = handleExportRequest(
        sql as unknown as SqlStorage,
        authCtx,
      );

      const body = await response.json() as Record<string, unknown>;
      const archive = body.archive as ExportArchive;
      expect(archive.events).toHaveLength(1);
      expect(archive.events[0].event_type).toBe('ToolCallCompleted');
    });
  });
});
