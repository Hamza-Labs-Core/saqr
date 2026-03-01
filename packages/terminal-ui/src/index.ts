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

// ToolCall sub-variant components
export { ReadTool } from "./components/ReadTool.js";
export { EditTool } from "./components/EditTool.js";
export { WriteTool } from "./components/WriteTool.js";
export { BashTool } from "./components/BashTool.js";
export { GlobTool } from "./components/GlobTool.js";
export { GrepTool } from "./components/GrepTool.js";
export { WebFetchTool } from "./components/WebFetchTool.js";
export { TaskTool } from "./components/TaskTool.js";

// Component prop types
export type { TimelineProps } from "./components/Timeline.js";
export type { UserMessageProps } from "./components/UserMessage.js";
export type { AssistantMessageProps } from "./components/AssistantMessage.js";
export type { ThinkingBlockProps } from "./components/ThinkingBlock.js";
export type { ToolCallProps } from "./components/ToolCall.js";
export type { PermissionRequestProps } from "./components/PermissionRequest.js";
export type { ErrorBlockProps } from "./components/ErrorBlock.js";
export type { ReadToolProps } from "./components/ReadTool.js";
export type { EditToolProps } from "./components/EditTool.js";
export type { WriteToolProps } from "./components/WriteTool.js";
export type { BashToolProps } from "./components/BashTool.js";
export type { GlobToolProps } from "./components/GlobTool.js";
export type { GrepToolProps } from "./components/GrepTool.js";
export type { WebFetchToolProps } from "./components/WebFetchTool.js";
export type { TaskToolProps } from "./components/TaskTool.js";

// Hooks
export { useSession } from "./hooks/useSession.js";
export { useTimeline } from "./hooks/useTimeline.js";
export { useVoice } from "./hooks/useVoice.js";
export type { UseSessionOptions, UseSessionResult } from "./hooks/useSession.js";
export type { UseTimelineResult } from "./hooks/useTimeline.js";
export type { UseVoiceOptions, UseVoiceResult, VoiceState } from "./hooks/useVoice.js";

// Theme
export {
  themeColorsToCssVars,
  syntaxThemeToCssVars,
  themeToCssVars,
  getToolColorVar,
} from "./theme.js";

// Utilities
export {
  normalizeGCEvent,
  normalizeSDKEvent,
  mergeIntoTimeline,
} from "./utils/normalize.js";
export type { SDKStreamEvent } from "./utils/normalize.js";

export {
  detectLanguage,
  tokenize,
  tokenTypeToCssVar,
} from "./utils/syntax-highlight.js";
export type { LanguageId, SyntaxToken } from "./utils/syntax-highlight.js";

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
