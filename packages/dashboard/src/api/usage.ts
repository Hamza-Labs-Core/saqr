/**
 * Usage Analytics API — parse JSONL transcripts for token usage.
 *
 * Reads Claude's JSONL transcript files from ~/.claude/projects/ and
 * aggregates usage data per project, per model, per day, and per month.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";

import { listProjects } from "./events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionUsage {
  session_id: string;
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  model: string;
  started_at: string;
  last_api_call_at: string;
}

export interface DailyUsage {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  api_calls: number;
}

export interface MonthlyUsage {
  month: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  api_calls: number;
}

export interface UsageTotals {
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

export interface ProjectUsage {
  project_id: string;
  project_name: string;
  claude_dir: string;
  sessions: SessionUsage[];
  totals: UsageTotals;
  weekly: UsageTotals;
  by_model: Record<string, UsageTotals>;
  daily: DailyUsage[];
  monthly: MonthlyUsage[];
}

// ---------------------------------------------------------------------------
// Model pricing (per 1M tokens)
// ---------------------------------------------------------------------------

export const MODEL_PRICING: Record<string, {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}> = {
  opus: { input: 15, output: 75, cache_read: 1.5, cache_create: 18.75 },
  sonnet: { input: 3, output: 15, cache_read: 0.3, cache_create: 3.75 },
  haiku: { input: 0.8, output: 4, cache_read: 0.08, cache_create: 1 },
};

export function getModelTier(model: string): string {
  if (!model) return "opus";
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  return "opus";
}

export function calcCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  model: string,
): number {
  const tier = getModelTier(model);
  const p = MODEL_PRICING[tier] || MODEL_PRICING.opus;
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheReadTokens / 1_000_000) * p.cache_read +
    (cacheCreateTokens / 1_000_000) * p.cache_create
  );
}

export function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

export function formatCost(c: number): string {
  if (c >= 100) return "$" + c.toFixed(0);
  if (c >= 10) return "$" + c.toFixed(1);
  return "$" + c.toFixed(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/** Convert a project directory path to Claude's directory name convention */
export function toClaudeDir(projectDir: string): string {
  return "-" + projectDir.replace(/^\//, "").replace(/\//g, "-");
}

/** Read project_dir from the first session.json found in a project's events dir */
export async function getProjectDir(
  eventsDir: string,
  projectId: string,
): Promise<string | null> {
  const pdir = path.join(eventsDir, projectId);
  try {
    const entries = await readdir(pdir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(pdir, e.name, "session.json");
      try {
        const raw = await readFile(metaPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.project_dir) return parsed.project_dir;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* no events dir */
  }
  return null;
}

// Usage cache: key = "filepath:filesize" -> parsed result
const usageCache = new Map<string, { sessions: Map<string, SessionUsage>; daily: Map<string, DailyUsage> }>();

/** Stream-parse a JSONL transcript file and extract assistant usage entries */
export async function parseTranscriptFile(
  filePath: string,
): Promise<{ sessions: Map<string, SessionUsage>; daily: Map<string, DailyUsage> }> {
  const sessions = new Map<string, SessionUsage>();
  const daily = new Map<string, DailyUsage>();

  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      // Fast pre-filter
      if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) return;

      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant") return;

        const usage = entry.message?.usage;
        if (!usage) return;

        const sessionId = entry.sessionId || "unknown";
        const model = entry.message?.model || "unknown";
        const timestamp = entry.timestamp || "";

        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, {
            session_id: sessionId,
            api_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            model,
            started_at: timestamp,
            last_api_call_at: timestamp,
          });
        }

        const s = sessions.get(sessionId)!;
        s.api_calls++;
        s.input_tokens += usage.input_tokens || 0;
        s.output_tokens += usage.output_tokens || 0;
        s.cache_read_tokens += usage.cache_read_input_tokens || 0;
        s.cache_create_tokens += usage.cache_creation_input_tokens || 0;
        if (model !== "unknown") s.model = model;
        if (!s.started_at || timestamp < s.started_at) s.started_at = timestamp;
        if (!s.last_api_call_at || timestamp > s.last_api_call_at) s.last_api_call_at = timestamp;

        // Aggregate daily
        const dateKey = timestamp.slice(0, 10);
        if (dateKey && dateKey.length === 10) {
          if (!daily.has(dateKey)) {
            daily.set(dateKey, {
              date: dateKey,
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_create_tokens: 0,
              api_calls: 0,
            });
          }
          const d = daily.get(dateKey)!;
          d.input_tokens += usage.input_tokens || 0;
          d.output_tokens += usage.output_tokens || 0;
          d.cache_read_tokens += usage.cache_read_input_tokens || 0;
          d.cache_create_tokens += usage.cache_creation_input_tokens || 0;
          d.api_calls++;
        }
      } catch {
        /* skip malformed */
      }
    });

    rl.on("close", () => resolve({ sessions, daily }));
    rl.on("error", (err: Error) => reject(err));
    stream.on("error", (err: Error) => reject(err));
  });
}

