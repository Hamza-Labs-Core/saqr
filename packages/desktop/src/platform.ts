/**
 * Platform Detection.
 *
 * Determines whether the app is running inside Tauri or a browser.
 * Used by the dashboard to conditionally enable native features.
 *
 * @module platform
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Platform information. */
export interface PlatformInfo {
  /** Whether the app is running inside a Tauri WebView. */
  isTauri: boolean;
  /** Platform identifier: "tauri" or "browser". */
  platform: "tauri" | "browser";
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the app is running inside a Tauri WebView.
 * Checks for the presence of `__TAURI__` on the global object.
 */
export function isTauri(): boolean {
  return "__TAURI__" in globalThis;
}

/**
 * Returns platform information including whether the app runs in Tauri.
 */
export function getPlatformInfo(): PlatformInfo {
  const inTauri = isTauri();
  return {
    isTauri: inTauri,
    platform: inTauri ? "tauri" : "browser",
  };
}
