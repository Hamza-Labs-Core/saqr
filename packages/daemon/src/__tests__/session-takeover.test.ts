/**
 * Tests for SessionTakeover — takes over an observed session under daemon PTY control.
 *
 * Uses mocked node-pty interface to avoid real PTY dependency.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  SessionTakeover,
  type PtyProcess,
  type PtyFactory,
  type TakeoverOptions,
  type TakeoverResult,
} from "../sessions/session-takeover.js";
import { SessionRegistry } from "../sessions/session-registry.js";
import { EventBus } from "../event-bus/event-bus.js";
import { RingBuffer } from "../sessions/ring-buffer.js";

/**
 * Creates a mock PTY process.
 */
function createMockPty(): PtyProcess & EventEmitter {
  const pty = new EventEmitter() as PtyProcess & EventEmitter;
  pty.pid = 9999;
  pty.write = vi.fn();
  pty.resize = vi.fn();
  pty.kill = vi.fn();
  pty.onData = vi.fn((cb: (data: string) => void) => {
    pty.on("data", cb);
    return { dispose: () => pty.removeListener("data", cb) };
  });
  pty.onExit = vi.fn(
    (cb: (exitInfo: { exitCode: number; signal?: number }) => void) => {
      pty.on("exit", cb);
      return { dispose: () => pty.removeListener("exit", cb) };
    },
  );
  return pty;
}

function createMockPtyFactory(mockPty?: PtyProcess & EventEmitter): PtyFactory {
  const pty = mockPty || createMockPty();
  return {
    spawn: vi.fn().mockReturnValue(pty),
  };
}

