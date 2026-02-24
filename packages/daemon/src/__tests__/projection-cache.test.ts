/**
 * Tests for the ProjectionCache — in-memory LRU cache with memory budget and TTL.
 *
 * Covers: T-24 through T-27 from Story 04 testing plan.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ProjectionCache } from "../store/projection-cache.js";

describe("ProjectionCache", () => {
  let cache: ProjectionCache;

  beforeEach(() => {
    // 1MB budget, 60 second TTL
    cache = new ProjectionCache(1024 * 1024, 60);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // T-24: get/set/invalidate lifecycle
  describe("basic get/set/invalidate", () => {
    it("should return undefined for a key that was never set", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("should store and retrieve a value", () => {
      cache.set("key1", { hello: "world" }, 100, 5);
      const result = cache.get("key1");
      expect(result).toEqual({ hello: "world" });
    });

    it("should invalidate a specific key", () => {
      cache.set("key1", { hello: "world" }, 100, 5);
      cache.invalidate("key1");
      expect(cache.get("key1")).toBeUndefined();
    });

    it("should replace existing entry on re-set", () => {
      cache.set("key1", { v: 1 }, 100, 5);
      cache.set("key1", { v: 2 }, 200, 10);
      expect(cache.get("key1")).toEqual({ v: 2 });
    });

    it("should clear all entries", () => {
      cache.set("key1", "a", 50, 1);
      cache.set("key2", "b", 50, 2);
      cache.clear();
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBeUndefined();
      expect(cache.getStats().entryCount).toBe(0);
      expect(cache.getStats().memoryUsedBytes).toBe(0);
    });
  });

  // TTL expiry
  describe("TTL expiration", () => {
    it("should expire entries after TTL", () => {
      vi.useFakeTimers();
      const shortCache = new ProjectionCache(1024 * 1024, 2); // 2 second TTL

      shortCache.set("key1", "value", 100, 1);
      expect(shortCache.get("key1")).toBe("value");

      // Advance time past TTL
      vi.advanceTimersByTime(3000);
      expect(shortCache.get("key1")).toBeUndefined();
    });

    it("should not expire entries before TTL", () => {
      vi.useFakeTimers();
      const shortCache = new ProjectionCache(1024 * 1024, 5); // 5 second TTL

      shortCache.set("key1", "value", 100, 1);

      // Advance time but not past TTL
      vi.advanceTimersByTime(3000);
      expect(shortCache.get("key1")).toBe("value");
    });
  });

  // Hit/miss counters
  describe("hit/miss tracking", () => {
    it("should track hits and misses", () => {
      cache.set("key1", "value", 100, 1);

      cache.get("key1"); // hit
      cache.get("key1"); // hit
      cache.get("nonexistent"); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it("should report 0 hit rate when no lookups", () => {
      expect(cache.getStats().hitRate).toBe(0);
    });
  });

  // T-25: LRU eviction removes oldest entry
  describe("LRU eviction", () => {
    it("should evict least recently used entries when memory budget is exceeded", () => {
      // Create a cache with a 500 byte budget
      const smallCache = new ProjectionCache(500, 60);

      smallCache.set("key1", "aaa", 200, 1);
      smallCache.set("key2", "bbb", 200, 2);

      // Access key1 to make it more recently used
      smallCache.get("key1");

      // This should trigger eviction since 200+200+200 > 500
      smallCache.set("key3", "ccc", 200, 3);

      // key2 should be evicted (LRU), key1 was accessed more recently
      expect(smallCache.get("key2")).toBeUndefined();
      expect(smallCache.get("key1")).toBeDefined();
      expect(smallCache.get("key3")).toBeDefined();
    });

    it("should evict to 80% of budget to prevent thrashing", () => {
      const smallCache = new ProjectionCache(500, 60);

      // Fill cache
      smallCache.set("key1", "a", 150, 1);
      smallCache.set("key2", "b", 150, 2);
      smallCache.set("key3", "c", 150, 3);

      // This should trigger eviction
      smallCache.set("key4", "d", 150, 4);

      // After eviction, should be at or below 80% = 400 bytes
      const stats = smallCache.getStats();
      expect(stats.memoryUsedBytes).toBeLessThanOrEqual(400);
    });

    it("should track eviction count", () => {
      const smallCache = new ProjectionCache(300, 60);

      smallCache.set("key1", "a", 150, 1);
      smallCache.set("key2", "b", 150, 2);
      // This triggers eviction
      smallCache.set("key3", "c", 150, 3);

      const stats = smallCache.getStats();
      expect(stats.evictionCount).toBeGreaterThan(0);
    });
  });

  // T-26: Memory budget is not exceeded
  describe("memory budget enforcement", () => {
    it("should never exceed the configured memory budget", () => {
      const smallCache = new ProjectionCache(1000, 60);

      for (let i = 0; i < 20; i++) {
        smallCache.set(`key${i}`, `value-${i}`, 200, i);
      }

      const stats = smallCache.getStats();
      expect(stats.memoryUsedBytes).toBeLessThanOrEqual(1000);
    });

    it("should handle entry larger than budget gracefully", () => {
      const smallCache = new ProjectionCache(100, 60);

      // This single entry exceeds the budget but should still work
      smallCache.set("big", "huge-data", 200, 1);

      // It should either store it (accepting overbudget) or reject it
      // Implementation choice: we store it but it will be the only entry
      const stats = smallCache.getStats();
      expect(stats.entryCount).toBeLessThanOrEqual(1);
    });
  });

  // T-27: Invalidation on new event clears session projections
  describe("session/project invalidation", () => {
    it("should invalidate all entries for a session", () => {
      cache.set("timeline:proj-a:sess-001", "timeline-data", 100, 5);
      cache.set("usage:proj-a:sess-001", "usage-data", 100, 5);
      cache.set("timeline:proj-a:sess-002", "other-data", 100, 5);

      cache.invalidateForSession("proj-a", "sess-001");

      expect(cache.get("timeline:proj-a:sess-001")).toBeUndefined();
      expect(cache.get("usage:proj-a:sess-001")).toBeUndefined();
      // Other session not affected
      expect(cache.get("timeline:proj-a:sess-002")).toBeDefined();
    });

    it("should invalidate all entries for a project (no session specified)", () => {
      cache.set("timeline:proj-a:sess-001", "data-1", 100, 5);
      cache.set("usage:proj-a:sess-002", "data-2", 100, 5);
      cache.set("timeline:proj-b:sess-003", "data-3", 100, 5);

      cache.invalidateForSession("proj-a");

      expect(cache.get("timeline:proj-a:sess-001")).toBeUndefined();
      expect(cache.get("usage:proj-a:sess-002")).toBeUndefined();
      // Other project not affected
      expect(cache.get("timeline:proj-b:sess-003")).toBeDefined();
    });

    it("should reclaim memory when invalidating", () => {
      cache.set("key1", "data", 500, 1);
      const before = cache.getStats().memoryUsedBytes;

      cache.invalidate("key1");
      const after = cache.getStats().memoryUsedBytes;

      expect(after).toBe(before - 500);
    });
  });

  describe("stats", () => {
    it("should report correct memory usage", () => {
      cache.set("key1", "a", 100, 1);
      cache.set("key2", "b", 200, 2);

      const stats = cache.getStats();
      expect(stats.memoryUsedBytes).toBe(300);
      expect(stats.memoryBudgetBytes).toBe(1024 * 1024);
      expect(stats.entryCount).toBe(2);
    });

    it("should adjust memory when replacing entries", () => {
      cache.set("key1", "a", 100, 1);
      expect(cache.getStats().memoryUsedBytes).toBe(100);

      cache.set("key1", "b", 200, 2);
      expect(cache.getStats().memoryUsedBytes).toBe(200);
    });
  });

  describe("prewarm", () => {
    it("should accept project IDs without error", async () => {
      // Pre-warm is a no-op currently (needs event store integration)
      // but should not throw
      await expect(cache.prewarm(["proj-a", "proj-b"])).resolves.not.toThrow();
    });
  });
});
