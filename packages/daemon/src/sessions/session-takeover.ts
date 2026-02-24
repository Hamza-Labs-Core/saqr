/**
 * SessionTakeover — takes over an observed session under daemon PTY control.
 *
 * Implements the "resumed" mode: the daemon stops the observed session's
 * external process and restarts it under a daemon-managed PTY.
 *
 * Features:
 * - PTY spawning via pluggable PtyFactory interface (mocked in tests)
 * - Ring buffer for output storage (reconnection replay)
 * - Terminal multiplexing: multiple read-only client views
 * - Single-writer model: only one client can send input at a time
 */

import type { EventBus } from "../event-bus/event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import { RingBuffer } from "./ring-buffer.js";

// ---------------------------------------------------------------------------
// PTY interface (mock-friendly)
// ---------------------------------------------------------------------------

/**
 * Disposable returned by PTY event subscriptions.
 */
export interface IDisposable {
  dispose(): void;
}

/**
 * Minimal PTY process interface compatible with node-pty.
 * In production, node-pty's IPty is used. In tests, this is mocked.
 */
export interface PtyProcess {
  /** Process ID of the spawned PTY */
  pid: number;

  /** Write data to the PTY stdin */
  write(data: string): void;

  /** Resize the PTY */
  resize(cols: number, rows: number): void;

  /** Kill the PTY process */
  kill(signal?: string): void;

  /** Subscribe to PTY output data */
  onData(callback: (data: string) => void): IDisposable;

  /** Subscribe to PTY exit */
  onExit(
    callback: (exitInfo: { exitCode: number; signal?: number }) => void,
  ): IDisposable;
}

/**
 * Factory for creating PTY processes.
 * In tests, this is replaced with a mock.
 */
export interface PtyFactory {
  spawn(
    command: string,
    args: string[],
    options: { cols?: number; rows?: number; cwd?: string },
  ): PtyProcess;
}

// ---------------------------------------------------------------------------
// Takeover options and result
// ---------------------------------------------------------------------------

/**
 * Options for taking over a session.
 */
export interface TakeoverOptions {
  /** Session ID to take over */
  sessionId: string;

  /** Command to spawn (e.g., "claude") */
  command: string;

  /** Arguments to pass to the command */
  args: string[];

  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;

  /** Initial terminal columns. Default: 80 */
  cols?: number;

  /** Initial terminal rows. Default: 24 */
  rows?: number;

  /** Ring buffer capacity in bytes. Default: 8MB */
  bufferCapacity?: number;
}

/**
 * Result of a takeover attempt.
 */
export interface TakeoverResult {
  /** Whether the takeover succeeded */
  success: boolean;

  /** PID of the spawned PTY process (if success) */
  ptyPid?: number;

  /** Error message (if failed) */
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ClientEntry {
  id: string;
  onData: (data: string) => void;
}

interface TakenOverSession {
  pty: PtyProcess;
  buffer: RingBuffer;
  clients: Map<string, ClientEntry>;
  writerId: string | null;
  dataDisposable: IDisposable;
  exitDisposable: IDisposable;
}

// ---------------------------------------------------------------------------
// SessionTakeover
// ---------------------------------------------------------------------------

/**
 * Manages session takeover: spawns PTY, routes output, enforces single-writer.
 */
export class SessionTakeover {
  private readonly registry: SessionRegistry;
  private readonly eventBus: EventBus;
  private readonly ptyFactory: PtyFactory;
  private readonly sessions = new Map<string, TakenOverSession>();
  private nextClientId = 0;

  constructor(
    registry: SessionRegistry,
    eventBus: EventBus,
    ptyFactory: PtyFactory,
  ) {
    this.registry = registry;
    this.eventBus = eventBus;
    this.ptyFactory = ptyFactory;
  }