describe("SessionTakeover", () => {
  let takeover: SessionTakeover;
  let registry: SessionRegistry;
  let eventBus: EventBus;
  let mockPty: PtyProcess & EventEmitter;
  let mockPtyFactory: PtyFactory;

  beforeEach(() => {
    eventBus = new EventBus();
    registry = new SessionRegistry(eventBus);
    mockPty = createMockPty();
    mockPtyFactory = createMockPtyFactory(mockPty);
    takeover = new SessionTakeover(registry, eventBus, mockPtyFactory);
  });

  describe("takeover", () => {
    it("should spawn a PTY process and return result", async () => {
      registry.register({
        sessionId: "sess-001",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: 1234,
      });
      registry.updateState("sess-001", "observed");

      const result = await takeover.takeover({
        sessionId: "sess-001",
        command: "claude",
        args: ["--resume", "--session-id", "sess-001"],
      });

      expect(result.success).toBe(true);
      expect(result.ptyPid).toBe(9999);
      expect(mockPtyFactory.spawn).toHaveBeenCalledWith(
        "claude",
        ["--resume", "--session-id", "sess-001"],
        expect.any(Object),
      );
    });

    it("should transition session to resumed state", async () => {
      registry.register({
        sessionId: "sess-002",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });
      registry.updateState("sess-002", "observed");

      await takeover.takeover({
        sessionId: "sess-002",
        command: "claude",
        args: [],
      });

      expect(registry.getSession("sess-002")!.state).toBe("resumed");
    });

    it("should fail if session is not in observed state", async () => {
      registry.register({
        sessionId: "sess-003",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });

      const result = await takeover.takeover({
        sessionId: "sess-003",
        command: "claude",
        args: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in observed state/);
    });

    it("should fail if session does not exist", async () => {
      const result = await takeover.takeover({
        sessionId: "nonexistent",
        command: "claude",
        args: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/);
    });

    it("should store PTY output in a ring buffer", async () => {
      registry.register({
        sessionId: "sess-buf",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });
      registry.updateState("sess-buf", "observed");

      await takeover.takeover({
        sessionId: "sess-buf",
        command: "claude",
        args: [],
      });

      // Simulate PTY output
      mockPty.emit("data", "Hello from PTY");
      mockPty.emit("data", " - more output");

      const buffer = takeover.getBuffer("sess-buf");
      expect(buffer).toBeDefined();
      expect(buffer!.getContents()).toBe("Hello from PTY - more output");
    });
  });

  describe("client management", () => {
    beforeEach(async () => {
      registry.register({
        sessionId: "sess-cli",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });
      registry.updateState("sess-cli", "observed");
      await takeover.takeover({
        sessionId: "sess-cli",
        command: "claude",
        args: [],
      });
    });

    it("should add a client viewer", () => {
      const clientData: string[] = [];
      const clientId = takeover.addClient("sess-cli", (data) =>
        clientData.push(data),
      );
      expect(clientId).toBeDefined();

      mockPty.emit("data", "output");
      expect(clientData).toContain("output");
    });

    it("should broadcast to multiple clients", () => {
      const data1: string[] = [];
      const data2: string[] = [];
      takeover.addClient("sess-cli", (d) => data1.push(d));
      takeover.addClient("sess-cli", (d) => data2.push(d));

      mockPty.emit("data", "broadcast");
      expect(data1).toContain("broadcast");
      expect(data2).toContain("broadcast");
    });

    it("should remove a client", () => {
      const data: string[] = [];
      const clientId = takeover.addClient("sess-cli", (d) => data.push(d));
      takeover.removeClient("sess-cli", clientId);

      mockPty.emit("data", "after remove");
      expect(data).toHaveLength(0);
    });

    it("should enforce single-writer model", () => {
      const c1 = takeover.addClient("sess-cli", () => {});
      const c2 = takeover.addClient("sess-cli", () => {});

      // First client claims write access
      expect(takeover.claimWriter("sess-cli", c1)).toBe(true);
      // Second client cannot claim write access
      expect(takeover.claimWriter("sess-cli", c2)).toBe(false);
    });

    it("should allow sending input only from the writer", () => {
      const c1 = takeover.addClient("sess-cli", () => {});
      const c2 = takeover.addClient("sess-cli", () => {});
      takeover.claimWriter("sess-cli", c1);

      expect(takeover.sendInput("sess-cli", c1, "hello")).toBe(true);
      expect(mockPty.write).toHaveBeenCalledWith("hello");

      expect(takeover.sendInput("sess-cli", c2, "nope")).toBe(false);
    });

    it("should allow releasing writer claim", () => {
      const c1 = takeover.addClient("sess-cli", () => {});
      const c2 = takeover.addClient("sess-cli", () => {});

      takeover.claimWriter("sess-cli", c1);
      takeover.releaseWriter("sess-cli", c1);
      expect(takeover.claimWriter("sess-cli", c2)).toBe(true);
    });
  });

  describe("PTY lifecycle", () => {
    it("should transition to closed when PTY exits", async () => {
      registry.register({
        sessionId: "sess-exit",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });
      registry.updateState("sess-exit", "observed");

      await takeover.takeover({
        sessionId: "sess-exit",
        command: "claude",
        args: [],
      });

      // Simulate PTY exit
      mockPty.emit("exit", { exitCode: 0 });

      expect(registry.getSession("sess-exit")!.state).toBe("closed");
    });

    it("should notify clients on PTY exit", async () => {
      registry.register({
        sessionId: "sess-notify",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });
      registry.updateState("sess-notify", "observed");

      await takeover.takeover({
        sessionId: "sess-notify",
        command: "claude",
        args: [],
      });

      const exitData: string[] = [];
      takeover.addClient("sess-notify", (data) => exitData.push(data));

      mockPty.emit("exit", { exitCode: 0 });
      // Check that some exit indicator was sent
      expect(exitData.some((d) => d.includes("exit") || d.includes("closed"))).toBe(true);
    });

    it("should kill PTY when explicitly terminated", async () => {
      registry.register({
        sessionId: "sess-kill",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });
      registry.updateState("sess-kill", "observed");

      await takeover.takeover({
        sessionId: "sess-kill",
        command: "claude",
        args: [],
      });

      takeover.terminate("sess-kill");
      expect(mockPty.kill).toHaveBeenCalled();
    });
  });

  describe("resize", () => {
    it("should forward resize to PTY", async () => {
      registry.register({
        sessionId: "sess-resize",
        projectId: "proj-a",
        agentProvider: "claude-code",
        detectedAt: new Date(),
        state: "detected",
        pid: undefined,
      });
      registry.updateState("sess-resize", "observed");

      await takeover.takeover({
        sessionId: "sess-resize",
        command: "claude",
        args: [],
      });

      takeover.resize("sess-resize", 120, 40);
      expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    });
  });
});
