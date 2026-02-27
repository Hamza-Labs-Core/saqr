/**
 * @saqr/terminal-ui — Terminal-faithful UI components for remote clients.
 *
 * Provides React components that replicate Claude Code's terminal rendering
 * in browser (Tauri WebView, web client) and React Native Web.
 *
 * @packageDocumentation
 */

// Components
export { Timeline } from "./components/Timeline.js";
export { UserMessage } from "./components/UserMessage.js";
export { AssistantMessage } from "./components/AssistantMessage.js";
export { ThinkingBlock } from "./components/ThinkingBlock.js";
export { ToolCall } from "./components/ToolCall.js";
export { PermissionRequest } from "./components/PermissionRequest.js";
export { ErrorBlock } from "./components/ErrorBlock.js";
export { SystemNotification, CompactNotification, UsageUpdate } from "./components/SystemNotification.js";

// Component prop types
export type { TimelineProps } from "./components/Timeline.js";
export type { UserMessageProps } from "./components/UserMessage.js";
export type { AssistantMessageProps } from "./components/AssistantMessage.js";
export type { ThinkingBlockProps } from "./components/ThinkingBlock.js";
export type { ToolCallProps } from "./components/ToolCall.js";
export type { PermissionRequestProps } from "./components/PermissionRequest.js";
export type { ErrorBlockProps } from "./components/ErrorBlock.js";

// Hooks
export { useSession } from "./hooks/useSession.js";
export { useTimeline } from "./hooks/useTimeline.js";
export type { UseSessionOptions, UseSessionResult } from "./hooks/useSession.js";
export type { UseTimelineResult } from "./hooks/useTimeline.js";

// Theme
export {
  themeColorsToCssVars,
  syntaxThemeToCssVars,
  themeToCssVars,
  getToolColorVar,
} from "./theme.js";

// Types (re-exported from @saqr/cli)
export type {
  TimelineItem,
  TimelineItemType,
  UserMessage as UserMessageType,
  AssistantMessage as AssistantMessageType,
  ThinkingBlock as ThinkingBlockType,
  ToolCall as ToolCallType,
  PermissionRequest as PermissionRequestType,
  ErrorItem,
  SystemNotification as SystemNotificationType,
  CompactNotification as CompactNotificationType,
  UsageUpdate as UsageUpdateType,
  AppTheme,
  ThemeColors,
  SyntaxTheme,
  ConnectionState,
  SessionInfo,
  WsMessage,
} from "./types.js";

export {
  isUserMessage,
  isAssistantMessage,
  isThinkingBlock,
  isToolCall,
  isPermissionRequest,
  isPermissionResolved,
  isErrorItem,
  isSystemNotification,
  isCompactNotification,
  isUsageUpdate,
  DARK_THEME,
  LIGHT_THEME,
} from "./types.js";
