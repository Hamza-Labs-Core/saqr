/**
 * Tauri Bridge: Typed invoke() wrappers for all IPC commands.
 *
 * This module provides a production-ready bridge that connects to the
 * actual Tauri backend. It wraps `@tauri-apps/api/core.invoke()` with
 * the types from `IpcCommandMap`.
 *
 * @module tauri-bridge
 */

import type {
  DaemonStatus,
  NotificationSettings,
  WindowInfo,
  WindowState,
} from "../ipc-types.js";
import type { IpcBridge, InvokeFunction } from "../ipc-bridge.js";
import { createIpcBridge } from "../ipc-bridge.js";

// ---------------------------------------------------------------------------
// Tauri Detection
// ---------------------------------------------------------------------------

/**
 * Check if the code is running inside a Tauri WebView.
 * Returns true if `window.__TAURI_INTERNALS__` is available.
 */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

// ---------------------------------------------------------------------------
// Bridge Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Tauri IPC bridge using the real `@tauri-apps/api/core.invoke`.
 *
 * Usage:
 * ```typescript
 * import { createTauriBridge } from './lib/tauri-bridge';
 * const bridge = await createTauriBridge();
 * const status = await bridge.getDaemonStatus();
 * ```
 *
 * @throws Error if not running inside Tauri WebView.
 */
export async function createTauriBridge(): Promise<IpcBridge> {
  if (!isTauri()) {
    throw new Error(
      "Not running inside Tauri WebView. Use createIpcBridge() with a mock invoke for testing."
    );
  }

  // Dynamic import to avoid bundling issues outside Tauri
  const { invoke } = await import("@tauri-apps/api/core");
  return createIpcBridge(invoke as InvokeFunction);
}
