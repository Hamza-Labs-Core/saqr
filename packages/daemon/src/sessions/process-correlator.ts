/**
 * ProcessCorrelator — matches session IDs to running agent PIDs.
 *
 * Provides process discovery for correlating observed sessions to
 * the running `claude`, `opencode`, or `codex` processes.
 *
 * Uses a pluggable ProcessDiscovery interface so that tests can
 * inject mocks while production code uses /proc or `ps`.
 */

/**
 * Information about a discovered agent process.
 */
export interface ProcessInfo {
  /** System process ID */
  pid: number;

  /** Executable command name */
  command: string;

  /** Command-line arguments */
  args: string[];

  /** Detected agent type */
  agentType: "claude-code" | "opencode" | "codex" | "unknown";

  /** Process start time */
  startTime: Date;

  /** Session ID if discoverable from args or env */
  sessionId?: string;
}

/**
 * Pluggable interface for discovering running agent processes.
 *
 * In production, this reads /proc on Linux or uses `ps` on macOS.
 * In tests, a mock implementation is injected.
 */
export interface ProcessDiscovery {
  /**
   * List all running processes that look like agent CLIs.
   */
  listAgentProcesses(): Promise<ProcessInfo[]>;

  /**
   * Check whether a specific PID is still running.
   */
  isProcessRunning(pid: number): Promise<boolean>;
}

/**
 * Correlates session IDs with running agent processes.
 *
 * Supports two modes of correlation:
 * 1. Automatic: scan running processes and match session IDs in args.
 * 2. Manual: explicit registration of session-to-PID mappings.
 */
export class ProcessCorrelator {
  private readonly discovery: ProcessDiscovery;

  /** Manual session-to-PID mappings (set by registerSessionProcess) */
  private readonly sessionPidMap = new Map<string, number>();

  /**
   * Creates a new ProcessCorrelator.
   *
   * @param discovery - The process discovery backend.
   */
  constructor(discovery: ProcessDiscovery) {
    this.discovery = discovery;
  }

  /**
   * Find a running process associated with the given session ID.
   *
   * Searches both manual mappings and automatic process discovery.
   * In automatic mode, the session ID is matched against command-line
   * arguments (e.g., `--session-id sess-001`) or the `sessionId` field
   * provided by the discovery backend.
   *
   * @param sessionId - The session ID to look up.
   * @returns The matching ProcessInfo, or null if not found.
   */
  async findProcessForSession(
    sessionId: string,
  ): Promise<ProcessInfo | null> {
    // First check manual mappings
    const manualPid = this.sessionPidMap.get(sessionId);
    if (manualPid !== undefined) {
      const processes = await this.discovery.listAgentProcesses();
      const match = processes.find((p) => p.pid === manualPid);
      if (match) return match;
    }

    // Automatic: scan all running agent processes
    const processes = await this.discovery.listAgentProcesses();
    for (const proc of processes) {
      // Check explicit sessionId field
      if (proc.sessionId === sessionId) {
        return proc;
      }

      // Check command-line args for --session-id <value> patterns
      for (let i = 0; i < proc.args.length; i++) {
        const arg = proc.args[i];
        if (
          (arg === "--session-id" || arg === "--session") &&
          proc.args[i + 1] === sessionId
        ) {
          return proc;
        }
        // Also check --session-id=value form
        if (
          (arg.startsWith("--session-id=") ||
            arg.startsWith("--session=")) &&
          arg.split("=")[1] === sessionId
        ) {
          return proc;
        }
      }
    }

    return null;
  }

  /**
   * Check whether a specific PID is still running.
   *
   * @param pid - The process ID to check.
   * @returns true if the process is running.
   */
  async isProcessRunning(pid: number): Promise<boolean> {
    return this.discovery.isProcessRunning(pid);
  }

  /**
   * List all discovered agent processes.
   *
   * @returns Array of all running agent process infos.
   */
  async listAgentProcesses(): Promise<ProcessInfo[]> {
    return this.discovery.listAgentProcesses();
  }

  /**
   * Manually register a session-to-PID mapping.
   *
   * This is used when the daemon knows the PID from spawning the process
   * itself, or when receiving the PID from a hook.
   *
   * @param sessionId - The session ID.
   * @param pid - The process ID.
   */
  registerSessionProcess(sessionId: string, pid: number): void {
    this.sessionPidMap.set(sessionId, pid);
  }

  /**
   * Get the manually registered PID for a session.
   *
   * @param sessionId - The session ID.
   * @returns The PID, or undefined if not registered.
   */
  getSessionProcess(sessionId: string): number | undefined {
    return this.sessionPidMap.get(sessionId);
  }

  /**
   * Remove a manual session-to-PID mapping.
   *
   * @param sessionId - The session ID to unregister.
   */
  unregisterSessionProcess(sessionId: string): void {
    this.sessionPidMap.delete(sessionId);
  }
}
