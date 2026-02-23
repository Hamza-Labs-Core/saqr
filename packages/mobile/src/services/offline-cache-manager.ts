/**
 * OfflineCacheManager - Cache invalidation logic, storage quota management,
 * and sync queue for offline operation.
 *
 * @module services/offline-cache-manager
 */

/** Configuration for the cache. */
export interface CacheConfig {
  /** Maximum cache size in bytes. */
  maxSizeBytes: number;
  /** Maximum number of cache entries. */
  maxEntries: number;
}

/** Options for a cache entry. */
export interface CacheEntryOptions {
  /** Time-to-live in milliseconds. */
  ttlMs?: number;
  /** Tags for group invalidation. */
  tags?: string[];
}

/** Metadata about a cache entry. */
export interface CacheEntryMetadata {
  /** When the entry was created (ISO 8601). */
  createdAt: string;
  /** When the entry was last accessed (ISO 8601). */
  lastAccessedAt: string;
  /** When the entry expires (ISO 8601), or null if no TTL. */
  expiresAt: string | null;
  /** Tags for group invalidation. */
  tags: string[];
  /** Estimated size in bytes. */
  sizeBytes: number;
}

/** A sync queue item for deferred operations. */
export interface SyncQueueItem {
  /** Type of the data (e.g., "session", "agent"). */
  type: string;
  /** Key identifying the data. */
  key: string;
  /** Operation to perform when online. */
  operation: "create" | "update" | "delete";
  /** ISO 8601 timestamp when the item was queued. */
  timestamp: string;
}

/** Cache quota usage info. */
export interface QuotaUsage {
  /** Used bytes. */
  usedBytes: number;
  /** Maximum allowed bytes. */
  maxBytes: number;
  /** Percentage used (0-100). */
  percentage: number;
  /** Number of entries. */
  entryCount: number;
  /** Maximum allowed entries. */
  maxEntries: number;
}

/** Internal cache entry. */
interface CacheEntry {
  value: unknown;
  metadata: CacheEntryMetadata;
}

/**
 * Manages offline cache with TTL-based expiration, LRU eviction,
 * tag-based invalidation, and a sync queue.
 */
export class OfflineCacheManager {
  private entries: Map<string, CacheEntry> = new Map();
  private syncQueue: SyncQueueItem[] = [];
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
  }

  /**
   * Store a value in the cache.
   */
  put(
    key: string,
    value: unknown,
    options: CacheEntryOptions = {}
  ): void {
    const now = new Date().toISOString();
    const sizeBytes = this.estimateSize(value);

    const expiresAt = options.ttlMs
      ? new Date(Date.now() + options.ttlMs).toISOString()
      : null;

    const entry: CacheEntry = {
      value,
      metadata: {
        createdAt: now,
        lastAccessedAt: now,
        expiresAt,
        tags: options.tags ?? [],
        sizeBytes,
      },
    };

    this.entries.set(key, entry);
    this.enforceQuota();
  }

  /**
   * Get a value from the cache. Returns undefined if not found or expired.
   */
  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // Check expiry
    if (entry.metadata.expiresAt) {
      if (new Date(entry.metadata.expiresAt).getTime() <= Date.now()) {
        this.entries.delete(key);
        return undefined;
      }
    }

    // Update last accessed
    entry.metadata.lastAccessedAt = new Date().toISOString();
    return entry.value;
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete an entry from the cache.
   */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get the number of cache entries.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Touch an entry to reset its TTL.
   */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.metadata.lastAccessedAt = new Date().toISOString();

    // If entry has a TTL, reset expiry based on original TTL
    if (entry.metadata.expiresAt && entry.metadata.createdAt) {
      const originalCreated = new Date(entry.metadata.createdAt).getTime();
      const originalExpiry = new Date(entry.metadata.expiresAt).getTime();
      const ttl = originalExpiry - originalCreated;
      entry.metadata.expiresAt = new Date(Date.now() + ttl).toISOString();
      entry.metadata.createdAt = new Date().toISOString();
    }
  }

  /**
   * Remove expired entries.
   */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.metadata.expiresAt) {
        if (new Date(entry.metadata.expiresAt).getTime() <= now) {
          this.entries.delete(key);
        }
      }
    }
  }

  /**
   * Invalidate all entries whose key starts with the given prefix.
   */
  invalidateByPrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Invalidate all entries that have the given tag.
   */
  invalidateByTag(tag: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.metadata.tags.includes(tag)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Get estimated total size of the cache in bytes.
   */
  estimatedSizeBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.metadata.sizeBytes;
    }
    return total;
  }

  /**
   * Get cache quota usage information.
   */
  getQuotaUsage(): QuotaUsage {
    const usedBytes = this.estimatedSizeBytes();
    return {
      usedBytes,
      maxBytes: this.config.maxSizeBytes,
      percentage: Math.min(
        100,
        Math.round((usedBytes / this.config.maxSizeBytes) * 100)
      ),
      entryCount: this.entries.size,
      maxEntries: this.config.maxEntries,
    };
  }

  /**
   * Get metadata for a cache entry.
   */
  getMetadata(key: string): CacheEntryMetadata | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { ...entry.metadata, tags: [...entry.metadata.tags] };
  }

  /**
   * Get all cache keys.
   */
  getAllKeys(): string[] {
    return Array.from(this.entries.keys());
  }

  // -- Sync Queue --

  /**
   * Add an item to the sync queue.
   */
  enqueueSyncItem(item: SyncQueueItem): void {
    this.syncQueue.push({ ...item });
  }

  /**
   * Remove and return the first item from the sync queue.
   */
  dequeueSyncItem(): SyncQueueItem | undefined {
    return this.syncQueue.shift();
  }

  /**
   * Get the sync queue.
   */
  getSyncQueue(): SyncQueueItem[] {
    return this.syncQueue.map((item) => ({ ...item }));
  }

  /**
   * Clear the sync queue.
   */
  clearSyncQueue(): void {
    this.syncQueue = [];
  }

  // -- Private --

  private estimateSize(value: unknown): number {
    try {
      return JSON.stringify(value).length * 2; // Rough estimate: 2 bytes per char
    } catch {
      return 0;
    }
  }

  private enforceQuota(): void {
    // Evict LRU entries if over max entries
    while (this.entries.size > this.config.maxEntries) {
      this.evictLRU();
    }

    // Evict LRU entries if over max size
    while (
      this.estimatedSizeBytes() > this.config.maxSizeBytes &&
      this.entries.size > 0
    ) {
      this.evictLRU();
    }
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      const accessTime = new Date(
        entry.metadata.lastAccessedAt
      ).getTime();
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }
}
