/**
 * Re-exports from @saqr/cli sub-modules for terminal UI consumers.
 *
 * We import directly from sub-modules (@saqr/cli/types/timeline, @saqr/cli/theme)
 * instead of the barrel (@saqr/cli) to avoid pulling in parseArgs side effects.
 */
export type {
  TimelineItem,
  TimelineItemType,
  TimelineItemBase,
  UserMessage,
  AssistantMessage,
  ThinkingBlock,
  ToolCall,
  ToolCallRead,
  ToolCallEdit,
  ToolCallWrite,
  ToolCallBash,
  ToolCallGlob,
  ToolCallGrep,
  ToolCallWebFetch,
  ToolCallTask,
  PermissionRequest,
  PermissionResolved,
  ErrorItem,
  SystemNotification,
  CompactNotification,
  UsageUpdate,
} from "@saqr/cli/types/timeline";

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
} from "@saqr/cli/types/timeline";

export type { AppTheme, ThemeColors, SyntaxTheme } from "@saqr/cli/theme";
export { DARK_THEME, LIGHT_THEME } from "@saqr/cli/theme";

/**
 * WebSocket message types sent by the daemon.
 */
export interface WsSessionInfo {
  type: "session_info";
  session: {
    sessionId: string;
    projectId: string;
    agentProvider: string;
    model: string;
    status: string;
    startedAt: string;
  };
}

export interface WsTimelineEvent {
  type: "timeline_event";
  event: {
    eventId: string;
    eventType: string;
    sessionId: string;
    sequence: number;
    timestamp: string;
    agentProvider: string;
    data: Record<string, unknown>;
  };
}

export interface WsError {
  type: "error";
  message: string;
}

export type WsMessage = WsSessionInfo | WsTimelineEvent | WsError;

/**
 * Connection state for the useSession hook.
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * Session info from the daemon.
 */
export interface SessionInfo {
  sessionId: string;
  projectId: string;
  agentProvider: string;
  model: string;
  status: string;
  startedAt: string;
}
