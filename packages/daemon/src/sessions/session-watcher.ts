/**
 * SessionWatcher — filesystem watcher for detecting new sessions and events.
 *
 * Watches the event store directory tree for new session directories and
 * event files. This is the fallback ingestion path when UDP notifications
 * are missed (or when the daemon starts after events have been written).
 *
 * Watches: ~/.saqr/events/ (configurable)
 * Detects:
 *   - New session directories (project-id/session-id/)
 *   - New event files (*.json numbered files)
 *   - Ignores .lock files and session.json updates
 *
 * Uses fs.watch (inotify on Linux, FSEvents on macOS) with debouncing
 * to batch rapid file creation events.
 */

import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Events emitted by the SessionWatcher.
 */
export interface SessionWatcherEvents {
  /** Emitted when a new event file is detected */
  new_event: (filePath: string) => void;

  /** Emitted when a new session directory is created */
  new_session: (sessionDir: string) => void;

  /** Emitted on watcher errors */
  error: (error: Error) => void;
}

/**
 * Configuration for the SessionWatcher.
 */
export interface SessionWatcherConfig {
  /** Root directory to watch (e.g., ~/.saqr/events) */
  eventsDir: string;

  /** Debounce interval in milliseconds. Default: 50 */
  debounceMs: number;
}

// Match numbered event files: NNNNNN.json
const EVENT_FILE_RE = /^\d{6}\.json$/;

/**
 * Watches the event store filesystem for new sessions and events.
 *
 * This is the fallback ingestion path for the daemon. It detects new
 * event files written by capture-event (or any other writer) and
 * emits notifications for the daemon to process.
 */
export class SessionWatcher extends EventEmitter {
  private readonly config: SessionWatcherConfig;
  private watching = false;
  private watcher: FSWatcher | null = null;

  /** Pending file paths accumulated during debounce window */
  private pendingFiles = new Set<string>();

  /** Pending session dirs accumulated during debounce window */
  private pendingSessions = new Set<string>();

  /** Known session directories (to detect new ones) */
  private knownSessions = new Set<string>();

  /** Debounce timer */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Creates a new SessionWatcher.
   *
   * @param config - Watcher configuration
   */
  constructor(config: SessionWatcherConfig) {
    super();
    this.config = config;
  }

  /**
   * Start watching the event store directory for changes.
   *
   * @throws If already watching
   */
  start(): void {
    if (this.watching) {
      throw new Error("SessionWatcher is already running");
    }

    this.watching = true;

    try {
      this.watcher = watch(
        this.config.eventsDir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;
          this.handleFsEvent(eventType, filename);
        },
      );

      this.watcher.on("error", (err) => {
        this.emit("error", err);
      });
    } catch (err) {
      // If the directory doesn't exist or watching fails, emit error
      // but keep the watching flag true so stop() still works
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Stop watching for filesystem changes.
   */
  stop(): void {
    if (!this.watching) {
      return;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.flushPending();
      this.debounceTimer = null;
    }

    this.watching = false;
  }

  /**
   * Perform a one-time scan of the event store to find events
   * newer than the given checkpoint.
   *
   * Used on daemon startup to catch events written while the daemon
   * was not running.
   *
   * @param since - Only return events with modification time after this date
   * @returns Array of event file paths discovered
   */
  async scanSince(since: Date): Promise<string[]> {
    const result: string[] = [];
    const sinceMs = since.getTime();

    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.config.eventsDir);
    } catch {
      return [];
    }

    for (const projDir of projectDirs) {
      const projPath = path.join(this.config.eventsDir, projDir);
      const pst = await safeStat(projPath);
      if (!pst?.isDirectory()) continue;

      let sessionDirs: string[];
      try {
        sessionDirs = await readdir(projPath);
      } catch {
        continue;
      }

      for (const sessDir of sessionDirs) {
        const sessPath = path.join(projPath, sessDir);
        const sst = await safeStat(sessPath);
        if (!sst?.isDirectory()) continue;

        // Track known sessions
        this.knownSessions.add(sessPath);

        let files: string[];
        try {
          files = await readdir(sessPath);
        } catch {
          continue;
        }

        for (const file of files) {
          if (!EVENT_FILE_RE.test(file)) continue;

          const filePath = path.join(sessPath, file);
          const fst = await safeStat(filePath);
          if (!fst) continue;

          if (fst.mtimeMs >= sinceMs) {
            result.push(filePath);
          }
        }
      }
    }

    // Sort by path (which is effectively by sequence within each session)
    result.sort();
    return result;
  }

  /**
   * Whether the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watching;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Handle a raw fs.watch event.
   */
  private handleFsEvent(_eventType: string, filename: string): void {
    // Normalize path separators
    const normalized = filename.replace(/\\/g, "/");

    // Check if this is a numbered event file
    const basename = path.basename(normalized);
    if (EVENT_FILE_RE.test(basename)) {
      const fullPath = path.join(this.config.eventsDir, normalized);
      this.pendingFiles.add(fullPath);
      this.scheduleDebouncedFlush();
      return;
    }

    // Check if this looks like a session.json being created (indicating new session)
    if (basename === "session.json") {
      const sessionDir = path.dirname(
        path.join(this.config.eventsDir, normalized),
      );
      if (!this.knownSessions.has(sessionDir)) {
        this.knownSessions.add(sessionDir);
        this.pendingSessions.add(sessionDir);
        this.scheduleDebouncedFlush();
      }
    }
  }

  /**
   * Schedule a debounced flush of pending events.
   */
  private scheduleDebouncedFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flushPending();
      this.debounceTimer = null;
    }, this.config.debounceMs);
  }

  /**
   * Flush all pending events and sessions.
   */
  private flushPending(): void {
    // Emit new sessions first
    for (const sessionDir of this.pendingSessions) {
      this.emit("new_session", sessionDir);
    }
    this.pendingSessions.clear();

    // Emit new events
    for (const filePath of this.pendingFiles) {
      this.emit("new_event", filePath);
    }
    this.pendingFiles.clear();
  }
}

/**
 * Stat a path, returning null on error.
 */
async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}
