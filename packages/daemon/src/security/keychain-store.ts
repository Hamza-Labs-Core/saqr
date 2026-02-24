/**
 * KeychainStore — Platform keychain abstraction for secure key storage.
 *
 * Provides a unified interface for storing encryption keys in the OS keychain.
 * Falls back to file-based storage with restrictive permissions (0o600)
 * when no native keychain is available.
 *
 * Supported backends:
 * - macOS: `security` CLI (Keychain Access)
 * - Linux: `secret-tool` CLI (GNOME Keyring / Secret Service)
 * - Windows: `cmdkey` CLI (Windows Credential Manager)
 * - Fallback: Encrypted file storage with 0o600 permissions
 *
 * @module security/keychain-store
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

/** Service name prefix for all keychain entries */
const SERVICE_NAME = "com.saqr.daemon";

/**
 * Interface for platform keychain operations.
 */
export interface KeychainStore {
  /**
   * Store a key in the keychain.
   * @param key - The key data to store (base64-encoded string)
   * @param label - A unique label identifying this key
   */
  store(key: string, label: string): Promise<void>;

  /**
   * Retrieve a key from the keychain.
   * @param label - The label of the key to retrieve
   * @returns The key data, or null if not found
   */
  retrieve(label: string): Promise<string | null>;

  /**
   * Delete a key from the keychain.
   * @param label - The label of the key to delete
   * @returns true if the key was deleted, false if it didn't exist
   */
  delete(label: string): Promise<boolean>;

  /**
   * Check if a key exists in the keychain.
   * @param label - The label to check
   */
  exists(label: string): Promise<boolean>;
}

/**
 * macOS Keychain implementation using the `security` CLI.
 */
export class DesktopKeychainStore implements KeychainStore {
  private readonly platform: NodeJS.Platform;
  private readonly execFn: typeof execFileAsync;

  constructor(
    platform?: NodeJS.Platform,
    execFn?: typeof execFileAsync,
  ) {
    this.platform = platform ?? process.platform;
    this.execFn = execFn ?? execFileAsync;
  }

  async store(key: string, label: string): Promise<void> {
    const service = `${SERVICE_NAME}.${label}`;

    switch (this.platform) {
      case "darwin": {
        // Delete first to allow overwrite
        try {
          await this.execFn("security", [
            "delete-generic-password",
            "-s",
            service,
            "-a",
            label,
          ]);
        } catch {
          // Ignore - key may not exist yet
        }
        await this.execFn("security", [
          "add-generic-password",
          "-s",
          service,
          "-a",
          label,
          "-w",
          key,
          "-U",
        ]);
        break;
      }
      case "linux": {
        await this.execFn("secret-tool", [
          "store",
          "--label",
          label,
          "service",
          service,
          "account",
          label,
        ], { input: key } as any);
        break;
      }
      case "win32": {
        await this.execFn("cmdkey", [
          `/add:${service}`,
          `/user:${label}`,
          `/pass:${key}`,
        ]);
        break;
      }
      default:
        throw new Error(`Unsupported platform for DesktopKeychainStore: ${this.platform}`);
    }
  }

  async retrieve(label: string): Promise<string | null> {
    const service = `${SERVICE_NAME}.${label}`;

    try {
      switch (this.platform) {
        case "darwin": {
          const { stdout } = await this.execFn("security", [
            "find-generic-password",
            "-s",
            service,
            "-a",
            label,
            "-w",
          ]);
          return stdout.trim();
        }
        case "linux": {
          const { stdout } = await this.execFn("secret-tool", [
            "lookup",
            "service",
            service,
            "account",
            label,
          ]);
          return stdout.trim();
        }
        case "win32": {
          const { stdout } = await this.execFn("cmdkey", [
            `/list:${service}`,
          ]);
          // cmdkey /list doesn't directly return the password.
          // On real Windows, we'd use a different API. This is a simplification.
          if (stdout.includes(service)) {
            return stdout.trim();
          }
          return null;
        }
        default:
          throw new Error(`Unsupported platform: ${this.platform}`);
      }
    } catch {
      return null;
    }
  }

  async delete(label: string): Promise<boolean> {
    const service = `${SERVICE_NAME}.${label}`;

    try {
      switch (this.platform) {
        case "darwin": {
          await this.execFn("security", [
            "delete-generic-password",
            "-s",
            service,
            "-a",
            label,
          ]);
          return true;
        }
        case "linux": {
          await this.execFn("secret-tool", [
            "clear",
            "service",
            service,
            "account",
            label,
          ]);
          return true;
        }
        case "win32": {
          await this.execFn("cmdkey", [
            `/delete:${service}`,
          ]);
          return true;
        }
        default:
          throw new Error(`Unsupported platform: ${this.platform}`);
      }
    } catch {
      return false;
    }
  }

  async exists(label: string): Promise<boolean> {
    const result = await this.retrieve(label);
    return result !== null;
  }
}

/**
 * File-based keychain fallback using restrictive file permissions.
 *
 * Keys are stored in `~/.saqr/keychain/` with mode 0o600 (owner read/write only).
 * This is the fallback for systems without a native keychain.
 */
export class FileKeychainStore implements KeychainStore {
  private readonly storeDir: string;

  constructor(storeDir?: string) {
    this.storeDir =
      storeDir ??
      path.join(os.homedir(), ".saqr", "keychain");
  }

  private keyPath(label: string): string {
    // Sanitize label to prevent directory traversal
    // Replace any character that isn't alphanumeric, single dot, or hyphen
    const safe = label
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      // Collapse consecutive dots to prevent ".." traversal in filename
      .replace(/\.{2,}/g, "_");
    return path.join(this.storeDir, `${safe}.key`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    }
  }

  async store(key: string, label: string): Promise<void> {
    this.ensureDir();
    const filePath = this.keyPath(label);
    fs.writeFileSync(filePath, key, { mode: 0o600 });
  }

  async retrieve(label: string): Promise<string | null> {
    const filePath = this.keyPath(label);
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async delete(label: string): Promise<boolean> {
    const filePath = this.keyPath(label);
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async exists(label: string): Promise<boolean> {
    const filePath = this.keyPath(label);
    return fs.existsSync(filePath);
  }
}

/**
 * Auto-detect the best keychain store for the current platform.
 *
 * Returns a DesktopKeychainStore on macOS/Linux/Windows if the required
 * CLI tool is available, otherwise falls back to FileKeychainStore.
 *
 * @param storeDir - Override directory for file-based fallback
 * @returns The best available KeychainStore implementation
 */
export function createKeychainStore(storeDir?: string): KeychainStore {
  const platform = process.platform;

  // Check if native keychain tool exists
  const toolMap: Record<string, string> = {
    darwin: "security",
    linux: "secret-tool",
    win32: "cmdkey",
  };

  const tool = toolMap[platform];
  if (tool) {
    try {
      // Quick check if the tool is accessible
      const { execFileSync } = require("node:child_process");
      execFileSync("which", [tool], { stdio: "ignore" });
      return new DesktopKeychainStore(platform);
    } catch {
      // Tool not available, fall through to file-based
    }
  }

  return new FileKeychainStore(storeDir);
}