  /**
   * Take over a session: spawn a PTY process under daemon control.
   *
   * The session must be in the 'observed' state. On success, it
   * transitions to 'resumed'.
   *
   * @param options - Takeover options.
   * @returns Result indicating success or failure.
   */
  async takeover(options: TakeoverOptions): Promise<TakeoverResult> {
    const session = this.registry.getSession(options.sessionId);
    if (!session) {
      return {
        success: false,
        error: `Session "${options.sessionId}" not found`,
      };
    }

    if (session.state !== "observed") {
      return {
        success: false,
        error: `Session "${options.sessionId}" is not in observed state (current: ${session.state})`,
      };
    }

    try {
      const pty = this.ptyFactory.spawn(options.command, options.args, {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: options.cwd,
      });

      const buffer = new RingBuffer(options.bufferCapacity);
      const clients = new Map<string, ClientEntry>();

      const dataDisposable = pty.onData((data: string) => {
        // Store in ring buffer
        buffer.write(data);

        // Broadcast to all connected clients
        for (const client of clients.values()) {
          try {
            client.onData(data);
          } catch {
            // Swallow client errors
          }
        }
      });

      const exitDisposable = pty.onExit(
        (_exitInfo: { exitCode: number; signal?: number }) => {
          // Notify clients of exit
          for (const client of clients.values()) {
            try {
              client.onData(`\r\n[session exit: code ${_exitInfo.exitCode}]\r\n`);
            } catch {
              // Swallow
            }
          }

          // Transition to closed
          try {
            this.registry.updateState(options.sessionId, "closed");
          } catch {
            // Session may already be closed
          }

          // Clean up
          this.sessions.delete(options.sessionId);
        },
      );

      this.sessions.set(options.sessionId, {
        pty,
        buffer,
        clients,
        writerId: null,
        dataDisposable,
        exitDisposable,
      });

      // Transition session to resumed
      this.registry.updateState(options.sessionId, "resumed");

      return {
        success: true,
        ptyPid: pty.pid,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get the ring buffer for a taken-over session.
   *
   * @param sessionId - The session ID.
   * @returns The RingBuffer, or undefined if session not found.
   */
  getBuffer(sessionId: string): RingBuffer | undefined {
    return this.sessions.get(sessionId)?.buffer;
  }

  /**
   * Add a read-only client to a taken-over session.
   *
   * The client will receive all future PTY output. To replay buffered
   * output, read from getBuffer() first.
   *
   * @param sessionId - The session ID.
   * @param onData - Callback invoked with each chunk of PTY output.
   * @returns A unique client ID for this connection.
   */
  addClient(sessionId: string, onData: (data: string) => void): string {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`No taken-over session "${sessionId}"`);
    }

    const clientId = `client-${this.nextClientId++}`;
    entry.clients.set(clientId, { id: clientId, onData });
    return clientId;
  }

  /**
   * Remove a client from a taken-over session.
   *
   * @param sessionId - The session ID.
   * @param clientId - The client ID returned by addClient().
   */
  removeClient(sessionId: string, clientId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    entry.clients.delete(clientId);

    // If the removed client was the writer, release the lock
    if (entry.writerId === clientId) {
      entry.writerId = null;
    }
  }

  /**
   * Claim exclusive write access for a client.
   *
   * Only one client can write to the PTY at a time (single-writer model).
   *
   * @param sessionId - The session ID.
   * @param clientId - The client ID requesting write access.
   * @returns true if write access was granted, false if already claimed.
   */
  claimWriter(sessionId: string, clientId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    if (entry.writerId !== null && entry.writerId !== clientId) {
      return false;
    }

    entry.writerId = clientId;
    return true;
  }

  /**
   * Release exclusive write access.
   *
   * @param sessionId - The session ID.
   * @param clientId - The client ID releasing write access.
   */
  releaseWriter(sessionId: string, clientId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.writerId === clientId) {
      entry.writerId = null;
    }
  }

  /**
   * Send input to the PTY from the designated writer client.
   *
   * @param sessionId - The session ID.
   * @param clientId - The client ID (must be the current writer).
   * @param data - The input data to send.
   * @returns true if input was sent, false if client is not the writer.
   */
  sendInput(sessionId: string, clientId: string, data: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    if (entry.writerId !== clientId) {
      return false;
    }

    entry.pty.write(data);
    return true;
  }

  /**
   * Resize the PTY terminal.
   *
   * @param sessionId - The session ID.
   * @param cols - New column count.
   * @param rows - New row count.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.pty.resize(cols, rows);
  }

  /**
   * Terminate a taken-over session's PTY process.
   *
   * @param sessionId - The session ID.
   */
  terminate(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.pty.kill();
  }
}