/** Parse JSONL lines directly (for testing / in-memory usage) */
export function parseTranscriptLines(
  lines: string[],
): { sessions: Map<string, SessionUsage>; daily: Map<string, DailyUsage> } {
  const sessions = new Map<string, SessionUsage>();
  const daily = new Map<string, DailyUsage>();

  for (const line of lines) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) continue;

    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") return { sessions, daily };

      const usage = entry.message?.usage;
      if (!usage) continue;

      const sessionId = entry.sessionId || "unknown";
      const model = entry.message?.model || "unknown";
      const timestamp = entry.timestamp || "";

      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          session_id: sessionId,
          api_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_create_tokens: 0,
          model,
          started_at: timestamp,
          last_api_call_at: timestamp,
        });
      }

      const s = sessions.get(sessionId)!;
      s.api_calls++;
      s.input_tokens += usage.input_tokens || 0;
      s.output_tokens += usage.output_tokens || 0;
      s.cache_read_tokens += usage.cache_read_input_tokens || 0;
      s.cache_create_tokens += usage.cache_creation_input_tokens || 0;
      if (model !== "unknown") s.model = model;
      if (!s.started_at || timestamp < s.started_at) s.started_at = timestamp;
      if (!s.last_api_call_at || timestamp > s.last_api_call_at) s.last_api_call_at = timestamp;

      const dateKey = timestamp.slice(0, 10);
      if (dateKey && dateKey.length === 10) {
        if (!daily.has(dateKey)) {
          daily.set(dateKey, {
            date: dateKey,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            api_calls: 0,
          });
        }
        const d = daily.get(dateKey)!;
        d.input_tokens += usage.input_tokens || 0;
        d.output_tokens += usage.output_tokens || 0;
        d.cache_read_tokens += usage.cache_read_input_tokens || 0;
        d.cache_create_tokens += usage.cache_creation_input_tokens || 0;
        d.api_calls++;
      }
    } catch {
      /* skip */
    }
  }

  return { sessions, daily };
}

/** Get cached usage for a single JSONL file */
async function getFileUsage(filePath: string) {
  try {
    const st = await stat(filePath);
    const cacheKey = filePath + ":" + st.size;
    if (usageCache.has(cacheKey)) {
      return usageCache.get(cacheKey)!;
    }
    const result = await parseTranscriptFile(filePath);
    usageCache.set(cacheKey, result);
    return result;
  } catch {
    return { sessions: new Map<string, SessionUsage>(), daily: new Map<string, DailyUsage>() };
  }
}

