/**
 * Event normalization utilities — re-exports from @saqr/cli normalization.
 *
 * Provides normalizers that convert raw GC events and SDK stream events
 * into TimelineItem[] for rendering. Also provides the mergeIntoTimeline
 * function for correlating related events (e.g., ToolCallRequested + Completed).
 *
 * @module utils/normalize
 */
export { normalizeGCEvent } from "@saqr/cli/normalization";
export { normalizeSDKEvent } from "@saqr/cli/normalization";
export type { SDKStreamEvent } from "@saqr/cli/normalization";
export { mergeIntoTimeline } from "@saqr/cli/normalization";
