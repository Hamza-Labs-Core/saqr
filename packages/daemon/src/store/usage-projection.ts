/**
 * UsageProjection — token usage tracking per project, per model, per day.
 *
 * Processes events from the EventBus and builds:
 * - Per-session usage (tokens, tool calls, cost)
 * - Cross-session daily usage aggregation
 * - Cross-session per-model aggregation
 *
 * Story 04 requirement: Usage projections with cost estimation.
 */

import type { EventEnvelope } from "../event-bus/event-bus.js";

// ---------------------------------------------------------------------------
// Model pricing
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  "claude-sonnet-4-20250514": {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
};

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/**
 * Estimate cost in USD for a given token usage and model.
 */
export function estimateCost(usage: TokenUsage, model: string): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
  return (
    (usage.input_tokens * pricing.inputPerMillion) / 1_000_000 +
    (usage.output_tokens * pricing.outputPerMillion) / 1_000_000 +
    (usage.cache_read_tokens * pricing.cacheReadPerMillion) / 1_000_000 +
    (usage.cache_write_tokens * pricing.cacheWritePerMillion) / 1_000_000
  );
}

// ---------------------------------------------------------------------------
// Per-session usage types
// ---------------------------------------------------------------------------

export interface UsageTurn {
  turn_number: number;
  sequence: number;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_calls: number;
  prompt_preview: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  estimated_cost_usd: number;
}

export interface SessionUsage {
  _projection_type: "usage";
  _projection_version: number;
  _last_sequence: number;
  _session_id: string;
  model: string;
  agent_provider: string;
  turns: UsageTurn[];
  totals: UsageTotals;
  by_tool: Record<string, { calls: number; errors: number }>;
}

// ---------------------------------------------------------------------------
// Cross-session types
// ---------------------------------------------------------------------------

export interface DailyUsageEntry {
  date: string;
  sessions: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  by_model: Record<string, { sessions: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number }>;
  by_agent: Record<string, { sessions: number; total_tokens: number }>;
}

export interface DailyUsageProjection {
  _projection_type: "usage-daily";
  _projection_version: number;
  _project_id: string;
  days: DailyUsageEntry[];
  totals: {
    days_active: number;
    total_sessions: number;
    total_tokens: number;
    estimated_total_cost_usd: number;
  };
}

export interface ModelUsageEntry {
  sessions: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  estimated_cost_usd: number;
  first_used: string;
  last_used: string;
}

export interface UsageByModelProjection {
  _projection_type: "usage-by-model";
  _projection_version: number;
  _project_id: string;
  models: Record<string, ModelUsageEntry>;
}

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface SessionState {
  projectId: string;
  sessionId: string;
  model: string;
  agentProvider: string;
  startedAt: string;
  turns: UsageTurn[];
  currentTurnToolCalls: number;
  lastPrompt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  toolCalls: number;
  toolErrors: number;
  byTool: Record<string, { calls: number; errors: number }>;
  lastSequence: number;
}

// ---------------------------------------------------------------------------
// UsageProjection class
// ---------------------------------------------------------------------------

/**
 * Processes events and builds usage projections per session and across sessions.
 */
export class UsageProjection {
  private sessions = new Map<string, SessionState>();

