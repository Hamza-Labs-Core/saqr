/**
 * UserSyncDO — Per-user Durable Object with SQLite metadata store.
 *
 * Each user gets one DO instance. Handles:
 * - Event metadata storage (SQLite)
 * - Machine registry
 * - Sync cursor management
 * - Push/Pull operations
 * - Account management
 */

import type {
  Env,
  AuthContext,
  PushRequest,
  PullRequest,
  PushResponse,
  PullResponse,
  PullEventResponse,
  EventMetaRow,
  AccountRow,
  MachineInfo,
  RegisterMachineRequest,
  DeleteAccountRequest,
} from '../types.js';
import {
  jsonResponse,
  errorResponse,
  getTierLimits,
  base64ToArrayBuffer,
  generateId,
} from '../helpers.js';
import { checkStorageQuota, checkDeviceLimit } from '../middleware/tier-enforcement.js';
import { deleteAccount } from '../account/crypto-shred.js';

export class UserSyncDO {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema Initialization
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS account (
        user_id          TEXT PRIMARY KEY,
        email            TEXT NOT NULL,
        password_hash    TEXT NOT NULL DEFAULT '',
        tier             TEXT NOT NULL DEFAULT 'free',
        email_verified   INTEGER DEFAULT 0,
        storage_used_bytes INTEGER DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        deleted_at       TEXT
      );

