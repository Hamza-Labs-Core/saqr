/**
 * EventStore — read-side access to the event file store.
 *
 * The EventStore is the daemon's read-side view of the immutable event files
 * written by capture-event. It provides query APIs for reading events from
 * disk and integrates with the projection cache and search index.
 *
 * Key principle (Story 04): The event store on disk is the single source
 * of truth. The daemon is a read-side accelerator — it caches, indexes,
 * and streams, but never owns data that does not also exist on disk.
 * If the daemon restarts, it rebuilds state from the filesystem.
 *
 * File layout:
 *   {eventsDir}/{project-id}/{session-id}/000001.json
 *   {eventsDir}/{project-id}/{session-id}/000002.json
 *   {eventsDir}/{project-id}/{session-id}/session.json
 */

import { readdir, readFile, access, stat } from "node:fs/promises";
import path from "node:path";
import type { EventEnvelope } from "../event-bus/event-bus.js";

/**
 * Query options for reading events.
 */
export interface EventQuery {
  /** Filter by project ID */
  projectId?: string;

  /** Filter by session ID */
  sessionId?: string;

  /** Filter by event type(s) */
  eventTypes?: string[];

  /** Filter by agent provider */
  agentProvider?: string;

  /** Only events after this sequence number */
  afterSequence?: number;

  /** Only events after this timestamp (ISO 8601) */
  afterTimestamp?: string;

  /** Maximum number of events to return */
  limit?: number;

  /** Sort order: "asc" (default) or "desc" */
  order?: "asc" | "desc";
}

/**
 * Summary of a project's event data.
 */
export interface ProjectSummary {
  /** Project identifier */
  projectId: string;

  /** Total number of sessions */
  sessionCount: number;

  /** Total number of events across all sessions */
  totalEvents: number;

  /** Timestamp of the most recent event */
  lastEventAt: string | null;

  /** Agent providers that have sessions in this project */
  agentProviders: string[];
}

/**
 * Summary of a session's event data.
 */
export interface SessionSummary {
  /** Session identifier */
  sessionId: string;

  /** Project this session belongs to */
  projectId: string;

  /** Agent provider for this session */
  agentProvider: string;

  /** Total events in this session */
  eventCount: number;

  /** First event timestamp */
  startedAt: string | null;

  /** Last event timestamp */
  endedAt: string | null;
}

/**
 * Session metadata from session.json.
 */
export interface SessionMetadata {
  session_id: string;
  project_id: string;
  project_dir?: string;
  started_at?: string;
  source?: string;
  model?: string;
  event_count: number;
  last_event_at?: string;
  last_event_type?: string;
  last_prompt?: string | null;
  ended_at?: string | null;
  previous_session_id?: string | null;
  agent_provider: string;
  agent_version?: string | null;
  parent_session_id?: string | null;
  parent_agent_provider?: string | null;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
  tool_call_count?: number;
  tool_call_errors?: number;
  compaction_count?: number;
  tags?: string[];
}

// Helper: zero-pad a sequence number to 6 digits
function padSequence(seq: number): string {
  return String(seq).padStart(6, "0");
}

// Helper: test if a filename matches the NNNNNN.json pattern
const EVENT_FILE_RE = /^\d{6}\.json$/;

/**
 * Read-side event store for the daemon.
 *
 * Provides efficient access to event files on disk with support
 * for filtering, pagination, and summaries.
 */
export class EventStore {
  private readonly eventsDir: string;

  /**
   * Creates a new EventStore.
   *
   * @param eventsDir - Root directory for event files
   */
  constructor(eventsDir: string) {
    this.eventsDir = eventsDir;
  }

  /**
   * Read events matching the given query.
   */
  async queryEvents(query: EventQuery): Promise<EventEnvelope[]> {
    const sessions = await this.resolveSessionDirs(query.projectId, query.sessionId);
    const allEvents: EventEnvelope[] = [];

    for (const { projectId, sessionId, sessionDir } of sessions) {
      const events = await this.readSessionEvents(sessionDir, projectId, sessionId, query);
      allEvents.push(...events);
    }

    // Sort
    const order = query.order ?? "asc";
    allEvents.sort((a, b) => {
      const cmp = a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence;
      return order === "asc" ? cmp : -cmp;
    });

    // Apply limit
    if (query.limit !== undefined && query.limit > 0) {
      return allEvents.slice(0, query.limit);
    }

    return allEvents;
  }

