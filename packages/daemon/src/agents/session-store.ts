/**
 * Session persistence store for agent sessions.
 *
 * Saves and loads session state to/from disk so sessions can survive
 * daemon restarts. Storage location: ~/.saqr/sessions/
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Serializable session state for persistence.
 */
export interface PersistedSessionState {
  sessionId: string;
  providerId: string;
  model: string;
  workingDirectory: string;
  worktreePath?: string;
  branchName?: string;
  createdAt: string; // ISO 8601
  lastActivityAt: string; // ISO 8601
  state: string;
  turnCount: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  permissionAllowList: string[];
  providerState: Record<string, unknown>;
}

export interface SessionStoreOptions {
  /** Base directory for session persistence. Default: ~/.saqr/sessions */
  baseDir?: string;
}

/**
 * Persists and loads session state to/from the filesystem.
 */
export class SessionStore {
  private readonly baseDir: string;

  constructor(options: SessionStoreOptions = {}) {
    this.baseDir =
      options.baseDir ?? path.join(os.homedir(), ".saqr", "sessions");
  }

  /**
   * Save session state to disk.
   */
  async save(
    sessionId: string,
    state: PersistedSessionState,
  ): Promise<void> {
    const sessionDir = path.join(this.baseDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "handle.json");
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /**
   * Load session state from disk.
   *
   * @returns The persisted state, or null if not found.
   */
  async load(sessionId: string): Promise<PersistedSessionState | null> {
    const filePath = path.join(this.baseDir, sessionId, "handle.json");
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data) as PersistedSessionState;
    } catch {
      return null;
    }
  }

  /**
   * List all saved session IDs.
   */
  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, {
        withFileTypes: true,
      });
      const sessionIds: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Check that the handle.json exists
          const handlePath = path.join(
            this.baseDir,
            entry.name,
            "handle.json",
          );
          try {
            await fs.access(handlePath);
            sessionIds.push(entry.name);
          } catch {
            // Directory exists but no handle file, skip
          }
        }
      }
      return sessionIds;
    } catch {
      // Base directory does not exist yet
      return [];
    }
  }

  /**
   * Delete a saved session.
   */
  async delete(sessionId: string): Promise<void> {
    const sessionDir = path.join(this.baseDir, sessionId);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore errors on deletion
    }
  }

  /**
   * Get the base directory path.
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
