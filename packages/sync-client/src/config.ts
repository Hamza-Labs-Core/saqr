import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Local sync configuration stored at ~/.saqr/sync.json
 */
export interface SyncLocalConfig {
  /** Whether sync is enabled */
  enabled: boolean;
  /** The sync server URL */
  serverUrl: string;
  /** Unique machine identifier for this device */
  machineId: string;
  /** Human-readable machine name */
  machineName: string;
  /** JWT auth token for server authentication */
  authToken?: string;
  /** Key ID of the current master key */
  keyId?: string;
  /** ISO 8601 timestamp when the config was created */
  createdAt: string;
}

/**
 * Default config directory path
 */
export function getDefaultConfigDir(): string {
  return path.join(os.homedir(), '.saqr');
}

/**
 * Generate a deterministic machine ID from hostname + username.
 */
export function generateMachineId(): string {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const hash = crypto
    .createHash('sha256')
    .update(hostname + username)
    .digest('hex');
  const sanitizedHostname = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20);
  return `${sanitizedHostname}-${hash.slice(0, 6)}`;
}

/**
 * Get default sync configuration.
 */
export function getDefaultConfig(): SyncLocalConfig {
  return {
    enabled: false,
    serverUrl: '',
    machineId: generateMachineId(),
    machineName: os.hostname(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Load sync configuration from disk.
 *
 * @param configDir - Configuration directory (defaults to ~/.saqr/)
 * @returns The loaded config, or a default config if none exists
 */
export function loadConfig(configDir?: string): SyncLocalConfig {
  const dir = configDir ?? getDefaultConfigDir();
  const configPath = path.join(dir, 'sync.json');

  if (!fs.existsSync(configPath)) {
    return getDefaultConfig();
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(content) as Partial<SyncLocalConfig>;

    // Merge with defaults to ensure all fields are present
    const defaults = getDefaultConfig();
    return {
      ...defaults,
      ...parsed,
    };
  } catch {
    return getDefaultConfig();
  }
}

/**
 * Save sync configuration to disk.
 *
 * @param config - The configuration to save
 * @param configDir - Configuration directory (defaults to ~/.saqr/)
 */
export function saveConfig(config: SyncLocalConfig, configDir?: string): void {
  const dir = configDir ?? getDefaultConfigDir();

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const configPath = path.join(dir, 'sync.json');
  const tmpPath = configPath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}
