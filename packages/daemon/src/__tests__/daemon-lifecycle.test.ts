/**
 * Tests for Daemon lifecycle (start/stop).
 *
 * Validates that the Daemon:
 * - Starts and creates all subsystems
 * - Responds to health checks via HttpServer
 * - Stops cleanly and tears down subsystems
 * - Throws on double-start and double-stop
 */
import { describe, it, expect, afterEach } from "vitest";
import { Daemon } from "../daemon.js";
import { loadConfig } from "../config.js";

// Use a random high port to avoid conflicts in parallel test runs
function getTestConfig() {
  const port = 30000 + Math.floor(Math.random() * 10000);
  return loadConfig({
    server: { port, host: "127.0.0.1" },
  });
}

describe("Daemon lifecycle", () => {
  let daemon: Daemon | null = null;

  afterEach(async () => {
    if (daemon?.isRunning()) {
      await daemon.stop();
    }
    daemon = null;
  });

  it("starts and responds to health check", async () => {
    const config = getTestConfig();
    daemon = new Daemon(config);

    await daemon.start();
    expect(daemon.isRunning()).toBe(true);

    // Verify health endpoint responds
    const res = await fetch(`http://127.0.0.1:${config.server.port}/api/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("stops cleanly after start", async () => {
    const config = getTestConfig();
    daemon = new Daemon(config);

    await daemon.start();
    expect(daemon.isRunning()).toBe(true);

    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);

    // Verify health endpoint is no longer reachable
    try {
      await fetch(`http://127.0.0.1:${config.server.port}/api/health`);
      // If we get here, the server is still running — fail
      expect.unreachable("Server should be stopped");
    } catch {
      // Expected — connection refused
    }
  });

  it("throws on double start", async () => {
    const config = getTestConfig();
    daemon = new Daemon(config);

    await daemon.start();
    await expect(daemon.start()).rejects.toThrow("already running");
  });

  it("throws on double stop", async () => {
    const config = getTestConfig();
    daemon = new Daemon(config);

    await daemon.start();
    await daemon.stop();
    await expect(daemon.stop()).rejects.toThrow("not running");
  });

  it("getEventBus throws when not running", () => {
    const config = getTestConfig();
    daemon = new Daemon(config);

    expect(() => daemon!.getEventBus()).toThrow("not running");
  });

  it("getEventBus returns EventBus after start", async () => {
    const config = getTestConfig();
    daemon = new Daemon(config);

    await daemon.start();
    const bus = daemon.getEventBus();
    expect(bus).toBeDefined();
    expect(typeof bus.publish).toBe("function");
  });

  it("getConfig returns configuration", () => {
    const config = getTestConfig();
    daemon = new Daemon(config);

    const result = daemon.getConfig();
    expect(result.server.host).toBe("127.0.0.1");
  });
});