  /**
   * Process an event and update usage tracking.
   */
  processEvent(event: EventEnvelope): void {
    const key = `${event.project_id}:${event.session_id}`;

    switch (event.event_type) {
      case "SessionStarted": {
        const model =
          (event.data.model as string) ??
          (event.agent_metadata?.model as string) ??
          "unknown";
        this.sessions.set(key, {
          projectId: event.project_id,
          sessionId: event.session_id,
          model,
          agentProvider: event.agent_provider ?? "unknown",
          startedAt: event.timestamp,
          turns: [],
          currentTurnToolCalls: 0,
          lastPrompt: "",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          toolCalls: 0,
          toolErrors: 0,
          byTool: {},
          lastSequence: event.sequence,
        });
        break;
      }

      case "UserPromptReceived": {
        const session = this.getOrCreateSession(key, event);
        session.lastPrompt = (event.data.prompt as string) ?? "";
        session.currentTurnToolCalls = 0;
        session.lastSequence = event.sequence;
        break;
      }

      case "ToolCallCompleted": {
        const session = this.getOrCreateSession(key, event);
        const toolName = (event.data.tool_name as string) ?? "unknown";
        session.toolCalls++;
        session.currentTurnToolCalls++;
        if (!session.byTool[toolName]) {
          session.byTool[toolName] = { calls: 0, errors: 0 };
        }
        session.byTool[toolName].calls++;
        session.lastSequence = event.sequence;
        break;
      }

      case "ToolCallFailed": {
        const session = this.getOrCreateSession(key, event);
        const toolName = (event.data.tool_name as string) ?? "unknown";
        session.toolErrors++;
        if (!session.byTool[toolName]) {
          session.byTool[toolName] = { calls: 0, errors: 0 };
        }
        session.byTool[toolName].errors++;
        session.lastSequence = event.sequence;
        break;
      }

      case "TurnCompleted": {
        const session = this.getOrCreateSession(key, event);
        const usage = event.data.usage as Record<string, number> | undefined;

        const inputTokens = usage?.input_tokens ?? 0;
        const outputTokens = usage?.output_tokens ?? 0;
        const cacheRead = usage?.cache_read_input_tokens ?? 0;
        const cacheWrite = usage?.cache_creation_input_tokens ?? 0;

        session.totalInputTokens += inputTokens;
        session.totalOutputTokens += outputTokens;
        session.totalCacheRead += cacheRead;
        session.totalCacheWrite += cacheWrite;

        session.turns.push({
          turn_number: session.turns.length + 1,
          sequence: event.sequence,
          timestamp: event.timestamp,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          tool_calls: session.currentTurnToolCalls,
          prompt_preview: session.lastPrompt.slice(0, 80),
        });

        session.currentTurnToolCalls = 0;
        session.lastSequence = event.sequence;
        break;
      }

      default:
        // Untracked event types are ignored for usage projection
        break;
    }
  }

  /**
   * Get the per-session usage projection.
   */
  getSessionUsage(projectId: string, sessionId: string): SessionUsage | null {
    const key = `${projectId}:${sessionId}`;
    const session = this.sessions.get(key);
    if (!session) return null;

    const totalTokens =
      session.totalInputTokens +
      session.totalOutputTokens +
      session.totalCacheRead +
      session.totalCacheWrite;

    const cost = estimateCost(
      {
        input_tokens: session.totalInputTokens,
        output_tokens: session.totalOutputTokens,
        cache_read_tokens: session.totalCacheRead,
        cache_write_tokens: session.totalCacheWrite,
      },
      session.model,
    );

    return {
      _projection_type: "usage",
      _projection_version: 1,
      _last_sequence: session.lastSequence,
      _session_id: session.sessionId,
      model: session.model,
      agent_provider: session.agentProvider,
      turns: [...session.turns],
      totals: {
        input_tokens: session.totalInputTokens,
        output_tokens: session.totalOutputTokens,
        cache_read_tokens: session.totalCacheRead,
        cache_write_tokens: session.totalCacheWrite,
        total_tokens: totalTokens,
        turns: session.turns.length,
        tool_calls: session.toolCalls,
        tool_errors: session.toolErrors,
        estimated_cost_usd: Math.round(cost * 100) / 100,
      },
      by_tool: { ...session.byTool },
    };
  }

