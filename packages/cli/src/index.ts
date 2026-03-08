/**
 * @saqr/cli - CLI tool for the Saqr multi-agent hook system.
 *
 * This package provides the `saqr` CLI binary and exports command handlers
 * for programmatic use.
 */

export { parseArgs } from "./bin/saqr.js";
export type { ParsedArgs } from "./bin/saqr.js";

export {
  runInstall,
  runDoctor,
  runStart,
  runStop,
  runStatus,
  runWatch,
  runQuery,
  runAgent,
} from "./commands/index.js";

export {
  bold,
  dim,
  red,
  green,
  yellow,
  blue,
  cyan,
  gray,
  symbols,
  info,
  success,
  warn,
  error,
  header,
  table,
  spinner,
} from "./utils/output.js";

export type { TableColumn, Spinner } from "./utils/output.js";

// Theme
export type { AppTheme, ThemeColors, SyntaxTheme, ThemeSpacing, ThemeTypography } from "./theme/index.js";
export { DARK_THEME, LIGHT_THEME, DARK_SYNTAX_THEME, LIGHT_SYNTAX_THEME } from "./theme/index.js";

// Timeline Types
export type {
  TimelineItemSource,
  TimelineItemBase,
  UserMessage,
  AssistantMessage,
  ThinkingBlock,
  ToolCallBase,
  ToolCallRead,
  ToolCallEdit,
  ToolCallWrite,
  ToolCallBash,
  ToolCallGlob,
  ToolCallGrep,
  ToolCallWebFetch,
  ToolCallTask,
  ToolCall,
  PermissionRequest,
  PermissionResolved,
  ErrorItem,
  SystemNotificationCategory,
  SystemNotification,
  CompactNotification,
  UsageUpdate,
  TimelineItem,
  TimelineItemType,
} from "./types/timeline.js";

export {
  createTimelineItemBase,
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
} from "./types/timeline.js";
