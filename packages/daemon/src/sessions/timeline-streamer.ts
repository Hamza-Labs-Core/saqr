/**
 * TimelineStreamer — streams session events to connected WebSocket/SSE clients.
 *
 * Converts raw EventEnvelope events from the EventBus into TimelineItem
 * objects and delivers them to connected clients. Supports:
 * - Multiple concurrent clients per session
 * - Backpressure handling (skip delivery to slow/paused clients)
 * - Automatic cleanup of EventBus subscriptions
 */

import type {
  EventBus,
  EventEnvelope,
  Unsubscribe,
} from "../event-bus/event-bus.js";

/**
 * A timeline item derived from an event envelope.
 *
 * This is the serialized form sent to WebSocket/SSE clients.
 */
export interface TimelineItem {
  /** Original event ID */
  eventId: string;

  /** Event type */
  eventType: string;

  /** Session ID */
  sessionId: string;

  /** Sequence number within the session */
  sequence: number;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Agent provider */
  agentProvider: string;

  /** Event payload data */
  data: Record<string, unknown>;
}

/**
 * Interface for a connected streaming client.
 *
 * The `isReady()` method is used for backpressure: if the client
 * is not ready (e.g., TCP buffer full), the event is dropped for
 * that client.
 */
export interface TimelineClient {
  /** Send a timeline item to this client */
  send(item: TimelineItem): void;

  /** Whether the client can accept data right now (backpressure) */
  isReady(): boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SessionClients {
  clients: Map<string, TimelineClient>;
  unsubscribe: Unsubscribe;
  droppedCount: number;
}

// ---------------------------------------------------------------------------
// TimelineStreamer
// ---------------------------------------------------------------------------

/**
 * Streams session events to connected clients via the EventBus.
 */
export class TimelineStreamer {
  private readonly eventBus: EventBus;
  private readonly sessionMap = new Map<string, SessionClients>();
  private nextClientId = 0;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Add a client that will receive timeline events for a session.
   *
   * If this is the first client for the session, an EventBus subscription
   * is created to start listening for events.
   *
   * @param sessionId - The session to stream events from.
   * @param client - The client interface.
   * @returns A unique client ID.
   */
  addClient(sessionId: string, client: TimelineClient): string {
    const clientId = `tc-${this.nextClientId++}`;

    let entry = this.sessionMap.get(sessionId);
    if (!entry) {
      // First client for this session — subscribe to EventBus
      const unsub = this.eventBus.subscribe(
        { sessionId },
        (event: EventEnvelope) => {
          this.handleEvent(sessionId, event);
        },
      );
      entry = {
        clients: new Map(),
        unsubscribe: unsub,
        droppedCount: 0,
      };
      this.sessionMap.set(sessionId, entry);
    }

    entry.clients.set(clientId, client);
    return clientId;
  }

  /**
   * Remove a client from a session.
   *
   * If this was the last client for the session, the EventBus
   * subscription is cleaned up.
   *
   * @param sessionId - The session ID.
   * @param clientId - The client ID returned by addClient().
   */
  removeClient(sessionId: string, clientId: string): void {
    const entry = this.sessionMap.get(sessionId);
    if (!entry) return;

    entry.clients.delete(clientId);

    if (entry.clients.size === 0) {
      entry.unsubscribe();
      this.sessionMap.delete(sessionId);
    }
  }

  /**
   * Get the number of connected clients for a session.
   *
   * @param sessionId - The session ID.
   * @returns Number of connected clients.
   */
  clientCount(sessionId: string): number {
    return this.sessionMap.get(sessionId)?.clients.size ?? 0;
  }

  /**
   * Get the number of events dropped due to backpressure for a session.
   *
   * @param sessionId - The session ID.
   * @returns Number of dropped events.
   */
  droppedCount(sessionId: string): number {
    return this.sessionMap.get(sessionId)?.droppedCount ?? 0;
  }

  /**
   * Destroy the streamer: remove all clients and clean up subscriptions.
   */
  destroy(): void {
    for (const [, entry] of this.sessionMap) {
      entry.unsubscribe();
      entry.clients.clear();
    }
    this.sessionMap.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert an EventEnvelope to a TimelineItem.
   */
  private toTimelineItem(event: EventEnvelope): TimelineItem {
    return {
      eventId: event.event_id,
      eventType: event.event_type,
      sessionId: event.session_id,
      sequence: event.sequence,
      timestamp: event.timestamp,
      agentProvider: event.agent_provider,
      data: event.data,
    };
  }

  /**
   * Handle an event from the EventBus for a specific session.
   */
  private handleEvent(sessionId: string, event: EventEnvelope): void {
    const entry = this.sessionMap.get(sessionId);
    if (!entry) return;

    const item = this.toTimelineItem(event);

    for (const client of entry.clients.values()) {
      if (client.isReady()) {
        try {
          client.send(item);
        } catch {
          // Swallow client errors
        }
      } else {
        entry.droppedCount++;
      }
    }
  }
}
