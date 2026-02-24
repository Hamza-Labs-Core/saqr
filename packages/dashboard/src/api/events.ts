/**
 * Event Feed API — read events from the on-disk event store.
 *
 * The event store layout is:
 *   {eventsDir}/{project-id}/{session-id}/000001.json
 *   {eventsDir}/{project-id}/{session-id}/session.json
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  project_id: string;
  name: string;
  session_count: number;
}

export interface SessionInfo {
  session_id: string;
  project_id: string;
  event_count: number;
  started_at?: string;
  ended_at?: string | null;
  model?: string;
  last_prompt?: string | null;
  [key: string]: unknown;
}

export interface EventEnvelope {
  event_id: string;
  event_type: string;
  project_id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  agent_provider: string;
  agent_native_event: string;
  agent_metadata: Record<string, unknown>;
  data: Record<string, unknown>;
  _summary?: { text: string; html: string };
}

export interface EventQuery {
  projectId: string;
  sessionId: string;
  fromSequence?: number;
  eventTypes?: string[];
  afterTimestamp?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVENT_FILE_RE = /^\d{6}\.json$/;

/**
 * Regex for safe identifiers: alphanumeric, dots, hyphens, underscores.
 * Dots are allowed because project IDs use the format "basename-hash6".
 * Maximum 256 characters to prevent abuse.
 */
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,256}$/;

/**
 * Validate that an identifier is safe for use in filesystem paths.
 * Rejects path traversal attempts (e.g. "..", "/", "\", null bytes).
 */
export function isValidPathId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  return SAFE_ID_RE.test(id);
}

/** Strip trailing 6-char hash from project_id to get display name */
export function projectName(projectId: string): string {
  return projectId.replace(/-[a-f0-9]{6}$/, "");
}

