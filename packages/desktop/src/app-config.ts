/**
 * App Configuration Manager.
 *
 * Settings persistence, default values, migration logic.
 *
 * @module app-config
 */

import type { AppConfig } from "./ipc-types.js";
import { DEFAULT_APP_CONFIG } from "./ipc-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current configuration schema version. */
export const CONFIG_VERSION = 2;

/** Valid theme values. */
const VALID_THEMES = ["light", "dark", "system"] as const;

// ---------------------------------------------------------------------------
// Versioned Config (for serialization)
// ---------------------------------------------------------------------------

interface VersionedConfig extends AppConfig {
  _version: number;
}

// ---------------------------------------------------------------------------
// App Config Manager
// ---------------------------------------------------------------------------

/**
 * Manages application configuration with typed get/set operations,
 * serialization, and migration from older config versions.
 */
export class AppConfigManager {
  private config: AppConfig;

  constructor() {
    this.config = { ...DEFAULT_APP_CONFIG };
  }

  /** Get the current full config. */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /** Set a single config value. */
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.config[key] = value;
  }

  /** Merge multiple config values at once. */
  update(partial: Partial<AppConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Reset all config values to defaults. */
  reset(): void {
    this.config = { ...DEFAULT_APP_CONFIG };
  }

  /** Serialize config to JSON string (includes version). */
  serialize(): string {
    const versioned: VersionedConfig = {
      ...this.config,
      _version: CONFIG_VERSION,
    };
    return JSON.stringify(versioned);
  }

  /**
   * Deserialize config from JSON string.
   * Returns a new manager with the loaded (and migrated) config.
   * Falls back to defaults if the JSON is invalid.
   */
  static deserialize(json: string): AppConfigManager {
    const manager = new AppConfigManager();

    if (!json) return manager;

    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const migrated = migrateConfig(parsed);
      manager.config = {
        daemon_port:
          typeof migrated.daemon_port === "number"
            ? migrated.daemon_port
            : DEFAULT_APP_CONFIG.daemon_port,
        theme: isValidTheme(migrated.theme)
          ? migrated.theme
          : DEFAULT_APP_CONFIG.theme,
        auto_start:
          typeof migrated.auto_start === "boolean"
            ? migrated.auto_start
            : DEFAULT_APP_CONFIG.auto_start,
        minimize_to_tray:
          typeof migrated.minimize_to_tray === "boolean"
            ? migrated.minimize_to_tray
            : DEFAULT_APP_CONFIG.minimize_to_tray,
        check_updates:
          typeof migrated.check_updates === "boolean"
            ? migrated.check_updates
            : DEFAULT_APP_CONFIG.check_updates,
        update_check_interval_hours:
          typeof migrated.update_check_interval_hours === "number"
            ? migrated.update_check_interval_hours
            : DEFAULT_APP_CONFIG.update_check_interval_hours,
      };
    } catch {
      // Invalid JSON -- use defaults
    }

    return manager;
  }
}

// ---------------------------------------------------------------------------
// Config Migration
// ---------------------------------------------------------------------------

/**
 * Migrates an older config to the current schema version.
 * Adds missing fields from defaults while preserving user values.
 */
export function migrateConfig(
  oldConfig: Record<string, unknown>
): VersionedConfig {
  const result: VersionedConfig = {
    ...DEFAULT_APP_CONFIG,
    _version: CONFIG_VERSION,
  };

  // Preserve any existing valid values from the old config
  if (typeof oldConfig["daemon_port"] === "number") {
    result.daemon_port = oldConfig["daemon_port"] as number;
  }

  if (isValidTheme(oldConfig["theme"])) {
    result.theme = oldConfig["theme"];
  }

  if (typeof oldConfig["auto_start"] === "boolean") {
    result.auto_start = oldConfig["auto_start"] as boolean;
  }

  if (typeof oldConfig["minimize_to_tray"] === "boolean") {
    result.minimize_to_tray = oldConfig["minimize_to_tray"] as boolean;
  }

  if (typeof oldConfig["check_updates"] === "boolean") {
    result.check_updates = oldConfig["check_updates"] as boolean;
  }

  if (typeof oldConfig["update_check_interval_hours"] === "number") {
    result.update_check_interval_hours = oldConfig[
      "update_check_interval_hours"
    ] as number;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

/**
 * Validates an AppConfig object.
 * Returns true if all values are within acceptable ranges.
 */
export function validateConfig(config: AppConfig): boolean {
  // Daemon port: 1-65535
  if (config.daemon_port < 1 || config.daemon_port > 65535) {
    return false;
  }

  // Theme: must be one of the valid values
  if (!isValidTheme(config.theme)) {
    return false;
  }

  // Update check interval: must be positive
  if (config.update_check_interval_hours <= 0) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidTheme(value: unknown): value is "light" | "dark" | "system" {
  return (
    typeof value === "string" &&
    (VALID_THEMES as readonly string[]).includes(value)
  );
}
