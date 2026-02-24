/**
 * Daemon configuration types and loader.
 *
 * DaemonConfig defines all tunable parameters for the AgentContext daemon,
 * including server ports, event store paths, hook integration settings,
 * and resource budgets.
 */

/**
 * Configuration for the HTTP/WS/SSE server.
 */
export interface ServerConfig {
  /** HTTP server listen port. Default: 3100 */
  port: number;

  /** HTTP server bind host. Default: "127.0.0.1" */
  host: string;
}

/**
 * Configuration for the event store read-side.
 */
export interface EventStoreConfig {
  /** Root directory for event files. Default: ~/.saqr/events */
  eventsDir: string;

  /** UDP port for event notifications from capture-event. Default: 3101 */
  udpPort: number;

  /** Filesystem watcher debounce interval in ms. Default: 50 */
  watcherDebounceMs: number;
}

/**
 * Configuration for the projection cache.
 */
export interface CacheConfig {
  /** Maximum memory budget for projection cache in bytes. Default: 50MB */
  maxMemoryBytes: number;

  /** TTL for cached projections in seconds. Default: 300 */
  ttlSeconds: number;
}

/**
 * Configuration for the hook system.
 */
export interface HookConfig {
  /** Enable Claude Code hook integration. Default: true */
  claudeCode: boolean;

  /** Enable OpenCode hook integration. Default: true */
  opencode: boolean;

  /** Enable Codex hook integration. Default: true */
  codex: boolean;

  /** Enable custom hook protocol. Default: false */
  custom: boolean;
}

/**
 * Top-level daemon configuration.
 *
 * All fields have sensible defaults. The config can be loaded from:
 * 1. ~/.saqr/daemon.json (file-based config)
 * 2. AGENTCTX_* environment variables (overrides)
 * 3. CLI flags (highest priority)
 */
export interface DaemonConfig {
  /** Server configuration */
  server: ServerConfig;

  /** Event store configuration */
  eventStore: EventStoreConfig;

  /** Projection cache configuration */
  cache: CacheConfig;

  /** Hook integration configuration */
  hooks: HookConfig;

  /** Log level: "debug" | "info" | "warn" | "error". Default: "info" */
  logLevel: "debug" | "info" | "warn" | "error";

  /** Base directory for all Saqr data. Default: ~/.saqr */
  baseDir: string;
}

/**
 * Returns the default daemon configuration.
 *
 * @returns A complete DaemonConfig with all defaults applied
 */
export function getDefaultConfig(): DaemonConfig {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const baseDir = process.env.AGENTCTX_BASE_DIR ?? `${homeDir}/.saqr`;

  return {
    server: {
      port: 3100,
      host: "127.0.0.1",
    },
    eventStore: {
      eventsDir: `${baseDir}/events`,
      udpPort: 3101,
      watcherDebounceMs: 50,
    },
    cache: {
      maxMemoryBytes: 50 * 1024 * 1024, // 50MB
      ttlSeconds: 300,
    },
    hooks: {
      claudeCode: true,
      opencode: true,
      codex: true,
      custom: false,
    },
    logLevel: "info",
    baseDir,
  };
}

/**
 * Loads daemon configuration from all sources, merging in priority order:
 * defaults < config file < environment variables < explicit overrides.
 *
 * @param overrides - Partial config to merge on top of loaded config
 * @returns Fully resolved DaemonConfig
 *
 * TODO: Implement config file loading from ~/.saqr/daemon.json
 * TODO: Implement AGENTCTX_* environment variable parsing
 * TODO: Implement deep merge of partial overrides
 */
export function loadConfig(
  overrides?: Partial<DaemonConfig>,
): DaemonConfig {
  // TODO: Load from config file
  // TODO: Apply environment variable overrides
  // TODO: Deep merge with explicit overrides
  const defaults = getDefaultConfig();

  if (!overrides) {
    return defaults;
  }

  return {
    ...defaults,
    ...overrides,
    server: { ...defaults.server, ...overrides.server },
    eventStore: { ...defaults.eventStore, ...overrides.eventStore },
    cache: { ...defaults.cache, ...overrides.cache },
    hooks: { ...defaults.hooks, ...overrides.hooks },
  };
}
