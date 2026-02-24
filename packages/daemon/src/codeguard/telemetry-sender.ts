/**
 * Codeguard Telemetry Sender — Periodically sends rule usage stats to the sync server.
 *
 * Respects user consent (enabled flag) and deduplicates payloads by comparing
 * with the last successfully sent snapshot. Uses global fetch for HTTP requests.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
  /** Sync server URL, e.g. "https://sync.saqr.dev" */
  serverUrl: string;
  /** How often to send telemetry (default: 3600000 = 1 hour) */
  intervalMs?: number;
  /** JWT for authenticated requests */
  authToken?: string;
}

export interface TelemetrySnapshot {
  /** Rules with their scope and block counts */
  rules: Array<{ id: string; scope: "global" | "project"; blocks: number }>;
  /** ISO timestamp of when the snapshot was built */
  sent_at: string;
}

// ---------------------------------------------------------------------------
// Interfaces for dependencies (duck-typed for decoupling)
// ---------------------------------------------------------------------------

export interface TelemetryRuleManager {
  listRules(
    projectDir?: string,
  ): Promise<Array<{ id: string; layer: string }>>;
}

export interface TelemetryViolationTracker {
  getStats(): Map<string, { total: number }>;
}

// ---------------------------------------------------------------------------
// TelemetrySender
// ---------------------------------------------------------------------------

export class TelemetrySender {
  private config: TelemetryConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: TelemetrySnapshot | null = null;
  private enabled: boolean = false;

  constructor(config: TelemetryConfig) {
    this.config = { ...config };
  }

  /**
   * Update the JWT auth token used for authenticated requests.
   */
  setAuthToken(token: string): void {
    this.config.authToken = token;
  }

  /**
   * Enable or disable telemetry sending (respects user consent).
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Start periodic telemetry sending. Requires a ruleManager and
   * violationTracker to be passed on each send cycle.
   */
  start(
    ruleManager: TelemetryRuleManager,
    violationTracker: TelemetryViolationTracker,
  ): void {
    this.stop();
    const intervalMs = this.config.intervalMs ?? 3_600_000;
    this.timer = setInterval(() => {
      void this.sendNow(ruleManager, violationTracker);
    }, intervalMs);
  }

  /**
   * Stop periodic telemetry sending.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Send telemetry immediately. Returns success/error status.
   *
   * 1. Gets rules from ruleManager.listRules()
   * 2. Gets stats from violationTracker.getStats()
   * 3. Builds payload via buildPayload()
   * 4. Compares with lastSnapshot -- skips if identical
   * 5. POSTs to ${serverUrl}/api/codeguard/telemetry with Authorization header
   * 6. Stores successful response as lastSnapshot
   */
  async sendNow(
    ruleManager: TelemetryRuleManager,
    violationTracker: TelemetryViolationTracker,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.enabled) {
      return { success: false, error: "Telemetry is disabled" };
    }

    try {
      const rules = await ruleManager.listRules();
      const stats = violationTracker.getStats();
      const payload = this.buildPayload(rules, stats);

      // Deduplicate: skip if payload is identical to last sent snapshot
      if (this.lastSnapshot && this.snapshotsEqual(this.lastSnapshot, payload)) {
        return { success: true };
      }

      const url = `${this.config.serverUrl}/api/codeguard/telemetry`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.config.authToken) {
        headers["Authorization"] = `Bearer ${this.config.authToken}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      this.lastSnapshot = payload;
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Build a telemetry payload from rules and violation stats.
   *
   * Maps each rule to { id, scope, blocks } where:
   * - scope = "global" if layer is "global", otherwise "project"
   * - blocks = total violations for that rule (0 if no violations recorded)
   */
  buildPayload(
    rules: Array<{ id: string; layer: string }>,
    stats: Map<string, { total: number }>,
  ): TelemetrySnapshot {
    return {
      rules: rules.map((rule) => ({
        id: rule.id,
        scope: rule.layer === "global" ? ("global" as const) : ("project" as const),
        blocks: stats.get(rule.id)?.total ?? 0,
      })),
      sent_at: new Date().toISOString(),
    };
  }

  /**
   * Get the last successfully sent snapshot (or null if none sent yet).
   */
  getLastSnapshot(): TelemetrySnapshot | null {
    return this.lastSnapshot;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Compare two snapshots for equality (ignoring sent_at timestamp).
   */
  private snapshotsEqual(
    a: TelemetrySnapshot,
    b: TelemetrySnapshot,
  ): boolean {
    if (a.rules.length !== b.rules.length) return false;
    for (let i = 0; i < a.rules.length; i++) {
      const ra = a.rules[i];
      const rb = b.rules[i];
      if (ra.id !== rb.id || ra.scope !== rb.scope || ra.blocks !== rb.blocks) {
        return false;
      }
    }
    return true;
  }
}
