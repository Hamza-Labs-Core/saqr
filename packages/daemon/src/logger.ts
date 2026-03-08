/**
 * File-based logger for the SaqrNest daemon.
 *
 * Writes structured log lines to ~/.saqr/logs/daemon.log with:
 * - Level filtering (debug/info/warn/error)
 * - Automatic rotation when file exceeds maxBytes (default 5MB)
 * - Keeps one rotated backup (daemon.log.1)
 * - ISO 8601 timestamps
 *
 * Also mirrors to stderr so foreground mode still shows logs in terminal.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB

export interface LoggerOptions {
  level: LogLevel;
  logDir: string;
  /** Max log file size in bytes before rotation. Default: 5MB */
  maxBytes?: number;
  /** Write to stderr in addition to file. Default: true */
  stderr?: boolean;
}

let globalLogger: Logger | null = null;

export class Logger {
  private readonly level: number;
  private readonly logDir: string;
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly stderr: boolean;
  private stream: fs.WriteStream | null = null;
  private currentSize = 0;

  constructor(options: LoggerOptions) {
    this.level = LEVEL_ORDER[options.level];
    this.logDir = options.logDir;
    this.logPath = path.join(this.logDir, "daemon.log");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.stderr = options.stderr ?? true;
  }

  /**
   * Opens the log file stream. Must be called before logging.
   */
  open(): void {
    fs.mkdirSync(this.logDir, { recursive: true });

    try {
      const stat = fs.statSync(this.logPath);
      this.currentSize = stat.size;
    } catch {
      this.currentSize = 0;
    }

    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
  }

  /**
   * Closes the log file stream.
   */
  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  debug(tag: string, msg: string, ...args: unknown[]): void {
    this.log("debug", tag, msg, args);
  }

  info(tag: string, msg: string, ...args: unknown[]): void {
    this.log("info", tag, msg, args);
  }

  warn(tag: string, msg: string, ...args: unknown[]): void {
    this.log("warn", tag, msg, args);
  }

  error(tag: string, msg: string, ...args: unknown[]): void {
    this.log("error", tag, msg, args);
  }

  private log(level: LogLevel, tag: string, msg: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < this.level) return;

    const ts = new Date().toISOString();
    const extra = args.length > 0
      ? " " + args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(" ")
      : "";
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}${extra}\n`;

    if (this.stream) {
      this.stream.write(line);
      this.currentSize += Buffer.byteLength(line);
      if (this.currentSize >= this.maxBytes) {
        this.rotate();
      }
    }

    if (this.stderr) {
      process.stderr.write(line);
    }
  }

  private rotate(): void {
    if (!this.stream) return;

    this.stream.end();

    const backup = this.logPath + ".1";
    try {
      fs.renameSync(this.logPath, backup);
    } catch {
      // If rename fails, truncate instead
      try {
        fs.truncateSync(this.logPath, 0);
      } catch {
        // Best effort
      }
    }

    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
    this.currentSize = 0;
  }
}

/**
 * Initializes the global logger. Call once at daemon startup.
 */
export function initLogger(options: LoggerOptions): Logger {
  if (globalLogger) {
    globalLogger.close();
  }
  globalLogger = new Logger(options);
  globalLogger.open();
  return globalLogger;
}

/**
 * Returns the global logger instance.
 * Falls back to a no-op stderr-only logger if not initialized.
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    // Fallback: create a stderr-only logger (no file)
    globalLogger = new Logger({
      level: "info",
      logDir: "/tmp",
      stderr: true,
    });
  }
  return globalLogger;
}
