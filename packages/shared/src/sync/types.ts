/**
 * Sync Protocol Types for the Saqr Agent Management Platform.
 *
 * Defines the data structures for the zero-knowledge encrypted sync
 * protocol between the local daemon and the Cloudflare edge sync server.
 *
 * The sync protocol follows these principles:
 * - **Client-side encryption**: All sensitive data is encrypted before leaving the machine.
 * - **Metadata separation**: Cleartext metadata (timestamps, token counts, event types)
 *   is stored separately from encrypted payloads for server-side aggregation.
 * - **Append-only**: Events are immutable; no conflicts are possible.
 * - **Offline-first**: Full local functionality; sync catches up when online.
 *
 * @module sync/types
 */

// ---------------------------------------------------------------------------
// Encrypted Data Structures
// ---------------------------------------------------------------------------

/**
 * An encrypted blob containing sensitive event data.
 *
 * The daemon encrypts the event's `data` field (prompts, responses,
 * file paths, tool inputs/outputs) using XChaCha20-Poly1305 via libsodium
 * before pushing to the sync server. The server only ever sees this opaque blob.
 */
export interface EncryptedBlob {
  /** Base64-encoded ciphertext produced by XChaCha20-Poly1305. */
  ciphertext: string;

  /** Base64-encoded nonce used for this encryption operation. */
  nonce: string;

  /**
   * Identifier of the key used for encryption.
   * Allows key rotation: the client can have multiple active keys.
   */
  key_id: string;

  /**
   * Encryption algorithm identifier.
   * Currently always `"xchacha20-poly1305"`.
   */
  algorithm: "xchacha20-poly1305";
}

/**
 * Cleartext metadata that the sync server can read for indexing and aggregation.
 *
 * This metadata is intentionally limited to non-sensitive operational data:
 * timestamps, token counts, event types, and model names. No user content
 * (prompts, code, file paths, tool inputs/outputs) is ever included in cleartext.
 */
export interface CleartextMetadata {
  /** UUID of the event. */
  event_id: string;

  /** The unified event type. */
  event_type: string;

  /** Project identifier ({basename}-{hash6}). */
  project_id: string;

  /** Session identifier. */
  session_id: string;

  /** Per-session sequence number. */
  sequence: number;

  /** ISO 8601 UTC timestamp. */
  timestamp: string;

  /** Which agent provider produced this event. */
  agent_provider: string;

  /** Model used (e.g., "claude-opus-4-6"). Safe to include in cleartext. */
  model?: string;

  /** Input tokens consumed (for usage tracking/billing). */
  input_tokens?: number;

  /** Output tokens produced (for usage tracking/billing). */
  output_tokens?: number;

  /** Machine identifier for multi-machine sync. */
  machine_id: string;
}

// ---------------------------------------------------------------------------
// Push / Pull Payloads
// ---------------------------------------------------------------------------

/**
 * Payload sent by the daemon when pushing a new event to the sync server.
 *
 * The daemon splits each event into cleartext metadata (for server-side
 * indexing) and an encrypted blob (for privacy). The server stores them
 * separately: metadata in SQLite (Durable Object), blob in R2.
 */
export interface SyncPushPayload {
  /** Cleartext metadata for server-side indexing. */
  metadata: CleartextMetadata;

  /** Encrypted event data blob. */
  encrypted: EncryptedBlob;
}

/**
 * Request from a client to pull events from the sync server.
 *
 * Uses cursor-based pagination to efficiently sync only new events.
 * The client sends its last-known cursor, and the server returns
 * events after that point.
 */
export interface SyncPullRequest {
  /** The machine to pull events from (or "all" for all machines). */
  machine_id: string | "all";

  /** Cursor from the last successful pull. `null` for the initial pull. */
  cursor: SyncCursor | null;

  /**
   * Optional filter: only pull events for these project IDs.
   * If empty or omitted, pulls events for all projects.
   */
  project_ids?: string[];

  /**
   * Maximum number of events to return in this response.
   * Server may return fewer if there are not enough events.
   */
  limit?: number;
}

/**
 * Response from the sync server for a pull request.
 */
export interface SyncPullResponse {
  /** The events matching the pull request criteria. */
  events: SyncPushPayload[];

  /** Updated cursor for the next pull request. */
  cursor: SyncCursor;

  /** Whether there are more events available after this batch. */
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Sync Cursor
// ---------------------------------------------------------------------------

/**
 * Opaque cursor for paginated sync pulls.
 *
 * The cursor tracks the sync position per machine so that
 * the client can efficiently resume syncing from where it left off.
 */
export interface SyncCursor {
  /**
   * ISO 8601 UTC timestamp of the last synced event.
   * Used as the primary sort key for pagination.
   */
  last_timestamp: string;

  /**
   * Event ID of the last synced event.
   * Used to break ties when multiple events share the same timestamp.
   */
  last_event_id: string;

  /**
   * Machine ID this cursor is tracking.
   * Each machine maintains its own independent cursor.
   */
  machine_id: string;
}

// ---------------------------------------------------------------------------
// Sync Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the sync client running in the daemon.
 */
export interface SyncConfig {
  /** Whether sync is enabled. */
  enabled: boolean;

  /** The sync server URL (Cloudflare Worker endpoint). */
  serverUrl: string;

  /**
   * JWT auth token for authenticating with the sync server.
   * Obtained during account setup / device registration.
   */
  authToken?: string;

  /**
   * Machine identifier for this device.
   * Generated on first run and persisted in the local config.
   */
  machineId: string;

  /**
   * Human-readable name for this machine (e.g., "Linux Dev VM").
   * Set by the user during setup.
   */
  machineName?: string;

  /**
   * Project IDs to sync. Empty array means sync all projects.
   * Provides privacy control: users can exclude sensitive projects.
   */
  syncProjectIds: string[];

  /**
   * How often to attempt pushing new events (in milliseconds).
   * @default 5000
   */
  pushIntervalMs: number;

  /**
   * How often to poll for new events from other machines (in milliseconds).
   * @default 30000
   */
  pullIntervalMs: number;

  /**
   * Maximum number of events to batch in a single push request.
   * @default 100
   */
  pushBatchSize: number;

  /**
   * Whether to use WebSocket for real-time sync notifications
   * instead of polling.
   * @default true
   */
  useWebSocket: boolean;
}
