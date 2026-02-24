/**
 * Codeguard Violation Tracker — Monitors and records security rule violations.
 *
 * Subscribes to CodeguardViolation events on the EventBus and maintains:
 * - Ring buffer of recent violations (for /codeguard history)
 * - Per-rule violation statistics
 */

import type { EventBus, EventEnvelope } from "../event-bus/event-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViolationRecord {
  /** When the violation occurred */
  timestamp: string;
  /** File that triggered the violation */
  file_path: string;
  /** Rule id that was violated */
  rule_id: string;
  /** What happened: blocked or warned */
  action: "blocked" | "warned";
  /** The matched pattern */
  matched_pattern?: string;
}

export interface RuleStats {
  /** Total number of violations for this rule */
  total: number;
  /** Timestamp of most recent violation */
  last_seen: string;
}

// ---------------------------------------------------------------------------
// ViolationTracker
// ---------------------------------------------------------------------------

export class ViolationTracker {
  private buffer: ViolationRecord[] = [];
  private maxSize: number;
  private stats = new Map<string, RuleStats>();
  private unsubscribe: (() => void) | null = null;

  constructor(options?: { maxSize?: number }) {
    this.maxSize = options?.maxSize ?? 200;
  }

  /**
   * Start tracking violations from the event bus.
   */
  subscribe(eventBus: EventBus): void {
    this.unsubscribe = eventBus.subscribe(
      (envelope: EventEnvelope) => {
        this.handleViolationEvent(envelope);
      },
      { eventType: "CodeguardViolation" },
    );
  }

  /**
   * Stop tracking violations.
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Record a violation event.
   */
  handleViolationEvent(envelope: EventEnvelope): void {
    const data = envelope.data ?? {};
    const filePath = String(data.file_path ?? "unknown");
    const violations = String(data.violations ?? "");

    // Parse violation lines: "[BLOCKED] rule-id: description"
    const lines = violations.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const match = line.match(/\[(BLOCKED|WARNED)]\s+([^:]+):/);
      if (match) {
        const action = match[1].toLowerCase() as "blocked" | "warned";
        const ruleId = match[2].trim();
        this.recordViolation({
          timestamp: envelope.timestamp,
          file_path: filePath,
          rule_id: ruleId,
          action,
        });
      }
    }

    // If no parseable lines, record a generic violation
    if (lines.length === 0 || !lines.some((l) => l.match(/\[(BLOCKED|WARNED)]/))) {
      this.recordViolation({
        timestamp: envelope.timestamp,
        file_path: filePath,
        rule_id: "unknown",
        action: "blocked",
      });
    }
  }

  /**
   * Add a violation to the ring buffer and update stats.
   */
  recordViolation(record: ViolationRecord): void {
    // Ring buffer: drop oldest when full
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }
    this.buffer.push(record);

    // Update per-rule stats
    const existing = this.stats.get(record.rule_id);
    this.stats.set(record.rule_id, {
      total: (existing?.total ?? 0) + 1,
      last_seen: record.timestamp,
    });
  }

  /**
   * Get recent violations, newest first.
   */
  getRecent(limit = 50): ViolationRecord[] {
    return this.buffer.slice(-limit).reverse();
  }

  /**
   * Get per-rule violation statistics.
   */
  getStats(): Map<string, RuleStats> {
    return new Map(this.stats);
  }

  /**
   * Get stats for a specific rule.
   */
  getRuleStats(ruleId: string): RuleStats | undefined {
    return this.stats.get(ruleId);
  }

  /**
   * Get a telemetry-ready snapshot of violation counts per rule.
   */
  getSnapshot(): Array<{ id: string; blocks: number }> {
    const result: Array<{ id: string; blocks: number }> = [];
    for (const [id, stats] of this.stats) {
      result.push({ id, blocks: stats.total });
    }
    return result;
  }

  /**
   * Clear all recorded violations and stats.
   */
  clear(): void {
    this.buffer = [];
    this.stats.clear();
  }
}
