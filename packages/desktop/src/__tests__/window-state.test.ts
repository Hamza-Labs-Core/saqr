/**
 * Tests for Window State Manager.
 *
 * Window state persistence, multi-window state tracking,
 * position validation against monitors.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  WindowStateManager,
  validateWindowPosition,
  type MonitorInfo,
} from "../window-state.js";
import type { WindowState } from "../ipc-types.js";

describe("WindowStateManager", () => {
  let manager: WindowStateManager;

  beforeEach(() => {
    manager = new WindowStateManager();
  });

  describe("save and load", () => {
    it("should save and load window state", () => {
      const state: WindowState = {
        x: 100,
        y: 200,
        width: 1200,
        height: 800,
        maximized: false,
      };

      manager.saveState("main", state);
      const loaded = manager.loadState("main");

      expect(loaded).toEqual(state);
    });

    it("should return null for unknown window label", () => {
      const loaded = manager.loadState("nonexistent");
      expect(loaded).toBeNull();
    });

    it("should save multiple window states independently", () => {
      const mainState: WindowState = {
        x: 0, y: 0, width: 1200, height: 800, maximized: false,
      };
      const agentState: WindowState = {
        x: 100, y: 100, width: 900, height: 700, maximized: false,
      };

      manager.saveState("main", mainState);
      manager.saveState("agent-abc123", agentState);

      expect(manager.loadState("main")).toEqual(mainState);
      expect(manager.loadState("agent-abc123")).toEqual(agentState);
    });

    it("should overwrite existing state for the same label", () => {
      const state1: WindowState = {
        x: 100, y: 200, width: 1200, height: 800, maximized: false,
      };
      const state2: WindowState = {
        x: 300, y: 400, width: 1000, height: 600, maximized: true,
      };

      manager.saveState("main", state1);
      manager.saveState("main", state2);

      expect(manager.loadState("main")).toEqual(state2);
    });
  });

  describe("savePosition", () => {
    it("should update position while keeping existing size", () => {
      const state: WindowState = {
        x: 100, y: 200, width: 1200, height: 800, maximized: false,
      };
      manager.saveState("main", state);

      manager.savePosition("main", 300, 400);

      const loaded = manager.loadState("main");
      expect(loaded?.x).toBe(300);
      expect(loaded?.y).toBe(400);
      expect(loaded?.width).toBe(1200);
      expect(loaded?.height).toBe(800);
    });

    it("should create new state with default size if no prior state exists", () => {
      manager.savePosition("new-window", 200, 300);

      const loaded = manager.loadState("new-window");
      expect(loaded).not.toBeNull();
      expect(loaded?.x).toBe(200);
      expect(loaded?.y).toBe(300);
      expect(loaded?.width).toBe(900);
      expect(loaded?.height).toBe(700);
    });
  });

  describe("saveSize", () => {
    it("should update size while keeping existing position", () => {
      const state: WindowState = {
        x: 100, y: 200, width: 1200, height: 800, maximized: false,
      };
      manager.saveState("main", state);

      manager.saveSize("main", 1000, 600);

      const loaded = manager.loadState("main");
      expect(loaded?.width).toBe(1000);
      expect(loaded?.height).toBe(600);
      expect(loaded?.x).toBe(100);
      expect(loaded?.y).toBe(200);
    });

    it("should create new state with default position if no prior state exists", () => {
      manager.saveSize("new-window", 1000, 600);

      const loaded = manager.loadState("new-window");
      expect(loaded).not.toBeNull();
      expect(loaded?.width).toBe(1000);
      expect(loaded?.height).toBe(600);
    });
  });

  describe("markClosed", () => {
    it("should keep state for later reopening", () => {
      const state: WindowState = {
        x: 100, y: 200, width: 1200, height: 800, maximized: false,
      };
      manager.saveState("main", state);
      manager.markClosed("main");

      const loaded = manager.loadState("main");
      expect(loaded).toEqual(state);
    });
  });

  describe("getAllStates", () => {
    it("should return all saved states", () => {
      manager.saveState("main", {
        x: 0, y: 0, width: 1200, height: 800, maximized: false,
      });
      manager.saveState("agent-1", {
        x: 100, y: 100, width: 900, height: 700, maximized: false,
      });

      const all = manager.getAllStates();
      expect(Object.keys(all)).toHaveLength(2);
      expect(all["main"]).toBeDefined();
      expect(all["agent-1"]).toBeDefined();
    });

    it("should return empty object when no states saved", () => {
      const all = manager.getAllStates();
      expect(Object.keys(all)).toHaveLength(0);
    });
  });

  describe("removeState", () => {
    it("should remove state for a window label", () => {
      manager.saveState("temp", {
        x: 0, y: 0, width: 900, height: 700, maximized: false,
      });
      manager.removeState("temp");

      expect(manager.loadState("temp")).toBeNull();
    });

    it("should not throw when removing non-existent state", () => {
      expect(() => manager.removeState("nonexistent")).not.toThrow();
    });
  });

  describe("serialization", () => {
    it("should serialize and deserialize state correctly", () => {
      manager.saveState("main", {
        x: 100, y: 200, width: 1200, height: 800, maximized: true,
      });

      const serialized = manager.serialize();
      const newManager = WindowStateManager.deserialize(serialized);

      const loaded = newManager.loadState("main");
      expect(loaded?.x).toBe(100);
      expect(loaded?.y).toBe(200);
      expect(loaded?.maximized).toBe(true);
    });

    it("should return empty manager on invalid JSON", () => {
      const newManager = WindowStateManager.deserialize("invalid json");
      expect(Object.keys(newManager.getAllStates())).toHaveLength(0);
    });

    it("should return empty manager on empty string", () => {
      const newManager = WindowStateManager.deserialize("");
      expect(Object.keys(newManager.getAllStates())).toHaveLength(0);
    });
  });
});

describe("validateWindowPosition", () => {
  const monitors: MonitorInfo[] = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 2560, height: 1440 },
  ];

  it("should keep position when within primary monitor", () => {
    const state: WindowState = {
      x: 100, y: 200, width: 1200, height: 800, maximized: false,
    };

    const result = validateWindowPosition(state, monitors);

    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it("should keep position when within secondary monitor", () => {
    const state: WindowState = {
      x: 2000, y: 100, width: 900, height: 700, maximized: false,
    };

    const result = validateWindowPosition(state, monitors);

    expect(result.x).toBe(2000);
    expect(result.y).toBe(100);
  });

  it("should recenter window when completely off-screen", () => {
    const state: WindowState = {
      x: -5000, y: -5000, width: 1200, height: 800, maximized: false,
    };

    const result = validateWindowPosition(state, monitors);

    // Should be centered on primary monitor
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x).toBeLessThan(1920);
    expect(result.y).toBeLessThan(1080);
  });

  it("should recenter window when off the right side", () => {
    const state: WindowState = {
      x: 10000, y: 200, width: 1200, height: 800, maximized: false,
    };

    const result = validateWindowPosition(state, monitors);

    // Should be centered on primary monitor
    expect(result.x).toBeLessThan(10000);
  });

  it("should use center of primary monitor when no monitors available", () => {
    const state: WindowState = {
      x: 100, y: 200, width: 1200, height: 800, maximized: false,
    };

    const result = validateWindowPosition(state, []);

    // Should fallback to centering
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it("should preserve size and maximized state", () => {
    const state: WindowState = {
      x: -5000, y: -5000, width: 1200, height: 800, maximized: true,
    };

    const result = validateWindowPosition(state, monitors);

    expect(result.width).toBe(1200);
    expect(result.height).toBe(800);
    expect(result.maximized).toBe(true);
  });

  it("should handle partially off-screen windows by checking if top-left corner is visible", () => {
    // Window that starts at the edge of monitor 1
    const state: WindowState = {
      x: 1900, y: 0, width: 900, height: 700, maximized: false,
    };

    const result = validateWindowPosition(state, monitors);

    // Top-left corner at (1900, 0) is within monitor 1 (0-1920), so position should be kept
    expect(result.x).toBe(1900);
    expect(result.y).toBe(0);
  });
});