async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Event summary generation
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, maxLen: number): string {
  if (typeof s !== "string") return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

export function generateEventSummary(event: EventEnvelope): { text: string; html: string } {
  const data = event.data || {};
  switch (event.event_type) {
    case "SessionStarted":
      return {
        text: `Session started (model: ${data.model || "?"}, cwd: ${data.cwd || "?"})`,
        html: `<span class="ev-session-icon">&#9654;</span> <span class="ev-code">${escHtml(String(data.model || "?"))}</span> <span class="ev-output">cwd: ${escHtml(truncate(String(data.cwd || "?"), 80))}</span>`,
      };
    case "SessionEnded":
      return {
        text: "Session ended",
        html: '<span class="ev-session-icon">&#9632;</span> <span class="ev-output">Session ended</span>',
      };
    case "UserPromptReceived": {
      const prompt = String(data.prompt || data.message || "");
      return {
        text: `User: ${truncate(prompt, 200)}`,
        html: `<span class="ev-prompt-icon">&#128172;</span> <span class="ev-prompt">${escHtml(truncate(prompt, 300))}</span>`,
      };
    }
    case "ToolCallRequested": {
      const toolName = String(data.tool_name || "?");
      return {
        text: `${toolName}: requested`,
        html: `<span class="ev-icon">&#128295;</span> <strong>${escHtml(toolName)}</strong>`,
      };
    }
    case "ToolCallCompleted": {
      const toolName = String(data.tool_name || "?");
      return {
        text: `${toolName}: completed`,
        html: `<span class="ev-icon">&#9989;</span> <strong>${escHtml(toolName)}</strong> <span class="ev-output ev-success">completed</span>`,
      };
    }
    case "ToolCallFailed": {
      const toolName = String(data.tool_name || "?");
      const error = String(data.error || "");
      return {
        text: `FAILED ${toolName}: ${truncate(error, 150)}`,
        html: `<div class="ev-error"><span class="ev-error-icon">&#10060;</span> <strong>${escHtml(toolName)}</strong>: ${escHtml(truncate(error, 200))}</div>`,
      };
    }
    case "AgentSpawned":
      return {
        text: `Spawned ${data.agent_type || "?"}: ${truncate(String(data.description || ""), 100)}`,
        html: `<span class="ev-agent-icon">&#129302;</span> <span class="ev-code">${escHtml(String(data.agent_type || "?"))}</span>`,
      };
    case "AgentCompleted":
      return {
        text: `Agent done: ${data.agent_type || "?"}`,
        html: `<span class="ev-agent-icon">&#129302;</span> <span class="ev-code">${escHtml(String(data.agent_type || "?"))}</span> <span class="ev-output ev-success">completed</span>`,
      };
    case "TurnCompleted":
      return {
        text: "Turn completed",
        html: '<span class="ev-output">Turn completed</span>',
      };
    case "CompactionTriggered":
      return {
        text: `COMPACTION at seq ${event.sequence}`,
        html: '<span class="ev-compact-icon">&#9888;</span> <span class="ev-compact">Compaction triggered</span>',
      };
    default:
      return {
        text: `${event.event_type} at seq ${event.sequence}`,
        html: `${escHtml(event.event_type)} <span class="ev-output">seq ${event.sequence || ""}</span>`,
      };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all projects (directories under eventsDir) */
export async function listProjects(eventsDir: string): Promise<ProjectInfo[]> {
  const entries = await safeReaddir(eventsDir);
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    const entryPath = path.join(eventsDir, entry);
    const st = await safeStat(entryPath);
    if (!st || !st.isDirectory()) continue;

    const sessions = await safeReaddir(entryPath);
    let sessionCount = 0;
    for (const s of sessions) {
      const sp = path.join(entryPath, s);
      const sst = await safeStat(sp);
      if (sst?.isDirectory()) sessionCount++;
    }

    projects.push({
      project_id: entry,
      name: projectName(entry),
      session_count: sessionCount,
    });
  }

  return projects;
}

/** List sessions for a project with metadata from session.json */
export async function listSessions(
  eventsDir: string,
  projectId: string,
): Promise<SessionInfo[]> {
  if (!isValidPathId(projectId)) {
    throw new Error("Invalid project ID");
  }
  const pdir = path.join(eventsDir, projectId);
  const entries = await safeReaddir(pdir);
  const sessions: SessionInfo[] = [];

  for (const entry of entries) {
    const sdir = path.join(pdir, entry);
    const st = await safeStat(sdir);
    if (!st || !st.isDirectory()) continue;

    let meta: SessionInfo = { session_id: entry, project_id: projectId, event_count: 0 };
    const metaPath = path.join(sdir, "session.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const parsed = JSON.parse(raw);
      meta = { ...meta, ...parsed };
    } catch {
      // Count event files as fallback
      const files = await safeReaddir(sdir);
      meta.event_count = files.filter((f) => EVENT_FILE_RE.test(f)).length;
    }

    sessions.push(meta);
  }

  // Sort by started_at descending (newest first)
  sessions.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
  return sessions;
}

/** Read events from a session, optionally filtering */
export async function readEvents(
  eventsDir: string,
  query: EventQuery,
): Promise<EventEnvelope[]> {
  if (!isValidPathId(query.projectId)) {
    throw new Error("Invalid project ID");
  }
  if (!isValidPathId(query.sessionId)) {
    throw new Error("Invalid session ID");
  }
  const sdir = path.join(eventsDir, query.projectId, query.sessionId);
  const entries = await safeReaddir(sdir);
  const fromSeq = query.fromSequence ?? 0;

  const eventFiles = entries
    .filter((f) => EVENT_FILE_RE.test(f))
    .map((f) => ({
      filename: f,
      sequence: parseInt(f.replace(".json", ""), 10),
    }))
    .filter((f) => f.sequence > fromSeq)
    .sort((a, b) => a.sequence - b.sequence);

  const events: EventEnvelope[] = [];
  for (const ef of eventFiles) {
    try {
      const raw = await readFile(path.join(sdir, ef.filename), "utf-8");
      const parsed: EventEnvelope = JSON.parse(raw);

      // Apply event type filter
      if (query.eventTypes && !query.eventTypes.includes(parsed.event_type)) {
        continue;
      }

      // Apply timestamp filter
      if (query.afterTimestamp && parsed.timestamp <= query.afterTimestamp) {
        continue;
      }

      parsed._summary = generateEventSummary(parsed);
      events.push(parsed);
    } catch {
      /* skip corrupt files */
    }

    // Apply limit
    if (query.limit && events.length >= query.limit) {
      break;
    }
  }

  return events;
}
