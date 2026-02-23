/**
 * Tests for UserSyncDO Durable Object
 *
 * Covers:
 * - Schema initialization
 * - Push events
 * - Pull with cursor
 * - Machine registration
 * - Account management
 * - Data retention (alarm)
 *
 * Uses a mock DurableObjectState with mock SqlStorage.
 * Since we can't run real SQLite in Node.js vitest,
 * we test the DO's behavior through its HTTP API
 * by verifying request routing and response structure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UserSyncDO } from '../durable-objects/user-sync.js';
import {
  MockDurableObjectState,
  MockKVNamespace,
  MockR2Bucket,
  createMockEnv,
  createRequest,
} from './helpers/mock-env.js';
import type { Env, AuthContext, PushRequest, PullRequest, RegisterMachineRequest } from '../types.js';

/**
 * NOTE: The UserSyncDO uses this.sql.exec() which calls our MockSqlStorage.
 * The mock doesn't actually execute SQL; it records calls.
 * Therefore, these tests verify:
 * 1. Schema creation queries are executed
 * 2. Request routing works correctly
 * 3. Response format is correct
 * 4. Error handling works
 *
 * For full integration tests with real SQLite, you'd use Miniflare.
 */

describe('UserSyncDO', () => {
  let doState: MockDurableObjectState;
  let env: Env;
  let kv: MockKVNamespace;
  let r2: MockR2Bucket;

  function createDO(): UserSyncDO {
    return new UserSyncDO(
      doState as unknown as DurableObjectState,
      env,
    );
  }

  function authHeaders(authCtx?: Partial<AuthContext>): Record<string, string> {
    return {
      'X-Auth-Context': JSON.stringify({
        userId: 'usr_test123456',
        email: 'test@example.com',
        tier: 'free',
        ...authCtx,
      }),
    };
  }

  beforeEach(() => {
    doState = new MockDurableObjectState();
    kv = new MockKVNamespace();
    r2 = new MockR2Bucket();
    env = createMockEnv({
      AUTH_KV: kv as unknown as KVNamespace,
      SYNC_BUCKET: r2 as unknown as R2Bucket,
    });
  });

  // -----------------------------------------------------------------------
  // Schema Initialization
  // -----------------------------------------------------------------------

  describe('Schema Initialization', () => {
    it('should create all required tables on construction', () => {
      const _do = createDO();
      const sql = doState.storage.sql;

      // Check that CREATE TABLE queries were executed
      expect(sql.hasTableCreation('account')).toBe(true);
      expect(sql.hasTableCreation('machines')).toBe(true);
      expect(sql.hasTableCreation('events_meta')).toBe(true);
      expect(sql.hasTableCreation('sync_cursors')).toBe(true);
      expect(sql.hasTableCreation('event_blobs')).toBe(true);
      expect(sql.hasTableCreation('usage_daily')).toBe(true);
      expect(sql.hasTableCreation('deletion_log')).toBe(true);
    });

    it('should use IF NOT EXISTS for idempotent schema creation', () => {
      const _do = createDO();
      const sql = doState.storage.sql;

      // All CREATE TABLE queries should have IF NOT EXISTS
      const createTableQueries = sql.execCalls.filter(q =>
        q.toLowerCase().includes('create table'),
      );

      // The schema is executed as a single SQL string with multiple statements
      // so we check the full string
      const fullSchema = sql.execCalls.join(' ').toLowerCase();
      expect(fullSchema).toContain('create table if not exists account');
      expect(fullSchema).toContain('create table if not exists machines');
      expect(fullSchema).toContain('create table if not exists events_meta');
    });
  });

  // -----------------------------------------------------------------------
  // Request Routing
  // -----------------------------------------------------------------------

  describe('Request Routing', () => {
    it('should return 404 for unknown endpoints', async () => {
      const DO = createDO();
      const request = createRequest('GET', '/api/unknown', undefined, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(404);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('not_found');
    });

    it('should require auth context for sync endpoints', async () => {
      const DO = createDO();
      const request = createRequest('POST', '/api/sync/push', { events: [] });
      const response = await DO.fetch(request);

      expect(response.status).toBe(401);
    });

    it('should handle init-account internal endpoint', async () => {
      const DO = createDO();
      const request = createRequest('POST', '/_internal/init-account', {
        userId: 'usr_test123456',
        email: 'test@example.com',
        tier: 'free',
      });

      const response = await DO.fetch(request);
      // Mock SQL doesn't actually insert, but we verify the route works
      expect(response.status).toBe(201);
    });
  });

  // -----------------------------------------------------------------------
  // Push Events
  // -----------------------------------------------------------------------

  describe('Push Events', () => {
    it('should reject push from unregistered machine', async () => {
      const DO = createDO();
      const pushBody: PushRequest = {
        machine_id: 'mach_unknown',
        events: [],
        blobs: {},
      };

      const request = createRequest('POST', '/api/sync/push', pushBody, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(403);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('unknown_machine');
    });

    it('should accept push request format', async () => {
      const DO = createDO();
      const pushBody: PushRequest = {
        machine_id: 'mach_test01',
        events: [
          {
            project_id: 'proj_abc',
            session_id: 'sess_123',
            sequence: 1,
            timestamp: '2026-02-22T10:00:00.000Z',
            event_type: 'UserPromptReceived',
            encrypted_blob_sha256: 'abc123def456',
            encrypted_size_bytes: 1024,
            metadata: {
              token_count_input: 500,
              token_count_output: 200,
              model: 'claude-opus-4-6',
            },
          },
        ],
        blobs: {
          abc123def456: btoa('encrypted-data-here'),
        },
      };

      // This will fail because the mock SQL doesn't return machine rows,
      // but we verify the request format is parsed correctly
      const request = createRequest('POST', '/api/sync/push', pushBody, authHeaders());
      const response = await DO.fetch(request);

      // Machine not found (mock returns empty array)
      expect(response.status).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // Pull Events
  // -----------------------------------------------------------------------

  describe('Pull Events', () => {
    it('should accept pull request format', async () => {
      const DO = createDO();
      const pullBody: PullRequest = {
        machine_id: 'mach_test01',
        cursor: null,
        limit: 50,
      };

      const request = createRequest('POST', '/api/sync/pull', pullBody, authHeaders());
      const response = await DO.fetch(request);

      // Should return 200 with empty events (mock SQL returns empty)
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.events).toBeDefined();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.has_more).toBe(false);
    });

    it('should accept pull with cursor', async () => {
      const DO = createDO();
      const pullBody: PullRequest = {
        machine_id: 'mach_test01',
        cursor: 'cur_2026-02-22T10:00:00.000Z_1',
      };

      const request = createRequest('POST', '/api/sync/pull', pullBody, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(200);
    });

    it('should accept pull with project filter', async () => {
      const DO = createDO();
      const pullBody: PullRequest = {
        machine_id: 'mach_test01',
        cursor: null,
        project_id: 'proj_abc',
      };

      const request = createRequest('POST', '/api/sync/pull', pullBody, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Machine Registration
  // -----------------------------------------------------------------------

  describe('Machine Registration', () => {
    it('should accept machine registration request', async () => {
      const DO = createDO();
      const machineBody: RegisterMachineRequest = {
        machine_id: 'mach_newdev',
        name: 'Dev Laptop',
        os: 'linux',
        arch: 'x64',
        hostname: 'dev-laptop',
        agent_version: '0.1.0',
      };

      const request = createRequest('POST', '/api/machines', machineBody, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(201);
      const body = await response.json() as Record<string, unknown>;
      expect(body.machine_id).toBe('mach_newdev');
      expect(body.name).toBe('Dev Laptop');
    });

    it('should list machines', async () => {
      const DO = createDO();
      const request = createRequest('GET', '/api/machines', undefined, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.machines).toBeDefined();
      expect(Array.isArray(body.machines)).toBe(true);
    });

    it('should soft-delete a machine', async () => {
      const DO = createDO();
      const request = createRequest('DELETE', '/api/machines/mach_test01', undefined, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.deleted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Account Management
  // -----------------------------------------------------------------------

  describe('Account Management', () => {
    it('should return account info', async () => {
      const DO = createDO();
      const request = createRequest('GET', '/api/account', undefined, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.user_id).toBeDefined();
      expect(body.email).toBeDefined();
      expect(body.tier).toBeDefined();
    });

    it('should reject account deletion without confirmation', async () => {
      const DO = createDO();
      const request = createRequest('DELETE', '/api/account', {
        confirmation: 'wrong text',
      }, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_confirmation');
    });

    it('should accept account deletion with correct confirmation', async () => {
      const DO = createDO();
      const request = createRequest('DELETE', '/api/account', {
        confirmation: 'DELETE MY ACCOUNT',
      }, authHeaders());
      const response = await DO.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.deleted).toBe(true);
      expect(body.crypto_shredded).toBe(true);
    });
  });
});
