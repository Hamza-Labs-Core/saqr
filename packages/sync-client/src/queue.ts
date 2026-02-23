import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * An item in the sync queue.
 */
export interface QueueItem {
  /** Unique ID for this queue entry */
  id: string;
  /** The serialized payload to sync */
  payload: string;
  /** ISO 8601 timestamp when the item was enqueued */
  addedAt: string;
  /** Number of retry attempts */
  retries: number;
  /** ISO 8601 timestamp of the last retry attempt */
  lastAttempt: string | null;
  /** Error message from the last failed attempt */
  lastError: string | null;
}

/**
 * Retry/backoff constants
 */
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000; // 60s cap per task spec
const MAX_RETRIES = 10;

/**
 * Calculate retry delay with exponential backoff.
 *
 * Sequence: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
 *
 * @param retryCount - Number of previous retries (0-based)
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(retryCount: number): number {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, retryCount);
  return Math.min(exponentialDelay, MAX_DELAY_MS);
}

/**
 * Type for a sender function used during flush.
 */
export type SenderFn = (payload: string) => Promise<void>;

/**
 * SyncQueue manages offline-first event queuing.
 *
 * Events are queued when the sync server is unreachable and
 * retried with exponential backoff when connectivity is restored.
 *
 * Queue data is persisted to disk for crash recovery.
 */
export class SyncQueue {
  private queue: QueueItem[] = [];
  private queueDir: string;

  /**
   * Create a new SyncQueue.
   *
   * @param queueDir - Directory to persist queue items (e.g., ~/.saqr/sync-queue/)
   */
  constructor(queueDir: string) {
    this.queueDir = queueDir;
  }

  /** Add a payload to the sync queue, persisting to disk */
  enqueue(payload: string): QueueItem {
    const item: QueueItem = {
      id: crypto.randomUUID(),
      payload,
      addedAt: new Date().toISOString(),
      retries: 0,
      lastAttempt: null,
      lastError: null,
    };

    this.queue.push(item);
    this.persistItem(item);

    return item;
  }

  /** Get the next item from the queue without removing it */
  dequeue(): QueueItem | undefined {
    return this.queue[0];
  }

  /** Remove the first item from the queue (after successful send) */
  ack(): void {
    const item = this.queue.shift();
    if (item) {
      this.removePersistedItem(item.id);
    }
  }

  /** Get number of pending items */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Get all items in the queue */
  get items(): ReadonlyArray<QueueItem> {
    return this.queue;
  }

  /**
   * Flush the queue by sending all items through the sender function.
   * Uses exponential backoff on failures.
   *
   * @param sender - Async function that sends a payload to the server
   * @returns Stats about the flush operation
   */
  async flush(sender: SenderFn): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    // Process a snapshot of current queue length to avoid infinite loops
    // if items are re-queued during processing
    const toProcess = this.queue.length;

    for (let i = 0; i < toProcess; i++) {
      const item = this.queue[0];
      if (!item) break;

      if (item.retries >= MAX_RETRIES) {
        // Move to dead letter (just discard from queue)
        this.queue.shift();
        this.removePersistedItem(item.id);
        failed++;
        continue;
      }

      try {
        await sender(item.payload);
        this.queue.shift();
        this.removePersistedItem(item.id);
        sent++;
      } catch (err) {
        item.retries++;
        item.lastAttempt = new Date().toISOString();
        item.lastError = err instanceof Error ? err.message : String(err);
        this.persistItem(item); // update persisted state

        // Apply backoff delay
        const delay = calculateRetryDelay(item.retries - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));

        failed++;
        // Move failed item to end so we can try other items
        this.queue.shift();
        this.queue.push(item);
      }
    }

    return { sent, failed };
  }

  /**
   * Persist the entire queue to disk.
   * Writes each item as a JSON file in the queue directory.
   */
  persist(): void {
    fs.mkdirSync(this.queueDir, { recursive: true, mode: 0o700 });

    // Write a manifest file with all queue items
    const manifestPath = path.join(this.queueDir, 'manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(this.queue, null, 2),
      { mode: 0o600 }
    );
  }

  /**
   * Restore the queue from disk.
   * Reads the manifest file and rebuilds the in-memory queue.
   */
  restore(): void {
    const manifestPath = path.join(this.queueDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      this.queue = [];
      return;
    }

    try {
      const content = fs.readFileSync(manifestPath, 'utf8');
      const items = JSON.parse(content) as QueueItem[];
      this.queue = items;
    } catch {
      // Corrupted manifest, start fresh
      this.queue = [];
    }
  }

  /** Persist a single queue item to disk */
  private persistItem(item: QueueItem): void {
    try {
      fs.mkdirSync(this.queueDir, { recursive: true, mode: 0o700 });
      // Just persist the full manifest each time for simplicity
      const manifestPath = path.join(this.queueDir, 'manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(this.queue, null, 2),
        { mode: 0o600 }
      );
    } catch {
      // Silently ignore persistence errors - queue still works in-memory
    }
  }

  /** Remove a persisted item from disk */
  private removePersistedItem(_id: string): void {
    try {
      const manifestPath = path.join(this.queueDir, 'manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(this.queue, null, 2),
        { mode: 0o600 }
      );
    } catch {
      // Silently ignore
    }
  }

  /** Clear all items from the queue */
  clear(): void {
    this.queue = [];
    try {
      const manifestPath = path.join(this.queueDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }
    } catch {
      // Silently ignore
    }
  }
}