  /**
   * Read a single event by project, session, and sequence.
   */
  async getEvent(
    projectId: string,
    sessionId: string,
    sequence: number,
  ): Promise<EventEnvelope | null> {
    const filePath = path.join(
      this.eventsDir,
      projectId,
      sessionId,
      `${padSequence(sequence)}.json`,
    );
    return this.readEventFile(filePath);
  }

  /**
   * List all projects in the event store.
   */
  async listProjects(): Promise<ProjectSummary[]> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.eventsDir);
    } catch {
      return [];
    }

    const projects: ProjectSummary[] = [];

    for (const projDir of projectDirs) {
      const projPath = path.join(this.eventsDir, projDir);
      const st = await safeStat(projPath);
      if (!st || !st.isDirectory()) continue;

      let sessionDirs: string[];
      try {
        sessionDirs = await readdir(projPath);
      } catch {
        continue;
      }

      let sessionCount = 0;
      let totalEvents = 0;
      let lastEventAt: string | null = null;
      const agentProviders = new Set<string>();

      for (const sessDir of sessionDirs) {
        const sessPath = path.join(projPath, sessDir);
        const sst = await safeStat(sessPath);
        if (!sst || !sst.isDirectory()) continue;

        const meta = await this.readSessionJsonFile(sessPath);
        if (!meta) continue;

        sessionCount++;
        totalEvents += meta.event_count ?? 0;

        if (meta.agent_provider) {
          agentProviders.add(meta.agent_provider);
        }

        const eventAt = meta.last_event_at ?? meta.started_at;
        if (eventAt && (!lastEventAt || eventAt > lastEventAt)) {
          lastEventAt = eventAt;
        }
      }

      if (sessionCount > 0) {
        projects.push({
          projectId: projDir,
          sessionCount,
          totalEvents,
          lastEventAt,
          agentProviders: [...agentProviders],
        });
      }
    }

    return projects;
  }

  /**
   * List all sessions for a project.
   */
  async listSessions(projectId: string): Promise<SessionSummary[]> {
    const projPath = path.join(this.eventsDir, projectId);
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(projPath);
    } catch {
      return [];
    }

    const sessions: SessionSummary[] = [];

    for (const sessDir of sessionDirs) {
      const sessPath = path.join(projPath, sessDir);
      const st = await safeStat(sessPath);
      if (!st || !st.isDirectory()) continue;

      const meta = await this.readSessionJsonFile(sessPath);
      if (!meta) continue;

      sessions.push({
        sessionId: meta.session_id ?? sessDir,
        projectId,
        agentProvider: meta.agent_provider ?? "unknown",
        eventCount: meta.event_count ?? 0,
        startedAt: meta.started_at ?? null,
        endedAt: meta.ended_at ?? null,
      });
    }

    return sessions;
  }

  /**
   * Get the latest event sequence number for a session.
   */
  async getLatestSequence(
    projectId: string,
    sessionId: string,
  ): Promise<number> {
    const sessionDir = path.join(this.eventsDir, projectId, sessionId);
    const files = await this.discoverEventFiles(sessionDir);
    if (files.length === 0) return 0;
    return Math.max(...files.map((f) => f.sequence));
  }

  /**
   * Count events matching a query.
   */
  async countEvents(query: EventQuery): Promise<number> {
    const sessions = await this.resolveSessionDirs(query.projectId, query.sessionId);
    let count = 0;

    for (const { sessionDir } of sessions) {
      const files = await this.discoverEventFiles(sessionDir);
      count += files.length;
    }

    return count;
  }

  /**
   * Get session metadata from session.json.
   */
  async getSessionMetadata(
    projectId: string,
    sessionId: string,
  ): Promise<SessionMetadata | null> {
    const sessPath = path.join(this.eventsDir, projectId, sessionId);
    return this.readSessionJsonFile(sessPath);
  }

  /**
   * Check if the events directory exists and is readable.
   */
  async isAccessible(): Promise<boolean> {
    try {
      await access(this.eventsDir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the base events directory path.
   */
  getEventsDir(): string {
    return this.eventsDir;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the list of session directories to scan based on query filters.
   */
  private async resolveSessionDirs(
    projectId?: string,
    sessionId?: string,
  ): Promise<Array<{ projectId: string; sessionId: string; sessionDir: string }>> {
    const result: Array<{ projectId: string; sessionId: string; sessionDir: string }> = [];

    if (projectId && sessionId) {
      const dir = path.join(this.eventsDir, projectId, sessionId);
      const st = await safeStat(dir);
      if (st?.isDirectory()) {
        result.push({ projectId, sessionId, sessionDir: dir });
      }
      return result;
    }

    if (projectId) {
      const projPath = path.join(this.eventsDir, projectId);
      let dirs: string[];
      try {
        dirs = await readdir(projPath);
      } catch {
        return [];
      }
      for (const d of dirs) {
        const sp = path.join(projPath, d);
        const st = await safeStat(sp);
        if (st?.isDirectory()) {
          result.push({ projectId, sessionId: d, sessionDir: sp });
        }
      }
      return result;
    }

    // No project filter — scan all
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.eventsDir);
    } catch {
      return [];
    }

    for (const pDir of projectDirs) {
      const projPath = path.join(this.eventsDir, pDir);
      const pst = await safeStat(projPath);
      if (!pst?.isDirectory()) continue;

      let sessDirs: string[];
      try {
        sessDirs = await readdir(projPath);
      } catch {
        continue;
      }
      for (const sDir of sessDirs) {
        const sp = path.join(projPath, sDir);
        const sst = await safeStat(sp);
        if (sst?.isDirectory()) {
          result.push({ projectId: pDir, sessionId: sDir, sessionDir: sp });
        }
      }
    }

    return result;
  }

  /**
   * Discover numbered event files in a session directory.
   */
  private async discoverEventFiles(
    sessionDir: string,
  ): Promise<Array<{ sequence: number; filePath: string }>> {
    let entries: string[];
    try {
      entries = await readdir(sessionDir);
    } catch {
      return [];
    }

    const files: Array<{ sequence: number; filePath: string }> = [];
    for (const entry of entries) {
      if (!EVENT_FILE_RE.test(entry)) continue;
      const sequence = parseInt(entry.replace(".json", ""), 10);
      files.push({ sequence, filePath: path.join(sessionDir, entry) });
    }

    files.sort((a, b) => a.sequence - b.sequence);
    return files;
  }

  /**
   * Read events from a single session directory, applying query filters.
   */
  private async readSessionEvents(
    sessionDir: string,
    projectId: string,
    sessionId: string,
    query: EventQuery,
  ): Promise<EventEnvelope[]> {
    const files = await this.discoverEventFiles(sessionDir);
    const events: EventEnvelope[] = [];

    for (const { sequence, filePath } of files) {
      // Apply afterSequence filter early (skip disk read)
      if (query.afterSequence !== undefined && sequence <= query.afterSequence) {
        continue;
      }

      const event = await this.readEventFile(filePath);
      if (!event) continue;

      // Apply event type filter
      if (query.eventTypes && !query.eventTypes.includes(event.event_type)) {
        continue;
      }

      // Apply agent provider filter
      if (query.agentProvider && event.agent_provider !== query.agentProvider) {
        continue;
      }

      // Apply afterTimestamp filter
      if (query.afterTimestamp && event.timestamp <= query.afterTimestamp) {
        continue;
      }

      events.push(event);
    }

    return events;
  }

  /**
   * Read and parse a single event JSON file.
   */
  private async readEventFile(filePath: string): Promise<EventEnvelope | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as EventEnvelope;
    } catch {
      return null;
    }
  }

  /**
   * Read session.json from a session directory.
   */
  private async readSessionJsonFile(
    sessionDir: string,
  ): Promise<SessionMetadata | null> {
    try {
      const raw = await readFile(path.join(sessionDir, "session.json"), "utf-8");
      return JSON.parse(raw) as SessionMetadata;
    } catch {
      return null;
    }
  }
}

/**
 * Stat a path, returning null if it does not exist.
 */
async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}
