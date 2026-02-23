/**
 * Store module — event store, projection cache, and search index.
 *
 * @module store
 */

export { EventStore } from "./event-store.js";
export type {
  EventQuery,
  ProjectSummary,
  SessionSummary,
} from "./event-store.js";

export { ProjectionCache } from "./projection-cache.js";
export type { CacheEntry, CacheStats } from "./projection-cache.js";

export { SearchIndex } from "./search-index.js";
export type {
  SearchResult,
  SearchQuery,
  IndexStats,
} from "./search-index.js";

export { UsageProjection, estimateCost, MODEL_PRICING } from "./usage-projection.js";
export type {
  SessionUsage,
  UsageTurn,
  UsageTotals,
  DailyUsageProjection,
  DailyUsageEntry,
  UsageByModelProjection,
  ModelUsageEntry,
  TokenUsage,
  ModelPricing,
} from "./usage-projection.js";
