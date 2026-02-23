import type {
  SyncConfig,
  SyncCursor,
  SyncPushPayload,
  CleartextMetadata,
  SyncPullResponse,
} from '@saqr/shared';
import { EncryptionManager } from './encryption.js';
import { splitEvent, reassembleEvent } from './metadata-splitter.js';
import { SyncQueue } from './queue.js';

/**
 * Sync status tracking
 */
export type SyncState = 'synced' | 'syncing' | 'pending' | 'error' | 'offline' | 'disabled';

export interface SyncStatus {
  state: SyncState;
  lastSync: string | null;
  pendingCount: number;
  lastError: string | null;
  connected: boolean;
}

/**
 * HTTP sender function type (injectable for testing)
 */
export type HttpSender = (
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Default HTTP sender using global fetch
 */
const defaultHttpSender: HttpSender = async (url, options) => {
  const response = await fetch(url, options);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>,
  };
};

/**
 * SyncClient manages encrypted push/pull sync with the Cloudflare sync server.
 *
 * Responsibilities:
 * - Encrypt events before sending (via EncryptionManager)
 * - Push encrypted events to sync server
 * - Pull and decrypt events from other machines
 * - Track sync cursors per machine
 * - Manage offline queue for retry
 */
export class SyncClient {
  private encryption: EncryptionManager;
  private httpSender: HttpSender;
  private state: SyncState = 'disabled';
  private lastSync: string | null = null;
  private lastError: string | null = null;

  constructor(
    private config: SyncConfig,
    encryption: EncryptionManager,
    httpSender?: HttpSender
  ) {
    this.encryption = encryption;
    this.httpSender = httpSender ?? defaultHttpSender;

    if (config.enabled) {
      this.state = 'pending';
    }
  }

  /**
   * Push an event to the sync server.
   *
   * The event is split into cleartext metadata and sensitive payload.
   * The sensitive payload is encrypted before transmission.
   *
   * @param event - The full event envelope to push
   */
  async pushEvent(event: Record<string, unknown>): Promise<void> {
    if (!this.config.enabled) {
      throw new Error('Sync is not enabled');
    }

    this.state = 'syncing';

    try {
      // Split event into metadata and sensitive payload
      const { metadata, sensitive } = splitEvent(event);

      // Set machine_id on metadata
      metadata.machine_id = this.config.machineId;

      // Encrypt the sensitive payload
      const sensitiveStr = JSON.stringify(sensitive);
      const encResult = await this.encryption.encryptString(sensitiveStr);

      // Build the push payload
      const pushPayload = {
        machine_id: this.config.machineId,
        key_id: this.encryption.getKeyId(),
        events: [
          {
            metadata,
            encrypted: encResult.ciphertext,
            nonce: encResult.nonce,
          },
        ],
      };

      // Send to server
      const response = await this.httpSender(`${this.config.serverUrl}/api/sync/push`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.authToken ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pushPayload),
      });

      if (!response.ok && response.status !== 207) {
        throw new Error(`Push failed: HTTP ${response.status}`);
      }

      this.lastSync = new Date().toISOString();
      this.state = 'synced';
      this.lastError = null;
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Pull events from the sync server since the given cursor.
   *
   * Downloaded events are decrypted and returned to the caller.
   *
   * @param cursor - The cursor position to pull from (null for first pull)
   * @returns Array of decrypted events
   */
  async pullEvents(cursor: SyncCursor | null): Promise<Record<string, unknown>[]> {
    if (!this.config.enabled) {
      throw new Error('Sync is not enabled');
    }

    this.state = 'syncing';

    try {
      const params = new URLSearchParams();
      if (cursor) {
        params.set('after', `${cursor.last_timestamp}:${cursor.last_event_id}`);
        if (cursor.machine_id !== 'all') {
          params.set('machine_id', cursor.machine_id);
        }
      }
      params.set('limit', '100');

      const url = `${this.config.serverUrl}/api/sync/pull?${params.toString()}`;

      const response = await this.httpSender(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.authToken ?? ''}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Pull failed: HTTP ${response.status}`);
      }

      const result = (await response.json()) as {
        events: Array<{
          metadata: CleartextMetadata;
          encrypted: string;
          nonce: string;
          key_id: string;
        }>;
        cursor: string;
        has_more: boolean;
      };

      const events: Record<string, unknown>[] = [];

      for (const syncEvent of result.events) {
        // Verify key_id matches our master key
        if (syncEvent.key_id !== this.encryption.getKeyId()) {
          continue; // Skip events encrypted with unknown keys
        }

        // Decrypt
        const ciphertext = this.encryption.fromBase64(syncEvent.encrypted);
        const nonce = this.encryption.fromBase64(syncEvent.nonce);
        const plaintext = await this.encryption.decrypt(ciphertext, nonce);
        const sensitive = JSON.parse(
          this.encryption.toString(plaintext)
        ) as Record<string, unknown>;

        // Reassemble full event
        const event = reassembleEvent(syncEvent.metadata, sensitive);
        events.push(event);
      }

      this.lastSync = new Date().toISOString();
      this.state = 'synced';
      this.lastError = null;

      return events;
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Get current sync status */
  async status(): Promise<SyncStatus> {
    return {
      state: this.state,
      lastSync: this.lastSync,
      pendingCount: 0,
      lastError: this.lastError,
      connected: this.state !== 'offline' && this.state !== 'disabled',
    };
  }
}
