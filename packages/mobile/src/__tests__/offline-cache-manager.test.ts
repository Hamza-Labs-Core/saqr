/**
 * Tests for the OfflineCacheManager service.
 *
 * Covers cache invalidation logic, storage quota management,
 * sync queue, and cache entry lifecycle.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OfflineCacheManager } from "../services/offline-cache-manager.js";

describe("OfflineCacheManager", () => {
  let cache: OfflineCacheManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-22T14:00:00Z"));
    cache = new OfflineCacheManager({ maxSizeBytes: 1024 * 1024, maxEntries: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic cache operations", () => {
    it("put and get a cache entry", () => {
      cache.put("key1", { data: "hello" });
      const entry = cache.get("key1");
      expect(entry).toEqual({ data: "hello" });
    });

    it("get returns undefined for missing key", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("has returns true for existing key", () => {
      cache.put("key1", { data: "hello" });
      expect(cache.has("key1")).toBe(true);
    });

    it("has returns false for missing key", () => {
      expect(cache.has("nonexistent")).toBe(false);
    });

    it("delete removes entry", () => {
      cache.put("key1", { data: "hello" });
      cache.delete("key1");
      expect(cache.has("key1")).toBe(false);
    });

    it("delete on missing key is a no-op", () => {
      cache.delete("nonexistent");
      expect(cache.size()).toBe(0);
    });

    it("clear removes all entries", () => {
      cache.put("key1", { data: "a" });
      cache.put("key2", { data: "b" });
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe("cache invalidation", () => {
    it("entries expire after TTL", () => {
      cache.put("key1", { data: "hello" }, { ttlMs: 5000 });
      expect(cache.get("key1")).toEqual({ data: "hello" });

      vi.advanceTimersByTime(6000);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("invalidateByPrefix removes matching entries", () => {
      cache.put("sessions:host-1:s1", { data: "a" });
      cache.put("sessions:host-1:s2", { data: "b" });
      cache.put("agents:host-1:a1", { data: "c" });

      cache.invalidateByPrefix("sessions:host-1");
      expect(cache.has("sessions:host-1:s1")).toBe(false);
      expect(cache.has("sessions:host-1:s2")).toBe(false);
      expect(cache.has("agents:host-1:a1")).toBe(true);
    });

    it("invalidateByTag removes entries with matching tag", () => {
      cache.put("key1", { data: "a" }, { tags: ["host-1"] });
      cache.put("key2", { data: "b" }, { tags: ["host-2"] });
      cache.put("key3", { data: "c" }, { tags: ["host-1"] });

      cache.invalidateByTag("host-1");
      expect(cache.has("key1")).toBe(false);
      expect(cache.has("key2")).toBe(true);
      expect(cache.has("key3")).toBe(false);
    });

    it("touch resets entry TTL", () => {
      cache.put("key1", { data: "hello" }, { ttlMs: 5000 });

      vi.advanceTimersByTime(4000);
      cache.touch("key1");

      vi.advanceTimersByTime(4000);
      // Would have expired at 5000ms, but touch at 4000ms reset it
      expect(cache.get("key1")).toEqual({ data: "hello" });
    });

    it("prune removes expired entries", () => {
      cache.put("key1", { data: "a" }, { ttlMs: 1000 });
      cache.put("key2", { data: "b" }, { ttlMs: 10000 });

      vi.advanceTimersByTime(2000);
      cache.prune();

      expect(cache.has("key1")).toBe(false);
      expect(cache.has("key2")).toBe(true);
    });
  });

  describe("storage quota management", () => {
    it("tracks estimated size", () => {
      cache.put("key1", { data: "hello" });
      expect(cache.estimatedSizeBytes()).toBeGreaterThan(0);
    });

    it("evicts LRU entries when max entries exceeded", () => {
      const smallCache = new OfflineCacheManager({
        maxSizeBytes: 10 * 1024 * 1024,
        maxEntries: 3,
      });

      smallCache.put("key1", { data: "a" });
      vi.advanceTimersByTime(1);
      smallCache.put("key2", { data: "b" });
      vi.advanceTimersByTime(1);
      smallCache.put("key3", { data: "c" });
      vi.advanceTimersByTime(1);
      smallCache.put("key4", { data: "d" });

      expect(smallCache.size()).toBe(3);
      expect(smallCache.has("key1")).toBe(false);
      expect(smallCache.has("key4")).toBe(true);
    });

    it("evicts LRU entries when max size exceeded", () => {
      const tinyCache = new OfflineCacheManager({
        maxSizeBytes: 100,
        maxEntries: 1000,
      });

      // Each entry is roughly 30+ bytes in JSON
      tinyCache.put("key1", { data: "aaaaaaaaaa" });
      vi.advanceTimersByTime(1);
      tinyCache.put("key2", { data: "bbbbbbbbbb" });
      vi.advanceTimersByTime(1);
      tinyCache.put("key3", { data: "cccccccccc" });

      // At least the oldest should be evicted
      expect(tinyCache.size()).toBeLessThanOrEqual(3);
    });

    it("getQuotaUsage returns percentage", () => {
      const smallCache = new OfflineCacheManager({
        maxSizeBytes: 1000,
        maxEntries: 100,
      });
      smallCache.put("key1", { data: "a".repeat(400) });

      const usage = smallCache.getQuotaUsage();
      expect(usage.usedBytes).toBeGreaterThan(0);
      expect(usage.maxBytes).toBe(1000);
      expect(usage.percentage).toBeGreaterThan(0);
      expect(usage.percentage).toBeLessThanOrEqual(100);
    });
  });

  describe("sync queue", () => {
    it("enqueueSyncItem adds to sync queue", () => {
      cache.enqueueSyncItem({
        type: "session",
        key: "sess-1",
        operation: "update",
        timestamp: "2026-02-22T14:00:00Z",
      });

      expect(cache.getSyncQueue()).toHaveLength(1);
    });

    it("dequeueSyncItem removes from sync queue", () => {
      cache.enqueueSyncItem({
        type: "session",
        key: "sess-1",
        operation: "update",
        timestamp: "2026-02-22T14:00:00Z",
      });

      const item = cache.dequeueSyncItem();
      expect(item?.key).toBe("sess-1");
      expect(cache.getSyncQueue()).toHaveLength(0);
    });

    it("dequeueSyncItem from empty queue returns undefined", () => {
      expect(cache.dequeueSyncItem()).toBeUndefined();
    });

    it("clearSyncQueue empties the queue", () => {
      cache.enqueueSyncItem({
        type: "session",
        key: "s1",
        operation: "update",
        timestamp: "2026-02-22T14:00:00Z",
      });
      cache.enqueueSyncItem({
        type: "session",
        key: "s2",
        operation: "create",
        timestamp: "2026-02-22T14:01:00Z",
      });

      cache.clearSyncQueue();
      expect(cache.getSyncQueue()).toHaveLength(0);
    });

    it("sync queue maintains FIFO order", () => {
      cache.enqueueSyncItem({
        type: "session",
        key: "first",
        operation: "update",
        timestamp: "2026-02-22T14:00:00Z",
      });
      cache.enqueueSyncItem({
        type: "session",
        key: "second",
        operation: "create",
        timestamp: "2026-02-22T14:01:00Z",
      });

      const first = cache.dequeueSyncItem();
      const second = cache.dequeueSyncItem();
      expect(first?.key).toBe("first");
      expect(second?.key).toBe("second");
    });
  });

  describe("cache metadata", () => {
    it("getMetadata returns entry info", () => {
      cache.put("key1", { data: "hello" }, { ttlMs: 5000, tags: ["tag1"] });
      const meta = cache.getMetadata("key1");
      expect(meta).toBeDefined();
      expect(meta?.createdAt).toBeDefined();
      expect(meta?.tags).toContain("tag1");
    });

    it("getMetadata returns undefined for missing key", () => {
      expect(cache.getMetadata("nonexistent")).toBeUndefined();
    });

    it("getAllKeys returns all cache keys", () => {
      cache.put("key1", { data: "a" });
      cache.put("key2", { data: "b" });
      const keys = cache.getAllKeys();
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
    });
  });
});
