/**
 * Events module: Unified event type system, envelope, and agent mapping tables.
 *
 * @module events
 */

export type {
  UnifiedEventType,
  SessionStartedPayload,
  UserPromptReceivedPayload,
  ToolCallRequestedPayload,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  AgentSpawnedPayload,
  AgentCompletedPayload,
  TurnCompletedPayload,
  CompactionTriggeredPayload,
  SessionEndedPayload,
  PermissionRequestedPayload,
  PermissionRespondedPayload,
  SessionStartedEvent,
  UserPromptReceivedEvent,
  ToolCallRequestedEvent,
  ToolCallCompletedEvent,
  ToolCallFailedEvent,
  AgentSpawnedEvent,
  AgentCompletedEvent,
  TurnCompletedEvent,
  CompactionTriggeredEvent,
  SessionEndedEvent,
  PermissionRequestedEvent,
  PermissionRespondedEvent,
  TypedEvent,
  EventPayloadMap,
} from "./types.js";

export { UNIFIED_EVENT_TYPES, isUnifiedEventType } from "./types.js";

export type {
  AgentMetadata,
  UnifiedEvent,
  CreateUnifiedEventParams,
} from "./envelope.js";

export { createUnifiedEvent } from "./envelope.js";

export type {
  EventMappingEntry,
  NativeToUnifiedMap,
} from "./mappings.js";

export {
  EVENT_MAPPING_TABLE,
  NATIVE_TO_UNIFIED,
  getNativeEventName,
  getUnifiedEventType,
} from "./mappings.js";
