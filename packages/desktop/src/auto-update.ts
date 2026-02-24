/**
 * Auto-Update Manager.
 *
 * Update check logic, version comparison, download progress tracking.
 * The actual download/install is handled by Tauri's updater plugin in Rust;
 * this module manages the TypeScript state and UI-facing logic.
 *
 * @module auto-update
 */

import type { UpdateInfo, UpdateProgress } from "./ipc-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Check interval: 6 hours in milliseconds. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Initial delay before first check: 30 seconds. */
export const INITIAL_DELAY_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an update check. */
export interface UpdateCheckResult {
  hasUpdate: boolean;
  update?: UpdateInfo;
}

// ---------------------------------------------------------------------------
// Auto-Update Manager
// ---------------------------------------------------------------------------

/**
 * Manages auto-update state: available update info, download progress,
 * checking state, and errors.
 */
export class AutoUpdateManager {
  readonly currentVersion: string;

  private _isChecking = false;
  private _isDownloading = false;
  private _availableUpdate: UpdateInfo | null = null;
  private _downloadProgress: UpdateProgress | null = null;
  private _lastError: string | null = null;

  constructor(currentVersion: string) {
    this.currentVersion = currentVersion;
  }

  get isChecking(): boolean {
    return this._isChecking;
  }

  get isDownloading(): boolean {
    return this._isDownloading;
  }

  get availableUpdate(): UpdateInfo | null {
    return this._availableUpdate;
  }

  get downloadProgress(): UpdateProgress | null {
    return this._downloadProgress;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  /** Set whether an update check is in progress. */
  setChecking(checking: boolean): void {
    this._isChecking = checking;
  }

  /** Store the result of an update check. Clears any previous error. */
  setCheckResult(result: UpdateCheckResult): void {
    this._isChecking = false;
    this._lastError = null;

    if (result.hasUpdate && result.update) {
      this._availableUpdate = { ...result.update };
    } else {
      this._availableUpdate = null;
    }
  }

  /** Set whether a download is in progress. Resets progress when starting. */
  setDownloading(downloading: boolean): void {
    this._isDownloading = downloading;
    if (downloading) {
      this._downloadProgress = null;
    }
  }

  /** Update download progress. */
  updateProgress(progress: UpdateProgress): void {
    this._downloadProgress = { ...progress };
  }

  /** Set an error message. */
  setError(message: string): void {
    this._lastError = message;
    this._isChecking = false;
    this._isDownloading = false;
  }
}

// ---------------------------------------------------------------------------
// Version Comparison
// ---------------------------------------------------------------------------

/**
 * Compares two semantic version strings.
 *
 * @returns Positive if a > b, negative if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((p) => parseInt(p, 10));
  const partsB = b.split(".").map((p) => parseInt(p, 10));

  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;

    if (numA !== numB) {
      return numA - numB;
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Update Response Parsing
// ---------------------------------------------------------------------------

/**
 * Parses a Tauri update server response into an UpdateInfo.
 * Returns null if the response is invalid.
 */
export function parseUpdateResponse(response: unknown): UpdateInfo | null {
  if (!response || typeof response !== "object") return null;

  const obj = response as Record<string, unknown>;

  if (typeof obj["version"] !== "string") return null;

  return {
    version: obj["version"] as string,
    notes: typeof obj["notes"] === "string" ? (obj["notes"] as string) : null,
    date:
      typeof obj["pub_date"] === "string"
        ? (obj["pub_date"] as string)
        : null,
  };
}
