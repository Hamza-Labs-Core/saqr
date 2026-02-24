import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncQueue, calculateRetryDelay } from '../queue.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('SyncQueue', () => {
  let queue: SyncQueue;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-queue-test-'));
    queue = new SyncQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('enqueue()', () => {
    it('should add an item to the queue', () => {
      const item = queue.enqueue('{"test": true}');
      expect(queue.pendingCount).toBe(1);
      expect(item.payload).toBe('{"test": true}');
      expect(item.retries).toBe(0);
      expect(item.lastAttempt).toBeNull();
      expect(item.lastError).toBeNull();
    });

    it('should assign a unique ID to each item', () => {
      const item1 = queue.enqueue('payload-1');
      const item2 = queue.enqueue('payload-2');
      expect(item1.id).not.toBe(item2.id);
    });

    it('should set addedAt timestamp', () => {
      const before = new Date().toISOString();
      const item = queue.enqueue('payload');
      const after = new Date().toISOString();

      expect(item.addedAt >= before).toBe(true);
      expect(item.addedAt <= after).toBe(true);
    });

    it('should persist item to disk', () => {
      queue.enqueue('persisted-payload');
      const manifestPath = path.join(tmpDir, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(content).toHaveLength(1);
      expect(content[0].payload).toBe('persisted-payload');
    });
  });

  describe('dequeue()', () => {
    it('should return the first item without removing it', () => {
      queue.enqueue('first');
      queue.enqueue('second');

      const item = queue.dequeue();
      expect(item?.payload).toBe('first');
      expect(queue.pendingCount).toBe(2); // Still 2 items
    });

    it('should return undefined when queue is empty', () => {
      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe('ack()', () => {
    it('should remove the first item from the queue', () => {
      queue.enqueue('first');
      queue.enqueue('second');

      queue.ack();
      expect(queue.pendingCount).toBe(1);
      expect(queue.dequeue()?.payload).toBe('second');
    });
  });

  describe('flush()', () => {
    it('should send all items and report success', async () => {
      queue.enqueue('msg-1');
      queue.enqueue('msg-2');
      queue.enqueue('msg-3');

      const sent: string[] = [];
      const result = await queue.flush(async (payload) => {
        sent.push(payload);
      });

      expect(result.sent).toBe(3);
      expect(result.failed).toBe(0);
      expect(sent).toEqual(['msg-1', 'msg-2', 'msg-3']);
      expect(queue.pendingCount).toBe(0);
    });

    it('should increment retries on failure', async () => {
      queue.enqueue('will-fail');

      let attempts = 0;
      const result = await queue.flush(async () => {
        attempts++;
        throw new Error('Network error');
      });

      expect(result.failed).toBe(1);
      expect(attempts).toBe(1);
      // Item should still be in queue with incremented retry count
      expect(queue.pendingCount).toBe(1);
      expect(queue.items[0].retries).toBe(1);
      expect(queue.items[0].lastError).toBe('Network error');
    });

    it('should discard items after MAX_RETRIES', async () => {
      const item = queue.enqueue('hopeless');
      // Manually set retries to 10 (MAX_RETRIES)
      (item as { retries: number }).retries = 10;

      const result = await queue.flush(async () => {
        throw new Error('Should not be called');
      });

      expect(result.failed).toBe(1);
      expect(queue.pendingCount).toBe(0);
    });

    it('should handle mixed success and failure', async () => {
      queue.enqueue('ok-1');
      queue.enqueue('fail');
      queue.enqueue('ok-2');

      let callCount = 0;
      const result = await queue.flush(async (payload) => {
        callCount++;
        if (payload === 'fail') {
          throw new Error('fail');
        }
      });

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(1);
    });
  });

  describe('persist() / restore()', () => {
    it('should persist and restore queue state', () => {
      queue.enqueue('item-1');
      queue.enqueue('item-2');
      queue.enqueue('item-3');
      queue.persist();

      // Create a new queue from the same directory
      const restored = new SyncQueue(tmpDir);
      restored.restore();

      expect(restored.pendingCount).toBe(3);
      expect(restored.items[0].payload).toBe('item-1');
      expect(restored.items[1].payload).toBe('item-2');
      expect(restored.items[2].payload).toBe('item-3');
    });

    it('should restore empty queue when no manifest exists', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-empty-'));
      const newQueue = new SyncQueue(emptyDir);
      newQueue.restore();

      expect(newQueue.pendingCount).toBe(0);
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it('should handle corrupted manifest gracefully', () => {
      const manifestPath = path.join(tmpDir, 'manifest.json');
      fs.writeFileSync(manifestPath, 'not valid json!!!');

      const q = new SyncQueue(tmpDir);
      q.restore();

      expect(q.pendingCount).toBe(0);
    });

    it('should preserve retry state across restarts', () => {
      const item = queue.enqueue('retried-item');
      (item as { retries: number; lastError: string | null }).retries = 3;
      (item as { retries: number; lastError: string | null }).lastError = 'timeout';
      queue.persist();

      const restored = new SyncQueue(tmpDir);
      restored.restore();

      expect(restored.items[0].retries).toBe(3);
      expect(restored.items[0].lastError).toBe('timeout');
    });
  });

  describe('clear()', () => {
    it('should remove all items from the queue', () => {
      queue.enqueue('a');
      queue.enqueue('b');
      queue.clear();

      expect(queue.pendingCount).toBe(0);
    });

    it('should remove manifest from disk', () => {
      queue.enqueue('a');
      queue.clear();

      const manifestPath = path.join(tmpDir, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(false);
    });
  });
});

describe('calculateRetryDelay()', () => {
  it('should return 1s for retry 0', () => {
    expect(calculateRetryDelay(0)).toBe(1000);
  });

  it('should return 2s for retry 1', () => {
    expect(calculateRetryDelay(1)).toBe(2000);
  });

  it('should return 4s for retry 2', () => {
    expect(calculateRetryDelay(2)).toBe(4000);
  });

  it('should return 8s for retry 3', () => {
    expect(calculateRetryDelay(3)).toBe(8000);
  });

  it('should cap at 60s (MAX_DELAY_MS)', () => {
    expect(calculateRetryDelay(10)).toBe(60000);
    expect(calculateRetryDelay(20)).toBe(60000);
  });

  it('should produce increasing delays', () => {
    const delays = [0, 1, 2, 3, 4, 5].map(calculateRetryDelay);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });
});
