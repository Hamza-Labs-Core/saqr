/**
 * Tests for App Configuration.
 *
 * Settings persistence, default values, migration logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  AppConfigManager,
  migrateConfig,
  validateConfig,
  CONFIG_VERSION,
} from "../app-config.js";
import type { AppConfig } from "../ipc-types.js";
import { DEFAULT_APP_CONFIG } from "../ipc-types.js";

describe("AppConfigManager", () => {
  let manager: AppConfigManager;

  beforeEach(() => {
    manager = new AppConfigManager();
  });

  describe("defaults", () => {
    it("should start with default configuration", () => {
      const config = manager.getConfig();
      expect(config).toEqual(DEFAULT_APP_CONFIG);
    });

    it("should have correct default daemon port", () => {
      expect(manager.getConfig().daemon_port).toBe(7399);
    });

    it("should have correct default theme", () => {
      expect(manager.getConfig().theme).toBe("system");
    });

    it("should have auto_start disabled by default", () => {
      expect(manager.getConfig().auto_start).toBe(false);
    });

    it("should have minimize_to_tray enabled by default", () => {
      expect(manager.getConfig().minimize_to_tray).toBe(true);
    });

    it("should have update checking enabled by default", () => {
      expect(manager.getConfig().check_updates).toBe(true);
    });

    it("should have 6-hour update check interval by default", () => {
      expect(manager.getConfig().update_check_interval_hours).toBe(6);
    });
  });

  describe("get and set", () => {
    it("should update a single config value", () => {
      manager.set("theme", "dark");
      expect(manager.getConfig().theme).toBe("dark");
    });

    it("should update daemon_port", () => {
      manager.set("daemon_port", 9999);
      expect(manager.getConfig().daemon_port).toBe(9999);
    });

    it("should update auto_start", () => {
      manager.set("auto_start", true);
      expect(manager.getConfig().auto_start).toBe(true);
    });

    it("should not affect other config values when setting one", () => {
      manager.set("theme", "light");
      expect(manager.getConfig().daemon_port).toBe(7399);
      expect(manager.getConfig().auto_start).toBe(false);
    });
  });

  describe("update (bulk)", () => {
    it("should merge multiple values", () => {
      manager.update({
        theme: "dark",
        daemon_port: 8080,
        auto_start: true,
      });

      const config = manager.getConfig();
      expect(config.theme).toBe("dark");
      expect(config.daemon_port).toBe(8080);
      expect(config.auto_start).toBe(true);
      expect(config.minimize_to_tray).toBe(true); // unchanged
    });
  });

  describe("reset", () => {
    it("should reset to defaults", () => {
      manager.set("theme", "dark");
      manager.set("daemon_port", 9999);

      manager.reset();

      expect(manager.getConfig()).toEqual(DEFAULT_APP_CONFIG);
    });
  });

  describe("serialization", () => {
    it("should serialize and deserialize correctly", () => {
      manager.set("theme", "dark");
      manager.set("daemon_port", 8080);

      const serialized = manager.serialize();
      const newManager = AppConfigManager.deserialize(serialized);

      expect(newManager.getConfig().theme).toBe("dark");
      expect(newManager.getConfig().daemon_port).toBe(8080);
    });

    it("should handle invalid JSON gracefully with defaults", () => {
      const newManager = AppConfigManager.deserialize("not json");
      expect(newManager.getConfig()).toEqual(DEFAULT_APP_CONFIG);
    });

    it("should handle empty string with defaults", () => {
      const newManager = AppConfigManager.deserialize("");
      expect(newManager.getConfig()).toEqual(DEFAULT_APP_CONFIG);
    });

    it("should include config version in serialized output", () => {
      const serialized = manager.serialize();
      const parsed = JSON.parse(serialized);
      expect(parsed._version).toBe(CONFIG_VERSION);
    });
  });
});

describe("migrateConfig", () => {
  it("should return current config if version matches", () => {
    const config = { ...DEFAULT_APP_CONFIG, _version: CONFIG_VERSION };
    const result = migrateConfig(config);
    expect(result).toEqual(config);
  });

  it("should add missing fields from defaults", () => {
    const oldConfig = {
      _version: 1,
      daemon_port: 7399,
      theme: "dark" as const,
    };

    const result = migrateConfig(oldConfig);

    expect(result.daemon_port).toBe(7399);
    expect(result.theme).toBe("dark");
    expect(result.auto_start).toBe(false); // from defaults
    expect(result.minimize_to_tray).toBe(true); // from defaults
    expect(result._version).toBe(CONFIG_VERSION);
  });

  it("should preserve user values during migration", () => {
    const oldConfig = {
      _version: 1,
      daemon_port: 9999,
      theme: "light" as const,
      auto_start: true,
      minimize_to_tray: false,
    };

    const result = migrateConfig(oldConfig);

    expect(result.daemon_port).toBe(9999);
    expect(result.theme).toBe("light");
    expect(result.auto_start).toBe(true);
    expect(result.minimize_to_tray).toBe(false);
  });

  it("should handle missing version field", () => {
    const oldConfig = {
      daemon_port: 7399,
      theme: "system" as const,
    };

    const result = migrateConfig(oldConfig);

    expect(result._version).toBe(CONFIG_VERSION);
  });
});

describe("validateConfig", () => {
  it("should accept valid config", () => {
    expect(validateConfig(DEFAULT_APP_CONFIG)).toBe(true);
  });

  it("should reject invalid daemon port (too low)", () => {
    const config = { ...DEFAULT_APP_CONFIG, daemon_port: -1 };
    expect(validateConfig(config)).toBe(false);
  });

  it("should reject invalid daemon port (too high)", () => {
    const config = { ...DEFAULT_APP_CONFIG, daemon_port: 70000 };
    expect(validateConfig(config)).toBe(false);
  });

  it("should reject invalid theme", () => {
    const config = { ...DEFAULT_APP_CONFIG, theme: "invalid" as "system" };
    expect(validateConfig(config)).toBe(false);
  });

  it("should reject invalid update check interval", () => {
    const config = { ...DEFAULT_APP_CONFIG, update_check_interval_hours: 0 };
    expect(validateConfig(config)).toBe(false);
  });

  it("should reject negative update check interval", () => {
    const config = { ...DEFAULT_APP_CONFIG, update_check_interval_hours: -1 };
    expect(validateConfig(config)).toBe(false);
  });

  it("should accept valid theme values", () => {
    expect(validateConfig({ ...DEFAULT_APP_CONFIG, theme: "light" })).toBe(true);
    expect(validateConfig({ ...DEFAULT_APP_CONFIG, theme: "dark" })).toBe(true);
    expect(validateConfig({ ...DEFAULT_APP_CONFIG, theme: "system" })).toBe(true);
  });
});
