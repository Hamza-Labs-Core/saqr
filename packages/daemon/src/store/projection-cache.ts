/**
 * ProjectionCache — in-memory cache for projection results.
 *
 * The projection cache accelerates repeated queries by storing computed
 * projection results in memory. It operates with a configurable memory
 * budget and TTL-based expiration.
 *
 * Design principles (Story 04):
 * - Cache is a performance optimization, not a source of truth
 * - All cached data can be reconstructed from event files on disk
 * - Memory budget prevents unbounded growth
 * - Pre-warming on startup for recently active projects
 * - Invalidation on new events via EventBus subscription
 */

/**
 * A cached projection entry.
 */
export interface CacheEntry<T = unknown> {
  /** The cached projection data */
  data: T;

  /** When this entry was created */
  createdAt: Date;

  /** When this entry expires */
  expiresAt: Date;

  /** Monotonic access counter for deterministic LRU ordering */
  accessOrder: number;

  /** Approximate size in bytes (for memory budget tracking) */
  sizeBytes: number;

  /** The event sequence that this projection was built up to */
  builtUpToSequence: number;
}

/**
 * Cache statistics.
 */
export interface CacheStats {
  /** Number of entries in the cache */
  entryCount: number;

  /** Total memory used by cached entries (approximate) */
  memoryUsedBytes: number;

  /** Configured memory budget */
  memoryBudgetBytes: number;

  /** Cache hit count since last reset */
  hits: number;

  /** Cache miss count since last reset */
  misses: number;

  /** Hit rate as a fraction (0-1) */
  hitRate: number;

  /** Number of LRU evictions since last reset */
  evictionCount: number;
}

/**
 * In-memory projection cache with memory budget and TTL.
 */
export class ProjectionCache {
  private readonly maxMemoryBytes: number;
  private readonly ttlSeconds: number;
  private readonly entries = new Map<string, CacheEntry>();
  private memoryUsedBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictionCount = 0;
  /** Monotonic counter for deterministic LRU ordering */
  private accessCounter = 0;

  /**
   * Creates a new ProjectionCache.
   *
   * @param maxMemoryBytes - Maximum memory budget for cached data
   * @param ttlSeconds - Time-to-live for cache entries in seconds
   */
  constructor(maxMemoryBytes: number, ttlSeconds: number) {
    this.maxMemoryBytes = maxMemoryBytes;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Get a cached projection by key.
   *
   * @param key - Cache key (typically "{projectionType}:{projectId}:{sessionId}")
   * @returns The cached data, or undefined if not found or expired
   */
  get<T = unknown>(key: string): T | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check if entry has expired
    const now = new Date();
    if (now >= entry.expiresAt) {
      // Evict expired entry
      this.memoryUsedBytes -= entry.sizeBytes;
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }

    // Update access order for LRU
    entry.accessOrder = ++this.accessCounter;
    this.hits++;
    return entry.data as T;
  }

  /**
   * Store a projection result in the cache.
   *
   * @param key - Cache key
   * @param data - The projection data to cache
   * @param sizeBytes - Approximate size of the data in bytes
   * @param builtUpToSequence - The event sequence this projection covers
   */
  set<T = unknown>(
    key: string,
    data: T,
    sizeBytes: number,
    builtUpToSequence: number,
  ): void {
    // Remove old entry's memory accounting if replacing
    const existing = this.entries.get(key);
    if (existing) {
      this.memoryUsedBytes -= existing.sizeBytes;
      this.entries.delete(key);
    }

    // Enforce memory budget before inserting
    this.evictIfNeeded(sizeBytes);

    const now = new Date();
    const entry: CacheEntry<T> = {
      data,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
      accessOrder: ++this.accessCounter,
      sizeBytes,
      builtUpToSequence,
    };

    this.entries.set(key, entry as CacheEntry);
    this.memoryUsedBytes += sizeBytes;
  }

  /**
   * Invalidate a cached entry by key.
   *
   * @param key - The cache key to invalidate
   */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.memoryUsedBytes -= entry.sizeBytes;
      this.entries.delete(key);
    }
  }

  /**
   * Invalidate all entries for a given project/session.
   *
   * @param projectId - Project to invalidate
   * @param sessionId - Optional session within the project
   */
  invalidateForSession(projectId: string, sessionId?: string): void {
    const keysToDelete: string[] = [];

    for (const key of this.entries.keys()) {
      if (sessionId) {
        // Match entries containing both projectId and sessionId
        if (key.includes(projectId) && key.includes(sessionId)) {
          keysToDelete.push(key);
        }
      } else {
        // Match entries containing projectId
        if (key.includes(projectId)) {
          keysToDelete.push(key);
        }
      }
    }

    for (const key of keysToDelete) {
      this.invalidate(key);
    }
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.entries.clear();
    this.memoryUsedBytes = 0;
  }

  /**
   * Get cache statistics.
   *
   * @returns Current cache stats
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entryCount: this.entries.size,
      memoryUsedBytes: this.memoryUsedBytes,
      memoryBudgetBytes: this.maxMemoryBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      evictionCount: this.evictionCount,
    };
  }

  /**
   * Pre-warm the cache for recently active projects.
   *
   * Called during daemon startup to populate the cache with
   * projections for projects that were recently active.
   *
   * @param projectIds - Projects to pre-warm
   */
  async prewarm(projectIds: string[]): Promise<void> {
    // Pre-warming is a no-op in this base implementation.
    // In production, this would be connected to the EventStore
    // to load recent projection files from disk.
    void projectIds;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evict LRU entries if adding newSizeBytes would exceed the budget.
   *
   * Evicts to 80% of budget to avoid thrashing.
   */
  private evictIfNeeded(newSizeBytes: number): void {
    if (this.memoryUsedBytes + newSizeBytes <= this.maxMemoryBytes) {
      return;
    }

    // Target: evict until we're at 80% of budget
    const target = Math.floor(this.maxMemoryBytes * 0.8) - newSizeBytes;

    // Sort entries by accessOrder ascending (least recently used first)
    const sortedEntries = [...this.entries.entries()].sort(
      (a, b) => a[1].accessOrder - b[1].accessOrder,
    );

    for (const [key, entry] of sortedEntries) {
      if (this.memoryUsedBytes <= target) break;

      this.memoryUsedBytes -= entry.sizeBytes;
      this.entries.delete(key);
      this.evictionCount++;
    }
  }
}
