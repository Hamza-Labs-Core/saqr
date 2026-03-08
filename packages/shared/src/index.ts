/**
 * @saqr/shared - Shared types and interfaces for the Saqr Agent Management Platform.
 *
 * This is the foundational types package consumed by all other Saqr TypeScript packages.
 * It provides:
 *
 * - **Events**: 12 unified event types, event envelope, and agent-to-unified mapping tables
 * - **Agents**: Provider types, capabilities, lifecycle states, and client/session interfaces
 * - **Sessions**: Session modes, runtime state, and persisted metadata
 * - **Sync**: Encrypted sync protocol types (push/pull payloads, cursors, config)
 * - **Crypto**: Client-side encryption types (keys, derivation params, encryption results)
 *
 * @packageDocumentation
 */

// -- Events ------------------------------------------------------------------
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
  AgentMetadata,
  UnifiedEvent,
  CreateUnifiedEventParams,
  EventMappingEntry,
  NativeToUnifiedMap,
} from "./events/index.js";

export {
  UNIFIED_EVENT_TYPES,
  isUnifiedEventType,
  createUnifiedEvent,
  EVENT_MAPPING_TABLE,
  NATIVE_TO_UNIFIED,
  getNativeEventName,
  getUnifiedEventType,
} from "./events/index.js";

// -- Agents ------------------------------------------------------------------
export type {
  AgentProvider,
  ProviderInfo,
  ProviderCapabilities,
  AgentLifecycleState,
  AgentClient,
  CreateSessionOptions,
  AgentSession,
} from "./agents/index.js";

export {
  BUILT_IN_PROVIDERS,
  ALL_PROVIDERS,
  isAgentProvider,
  PROVIDER_INFO,
  PROVIDER_CAPABILITIES,
  AGENT_LIFECYCLE_STATES,
} from "./agents/index.js";

// -- Sessions ----------------------------------------------------------------
export type {
  SessionMode,
  SessionState,
  SessionMetadata,
} from "./sessions/index.js";

export {
  SESSION_MODES,
  isSessionMode,
} from "./sessions/index.js";

// -- Sync --------------------------------------------------------------------
export type {
  EncryptedBlob,
  CleartextMetadata,
  SyncPushPayload,
  SyncPullRequest,
  SyncPullResponse,
  SyncCursor,
  SyncConfig,
} from "./sync/index.js";

// -- Auth --------------------------------------------------------------------
export type {
  DeviceCodeRequest,
  DeviceCodeResponse,
  DevicePollRequest,
  DevicePollTokenResponse,
  DevicePollPendingError,
  DevicePollErrorResponse,
  DeviceCodeStatus,
  DeviceCodeRecord,
  AuthCallback,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from "./auth/index.js";

// -- Crypto ------------------------------------------------------------------
export type {
  MasterKey,
  DerivedKey,
  KeyPurpose,
  EncryptionResult,
  KeyDerivationParams,
} from "./crypto/index.js";

export {
  KEY_PURPOSES,
  DEFAULT_KEY_DERIVATION_PARAMS,
} from "./crypto/index.js";
