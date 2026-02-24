/**
 * @saqr/mobile types - All type exports for the mobile data layer.
 *
 * @module types
 */

export type {
  RootTabParamList,
  AgentsStackParamList,
  SessionsStackParamList,
  DashboardStackParamList,
  SettingsStackParamList,
  DeepLinkConfig,
  TabName,
} from "./navigation.js";
export { DEEP_LINK_CONFIG, TAB_NAMES } from "./navigation.js";

export type {
  ConnectionState,
  HostProfile,
  DaemonRegistryState,
} from "./daemon.js";

export type {
  AgentStatus,
  TokenUsage,
  AgentSummary,
  AgentSortField,
  SortDirection,
  AgentListFilter,
  AgentStreamEvent,
  PermissionRequest,
} from "./agent.js";

export type {
  SessionSummary,
  SessionFilter,
  SessionSearchResult,
  SearchMatch,
  SessionEventsPage,
  SessionEvent,
} from "./session.js";

export type {
  UsageStats,
  DailyUsage,
  ProjectUsage,
  ModelUsage,
  DateRange,
  DateRangePreset,
} from "./usage.js";

export type { FileEntry, GitFileStatus } from "./file.js";

export type {
  NotificationType,
  NotificationPriority,
  AgentNotification,
  NotificationTypeSettings,
  QuietHours,
  NotificationSettings,
  NotificationCategory,
} from "./notification.js";
export {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
} from "./notification.js";

export type {
  KeyInfo,
  KeyStorageOptions,
  QRLanInfo,
  QRRelayInfo,
  PairingPayload,
  KeyTransferPayload,
} from "./crypto.js";
export {
  DEFAULT_KEY_STORAGE_OPTIONS,
  PAIRING_URL_SCHEME,
  KEY_TRANSFER_URL_SCHEME,
  QR_MAX_AGE_MS,
  KEY_TRANSFER_MAX_AGE_MS,
} from "./crypto.js";

export type {
  QRScanError,
  VoiceInputError,
  ConnectionError,
} from "./errors.js";
