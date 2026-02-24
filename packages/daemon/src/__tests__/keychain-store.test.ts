/**
 * Tests for KeychainStore — platform keychain abstraction.
 *
 * Tests both DesktopKeychainStore (with mocked exec) and
 * FileKeychainStore (with real temp directories).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DesktopKeychainStore,
  FileKeychainStore,
  createKeychainStore,
} from "../security/keychain-store.js";
import type { KeychainStore } from "../security/keychain-store.js";

// ---------------------------------------------------------------------------
// FileKeychainStore Tests
// ---------------------------------------------------------------------------

describe("FileKeychainStore", () => {
  let tmpDir: string;
  let store: FileKeychainStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-keychain-test-"));
    store = new FileKeychainStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should store and retrieve a key", async () => {
    const keyData = "dGVzdC1rZXktZGF0YS1iYXNlNjQ="; // base64 test data
    await store.store(keyData, "master-key");

    const retrieved = await store.retrieve("master-key");
    expect(retrieved).toBe(keyData);
  });

  it("should return null for non-existent key", async () => {
    const result = await store.retrieve("nonexistent");
    expect(result).toBeNull();
  });

  it("should check if key exists", async () => {
    expect(await store.exists("my-key")).toBe(false);

    await store.store("some-data", "my-key");
    expect(await store.exists("my-key")).toBe(true);
  });

  it("should delete a key", async () => {
    await store.store("data", "delete-me");
    expect(await store.exists("delete-me")).toBe(true);

    const deleted = await store.delete("delete-me");
    expect(deleted).toBe(true);
    expect(await store.exists("delete-me")).toBe(false);
  });

  it("should return false when deleting non-existent key", async () => {
    const deleted = await store.delete("nonexistent");
    expect(deleted).toBe(false);
  });

  it("should overwrite existing key", async () => {
    await store.store("original", "my-key");
    await store.store("updated", "my-key");

    const retrieved = await store.retrieve("my-key");
    expect(retrieved).toBe("updated");
  });

  it("should create store directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "keychain");
    const nestedStore = new FileKeychainStore(nestedDir);

    await nestedStore.store("data", "key");
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it("should store files with restrictive permissions (0o600)", async () => {
    await store.store("secret-data", "restricted-key");

    const keyPath = path.join(tmpDir, "restricted-key.key");
    const stats = fs.statSync(keyPath);
    // 0o600 = owner read/write only
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("should sanitize label to prevent directory traversal", async () => {
    // Labels with path separators should be sanitized
    await store.store("data", "../../../etc/passwd");
    // File should be in the store dir, not outside it
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0]).not.toContain("..");
  });

  it("should handle multiple keys", async () => {
    await store.store("key1-data", "key-1");
    await store.store("key2-data", "key-2");
    await store.store("key3-data", "key-3");

    expect(await store.retrieve("key-1")).toBe("key1-data");
    expect(await store.retrieve("key-2")).toBe("key2-data");
    expect(await store.retrieve("key-3")).toBe("key3-data");
  });
});

// ---------------------------------------------------------------------------
// DesktopKeychainStore Tests (mocked exec)
// ---------------------------------------------------------------------------

describe("DesktopKeychainStore", () => {
  describe("macOS (darwin)", () => {
    let execMock: ReturnType<typeof vi.fn>;
    let store: DesktopKeychainStore;

    beforeEach(() => {
      execMock = vi.fn();
      store = new DesktopKeychainStore("darwin", execMock as any);
    });

    it("should store a key using security add-generic-password", async () => {
      execMock.mockResolvedValue({ stdout: "", stderr: "" });

      await store.store("my-secret-key", "master");

      // First call: delete (may fail, that's OK)
      expect(execMock).toHaveBeenCalledWith("security", [
        "delete-generic-password",
        "-s",
        "com.saqr.daemon.master",
        "-a",
        "master",
      ]);

      // Second call: add
      expect(execMock).toHaveBeenCalledWith("security", [
        "add-generic-password",
        "-s",
        "com.saqr.daemon.master",
        "-a",
        "master",
        "-w",
        "my-secret-key",
        "-U",
      ]);
    });

    it("should retrieve a key using security find-generic-password", async () => {
      execMock.mockResolvedValue({ stdout: "my-secret-key\n", stderr: "" });

      const result = await store.retrieve("master");
      expect(result).toBe("my-secret-key");

      expect(execMock).toHaveBeenCalledWith("security", [
        "find-generic-password",
        "-s",
        "com.saqr.daemon.master",
        "-a",
        "master",
        "-w",
      ]);
    });

    it("should return null when key not found", async () => {
      execMock.mockRejectedValue(new Error("SecKeychainSearchCopyMatching"));

      const result = await store.retrieve("nonexistent");
      expect(result).toBeNull();
    });

    it("should delete a key", async () => {
      execMock.mockResolvedValue({ stdout: "", stderr: "" });

      const result = await store.delete("master");
      expect(result).toBe(true);

      expect(execMock).toHaveBeenCalledWith("security", [
        "delete-generic-password",
        "-s",
        "com.saqr.daemon.master",
        "-a",
        "master",
      ]);
    });

    it("should return false when deleting non-existent key", async () => {
      execMock.mockRejectedValue(new Error("Not found"));

      const result = await store.delete("nonexistent");
      expect(result).toBe(false);
    });

    it("should check existence via retrieve", async () => {
      execMock.mockResolvedValue({ stdout: "key-data\n", stderr: "" });

      const exists = await store.exists("master");
      expect(exists).toBe(true);
    });
  });

  describe("Linux", () => {
    let execMock: ReturnType<typeof vi.fn>;
    let store: DesktopKeychainStore;

    beforeEach(() => {
      execMock = vi.fn();
      store = new DesktopKeychainStore("linux", execMock as any);
    });

    it("should store a key using secret-tool", async () => {
      execMock.mockResolvedValue({ stdout: "", stderr: "" });

      await store.store("linux-key-data", "my-key");

      expect(execMock).toHaveBeenCalledWith(
        "secret-tool",
        [
          "store",
          "--label",
          "my-key",
          "service",
          "com.saqr.daemon.my-key",
          "account",
          "my-key",
        ],
        { input: "linux-key-data" },
      );
    });

    it("should retrieve a key using secret-tool lookup", async () => {
      execMock.mockResolvedValue({ stdout: "linux-key-data", stderr: "" });

      const result = await store.retrieve("my-key");
      expect(result).toBe("linux-key-data");
    });

    it("should delete a key using secret-tool clear", async () => {
      execMock.mockResolvedValue({ stdout: "", stderr: "" });

      const result = await store.delete("my-key");
      expect(result).toBe(true);

      expect(execMock).toHaveBeenCalledWith("secret-tool", [
        "clear",
        "service",
        "com.saqr.daemon.my-key",
        "account",
        "my-key",
      ]);
    });
  });

  describe("Windows", () => {
    let execMock: ReturnType<typeof vi.fn>;
    let store: DesktopKeychainStore;

    beforeEach(() => {
      execMock = vi.fn();
      store = new DesktopKeychainStore("win32", execMock as any);
    });

    it("should store a key using cmdkey", async () => {
      execMock.mockResolvedValue({ stdout: "", stderr: "" });

      await store.store("win-key", "master");

      expect(execMock).toHaveBeenCalledWith("cmdkey", [
        "/add:com.saqr.daemon.master",
        "/user:master",
        "/pass:win-key",
      ]);
    });

    it("should delete a key using cmdkey", async () => {
      execMock.mockResolvedValue({ stdout: "", stderr: "" });

      const result = await store.delete("master");
      expect(result).toBe(true);

      expect(execMock).toHaveBeenCalledWith("cmdkey", [
        "/delete:com.saqr.daemon.master",
      ]);
    });
  });

  describe("Unsupported platform", () => {
    it("should throw for unsupported platform on store", async () => {
      const store = new DesktopKeychainStore(
        "freebsd" as NodeJS.Platform,
        vi.fn() as any,
      );

      await expect(store.store("data", "key")).rejects.toThrow(
        "Unsupported platform",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// createKeychainStore Tests
// ---------------------------------------------------------------------------

describe("createKeychainStore", () => {
  it("should return a KeychainStore instance", () => {
    const store = createKeychainStore(
      path.join(os.tmpdir(), "saqr-test-create"),
    );
    expect(store).toBeDefined();
    // Should have the KeychainStore interface methods
    expect(typeof store.store).toBe("function");
    expect(typeof store.retrieve).toBe("function");
    expect(typeof store.delete).toBe("function");
    expect(typeof store.exists).toBe("function");
  });
});
