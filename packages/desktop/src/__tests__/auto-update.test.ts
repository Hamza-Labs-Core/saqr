/**
 * Tests for Auto-Update Manager.
 *
 * Update check logic, version comparison, download progress tracking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AutoUpdateManager,
  compareVersions,
  parseUpdateResponse,
  type UpdateCheckResult,
  CHECK_INTERVAL_MS,
  INITIAL_DELAY_MS,
} from "../auto-update.js";
import type { UpdateInfo, UpdateProgress } from "../ipc-types.js";

describe("AutoUpdateManager", () => {
  let manager: AutoUpdateManager;

  beforeEach(() => {
    manager = new AutoUpdateManager("1.0.0");
  });

  describe("initial state", () => {
    it("should have the current version", () => {
      expect(manager.currentVersion).toBe("1.0.0");
    });

    it("should not be checking initially", () => {
      expect(manager.isChecking).toBe(false);
    });

    it("should not be downloading initially", () => {
      expect(manager.isDownloading).toBe(false);
    });

    it("should have no available update", () => {
      expect(manager.availableUpdate).toBeNull();
    });

    it("should have no download progress", () => {
      expect(manager.downloadProgress).toBeNull();
    });
  });

  describe("check result handling", () => {
    it("should store update info when available", () => {
      const update: UpdateInfo = {
        version: "1.1.0",
        notes: "Bug fixes",
        date: "2026-03-15T12:00:00Z",
      };

      manager.setCheckResult({ hasUpdate: true, update });

      expect(manager.availableUpdate).toEqual(update);
    });

    it("should clear update info when no update", () => {
      manager.setCheckResult({
        hasUpdate: true,
        update: { version: "1.1.0", notes: null, date: null },
      });
      manager.setCheckResult({ hasUpdate: false });

      expect(manager.availableUpdate).toBeNull();
    });

    it("should set checking state", () => {
      manager.setChecking(true);
      expect(manager.isChecking).toBe(true);

      manager.setChecking(false);
      expect(manager.isChecking).toBe(false);
    });
  });

  describe("download progress tracking", () => {
    it("should track download progress", () => {
      manager.setDownloading(true);
      expect(manager.isDownloading).toBe(true);

      const progress: UpdateProgress = {
        downloaded: 5000000,
        total: 10000000,
        percent: 50.0,
      };
      manager.updateProgress(progress);

      expect(manager.downloadProgress).toEqual(progress);
    });

    it("should clear progress when download starts", () => {
      manager.updateProgress({
        downloaded: 10000000,
        total: 10000000,
        percent: 100,
      });

      manager.setDownloading(true);
      // Progress should reset when a new download starts
      expect(manager.downloadProgress).toBeNull();
    });

    it("should handle unknown total size", () => {
      const progress: UpdateProgress = {
        downloaded: 5000000,
        total: null,
        percent: -1.0,
      };
      manager.updateProgress(progress);

      expect(manager.downloadProgress?.total).toBeNull();
      expect(manager.downloadProgress?.percent).toBe(-1.0);
    });

    it("should reset state when download completes", () => {
      manager.setDownloading(true);
      manager.updateProgress({
        downloaded: 10000000,
        total: 10000000,
        percent: 100,
      });

      manager.setDownloading(false);

      expect(manager.isDownloading).toBe(false);
    });
  });

  describe("check/download error handling", () => {
    it("should store last error", () => {
      manager.setError("Network timeout");

      expect(manager.lastError).toBe("Network timeout");
    });

    it("should clear error on successful check", () => {
      manager.setError("Network timeout");
      manager.setCheckResult({ hasUpdate: false });

      expect(manager.lastError).toBeNull();
    });
  });

  describe("constants", () => {
    it("should have 6-hour check interval", () => {
      expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    });

    it("should have 30-second initial delay", () => {
      expect(INITIAL_DELAY_MS).toBe(30 * 1000);
    });
  });
});

describe("compareVersions", () => {
  it("should return 0 for equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("should return positive when first is newer (major)", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0);
  });

  it("should return negative when first is older (major)", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("should compare minor versions", () => {
    expect(compareVersions("1.2.0", "1.1.0")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.2.0")).toBeLessThan(0);
  });

  it("should compare patch versions", () => {
    expect(compareVersions("1.0.2", "1.0.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.2")).toBeLessThan(0);
  });

  it("should handle version with different segment counts", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
  });

  it("should handle versions with leading zeros", () => {
    expect(compareVersions("1.01.0", "1.1.0")).toBe(0);
  });
});

describe("parseUpdateResponse", () => {
  it("should parse valid update server response", () => {
    const response = {
      version: "1.1.0",
      notes: "Bug fixes and improvements",
      pub_date: "2026-03-15T12:00:00Z",
      platforms: {
        "darwin-aarch64": {
          signature: "abc123",
          url: "https://releases.example.com/v1.1.0/app.tar.gz",
        },
      },
    };

    const result = parseUpdateResponse(response);

    expect(result).not.toBeNull();
    expect(result?.version).toBe("1.1.0");
    expect(result?.notes).toBe("Bug fixes and improvements");
    expect(result?.date).toBe("2026-03-15T12:00:00Z");
  });

  it("should return null for invalid response", () => {
    expect(parseUpdateResponse(null)).toBeNull();
    expect(parseUpdateResponse(undefined)).toBeNull();
    expect(parseUpdateResponse({})).toBeNull();
    expect(parseUpdateResponse({ version: 123 })).toBeNull();
  });

  it("should handle response without optional fields", () => {
    const response = {
      version: "1.1.0",
      platforms: {},
    };

    const result = parseUpdateResponse(response);

    expect(result).not.toBeNull();
    expect(result?.version).toBe("1.1.0");
    expect(result?.notes).toBeNull();
    expect(result?.date).toBeNull();
  });
});
