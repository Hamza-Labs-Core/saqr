/**
 * Usage Types for the Saqr Mobile App.
 *
 * Defines usage statistics, daily/project/model breakdowns, and date ranges.
 *
 * @module types/usage
 */

/** Aggregated usage statistics for a time period. */
export interface UsageStats {
  /** Total input tokens across all projects. */
  totalInputTokens: number;
  /** Total output tokens across all projects. */
  totalOutputTokens: number;
  /** Total cache read tokens across all projects. */
  totalCacheReadTokens: number;
  /** Total estimated cost in USD. */
  totalCost: number;
  /** Per-day usage breakdown. */
  byDay: DailyUsage[];
  /** Per-project usage breakdown. */
  byProject: ProjectUsage[];
  /** Per-model usage breakdown. */
  byModel: ModelUsage[];
}

/** Usage data for a single day. */
export interface DailyUsage {
  /** Date in YYYY-MM-DD format. */
  date: string;
  /** Input tokens for this day. */
  inputTokens: number;
  /** Output tokens for this day. */
  outputTokens: number;
  /** Cache read tokens for this day. */
  cacheReadTokens: number;
  /** Cost for this day in USD. */
  cost: number;
  /** Number of sessions on this day. */
  sessionCount: number;
}

/** Usage data for a single project. */
export interface ProjectUsage {
  /** Project identifier. */
  projectId: string;
  /** Project display name. */
  projectName: string;
  /** Input tokens for this project. */
  inputTokens: number;
  /** Output tokens for this project. */
  outputTokens: number;
  /** Cost for this project in USD. */
  cost: number;
  /** Share of total cost (0-100). */
  percentage: number;
  /** Number of sessions in this project. */
  sessionCount: number;
}

/** Usage data for a single model. */
export interface ModelUsage {
  /** Model identifier. */
  model: string;
  /** Input tokens for this model. */
  inputTokens: number;
  /** Output tokens for this model. */
  outputTokens: number;
  /** Cost for this model in USD. */
  cost: number;
  /** Number of sessions using this model. */
  sessionCount: number;
}

/** Date range for filtering usage data. */
export interface DateRange {
  /** Start date (ISO 8601). */
  from: string;
  /** End date (ISO 8601). */
  to: string;
}

/** Predefined date range presets. */
export type DateRangePreset =
  | "this-week"
  | "this-month"
  | "last-month"
  | "last-3-months"
  | "custom";
