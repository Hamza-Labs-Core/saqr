/**
 * Badge Manager -- notification badge logic.
 *
 * Tracks per-session unread counts by badge type (permissions, errors,
 * prompts, general activity). Computes aggregate app icon badge count.
 *
 * @module badges/BadgeManager
 */

import type { TimelineItem } from "../types/timeline.js";

// ---------------------------------------------------------------------------
// Badge Types
// ---------------------------------------------------------------------------

/**
 * Badge type enumeration, ordered by priority (highest first).
 */
export enum BadgeType {
  Permission = "permission",
  Error = "error",
  Prompt = "prompt",
  Activity = "activity",
  None = "none",
}

/**
 * Badge priority mapping (lower number = higher priority).
 */
const BADGE_PRIORITY: Record<BadgeType, number> = {
  [BadgeType.Permission]: 0,
  [BadgeType.Error]: 1,
  [BadgeType.Prompt]: 2,
  [BadgeType.Activity]: 3,
  [BadgeType.None]: 4,
};

/**
 * Badge counts for a session.
 */
export interface BadgeCounts {
  permissions: number;
  errors: number;
  prompts: number;
  activity: number;
}

/**
 * Complete badge state for a session.
 */
export interface SessionBadgeState extends BadgeCounts {
  /** Total count across all badge types. */
  total: number;
  /** The highest-priority badge type with a non-zero count. */
  highestPriority: BadgeType;
}

// ---------------------------------------------------------------------------
// Badge Manager
// ---------------------------------------------------------------------------

/**
 * Manages badge state per session.
 *
 * Tracks unread counts by type, computes aggregate counts,
 * and handles clearing when sessions are viewed.
 */
export class BadgeManager {
  private sessions = new Map<string, BadgeCounts>();

  /**
   * Process a new timeline item and update badge counts.
   *
   * Items that are already read (read: true) do not generate badges.
   * Usage updates and certain other types are silently ignored.
   */
  onNewItem(sessionId: string, item: TimelineItem): void {
    // Skip already-read items
    if (item.read) return;

    const badgeType = classifyBadgeType(item);
    if (badgeType === null) return;

    const counts = this.getOrCreateSession(sessionId);

    switch (badgeType) {
      case BadgeType.Permission:
        counts.permissions++;
        break;
      case BadgeType.Error:
        counts.errors++;
        break;
      case BadgeType.Prompt:
        counts.prompts++;
        break;
      case BadgeType.Activity:
        counts.activity++;
        break;
    }
  }

  /**
   * Get badge state for a session.
   */
  getSessionBadges(sessionId: string): SessionBadgeState {
    const counts = this.sessions.get(sessionId) ?? {
      permissions: 0,
      errors: 0,
      prompts: 0,
      activity: 0,
    };

    const total = counts.permissions + counts.errors + counts.prompts + counts.activity;
    const highestPriority = computeHighestPriority(counts);

    return {
      ...counts,
      total,
      highestPriority,
    };
  }

  /**
   * Clear all badges for a session (user viewed the session).
   */
  markSessionViewed(sessionId: string): void {
    this.sessions.set(sessionId, {
      permissions: 0,
      errors: 0,
      prompts: 0,
      activity: 0,
    });
  }

  /**
   * Get aggregate app badge count.
   * Only counts permissions + errors across all sessions
   * (as specified -- these are high-priority items that appear on app icon).
   */
  getAppBadgeCount(): number {
    let total = 0;
    for (const counts of this.sessions.values()) {
      total += counts.permissions + counts.errors;
    }
    return total;
  }

  /**
   * Format a badge count for display.
   * Counts > 99 are displayed as "99+".
   */
  formatCount(count: number): string {
    if (count > 99) return "99+";
    return String(count);
  }

  /**
   * Get all session IDs with non-zero badges.
   */
  getSessionsWithBadges(): string[] {
    const result: string[] = [];
    for (const [sessionId, counts] of this.sessions) {
      const total = counts.permissions + counts.errors + counts.prompts + counts.activity;
      if (total > 0) {
        result.push(sessionId);
      }
    }
    return result;
  }

  /**
   * Clear all badge state.
   */
  reset(): void {
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getOrCreateSession(sessionId: string): BadgeCounts {
    let counts = this.sessions.get(sessionId);
    if (!counts) {
      counts = { permissions: 0, errors: 0, prompts: 0, activity: 0 };
      this.sessions.set(sessionId, counts);
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify which badge type an item contributes to.
 * Returns null for items that should not generate badges.
 */
function classifyBadgeType(item: TimelineItem): BadgeType | null {
  switch (item.type) {
    case "permission_request":
      return BadgeType.Permission;

    case "error":
      return BadgeType.Error;

    case "user_message":
      return BadgeType.Prompt;

    case "assistant_message":
      return BadgeType.Activity;

    case "tool_call":
      return BadgeType.Activity;

    case "thinking_block":
      return BadgeType.Activity;

    case "system_notification":
      return BadgeType.Activity;

    case "compact_notification":
      return BadgeType.Activity;

    case "permission_resolved":
      return BadgeType.Activity;

    // Usage updates do not generate badges
    case "usage_update":
      return null;

    default:
      return null;
  }
}

/**
 * Determine the highest-priority badge type from counts.
 */
function computeHighestPriority(counts: BadgeCounts): BadgeType {
  if (counts.permissions > 0) return BadgeType.Permission;
  if (counts.errors > 0) return BadgeType.Error;
  if (counts.prompts > 0) return BadgeType.Prompt;
  if (counts.activity > 0) return BadgeType.Activity;
  return BadgeType.None;
}
