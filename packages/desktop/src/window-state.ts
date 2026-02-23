/**
 * Window State Manager.
 *
 * Manages window position/size persistence, multi-window state tracking,
 * and position validation against monitor bounds.
 *
 * @module window-state
 */

import type { WindowState } from "./ipc-types.js";

// ---------------------------------------------------------------------------
// Monitor Info
// ---------------------------------------------------------------------------

/** Information about a display monitor. */
export interface MonitorInfo {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Default Window Sizes
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 700;

// ---------------------------------------------------------------------------
// Window State Manager
// ---------------------------------------------------------------------------

/**
 * Manages persisted window states (position, size, maximized).
 * States are keyed by window label (e.g., "main", "agent-abc123", "settings").
 */
export class WindowStateManager {
  private states: Map<string, WindowState>;

  constructor() {
    this.states = new Map();
  }

  /** Save a complete window state for a label. */
  saveState(label: string, state: WindowState): void {
    this.states.set(label, { ...state });
  }

  /** Load the persisted state for a window label. Returns null if not found. */
  loadState(label: string): WindowState | null {
    const state = this.states.get(label);
    return state ? { ...state } : null;
  }

  /** Update only the position of a window, keeping existing size. */
  savePosition(label: string, x: number, y: number): void {
    const existing = this.states.get(label);
    if (existing) {
      existing.x = x;
      existing.y = y;
      this.states.set(label, existing);
    } else {
      this.states.set(label, {
        x,
        y,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        maximized: false,
      });
    }
  }

  /** Update only the size of a window, keeping existing position. */
  saveSize(label: string, width: number, height: number): void {
    const existing = this.states.get(label);
    if (existing) {
      existing.width = width;
      existing.height = height;
      this.states.set(label, existing);
    } else {
      this.states.set(label, {
        x: 0,
        y: 0,
        width,
        height,
        maximized: false,
      });
    }
  }

  /** Mark a window as closed. Keeps state for later reopening. */
  markClosed(_label: string): void {
    // State is preserved for later reopening -- no action needed.
  }

  /** Remove the state for a window label. */
  removeState(label: string): void {
    this.states.delete(label);
  }

  /** Get all persisted window states. */
  getAllStates(): Record<string, WindowState> {
    const result: Record<string, WindowState> = {};
    for (const [label, state] of this.states) {
      result[label] = { ...state };
    }
    return result;
  }

  /** Serialize all states to JSON for persistence. */
  serialize(): string {
    return JSON.stringify(this.getAllStates());
  }

  /** Deserialize states from JSON. Returns a new manager with the loaded states. */
  static deserialize(json: string): WindowStateManager {
    const manager = new WindowStateManager();
    if (!json) return manager;

    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      for (const [label, state] of Object.entries(parsed)) {
        if (isWindowState(state)) {
          manager.saveState(label, state);
        }
      }
    } catch {
      // Invalid JSON -- return empty manager
    }

    return manager;
  }
}

// ---------------------------------------------------------------------------
// Position Validation
// ---------------------------------------------------------------------------

/**
 * Validates a window position against available monitors.
 * If the window's top-left corner is off-screen (not within any monitor),
 * it is re-centered on the primary monitor (first in the array).
 *
 * @param state - The window state to validate.
 * @param monitors - Available monitor information.
 * @returns A new WindowState with a valid position.
 */
export function validateWindowPosition(
  state: WindowState,
  monitors: MonitorInfo[]
): WindowState {
  if (monitors.length === 0) {
    // No monitor info available -- reset to origin
    return {
      ...state,
      x: 0,
      y: 0,
    };
  }

  // Check if the window's top-left corner is within any monitor
  const isOnScreen = monitors.some(
    (m) =>
      state.x >= m.x &&
      state.x < m.x + m.width &&
      state.y >= m.y &&
      state.y < m.y + m.height
  );

  if (isOnScreen) {
    return { ...state };
  }

  // Re-center on primary monitor (first in array)
  const primary = monitors[0];
  return {
    ...state,
    x: primary.x + Math.floor((primary.width - state.width) / 2),
    y: primary.y + Math.floor((primary.height - state.height) / 2),
  };
}

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

function isWindowState(value: unknown): value is WindowState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["x"] === "number" &&
    typeof obj["y"] === "number" &&
    typeof obj["width"] === "number" &&
    typeof obj["height"] === "number" &&
    typeof obj["maximized"] === "boolean"
  );
}
