/**
 * @saqr/mobile services - Data layer service exports.
 *
 * @module services
 */

export { ConnectionManager } from "./connection-manager.js";
export { DaemonRegistry } from "./daemon-registry.js";
export type { ParseResult } from "./daemon-registry.js";
export { AgentDataAggregator } from "./agent-data-aggregator.js";
export { SessionHistoryManager } from "./session-history-manager.js";
export type { SessionPage } from "./session-history-manager.js";
export { UsageDataAggregator } from "./usage-data-aggregator.js";
export type { MergeOptions } from "./usage-data-aggregator.js";
export { NotificationManager } from "./notification-manager.js";
export type { EventContext, DeepLink } from "./notification-manager.js";
export { OfflineCacheManager } from "./offline-cache-manager.js";
export type {
  CacheConfig,
  CacheEntryOptions,
  CacheEntryMetadata,
  SyncQueueItem,
  QuotaUsage,
} from "./offline-cache-manager.js";
export { EncryptionKeyManager, KeyCache } from "./encryption-key-manager.js";
export type { DecodeResult } from "./encryption-key-manager.js";
export { VoiceInputManager } from "./voice-input-manager.js";
export type { VoiceState, VoiceConfig } from "./voice-input-manager.js";