      CREATE TABLE IF NOT EXISTS machines (
        machine_id     TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        os             TEXT NOT NULL DEFAULT 'unknown',
        arch           TEXT NOT NULL DEFAULT 'unknown',
        hostname       TEXT NOT NULL DEFAULT 'unknown',
        registered_at  TEXT NOT NULL,
        last_sync_at   TEXT,
        last_seen_at   TEXT,
        agent_version  TEXT,
        is_active      INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_machines_active ON machines(is_active);

      CREATE TABLE IF NOT EXISTS events_meta (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id             TEXT NOT NULL,
        project_id             TEXT NOT NULL,
        session_id             TEXT NOT NULL,
        sequence               INTEGER NOT NULL,
        event_type             TEXT NOT NULL,
        timestamp              TEXT NOT NULL,
        encrypted_blob_key     TEXT NOT NULL,
        encrypted_blob_sha256  TEXT NOT NULL,
        encrypted_size_bytes   INTEGER NOT NULL,
        token_count_input      INTEGER DEFAULT 0,
        token_count_output     INTEGER DEFAULT 0,
        model                  TEXT,
        tool_name              TEXT,
        synced_at              TEXT NOT NULL,
        UNIQUE(machine_id, project_id, session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_events_meta_project ON events_meta(project_id, session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_meta_timestamp ON events_meta(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_meta_machine ON events_meta(machine_id, synced_at);
      CREATE INDEX IF NOT EXISTS idx_events_meta_synced ON events_meta(synced_at);

      CREATE TABLE IF NOT EXISTS sync_cursors (
        machine_id        TEXT NOT NULL,
        source_machine_id TEXT NOT NULL,
        last_synced_id    INTEGER NOT NULL,
        last_synced_at    TEXT NOT NULL,
        PRIMARY KEY (machine_id, source_machine_id)
      );

      CREATE TABLE IF NOT EXISTS event_blobs (
        sha256  TEXT PRIMARY KEY,
        data    BLOB NOT NULL,
        size    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_daily (
        date               TEXT NOT NULL,
        project_id         TEXT NOT NULL,
        model              TEXT NOT NULL,
        event_count        INTEGER DEFAULT 0,
        token_count_input  INTEGER DEFAULT 0,
        token_count_output INTEGER DEFAULT 0,
        blob_bytes         INTEGER DEFAULT 0,
        PRIMARY KEY (date, project_id, model)
      );

      CREATE TABLE IF NOT EXISTS deletion_log (
        deletion_id    TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'initiated',
        initiated_at   TEXT NOT NULL,
        completed_at   TEXT
      );
    `);
  }

  // ---------------------------------------------------------------------------
  // Request Router
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authCtxHeader = request.headers.get('X-Auth-Context');
    let authCtx: AuthContext | null = null;

    if (authCtxHeader) {
      try {
        authCtx = JSON.parse(authCtxHeader);
      } catch {
        return errorResponse(400, 'invalid_auth_context', 'Invalid X-Auth-Context header');
      }
    }

    try {
      // Internal endpoints (called by Worker, not exposed externally)
      if (url.pathname === '/_internal/init-account' && request.method === 'POST') {
        return this.handleInitAccount(request);
      }

      // Sync endpoints
      if (url.pathname === '/api/sync/push' && request.method === 'POST') {
        if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
        return this.handlePush(request, authCtx);
      }

      if (url.pathname === '/api/sync/pull' && request.method === 'POST') {
        if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
        return this.handlePull(request, authCtx);
      }

      // Machine endpoints
      if (url.pathname === '/api/machines' && request.method === 'GET') {
        if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
        return this.handleListMachines();
      }

      if (url.pathname === '/api/machines' && request.method === 'POST') {
        if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
        return this.handleMachineRegister(request, authCtx);
      }

      if (url.pathname.startsWith('/api/machines/') && request.method === 'DELETE') {
        if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
        const machineId = url.pathname.split('/').pop();
        if (!machineId) return errorResponse(400, 'missing_id', 'Machine ID required');
        return this.handleMachineDelete(machineId);
      }

      // Account endpoints
      if (url.pathname === '/api/account' && request.method === 'GET') {
        if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
        return this.handleGetAccount(authCtx);
      }

      if (url.pathname === '/api/account' && request.method === 'DELETE') {
        if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
        return this.handleDeleteAccount(request, authCtx);
      }

      return errorResponse(404, 'not_found', 'Endpoint not found');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return errorResponse(500, 'internal_error', message);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Account Initialization
  // ---------------------------------------------------------------------------

  private async handleInitAccount(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId: string;
      email: string;
      tier: string;
    };

    const now = new Date().toISOString();

    // Check if account already exists
    const existing = this.sql.exec(
      'SELECT user_id FROM account WHERE user_id = ?',
      body.userId,
    ).toArray();

    if (existing.length > 0) {
      return errorResponse(409, 'account_exists', 'Account already exists');
    }

    this.sql.exec(
      `INSERT INTO account (user_id, email, password_hash, tier, email_verified, storage_used_bytes, created_at, updated_at)
       VALUES (?, ?, '', ?, 0, 0, ?, ?)`,
      body.userId,
      body.email,
      body.tier || 'free',
      now,
      now,
    );

    return jsonResponse(201, { created: true, user_id: body.userId });
  }

  // ---------------------------------------------------------------------------
  // Push Handler
  // ---------------------------------------------------------------------------

  private async handlePush(request: Request, authCtx: AuthContext): Promise<Response> {
    const body = await request.json() as PushRequest;
    const now = new Date().toISOString();

    // 1. Verify machine belongs to user
    const machineRows = this.sql.exec(
      'SELECT machine_id FROM machines WHERE machine_id = ? AND is_active = 1',
      body.machine_id,
    ).toArray();

    if (machineRows.length === 0) {
      return errorResponse(403, 'unknown_machine', 'Machine not registered. Register the machine first via POST /api/machines.');
    }

    // 2. Check storage quota
    const accountRows = this.sql.exec('SELECT * FROM account LIMIT 1').toArray();
    const account = accountRows[0] as unknown as AccountRow | undefined;
    const tier = account?.tier || authCtx.tier || 'free';
    const currentUsage = (account?.storage_used_bytes as number) || 0;

    const incomingBytes = body.events.reduce((sum, e) => sum + e.encrypted_size_bytes, 0);
    const quotaCheck = checkStorageQuota(currentUsage, incomingBytes, tier, this.env);
    if (quotaCheck) return quotaCheck;

    // 3. Process each event
    let accepted = 0;
    let rejected = 0;

    for (const event of body.events) {
      try {
        const blobData = body.blobs?.[event.encrypted_blob_sha256];
        if (!blobData) {
          rejected++;
          continue;
        }

        const blobBytes = base64ToArrayBuffer(blobData);
        let blobKey: string;

        // Store blob: DO SQLite for < 2MB, R2 for >= 2MB
        if (blobBytes.byteLength < 2 * 1024 * 1024) {
          blobKey = `do://${event.encrypted_blob_sha256}`;
          this.sql.exec(
            'INSERT OR IGNORE INTO event_blobs (sha256, data, size) VALUES (?, ?, ?)',
            event.encrypted_blob_sha256,
            new Uint8Array(blobBytes),
            blobBytes.byteLength,
          );
        } else {
          // Overflow to R2
          blobKey = `users/${authCtx.userId}/events/${body.machine_id}/${event.project_id}/${event.session_id}/${String(event.sequence).padStart(6, '0')}.enc`;
          await this.env.SYNC_BUCKET.put(blobKey, blobBytes);
        }

        // 4. Insert event metadata
        this.sql.exec(
          `INSERT OR IGNORE INTO events_meta
            (machine_id, project_id, session_id, sequence, event_type, timestamp,
             encrypted_blob_key, encrypted_blob_sha256, encrypted_size_bytes,
             token_count_input, token_count_output, model, tool_name, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          body.machine_id,
          event.project_id,
          event.session_id,
          event.sequence,
          event.event_type,
          event.timestamp,
          blobKey,
          event.encrypted_blob_sha256,
          event.encrypted_size_bytes,
          event.metadata?.token_count_input || 0,
          event.metadata?.token_count_output || 0,
          event.metadata?.model || null,
          event.metadata?.tool_name || null,
          now,
        );

        // 5. Update usage aggregation
        const dateStr = event.timestamp.slice(0, 10);
        this.sql.exec(
          `INSERT INTO usage_daily (date, project_id, model, event_count, token_count_input, token_count_output, blob_bytes)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(date, project_id, model) DO UPDATE SET
             event_count = event_count + 1,
             token_count_input = token_count_input + excluded.token_count_input,
             token_count_output = token_count_output + excluded.token_count_output,
             blob_bytes = blob_bytes + excluded.blob_bytes`,
          dateStr,
          event.project_id,
          event.metadata?.model || 'unknown',
          event.metadata?.token_count_input || 0,
          event.metadata?.token_count_output || 0,
          event.encrypted_size_bytes,
        );

        accepted++;
      } catch {
        rejected++;
      }
    }

    // 6. Update storage counter
    this.sql.exec(
      `UPDATE account SET storage_used_bytes = (
        SELECT COALESCE(SUM(encrypted_size_bytes), 0) FROM events_meta
      ), updated_at = ?`,
      now,
    );

    // 7. Update machine timestamps
    this.sql.exec(
      'UPDATE machines SET last_sync_at = ?, last_seen_at = ? WHERE machine_id = ?',
      now,
      now,
      body.machine_id,
    );

    // 8. Build cursor and return
    const updatedAccount = this.sql.exec(
      'SELECT storage_used_bytes FROM account LIMIT 1',
    ).toArray();
    const storageUsed = updatedAccount.length > 0
      ? (updatedAccount[0] as unknown as { storage_used_bytes: number }).storage_used_bytes
      : 0;

    const lastEventRows = this.sql.exec(
      'SELECT synced_at, sequence FROM events_meta WHERE machine_id = ? ORDER BY id DESC LIMIT 1',
      body.machine_id,
    ).toArray();

    const lastEvent = lastEventRows[0] as unknown as { synced_at: string; sequence: number } | undefined;
    const cursor = lastEvent ? `cur_${lastEvent.synced_at}_${lastEvent.sequence}` : null;

    const limits = getTierLimits(tier, this.env);

    return jsonResponse(200, {
      accepted,
      rejected,
      cursor,
      storage_used_bytes: storageUsed,
      storage_quota_bytes: limits.storageBytes,
    } satisfies PushResponse);
  }

  // ---------------------------------------------------------------------------
  // Pull Handler
  // ---------------------------------------------------------------------------

  private async handlePull(request: Request, authCtx: AuthContext): Promise<Response> {
    const body = await request.json() as PullRequest;
    const now = new Date().toISOString();

    // 1. Resolve cursor position
    let fromId = 0;
    if (body.cursor) {
      const cursorRows = this.sql.exec(
        `SELECT last_synced_id FROM sync_cursors
         WHERE machine_id = ? AND source_machine_id = 'all'`,
        body.machine_id,
      ).toArray();

      if (cursorRows.length > 0) {
        fromId = (cursorRows[0] as unknown as { last_synced_id: number }).last_synced_id;
      }
    }

    // 2. Query events from other machines
    const limit = Math.min(body.limit || 100, 500);

    let query = 'SELECT * FROM events_meta WHERE machine_id != ? AND id > ?';
    const params: (string | number)[] = [body.machine_id, fromId];

    if (body.project_id) {
      query += ' AND project_id = ?';
      params.push(body.project_id);
    }

    query += ' ORDER BY id ASC LIMIT ?';
    params.push(limit + 1); // +1 for has_more detection

    const rows = this.sql.exec(query, ...params).toArray() as unknown as EventMetaRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit);

    // 3. Build response events
    const responseEvents: PullEventResponse[] = events.map((row) => ({
      project_id: row.project_id,
      session_id: row.session_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      event_type: row.event_type,
      source_machine_id: row.machine_id,
      encrypted_blob_key: row.encrypted_blob_key,
      encrypted_size_bytes: row.encrypted_size_bytes,
      metadata: {
        token_count_input: row.token_count_input,
        token_count_output: row.token_count_output,
        model: row.model,
        tool_name: row.tool_name,
      },
    }));

    // 4. Advance cursor (only if events were returned)
    if (events.length > 0) {
      const lastId = events[events.length - 1].id;
      this.sql.exec(
        `INSERT INTO sync_cursors (machine_id, source_machine_id, last_synced_id, last_synced_at)
         VALUES (?, 'all', ?, ?)
         ON CONFLICT(machine_id, source_machine_id) DO UPDATE SET
           last_synced_id = excluded.last_synced_id,
           last_synced_at = excluded.last_synced_at`,
        body.machine_id,
        lastId,
        now,
      );
    }

    // 5. Update machine last_seen_at
    this.sql.exec(
      'UPDATE machines SET last_seen_at = ? WHERE machine_id = ?',
      now,
      body.machine_id,
    );

    // 6. Count total pending
    const pendingFromId = events.length > 0 ? events[events.length - 1].id : fromId;
    const pendingRows = this.sql.exec(
      'SELECT COUNT(*) as cnt FROM events_meta WHERE machine_id != ? AND id > ?',
      body.machine_id,
      pendingFromId,
    ).toArray();
    const pendingCount = (pendingRows[0] as unknown as { cnt: number })?.cnt || 0;

    // 7. Build cursor string
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    const newCursor = lastEvent
      ? `cur_${lastEvent.synced_at}_${lastEvent.sequence}`
      : body.cursor || null;

    return jsonResponse(200, {
      events: responseEvents,
      cursor: newCursor,
      has_more: hasMore,
      total_pending: hasMore ? pendingCount : 0,
    } satisfies PullResponse);
  }

  // ---------------------------------------------------------------------------
  // Machine Registry
  // ---------------------------------------------------------------------------

  private async handleMachineRegister(request: Request, authCtx: AuthContext): Promise<Response> {
    const body = await request.json() as RegisterMachineRequest;
    const now = new Date().toISOString();

    // Check device limit
    const activeMachineRows = this.sql.exec(
      'SELECT COUNT(*) as cnt FROM machines WHERE is_active = 1',
    ).toArray();
    const currentCount = (activeMachineRows[0] as unknown as { cnt: number })?.cnt || 0;
    const limitCheck = checkDeviceLimit(currentCount, authCtx.tier, this.env);
    if (limitCheck) return limitCheck;

    // Upsert machine
    this.sql.exec(
      `INSERT INTO machines (machine_id, name, os, arch, hostname, registered_at, last_seen_at, agent_version, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(machine_id) DO UPDATE SET
         name = excluded.name,
         os = excluded.os,
         arch = excluded.arch,
         hostname = excluded.hostname,
         last_seen_at = excluded.last_seen_at,
         agent_version = excluded.agent_version,
         is_active = 1`,
      body.machine_id,
      body.name,
      body.os || 'unknown',
      body.arch || 'unknown',
      body.hostname || 'unknown',
      now,
      now,
      body.agent_version || null,
    );

    return jsonResponse(201, {
      machine_id: body.machine_id,
      name: body.name,
      registered_at: now,
    });
  }

  private async handleListMachines(): Promise<Response> {
    const machines = this.sql.exec(
      'SELECT * FROM machines WHERE is_active = 1 ORDER BY registered_at DESC',
    ).toArray() as unknown as MachineInfo[];

    return jsonResponse(200, { machines });
  }

  private async handleMachineDelete(machineId: string): Promise<Response> {
    this.sql.exec(
      'UPDATE machines SET is_active = 0 WHERE machine_id = ?',
      machineId,
    );

    return jsonResponse(200, { deleted: true, machine_id: machineId });
  }

  // ---------------------------------------------------------------------------
  // Account Management
  // ---------------------------------------------------------------------------

  private async handleGetAccount(authCtx: AuthContext): Promise<Response> {
    const rows = this.sql.exec('SELECT * FROM account LIMIT 1').toArray();
    const account = rows[0] as unknown as AccountRow | undefined;

    if (!account) {
      return jsonResponse(200, {
        user_id: authCtx.userId,
        email: authCtx.email,
        tier: authCtx.tier,
        email_verified: false,
        storage_used_bytes: 0,
        created_at: new Date().toISOString(),
      });
    }

    const machineRows = this.sql.exec(
      'SELECT COUNT(*) as cnt FROM machines WHERE is_active = 1',
    ).toArray();
    const machineCount = (machineRows[0] as unknown as { cnt: number })?.cnt || 0;

    return jsonResponse(200, {
      user_id: account.user_id,
      email: account.email,
      tier: account.tier,
      email_verified: account.email_verified === 1,
      storage_used_bytes: account.storage_used_bytes,
      machines_count: machineCount,
      created_at: account.created_at,
    });
  }

  private async handleDeleteAccount(request: Request, authCtx: AuthContext): Promise<Response> {
    let body: DeleteAccountRequest;
    try {
      body = await request.json() as DeleteAccountRequest;
    } catch {
      return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
    }

    if (body.confirmation !== 'DELETE MY ACCOUNT') {
      return errorResponse(
        400,
        'invalid_confirmation',
        'You must send { "confirmation": "DELETE MY ACCOUNT" } to confirm deletion.',
      );
    }

    const now = new Date().toISOString();

    // Log the deletion
    const deletionId = `del_${generateId(8)}`;
    this.sql.exec(
      `INSERT INTO deletion_log (deletion_id, user_id, status, initiated_at)
       VALUES (?, ?, 'initiated', ?)`,
      deletionId,
      authCtx.userId,
      now,
    );

    // Clear DO data
    this.sql.exec('DELETE FROM events_meta');
    this.sql.exec('DELETE FROM event_blobs');
    this.sql.exec('DELETE FROM machines');
    this.sql.exec('DELETE FROM sync_cursors');
    this.sql.exec('DELETE FROM usage_daily');
    this.sql.exec('DELETE FROM account');

    // Update deletion log
    this.sql.exec(
      `UPDATE deletion_log SET status = 'completed', completed_at = ? WHERE deletion_id = ?`,
      now,
      deletionId,
    );

    // Crypto-shred external data (KV + R2)
    const result = await deleteAccount(authCtx.userId, authCtx.email, this.env);

    return jsonResponse(200, {
      deleted: true,
      user_id: authCtx.userId,
      deletion_id: deletionId,
      message: result.message,
      crypto_shredded: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Alarm Handler
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    // Retention cleanup
    const accountRows = this.sql.exec('SELECT * FROM account LIMIT 1').toArray();
    const account = accountRows[0] as unknown as AccountRow | undefined;
    if (!account) return;

    const limits = getTierLimits(account.tier, this.env);
    if (limits.retentionDays > 0) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - limits.retentionDays);
      const cutoff = cutoffDate.toISOString();

      // Delete expired events
      this.sql.exec(
        'DELETE FROM events_meta WHERE timestamp < ?',
        cutoff,
      );

      // Recalculate storage
      const now = new Date().toISOString();
      this.sql.exec(
        `UPDATE account SET storage_used_bytes = (
          SELECT COALESCE(SUM(encrypted_size_bytes), 0) FROM events_meta
        ), updated_at = ?`,
        now,
      );
    }
  }
}
