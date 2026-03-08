/**
 * Tests for the Zustand storage adapter.
 *
 * Verifies get/set/remove operations and the clearStorage helper.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { zustandStorage, clearStorage } from "../../../lib/storage.js";

describe("zustandStorage", () => {
  beforeEach(() => {
    clearStorage();
  });

  it("getItem returns null for non-existent key", async () => {
    const result = await zustandStorage.getItem("nonexistent");
    expect(result).toBeNull();
  });

  it("setItem stores and getItem retrieves a value", async () => {
    await zustandStorage.setItem("test-key", '{"value":"hello"}');
    const result = await zustandStorage.getItem("test-key");
    expect(result).toBe('{"value":"hello"}');
  });

  it("removeItem deletes a stored value", async () => {
    await zustandStorage.setItem("key-to-remove", "data");
    await zustandStorage.removeItem("key-to-remove");
    const result = await zustandStorage.getItem("key-to-remove");
    expect(result).toBeNull();
  });

  it("setItem overwrites existing value", async () => {
    await zustandStorage.setItem("overwrite-key", "first");
    await zustandStorage.setItem("overwrite-key", "second");
    const result = await zustandStorage.getItem("overwrite-key");
    expect(result).toBe("second");
  });

  it("clearStorage removes all entries", async () => {
    await zustandStorage.setItem("k1", "v1");
    await zustandStorage.setItem("k2", "v2");
    clearStorage();
    expect(await zustandStorage.getItem("k1")).toBeNull();
    expect(await zustandStorage.getItem("k2")).toBeNull();
  });
});