/** Get usage data for a single project */
export async function getProjectUsage(
  eventsDir: string,
  projectId: string,
  claudeProjectsDir?: string,
): Promise<ProjectUsage | null> {
  const projectDir = await getProjectDir(eventsDir, projectId);
  if (!projectDir) return null;

  const claudeDir = toClaudeDir(projectDir);
  const claudePath = path.join(claudeProjectsDir || CLAUDE_PROJECTS_DIR, claudeDir);

  let files: string[];
  try {
    const entries = await readdir(claudePath);
    files = entries.filter((f) => f.endsWith(".jsonl")).map((f) => path.join(claudePath, f));
  } catch {
    return null;
  }

  const allSessions = new Map<string, SessionUsage>();
  const allDaily = new Map<string, DailyUsage>();

  // Parse files
  const CONCURRENCY = 8;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((f) => getFileUsage(f)));

    for (const result of results) {
      for (const [sid, usage] of result.sessions) {
        if (!allSessions.has(sid)) {
          allSessions.set(sid, { ...usage });
        } else {
          const existing = allSessions.get(sid)!;
          existing.api_calls += usage.api_calls;
          existing.input_tokens += usage.input_tokens;
          existing.output_tokens += usage.output_tokens;
          existing.cache_read_tokens += usage.cache_read_tokens;
          existing.cache_create_tokens += usage.cache_create_tokens;
          if (usage.model !== "unknown") existing.model = usage.model;
          if (usage.started_at < existing.started_at) existing.started_at = usage.started_at;
          if (usage.last_api_call_at > existing.last_api_call_at) existing.last_api_call_at = usage.last_api_call_at;
        }
      }

      for (const [dateKey, dayUsage] of result.daily) {
        if (!allDaily.has(dateKey)) {
          allDaily.set(dateKey, { ...dayUsage });
        } else {
          const existing = allDaily.get(dateKey)!;
          existing.input_tokens += dayUsage.input_tokens;
          existing.output_tokens += dayUsage.output_tokens;
          existing.cache_read_tokens += dayUsage.cache_read_tokens;
          existing.cache_create_tokens += dayUsage.cache_create_tokens;
          existing.api_calls += dayUsage.api_calls;
        }
      }
    }
  }

  const sessions = Array.from(allSessions.values()).sort(
    (a, b) => (b.last_api_call_at || "").localeCompare(a.last_api_call_at || ""),
  );

  const totals: UsageTotals = {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
  };

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekly: UsageTotals = {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
  };

  for (const s of sessions) {
    totals.api_calls += s.api_calls;
    totals.input_tokens += s.input_tokens;
    totals.output_tokens += s.output_tokens;
    totals.cache_read_tokens += s.cache_read_tokens;
    totals.cache_create_tokens += s.cache_create_tokens;

    if (s.last_api_call_at && new Date(s.last_api_call_at) >= weekAgo) {
      weekly.api_calls += s.api_calls;
      weekly.input_tokens += s.input_tokens;
      weekly.output_tokens += s.output_tokens;
      weekly.cache_read_tokens += s.cache_read_tokens;
      weekly.cache_create_tokens += s.cache_create_tokens;
    }
  }

  const byModel: Record<string, UsageTotals> = {};
  for (const s of sessions) {
    const model = s.model || "unknown";
    if (!byModel[model]) {
      byModel[model] = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_create_tokens: 0, api_calls: 0 };
    }
    byModel[model].input_tokens += s.input_tokens;
    byModel[model].output_tokens += s.output_tokens;
    byModel[model].cache_read_tokens += s.cache_read_tokens;
    byModel[model].cache_create_tokens += s.cache_create_tokens;
    byModel[model].api_calls += s.api_calls;
  }

  const daily = Array.from(allDaily.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Build monthly aggregation
  const monthlyMap = new Map<string, MonthlyUsage>();
  for (const d of daily) {
    const monthKey = d.date.slice(0, 7);
    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, {
        month: monthKey,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        api_calls: 0,
      });
    }
    const m = monthlyMap.get(monthKey)!;
    m.input_tokens += d.input_tokens;
    m.output_tokens += d.output_tokens;
    m.cache_read_tokens += d.cache_read_tokens;
    m.cache_create_tokens += d.cache_create_tokens;
    m.api_calls += d.api_calls;
  }

  const monthly = Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month));

  const name = projectId.replace(/-[a-f0-9]{6}$/, "");

  return {
    project_id: projectId,
    project_name: name,
    claude_dir: claudeDir,
    sessions,
    totals,
    weekly,
    by_model: byModel,
    daily,
    monthly,
  };
}

/** Get usage for all projects */
export async function getAllUsage(
  eventsDir: string,
  claudeProjectsDir?: string,
): Promise<ProjectUsage[]> {
  const projects = await listProjects(eventsDir);
  const results = await Promise.all(
    projects.map((p) => getProjectUsage(eventsDir, p.project_id, claudeProjectsDir).catch(() => null)),
  );
  return results.filter(Boolean) as ProjectUsage[];
}
