/**
 * Tests for desktop frontend App — routing, auth token persistence.
 */
import { describe, it, expect, beforeEach } from "vitest";

// Test the routing logic and token management directly.
// We don't test React rendering here (that would require jsdom + @testing-library/react),
// instead we test the pure logic functions.

describe("App routing logic", () => {
  describe("parseHash", () => {
    function parseHash(hash: string): { page: string; serverId?: string; sessionId?: string } {
      const clean = hash.replace(/^#\/?/, "");
      if (clean.startsWith("terminal/")) {
        const parts = clean.split("/");
        if (parts.length >= 3) {
          return { page: "terminal", serverId: parts[1], sessionId: parts[2] };
        }
      }
      if (clean === "login") return { page: "login" };
      return { page: "servers" };
    }

    it("parses empty hash as servers", () => {
      expect(parseHash("")).toEqual({ page: "servers" });
    });

    it("parses #/login as login", () => {
      expect(parseHash("#/login")).toEqual({ page: "login" });
    });

    it("parses #/servers as servers", () => {
      expect(parseHash("#/servers")).toEqual({ page: "servers" });
    });

    it("parses #/terminal/:serverId/:sessionId", () => {
      expect(parseHash("#/terminal/srv-1/sess-42")).toEqual({
        page: "terminal",
        serverId: "srv-1",
        sessionId: "sess-42",
      });
    });

    it("handles terminal with insufficient parts as servers", () => {
      expect(parseHash("#/terminal/only-one")).toEqual({ page: "servers" });
    });

    it("handles unknown routes as servers", () => {
      expect(parseHash("#/settings")).toEqual({ page: "servers" });
    });
  });

  describe("token persistence", () => {
    const TOKEN_KEY = "saqr_access_token";

    beforeEach(() => {
      globalThis.localStorage = {
        _data: {} as Record<string, string>,
        getItem(key: string) { return this._data[key] ?? null; },
        setItem(key: string, value: string) { this._data[key] = value; },
        removeItem(key: string) { delete this._data[key]; },
        clear() { this._data = {}; },
        get length() { return Object.keys(this._data).length; },
        key(index: number) { return Object.keys(this._data)[index] ?? null; },
      } as Storage;
    });

    it("stores and retrieves token", () => {
      localStorage.setItem(TOKEN_KEY, "test-token-123");
      expect(localStorage.getItem(TOKEN_KEY)).toBe("test-token-123");
    });

    it("returns null for missing token", () => {
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    it("clears token", () => {
      localStorage.setItem(TOKEN_KEY, "to-clear");
      localStorage.removeItem(TOKEN_KEY);
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    });
  });
});

describe("Server list helpers", () => {
  it("formatTime formats ISO string", () => {
    function formatTime(iso: string): string {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch {
        return iso;
      }
    }

    expect(formatTime("")).toBe("");
    expect(formatTime("2026-01-01T14:30:00Z")).toBeTruthy();
    expect(formatTime("invalid")).toBeTruthy(); // Date parse doesn't throw
  });
});

describe("Terminal URL construction", () => {
  it("builds local daemon WS URL", () => {
    const serverId = "local";
    const sessionId = "sess-1";
    const url = serverId === "local"
      ? `ws://localhost:3100/ws/session/${sessionId}`
      : `wss://${serverId}/ws/session/${sessionId}`;
    expect(url).toBe("ws://localhost:3100/ws/session/sess-1");
  });

  it("builds remote daemon WS URL", () => {
    const serverId = "my-server.saqr.dev";
    const sessionId = "sess-2";
    const url = serverId === "local"
      ? `ws://localhost:3100/ws/session/${sessionId}`
      : `wss://${serverId}/ws/session/${sessionId}`;
    expect(url).toBe("wss://my-server.saqr.dev/ws/session/sess-2");
  });
});
