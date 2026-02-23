/**
 * Agent-to-Unified Event Mapping Tables.
 *
 * Defines how each agent provider's native event names map to
 * the 12 unified event types. When an event type is `null` for a
 * provider, that provider does not produce that event natively --
 * the hook integration must never synthesize events the agent
 * does not emit.
 *
 * @module events/mappings
 */

import type { AgentProvider } from "../agents/types.js";
import type { UnifiedEventType } from "./types.js";

// ---------------------------------------------------------------------------
// Mapping Types
// ---------------------------------------------------------------------------

/**
 * A single row in the agent-to-unified mapping table.
 * Maps a unified event type to the native event name for each provider,
 * or `null` if the provider does not support that event.
 */
export interface EventMappingEntry {
  /** The unified event type. */
  unified: UnifiedEventType;
  /** Claude Code native hook name, or null if not supported. */
  claudeCode: string | null;
  /** OpenCode native event name, or null if not supported. */
  opencode: string | null;
  /** Codex native message type, or null if not supported. */
  codex: string | null;
}

/**
 * Complete mapping table: unified event type to native event names per provider.
 */
export const EVENT_MAPPING_TABLE: readonly EventMappingEntry[] = [
  {
    unified: "SessionStarted",
    claudeCode: "SessionStart",
    opencode: "session.created",
    codex: "process_spawn",
  },
  {
    unified: "UserPromptReceived",
    claudeCode: "UserPromptSubmit",
    opencode: "message.updated",
    codex: "stdin_message",
  },
  {
    unified: "ToolCallRequested",
    claudeCode: "PreToolUse",
    opencode: "tool.execute.before",
    codex: "tool_use",
  },
  {
    unified: "ToolCallCompleted",
    claudeCode: "PostToolUse",
    opencode: "tool.execute.after",
    codex: "tool_result",
  },
  {
    unified: "ToolCallFailed",
    claudeCode: "PostToolUseFailure",
    opencode: "tool.execute.after",
    codex: "tool_error",
  },
  {
    unified: "AgentSpawned",
    claudeCode: "SubagentStart",
    opencode: null,
    codex: null,
  },
  {
    unified: "AgentCompleted",
    claudeCode: "SubagentStop",
    opencode: null,
    codex: null,
  },
  {
    unified: "TurnCompleted",
    claudeCode: "Stop",
    opencode: "session.idle",
    codex: "turn_end",
  },
  {
    unified: "CompactionTriggered",
    claudeCode: "PreCompact",
    opencode: "session.compacted",
    codex: null,
  },
  {
    unified: "SessionEnded",
    claudeCode: "SessionEnd",
    opencode: "session.deleted",
    codex: "process_exit",
  },
  {
    unified: "PermissionRequested",
    claudeCode: null,
    opencode: "permission.asked",
    codex: "permission",
  },
  {
    unified: "PermissionResponded",
    claudeCode: null,
    opencode: "permission.replied",
    codex: "permission_response",
  },
] as const;

// ---------------------------------------------------------------------------
// Lookup: Native Event -> Unified Event
// ---------------------------------------------------------------------------

/**
 * Mapping from a provider's native event name to its unified event type.
 * Pre-computed at module load from {@link EVENT_MAPPING_TABLE}.
 */
export type NativeToUnifiedMap = ReadonlyMap<string, UnifiedEventType>;

/**
 * Pre-computed reverse-lookup maps: given a provider's native event name,
 * returns the corresponding unified event type.
 *
 * Usage:
 * ```typescript
 * const unified = NATIVE_TO_UNIFIED["claude-code"].get("PostToolUse");
 * // unified === "ToolCallCompleted"
 * ```
 */
export const NATIVE_TO_UNIFIED: Readonly<Record<AgentProvider, NativeToUnifiedMap>> =
  buildNativeToUnifiedMaps();

function buildNativeToUnifiedMaps(): Record<AgentProvider, NativeToUnifiedMap> {
  const claudeCode = new Map<string, UnifiedEventType>();
  const opencode = new Map<string, UnifiedEventType>();
  const codex = new Map<string, UnifiedEventType>();

  for (const entry of EVENT_MAPPING_TABLE) {
    if (entry.claudeCode !== null) {
      claudeCode.set(entry.claudeCode, entry.unified);
    }
    if (entry.opencode !== null) {
      // OpenCode's tool.execute.after maps to both ToolCallCompleted and ToolCallFailed;
      // the first mapping wins (ToolCallCompleted). Disambiguation is handled at the
      // integration layer by inspecting the error flag in the native event payload.
      if (!opencode.has(entry.opencode)) {
        opencode.set(entry.opencode, entry.unified);
      }
    }
    if (entry.codex !== null) {
      codex.set(entry.codex, entry.unified);
    }
  }

  return {
    "claude-code": claudeCode,
    opencode,
    codex,
    custom: new Map<string, UnifiedEventType>(),
  };
}

// ---------------------------------------------------------------------------
// Lookup: Unified Event -> Native Event
// ---------------------------------------------------------------------------

/**
 * Returns the native event name for a given unified event type and provider.
 *
 * @param unified - The unified event type to look up.
 * @param provider - The agent provider to get the native name for.
 * @returns The native event name, or `null` if the provider does not support this event.
 */
export function getNativeEventName(
  unified: UnifiedEventType,
  provider: AgentProvider,
): string | null {
  const entry = EVENT_MAPPING_TABLE.find((e) => e.unified === unified);
  if (!entry) return null;

  switch (provider) {
    case "claude-code":
      return entry.claudeCode;
    case "opencode":
      return entry.opencode;
    case "codex":
      return entry.codex;
    case "custom":
      return null;
  }
}

/**
 * Returns the unified event type for a given native event name and provider.
 *
 * @param nativeEvent - The native event name from the agent.
 * @param provider - The agent provider that produced the event.
 * @returns The unified event type, or `undefined` if no mapping exists.
 */
export function getUnifiedEventType(
  nativeEvent: string,
  provider: AgentProvider,
): UnifiedEventType | undefined {
  return NATIVE_TO_UNIFIED[provider].get(nativeEvent);
}
