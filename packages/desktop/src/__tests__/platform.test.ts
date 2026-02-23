/**
 * Tests for Platform Detection.
 *
 * Determines whether the app is running inside Tauri or a browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTauri, getPlatformInfo } from "../platform.js";

describe("Platform Detection", () => {
  describe("isTauri", () => {
    it("should return false in test/node environment (no window.__TAURI__)", () => {
      expect(isTauri()).toBe(false);
    });

    it("should detect Tauri when __TAURI__ is on globalThis", () => {
      (globalThis as Record<string, unknown>)["__TAURI__"] = {};
      try {
        expect(isTauri()).toBe(true);
      } finally {
        delete (globalThis as Record<string, unknown>)["__TAURI__"];
      }
    });
  });

  describe("getPlatformInfo", () => {
    it("should return platform info object", () => {
      const info = getPlatformInfo();

      expect(info).toHaveProperty("isTauri");
      expect(info).toHaveProperty("platform");
      expect(typeof info.isTauri).toBe("boolean");
      expect(typeof info.platform).toBe("string");
    });

    it("should report non-Tauri in test environment", () => {
      const info = getPlatformInfo();
      expect(info.isTauri).toBe(false);
      expect(info.platform).toBe("browser");
    });
  });
});