  /**
   * Get cross-session daily usage for a project.
   */
  getDailyUsage(projectId: string): DailyUsageProjection {
    const dayMap = new Map<string, DailyUsageEntry>();
    const sessionsByDay = new Map<string, Set<string>>();

    for (const session of this.sessions.values()) {
      if (session.projectId !== projectId) continue;

      // Determine the day from the session start
      const day = session.startedAt.slice(0, 10); // "YYYY-MM-DD"

      if (!sessionsByDay.has(day)) {
        sessionsByDay.set(day, new Set());
      }
      sessionsByDay.get(day)!.add(session.sessionId);

      let entry = dayMap.get(day);
      if (!entry) {
        entry = {
          date: day,
          sessions: 0,
          turns: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 0,
          estimated_cost_usd: 0,
          by_model: {},
          by_agent: {},
        };
        dayMap.set(day, entry);
      }

      entry.sessions = sessionsByDay.get(day)!.size;
      entry.turns += session.turns.length;
      entry.input_tokens += session.totalInputTokens;
      entry.output_tokens += session.totalOutputTokens;
      entry.cache_read_tokens += session.totalCacheRead;
      entry.cache_write_tokens += session.totalCacheWrite;
      entry.total_tokens +=
        session.totalInputTokens +
        session.totalOutputTokens +
        session.totalCacheRead +
        session.totalCacheWrite;

      const sessionCost = estimateCost(
        {
          input_tokens: session.totalInputTokens,
          output_tokens: session.totalOutputTokens,
          cache_read_tokens: session.totalCacheRead,
          cache_write_tokens: session.totalCacheWrite,
        },
        session.model,
      );
      entry.estimated_cost_usd += sessionCost;

      // By model
      if (!entry.by_model[session.model]) {
        entry.by_model[session.model] = {
          sessions: 0,
          input_tokens: 0,
          output_tokens: 0,
          estimated_cost_usd: 0,
        };
      }
      const modelEntry = entry.by_model[session.model];
      modelEntry.sessions++;
      modelEntry.input_tokens += session.totalInputTokens;
      modelEntry.output_tokens += session.totalOutputTokens;
      modelEntry.estimated_cost_usd += sessionCost;

      // By agent
      if (!entry.by_agent[session.agentProvider]) {
        entry.by_agent[session.agentProvider] = { sessions: 0, total_tokens: 0 };
      }
      const agentEntry = entry.by_agent[session.agentProvider];
      agentEntry.sessions++;
      agentEntry.total_tokens +=
        session.totalInputTokens +
        session.totalOutputTokens +
        session.totalCacheRead +
        session.totalCacheWrite;
    }

    const days = [...dayMap.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    let totalSessions = 0;
    let totalTokens = 0;
    let totalCost = 0;

    for (const day of days) {
      totalSessions += day.sessions;
      totalTokens += day.total_tokens;
      totalCost += day.estimated_cost_usd;
    }

    return {
      _projection_type: "usage-daily",
      _projection_version: 1,
      _project_id: projectId,
      days,
      totals: {
        days_active: days.length,
        total_sessions: totalSessions,
        total_tokens: totalTokens,
        estimated_total_cost_usd: Math.round(totalCost * 100) / 100,
      },
    };
  }

  /**
   * Get cross-session usage aggregated by model.
   */
  getUsageByModel(projectId: string): UsageByModelProjection {
    const models: Record<string, ModelUsageEntry> = {};

    for (const session of this.sessions.values()) {
      if (session.projectId !== projectId) continue;

      if (!models[session.model]) {
        models[session.model] = {
          sessions: 0,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          estimated_cost_usd: 0,
          first_used: session.startedAt,
          last_used: session.startedAt,
        };
      }

      const m = models[session.model];
      m.sessions++;
      m.input_tokens += session.totalInputTokens;
      m.output_tokens += session.totalOutputTokens;
      m.cache_read_tokens += session.totalCacheRead;
      m.cache_write_tokens += session.totalCacheWrite;
      m.total_tokens +=
        session.totalInputTokens +
        session.totalOutputTokens +
        session.totalCacheRead +
        session.totalCacheWrite;

      m.estimated_cost_usd += estimateCost(
        {
          input_tokens: session.totalInputTokens,
          output_tokens: session.totalOutputTokens,
          cache_read_tokens: session.totalCacheRead,
          cache_write_tokens: session.totalCacheWrite,
        },
        session.model,
      );

      if (session.startedAt < m.first_used) m.first_used = session.startedAt;
      if (session.startedAt > m.last_used) m.last_used = session.startedAt;
    }

    return {
      _projection_type: "usage-by-model",
      _projection_version: 1,
      _project_id: projectId,
      models,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get or create a session state entry.
   * Used when events arrive before SessionStarted (e.g. incremental loading).
   */
  private getOrCreateSession(key: string, event: EventEnvelope): SessionState {
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        projectId: event.project_id,
        sessionId: event.session_id,
        model: (event.agent_metadata?.model as string) ?? "unknown",
        agentProvider: event.agent_provider ?? "unknown",
        startedAt: event.timestamp,
        turns: [],
        currentTurnToolCalls: 0,
        lastPrompt: "",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        toolCalls: 0,
        toolErrors: 0,
        byTool: {},
        lastSequence: event.sequence,
      };
      this.sessions.set(key, session);
    }
    return session;
  }
}
