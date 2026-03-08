/**
 * Tests for CLI entry point (saqr.ts).
 *
 * Validates the arg parser and command dispatch table.
 */
import { describe, it, expect } from "vitest";
import { parseArgs } from "../bin/saqr.js";

describe("parseArgs", () => {
  it("parses command as first positional", () => {
    const result = parseArgs(["login"]);
    expect(result.command).toBe("login");
    expect(result.positional).toEqual([]);
  });

  it("parses --flag as boolean", () => {
    const result = parseArgs(["start", "--foreground"]);
    expect(result.command).toBe("start");
    expect(result.flags["foreground"]).toBe(true);
  });

  it("parses --key=value", () => {
    const result = parseArgs(["start", "--port=3200"]);
    expect(result.command).toBe("start");
    expect(result.flags["port"]).toBe("3200");
  });

  it("parses --key value", () => {
    const result = parseArgs(["login", "--server", "https://example.com"]);
    expect(result.command).toBe("login");
    expect(result.flags["server"]).toBe("https://example.com");
  });

  it("parses short flags -f", () => {
    const result = parseArgs(["start", "-f"]);
    expect(result.command).toBe("start");
    expect(result.flags["f"]).toBe(true);
  });

  it("parses -- separator", () => {
    const result = parseArgs(["agent", "--", "extra", "args"]);
    expect(result.command).toBe("agent");
    expect(result.positional).toEqual(["extra", "args"]);
  });

  it("parses login command correctly", () => {
    const result = parseArgs(["login", "--server", "https://sync.saqr.dev", "--no-browser"]);
    expect(result.command).toBe("login");
    expect(result.flags["server"]).toBe("https://sync.saqr.dev");
    expect(result.flags["no-browser"]).toBe(true);
  });

  it("parses logout command correctly", () => {
    const result = parseArgs(["logout"]);
    expect(result.command).toBe("logout");
    expect(result.positional).toEqual([]);
  });
});
