/**
 * Tests for login and logout commands.
 *
 * Tests cover:
 * - Login help text
 * - Logout help text
 * - Already-logged-in guard
 * - Logout when not logged in
 * - Logout clears authToken
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock modules before importing the commands
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// We'll mock sync-client config functions
const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();
const mockGetDefaultConfigDir = vi.fn();

vi.mock("@saqr/sync-client", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  getDefaultConfigDir: () => mockGetDefaultConfigDir(),
}));

import { runLogin } from "../commands/login.js";
import { runLogout } from "../commands/logout.js";
import type { ParsedArgs } from "../bin/saqr.js";

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: undefined,
    positional: [],
    flags: {},
    ...overrides,
  };
}

describe("login command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultConfigDir.mockReturnValue("/tmp/.saqr-test");
  });

  it("prints help with --help flag", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLogin(makeArgs({ flags: { help: true } }));
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("saqrnest login");
    expect(output).toContain("--server");
    logSpy.mockRestore();
  });

  it("prints help with -h flag", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLogin(makeArgs({ flags: { h: true } }));
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("saqrnest login");
    logSpy.mockRestore();
  });

  it("warns if already logged in", async () => {
    mockLoadConfig.mockReturnValue({ authToken: "existing-token" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runLogin(makeArgs());
    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Already logged in");
    errSpy.mockRestore();
  });
});

describe("logout command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultConfigDir.mockReturnValue("/tmp/.saqr-test");
  });

  it("prints help with --help flag", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLogout(makeArgs({ flags: { help: true } }));
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("saqrnest logout");
    logSpy.mockRestore();
  });

  it("warns if not logged in", async () => {
    mockLoadConfig.mockReturnValue({ authToken: undefined });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runLogout(makeArgs());
    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Not currently logged in");
    errSpy.mockRestore();
  });

  it("clears authToken and saves config", async () => {
    const config = {
      enabled: true,
      serverUrl: "https://sync.saqr.dev",
      authToken: "jwt-token-here",
      machineId: "test-123",
      machineName: "test",
      createdAt: "2024-01-01T00:00:00Z",
    };
    mockLoadConfig.mockReturnValue({ ...config });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLogout(makeArgs());

    expect(mockSaveConfig).toHaveBeenCalledOnce();
    const savedConfig = mockSaveConfig.mock.calls[0][0];
    expect(savedConfig.authToken).toBeUndefined();
    logSpy.mockRestore();
  });
});
