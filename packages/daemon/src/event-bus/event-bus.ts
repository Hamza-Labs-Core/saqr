/**
 * Internal pub/sub event bus for the AgentContext daemon.
 *
 * The EventBus is the communication backbone between daemon subsystems.
 * Components publish events (from hooks, filesystem watchers, agent processes)
 * and other components subscribe to them (projection cache, search index,
 * WebSocket/SSE streaming, session manager).
 *
 * Design principles:
 * - Synchronous dispatch within the daemon process (no network hops)
 * - Typed event envelopes matching the unified event system
 * - Filter-based subscriptions to avoid unnecessary processing
 * - Memory-safe: subscriptions are cleaned up via returned unsubscribe functions
 */

import { getLogger } from "../logger.js";

/**
 * Unified event envelope as defined in Story 03.
 * This is the standard event format flowing through the bus.
 */
export interface EventEnvelope {
  /** UUID v4, globally unique */
  event_id: string;

  /** One of the 12 unified event types */
  event_type: string;

  /** Project identifier: {basename}-{hash6} */
  project_id: string;

  /** Session identifier from the agent */
  session_id: string;

  /** Per-session monotonically increasing counter (1-based) */
  sequence: number;

  /** ISO 8601 UTC timestamp with millisecond precision */
  timestamp: string;

  /** Which agent integration produced this event */
  agent_provider: string;

  /** The agent's native event type before normalization */
  agent_native_event: string;

  /** Agent-specific metadata */
  agent_metadata: Record<string, unknown>;

  /** The complete, unmodified payload from the agent's native hook */
  data: Record<string, unknown>;
}

/**
 * Filter criteria for event subscriptions.
 * All fields are optional; when multiple are specified, they are ANDed.
 */
export interface EventFilter {
  /** Filter by project ID */
  projectId?: string;

  /** Filter by session ID */
  sessionId?: string;

  /** Filter by event type(s) */
  eventTypes?: string[];

  /** Filter by agent provider */
  agentProvider?: string;
}

/** Function to unsubscribe from the event bus. */
export type Unsubscribe = () => void;

/** Event handler callback type. */
export type EventHandler = (event: EventEnvelope) => void;

/**
 * Internal pub/sub event bus for daemon components.
 *
 * All daemon subsystems communicate through this bus. Events are dispatched
 * synchronously to all matching subscribers in registration order.
 */
export class EventBus {
  /** Active subscriptions keyed by a unique subscription ID */
  private subscriptions = new Map<
    string,
    { filter: EventFilter | null; handler: EventHandler }
  >();

  /** Counter for generating subscription IDs */
  private nextSubscriptionId = 0;

  /** Total number of events published (lifetime counter). */
  private publishedCount = 0;

  /** Errors encountered during handler dispatch. */
  private errorCount = 0;

  /**
   * Publish an event to all matching subscribers.
   *
   * Events are dispatched synchronously. If a subscriber throws,
   * the error is logged but does not prevent delivery to other subscribers.
   *
   * @param event - The event envelope to publish
   */
  publish(event: EventEnvelope): void {
    this.publishedCount++;

    for (const [, subscription] of this.subscriptions) {
      if (this.matchesFilter(subscription.filter, event)) {
        try {
          subscription.handler(event);
        } catch (err) {
          this.errorCount++;
          // Log but do not re-throw: one bad subscriber must not
          // prevent delivery to remaining subscribers.
          getLogger().error("event-bus", "subscriber error:", err);
        }
      }
    }
  }

  /**
   * Returns the total number of events published since creation.
   */
  get totalPublished(): number {
    return this.publishedCount;
  }

  /**
   * Returns the total number of handler errors encountered.
   */
  get totalErrors(): number {
    return this.errorCount;
  }

  /**
   * Check whether an event matches a subscription filter.
   * A null filter matches everything.
   */
  private matchesFilter(filter: EventFilter | null, event: EventEnvelope): boolean {
    if (filter === null) return true;

    if (filter.projectId !== undefined && event.project_id !== filter.projectId) {
      return false;
    }
    if (filter.sessionId !== undefined && event.session_id !== filter.sessionId) {
      return false;
    }
    if (filter.eventTypes !== undefined && !filter.eventTypes.includes(event.event_type)) {
      return false;
    }
    if (filter.agentProvider !== undefined && event.agent_provider !== filter.agentProvider) {
      return false;
    }

    return true;
  }

  /**
   * Subscribe to events with an optional filter.
   *
   * @param filter - Filter criteria (null = receive all events)
   * @param handler - Callback invoked for each matching event
   * @returns Unsubscribe function to remove this subscription
   *
   * TODO: Store subscription and return cleanup function
   */
  subscribe(filter: EventFilter | null, handler: EventHandler): Unsubscribe {
    const id = String(this.nextSubscriptionId++);
    this.subscriptions.set(id, { filter, handler });

    return () => {
      this.subscriptions.delete(id);
    };
  }

  /**
   * Subscribe to all events for a specific project.
   *
   * Convenience wrapper around subscribe() with a projectId filter.
   *
   * @param projectId - The project ID to filter on
   * @param handler - Callback invoked for each matching event
   * @returns Unsubscribe function
   */
  subscribeProject(projectId: string, handler: EventHandler): Unsubscribe {
    return this.subscribe({ projectId }, handler);
  }

  /**
   * Subscribe to all events for a specific session.
   *
   * Convenience wrapper around subscribe() with a sessionId filter.
   *
   * @param sessionId - The session ID to filter on
   * @param handler - Callback invoked for each matching event
   * @returns Unsubscribe function
   */
  subscribeSession(sessionId: string, handler: EventHandler): Unsubscribe {
    return this.subscribe({ sessionId }, handler);
  }

  /**
   * Returns the current number of active subscriptions.
   */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Removes all subscriptions. Used during daemon shutdown.
   *
   * TODO: Implement cleanup of all subscriptions
   */
  clear(): void {
    this.subscriptions.clear();
  }
}
