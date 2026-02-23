/**
 * Data Export Handler — Art. 20 GDPR data portability.
 *
 * Allows users to export all their data in a machine-readable JSON format.
 * The export includes all events, machine registrations, and account metadata.
 */

import type { Env, AuthContext, EventMetaRow, MachineInfo, AccountRow } from '../types.js';
import { jsonResponse, errorResponse, generateId } from '../helpers.js';

// ---------------------------------------------------------------------------
// Export Archive Format
// ---------------------------------------------------------------------------

export interface ExportArchive {
  version: '1.0';
  exported_at: string;
  user_id: string;
  account: {
    email: string;
    tier: string;
    created_at: string;
    storage_used_bytes: number;
  } | null;
  events: ExportEvent[];
  machines: ExportMachine[];
}

export interface ExportEvent {
  event_id: number;
  machine_id: string;
  project_id: string;
  session_id: string;
  sequence: number;
  event_type: string;
  timestamp: string;
  encrypted_size_bytes: number;
  token_count_input: number;
  token_count_output: number;
  model: string | null;
  tool_name: string | null;
  synced_at: string;
}

export interface ExportMachine {
  machine_id: string;
  name: string;
  os: string;
  arch: string;
  hostname: string;
  registered_at: string;
  last_sync_at: string | null;
  agent_version: string | null;
}

// ---------------------------------------------------------------------------
// Generate Export Archive
// ---------------------------------------------------------------------------

/**
 * Generate a complete export archive from DO SQLite storage.
 *
 * @param sql - The SqlStorage instance from the Durable Object
 * @param userId - The user's ID
 * @returns The complete export archive
 */
export function generateExportArchive(
  sql: SqlStorage,
  userId: string,
): ExportArchive {
  const now = new Date().toISOString();

  // Fetch account info
  const accountRows = sql.exec('SELECT * FROM account LIMIT 1').toArray();
  const account = accountRows[0] as unknown as AccountRow | undefined;

  // Fetch all events
  const eventRows = sql.exec(
    'SELECT * FROM events_meta ORDER BY id ASC',
  ).toArray() as unknown as EventMetaRow[];

  const events: ExportEvent[] = eventRows.map((row) => ({
    event_id: row.id,
    machine_id: row.machine_id,
    project_id: row.project_id,
    session_id: row.session_id,
    sequence: row.sequence,
    event_type: row.event_type,
    timestamp: row.timestamp,
    encrypted_size_bytes: row.encrypted_size_bytes,
    token_count_input: row.token_count_input,
    token_count_output: row.token_count_output,
    model: row.model,
    tool_name: row.tool_name,
    synced_at: row.synced_at,
  }));

  // Fetch all machines (including inactive)
  const machineRows = sql.exec(
    'SELECT * FROM machines ORDER BY registered_at ASC',
  ).toArray() as unknown as MachineInfo[];

  const machines: ExportMachine[] = machineRows.map((row) => ({
    machine_id: row.machine_id,
    name: row.name,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    registered_at: row.registered_at,
    last_sync_at: row.last_sync_at,
    agent_version: row.agent_version,
  }));

  return {
    version: '1.0',
    exported_at: now,
    user_id: userId,
    account: account
      ? {
          email: account.email,
          tier: account.tier,
          created_at: account.created_at,
          storage_used_bytes: account.storage_used_bytes,
        }
      : null,
    events,
    machines,
  };
}

// ---------------------------------------------------------------------------
// Export Request Handler
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/account/export — initiate data export.
 *
 * Generates a full export archive and returns it as JSON.
 * In production, this would generate a time-limited download URL
 * for large exports via R2.
 */
export function handleExportRequest(
  sql: SqlStorage,
  authCtx: AuthContext,
): Response {
  try {
    const archive = generateExportArchive(sql, authCtx.userId);
    const exportId = `exp_${generateId(8)}`;

    return jsonResponse(200, {
      export_id: exportId,
      status: 'completed',
      download_url: `/api/account/export/${exportId}`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1 hour
      archive,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    return errorResponse(500, 'export_failed', message);
  }
}
