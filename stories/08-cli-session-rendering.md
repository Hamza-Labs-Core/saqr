# Story 08: CLI Session Rendering on Mobile & Desktop

## Overview

This story specifies the faithful reproduction of the Claude Code CLI experience on non-terminal surfaces: mobile (React Native/Expo), desktop (Tauri), and web dashboard. Every visual element visible in the CLI must have a corresponding mobile/desktop representation that preserves the information density and interaction model of the terminal while adapting to touch-based and windowed environments.

The rendering system is built around an **Event Normalization Layer** that converts three distinct event sources -- GC hooks (JSONL events from observed sessions), SDK AgentStreamEvent (from managed sessions), and PTY raw bytes (from managed sessions) -- into a unified `TimelineItem[]` array. This array drives a component registry where each `TimelineItem` variant maps to a dedicated React Native component with appropriate icons, colors, interactions, and accessibility annotations.

This is the largest UI story in the AgentContext product. It defines the complete visual language for session rendering: from streaming text with cursor animation, to diff viewers with syntax highlighting, to terminal emulation via embedded xterm.js, to responsive layouts that adapt from phone to tablet to desktop. Every component specified here is consumed by F14 (Session Timeline/List), F15 (Agent Cards), and F18 (Desktop App), making this the foundational UI specification.

The story also covers interaction patterns unique to mobile agent management: permission action sheets with haptic feedback, session scrubbers for navigating long histories, search within sessions, dual view modes (structured vs terminal), and notification badges. These patterns do not exist in the CLI and represent genuinely new capabilities that make mobile management more than just a read-only mirror.

---

## Scope

### In Scope

| Component | Description |
|-----------|-------------|
| Event Normalization Layer | Unified `TimelineItem` type system converting all event sources to renderable items |
| CLI Element to Mobile Mapping | Complete specification of every CLI visual element and its mobile equivalent |
| Streaming Text Renderer (F13.2) | Word-by-word streaming via WebSocket with cursor animation |
| Diff Viewer Component (F13.3) | Unified diff with syntax highlighting, line numbers, side-by-side mode |
| Terminal Emulator Widget (F13.4) | xterm.js in React Native WebView for raw PTY rendering |
| Dual View Mode (F13.5) | Toggle between Structured (card-based) and Terminal (raw PTY) views |
| Syntax Highlighting (F13.6) | Language detection, highlight.js/Shiki integration, theme support |
| Prompt Input Component (F13.8) | Multiline input with history, markdown preview, voice input, attachments |
| Permission Action Sheet (F13.9) | Native bottom sheet with allow/deny/always, haptic feedback, push notifications |
| Search Within Session (F13.10) | Full-text search across session events with filters |
| Session Scrubber (F13.11) | Timeline scrubber bar for navigating session history |
| Notification Badges (F13.12) | Per-session unread counts, badge types, OS-level app badges |
| Responsive Layout (F13.13) | Phone/tablet/desktop layout breakpoints and adaptation |
| Theme System (F13.14) | Dark/light mode, terminal color scheme detection, color palette |

### Out of Scope (Non-Goals)

| Component | Reason |
|-----------|--------|
| File Navigator (F13.7) | Separate story -- depends on agent filesystem access APIs |
| Session List / Timeline (F14) | Separate story -- consumes components defined here |
| Agent Cards (F15) | Separate story -- uses TimelineItem types from here |
| Desktop App shell (F18) | Separate story -- Tauri integration, window management |
| E2EE transport layer | Covered by sync stories -- this story assumes decrypted data is available |
| Push notification infrastructure | Covered by notification story -- this story defines when to trigger |
| Voice input implementation (F6.10) | Referenced but not implemented here -- only the button integration point |

---

## Requirements

### 1. Event Normalization Layer

The Event Normalization Layer is the bridge between raw event sources and the rendering engine. It converts all event formats into a unified `TimelineItem` discriminated union that the component registry consumes.

#### Event Sources

```
Event Source (one of):
  +-- GC hooks (observed sessions)     -> JSONL events from ~/.claude-context/events/
  +-- SDK streaming (managed sessions) -> AgentStreamEvent from Claude SDK
  +-- PTY output (managed sessions)    -> raw bytes + parsed terminal grid
```

#### TimelineItem Type System

```typescript
/**
 * Base fields shared by all timeline items.
 * Every item in the session timeline extends this interface.
 */
interface TimelineItemBase {
  /** Unique identifier for this item (event_id from GC, or generated UUID) */
  id: string;
  /** ISO 8601 UTC timestamp of when this item occurred */
  timestamp: string;
  /** Monotonically increasing sequence number within the session */
  sequence: number;
  /** Source of this item for rendering hints */
  source: 'gc_hook' | 'sdk_stream' | 'pty';
  /** Whether this item has been read/seen by the user */
  read: boolean;
}

/**
 * User's prompt message.
 * Displayed as a right-aligned chat bubble.
 */
interface UserMessage extends TimelineItemBase {
  type: 'user_message';
  /** The full text of the user's prompt */
  text: string;
  /** Whether the prompt included file attachments */
  hasAttachments: boolean;
  /** Attached file paths, if any */
  attachments: string[];
}

/**
 * Claude's response message.
 * Supports both streaming (partial) and completed states.
 */
interface AssistantMessage extends TimelineItemBase {
  type: 'assistant_message';
  /** The response text (partial during streaming, complete when done) */
  text: string;
  /** Current streaming state */
  streamingState: 'streaming' | 'completed' | 'interrupted';
  /** Whether the response contains markdown that needs rendering */
  hasMarkdown: boolean;
  /** Model that generated this response */
  model: string;
  /** Token count for this response (available after completion) */
  outputTokens: number | null;
}

/**
 * Claude's thinking/reasoning block.
 * Shown as a collapsible card with subtle animation during streaming.
 */
interface ThinkingBlock extends TimelineItemBase {
  type: 'thinking_block';
  /** The thinking text (may be partial during streaming) */
  text: string;
  /** Current streaming state */
  streamingState: 'streaming' | 'completed';
  /** Duration of thinking in milliseconds (available after completion) */
  durationMs: number | null;
}

/**
 * Tool call base interface. All tool calls share these fields.
 * Each tool subtype extends this with tool-specific data.
 */
interface ToolCallBase extends TimelineItemBase {
  type: 'tool_call';
  /** Unique tool_use_id for correlating request/response */
  toolUseId: string;
  /** Execution status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Duration in milliseconds (available after completion) */
  durationMs: number | null;
  /** Error message if status is 'failed' */
  error: string | null;
}

interface ToolCallRead extends ToolCallBase {
  toolName: 'Read';
  input: {
    filePath: string;
    offset?: number;
    limit?: number;
  };
  output: {
    content: string | null;
    lineCount: number | null;
    language: string | null;
  } | null;
}

interface ToolCallEdit extends ToolCallBase {
  toolName: 'Edit';
  input: {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  };
  output: {
    /** Unified diff string (generated from old/new strings) */
    diff: string | null;
    language: string | null;
  } | null;
}

interface ToolCallWrite extends ToolCallBase {
  toolName: 'Write';
  input: {
    filePath: string;
    content: string;
  };
  output: {
    bytesWritten: number | null;
    language: string | null;
  } | null;
}

interface ToolCallBash extends ToolCallBase {
  toolName: 'Bash';
  input: {
    command: string;
    timeout?: number;
    description?: string;
  };
  output: {
    stdout: string | null;
    stderr: string | null;
    exitCode: number | null;
  } | null;
}

interface ToolCallGlob extends ToolCallBase {
  toolName: 'Glob';
  input: {
    pattern: string;
    path?: string;
  };
  output: {
    matches: string[];
    matchCount: number;
  } | null;
}

interface ToolCallGrep extends ToolCallBase {
  toolName: 'Grep';
  input: {
    pattern: string;
    path?: string;
    glob?: string;
    outputMode?: string;
  };
  output: {
    matches: Array<{ file: string; line: number; content: string }>;
    matchCount: number;
  } | null;
}

interface ToolCallWebFetch extends ToolCallBase {
  toolName: 'WebFetch';
  input: {
    url: string;
    prompt: string;
  };
  output: {
    summary: string | null;
    statusCode: number | null;
  } | null;
}

interface ToolCallTask extends ToolCallBase {
  toolName: 'Task';
  input: {
    prompt: string;
    description?: string;
  };
  output: {
    result: string | null;
    /** Nested timeline items from the subagent */
    nestedTimeline: TimelineItem[];
  } | null;
}

type ToolCall =
  | ToolCallRead
  | ToolCallEdit
  | ToolCallWrite
  | ToolCallBash
  | ToolCallGlob
  | ToolCallGrep
  | ToolCallWebFetch
  | ToolCallTask;

/**
 * Permission request from the agent.
 * Requires user action: allow, deny, or always allow.
 */
interface PermissionRequest extends TimelineItemBase {
  type: 'permission_request';
  /** The tool requesting permission */
  toolName: string;
  /** Description of what the tool will do */
  description: string;
  /** File path affected (if applicable) */
  filePath: string | null;
  /** Full tool input for detailed inspection */
  toolInput: Record<string, unknown>;
  /** Current resolution state */
  resolution: 'pending' | 'allowed' | 'denied' | 'always_allowed' | 'timed_out';
  /** Timestamp of when the permission was resolved (null if pending) */
  resolvedAt: string | null;
}

/**
 * Permission that was automatically allowed (e.g., by an "always allow" rule).
 * Shown as a subtle inline note, collapsed by default.
 */
interface PermissionResolved extends TimelineItemBase {
  type: 'permission_resolved';
  toolName: string;
  filePath: string | null;
  /** The rule that auto-allowed this permission */
  rule: string;
}

/**
 * Error from the agent or system.
 * Displayed with a red border and prominent error message.
 */
interface ErrorItem extends TimelineItemBase {
  type: 'error';
  /** Error message text */
  message: string;
  /** Stack trace (if available) */
  stackTrace: string | null;
  /** Whether this error is recoverable */
  isRecoverable: boolean;
  /** Error source classification */
  errorSource: 'agent' | 'tool' | 'system' | 'network';
}

/**
 * System notification (e.g., session started, model changed).
 * Displayed as a centered, muted inline notification.
 */
interface SystemNotification extends TimelineItemBase {
  type: 'system_notification';
  /** Notification category for icon selection */
  category: 'session_start' | 'session_end' | 'model_change' | 'context_clear' | 'agent_spawned' | 'agent_completed';
  /** Human-readable notification text */
  message: string;
  /** Optional metadata (e.g., model name, agent ID) */
  metadata: Record<string, unknown>;
}

/**
 * Compact notification -- context window was compacted.
 * Shows before/after token counts.
 */
interface CompactNotification extends TimelineItemBase {
  type: 'compact_notification';
  /** Token count before compaction */
  tokensBefore: number;
  /** Token count after compaction */
  tokensAfter: number;
  /** Whether this was automatic or manual */
  trigger: 'auto' | 'manual';
}

/**
 * Usage update -- cost, tokens, context window status.
 * Drives the sticky footer bar.
 */
interface UsageUpdate extends TimelineItemBase {
  type: 'usage_update';
  /** Current model identifier */
  model: string;
  /** Input tokens consumed this turn */
  inputTokens: number;
  /** Output tokens generated this turn */
  outputTokens: number;
  /** Cache read tokens this turn */
  cacheReadTokens: number;
  /** Cache write tokens this turn */
  cacheWriteTokens: number;
  /** Cumulative session cost in USD */
  sessionCostUsd: number;
  /** Context window usage as a fraction (0.0 to 1.0) */
  contextWindowUsage: number;
  /** Context window maximum tokens */
  contextWindowMax: number;
}

/**
 * Discriminated union of all timeline item types.
 */
type TimelineItem =
  | UserMessage
  | AssistantMessage
  | ThinkingBlock
  | ToolCall
  | PermissionRequest
  | PermissionResolved
  | ErrorItem
  | SystemNotification
  | CompactNotification
  | UsageUpdate;
```

#### GC Event Type to TimelineItem Mapping

| GC Event Type (`event_type`) | TimelineItem Type | Notes |
|------------------------------|-------------------|-------|
| `SessionStarted` | `SystemNotification` (category: `session_start`) | Extracts model from `data.model` |
| `UserPromptReceived` | `UserMessage` | Extracts text from `data.prompt` |
| `ToolCallRequested` | `ToolCall` (status: `running`) | Creates tool-specific variant based on `data.tool_name` |
| `ToolCallCompleted` | `ToolCall` (status: `completed`) | Merges with existing `running` item via `tool_use_id` correlation |
| `ToolCallFailed` | `ToolCall` (status: `failed`) | Merges with existing `running` item, sets error from `data.error` |
| `AgentSpawned` | `SystemNotification` (category: `agent_spawned`) | Also creates a nested `ToolCallTask` if correlated with a Task tool call |
| `AgentCompleted` | `SystemNotification` (category: `agent_completed`) | Updates nested timeline in correlated `ToolCallTask` |
| `TurnCompleted` | `AssistantMessage` (streamingState: `completed`) | Full response text from enriched transcript data |
| `CompactionTriggered` | `CompactNotification` | Extracts trigger type from `data.trigger` |
| `SessionEnded` | `SystemNotification` (category: `session_end`) | End of session marker |

#### SDK AgentStreamEvent to TimelineItem Mapping

| SDK Event Type | TimelineItem Type | Notes |
|---------------|-------------------|-------|
| `message_start` | `AssistantMessage` (streamingState: `streaming`) | Creates new streaming message |
| `content_block_start` (type: `text`) | Appends to current `AssistantMessage` | Text content block begins |
| `content_block_delta` (type: `text_delta`) | Updates current `AssistantMessage.text` | Streaming text chunk |
| `content_block_start` (type: `thinking`) | `ThinkingBlock` (streamingState: `streaming`) | Thinking block begins |
| `content_block_delta` (type: `thinking_delta`) | Updates current `ThinkingBlock.text` | Streaming thinking chunk |
| `content_block_start` (type: `tool_use`) | `ToolCall` (status: `pending`) | Tool call initiated |
| `content_block_delta` (type: `input_json_delta`) | Updates `ToolCall.input` incrementally | Streaming tool input JSON |
| `content_block_stop` | Finalizes current block | Marks block as complete |
| `message_delta` (stop_reason) | `AssistantMessage` (streamingState: `completed`) | Message finished |
| `message_stop` | Triggers `UsageUpdate` | Final usage stats available |
| `error` | `ErrorItem` | SDK-level error |

#### Normalization Function Signature

```typescript
/**
 * Converts a raw event from any source into one or more TimelineItems.
 * May return multiple items (e.g., a TurnCompleted can produce an AssistantMessage
 * plus a UsageUpdate).
 */
function normalizeEvent(
  event: GCEvent | AgentStreamEvent | PTYEvent,
  existingItems: Map<string, TimelineItem>
): TimelineItem[];

/**
 * Merges a new TimelineItem into the existing timeline.
 * Handles correlation (e.g., ToolCallCompleted updating a ToolCallRequested).
 * Returns the updated timeline.
 */
function mergeIntoTimeline(
  timeline: TimelineItem[],
  newItems: TimelineItem[]
): TimelineItem[];
```

#### Acceptance Criteria

- [ ] All 10 GC event types map to a corresponding `TimelineItem` variant
- [ ] All SDK `AgentStreamEvent` types map to corresponding `TimelineItem` variants
- [ ] The `TimelineItem` discriminated union covers all renderable states
- [ ] Tool calls use a sub-discriminated union based on `toolName`
- [ ] `ToolCallRequested` and `ToolCallCompleted` are correlated via `toolUseId`
- [ ] Streaming state transitions are correctly represented (`streaming` -> `completed` | `interrupted`)
- [ ] The normalization function is pure (no side effects, deterministic output for same input)
- [ ] Unknown event types produce a `SystemNotification` with the raw event data rather than crashing
- [ ] Nested timelines for `ToolCallTask` items are recursively normalized

---

### 2. CLI Element to Mobile Mapping

This section specifies every Claude Code CLI visual element and its mobile/desktop equivalent. For each element, the specification covers terminal appearance, React Native component, layout, interactions, and accessibility.

#### 2.1 User Prompt

**CLI Appearance**: `> ` prefix followed by white text on dark background. Multi-line prompts are displayed as-is. The prompt is editable until submitted.

**Mobile Component**:

```typescript
interface UserMessageBubbleProps {
  item: UserMessage;
  onTap: () => void;         // Expands long prompts
  onLongPress: () => void;   // Copy text menu
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<UserMessageBubble>` |
| Alignment | Right-aligned, max width 85% of screen |
| Background | `theme.colors.userBubble` (`#2A2D3E` dark, `#E8EAED` light) |
| Text | Monospace (`JetBrains Mono` or `SF Mono`), 14px, `theme.colors.userText` |
| Border radius | 16px (top-left, top-right, bottom-left), 4px (bottom-right) |
| Padding | 12px horizontal, 10px vertical |
| Truncation | Lines > 10: truncate with "Show more" tap target |
| Timestamp | Small text below bubble, right-aligned, `theme.colors.muted` |
| Attachments | File chip(s) below text with file icon + name |
| Touch target | Minimum 44x44pt for any interactive element |
| Screen reader | "Your message: [first 100 chars]. Sent at [time]." |

#### 2.2 Claude Response (Streaming + Completed)

**CLI Appearance**: Streaming text appears word-by-word. Markdown is rendered inline in terminal (bold, italic, lists, headers, code blocks). A cursor blinks at the end of the stream.

**Mobile Component**:

```typescript
interface AssistantMessageBubbleProps {
  item: AssistantMessage;
  onTap: () => void;            // No-op during streaming; copy menu when completed
  onLongPress: () => void;      // Copy full text
  onCodeBlockTap: (code: string, language: string) => void;  // Copy code block
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<AssistantMessageBubble>` |
| Alignment | Left-aligned, max width 90% of screen |
| Background | `theme.colors.assistantBubble` (`#1A1D2E` dark, `#FFFFFF` light) |
| Text | System font (SF Pro / Roboto), 15px, `theme.colors.assistantText` |
| Markdown | Full markdown rendering: headers, bold, italic, lists, links, code blocks, tables |
| Streaming | Word-by-word append with 16ms render interval (60fps target) |
| Cursor | Blinking `|` character at end of text during streaming (500ms blink interval) |
| Model badge | Small pill badge above message: model name + color coding |
| Touch target | Code blocks: tap to copy, 44x44pt minimum |
| Screen reader | "Claude's response: [first 200 chars]. [Streaming / Complete]. Model: [model name]." |

#### 2.3 Thinking/Reasoning Block

**CLI Appearance**: Collapsible block prefixed with "Thinking..." in grey text. During streaming, an ellipsis animates. The full reasoning text is shown when expanded.

**Mobile Component**:

```typescript
interface ThinkingBlockCardProps {
  item: ThinkingBlock;
  isExpanded: boolean;
  onToggleExpand: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ThinkingBlockCard>` |
| Alignment | Left-aligned, full width with 16px horizontal margin |
| Background | `theme.colors.thinkingBg` (`#1E1E2E` dark, `#F5F5F7` light) |
| Header | "Thinking..." with brain icon, subtle pulse animation during streaming |
| Text | Grey (`theme.colors.thinkingText`), 13px, italic |
| Collapsed height | 48px (header only) |
| Expanded height | Auto (up to 500px, then scrollable internally) |
| Default state | Collapsed |
| Animation | `Animated.spring` for expand/collapse (damping: 15, stiffness: 150) |
| Duration badge | Shows elapsed thinking time when completed (e.g., "12.3s") |
| Touch target | Full header row is tappable, minimum 48px height |
| Screen reader | "Thinking block. [Expanded/Collapsed]. Duration: [N] seconds. Double tap to [expand/collapse]." |

#### 2.4 Tool Call (Generic Card)

All tool calls share a common card structure with tool-specific content inside.

**CLI Appearance**: A line with a colored circle indicator (`running`/`completed`/`failed`) followed by the tool name. Tool-specific details appear below.

**Mobile Component (Generic Wrapper)**:

```typescript
interface ToolCallCardProps {
  item: ToolCall;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onHeaderTap: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallCard>` wrapping tool-specific content |
| Alignment | Left-aligned, full width with 16px horizontal margin |
| Background | `theme.colors.cardBg` (`#1C1F2E` dark, `#FFFFFF` light) |
| Border | 1px left border, color based on status: blue (running), green (completed), red (failed) |
| Header | Tool icon + tool name + file path (if applicable) + status badge + duration |
| Status badge | Colored dot: blue (running), green (completed), red (failed) with label text |
| Collapsed content | One-line summary (e.g., file path for Read, command for Bash) |
| Expanded content | Full tool-specific rendering (see sub-sections below) |
| Default state | Collapsed for completed, expanded for running or failed |
| Border radius | 8px |
| Shadow | `elevation: 2` (Android), `shadowOffset: {0, 1}` (iOS) |
| Touch target | Full header row, minimum 48px height |
| Screen reader | "[Tool name] tool call. Status: [status]. [File path or command]. Double tap to [expand/collapse]." |

**Tool Icon Mapping**:

| Tool Name | Icon | Color |
|-----------|------|-------|
| Read | `file-text` (Lucide) | `#60A5FA` (blue) |
| Edit | `file-edit` (Lucide) | `#FBBF24` (amber) |
| Write | `file-plus` (Lucide) | `#34D399` (green) |
| Bash | `terminal` (Lucide) | `#A78BFA` (purple) |
| Glob | `search` (Lucide) | `#F472B6` (pink) |
| Grep | `search-code` (Lucide) | `#F472B6` (pink) |
| WebFetch | `globe` (Lucide) | `#38BDF8` (cyan) |
| Task | `git-branch` (Lucide) | `#FB923C` (orange) |

#### 2.5 Tool: Read File

**CLI Appearance**: Shows file path and optionally line range. The file content is not displayed inline in the CLI unless the tool output is expanded.

**Mobile Component**:

```typescript
interface ToolCallReadContentProps {
  item: ToolCallRead;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallReadContent>` inside `<ToolCallCard>` |
| Header summary | File icon + path, line range if specified (e.g., "lines 10-50") |
| Expanded view | Syntax-highlighted file content with line numbers |
| Language detection | From file extension (see Requirement 7) |
| Line numbers | Grey, right-aligned in a fixed-width gutter (40px) |
| Max displayed lines | 100 lines, then "Show N more lines" expander |
| Copy button | Top-right of code block, copies full content |
| Touch: tap path | Opens file in file navigator (F13.7) if available |
| Screen reader | "Read file: [path]. [N] lines. Status: [status]." |

#### 2.6 Tool: Edit File (with Diff)

**CLI Appearance**: Shows file path followed by a unified diff with red/green line coloring for removed/added lines.

**Mobile Component**:

```typescript
interface ToolCallEditContentProps {
  item: ToolCallEdit;
  viewMode: 'unified' | 'side_by_side';
  onToggleViewMode: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallEditContent>` inside `<ToolCallCard>` |
| Header summary | Edit icon + path + change summary (e.g., "+3 -2 lines") |
| Unified diff | Default view. Red background for removed lines, green for added. Syntax highlighting within diff lines. |
| Side-by-side diff | Available on tablets (width >= 768px). Swipe right on diff to toggle. Old file left, new file right. |
| Line numbers | Dual column: old line number (left gutter), new line number (right gutter) |
| Collapse long diffs | Unchanged sections > 5 lines: collapsed with "Show N more lines" expander |
| Syntax highlighting | Language detected from file extension |
| Touch: swipe left/right | Toggle unified / side-by-side on tablet |
| Screen reader | "Edit file: [path]. [N] lines added, [M] lines removed. Status: [status]." |

#### 2.7 Tool: Write File

**CLI Appearance**: Shows file path and the full content written.

**Mobile Component**:

```typescript
interface ToolCallWriteContentProps {
  item: ToolCallWrite;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallWriteContent>` inside `<ToolCallCard>` |
| Header summary | Create icon + path + file size badge (e.g., "2.4 KB") |
| Expanded view | Full file content with syntax highlighting and line numbers |
| Language detection | From file extension |
| Max displayed lines | 50 lines, then "Show N more lines" expander |
| Copy button | Top-right of code block |
| Screen reader | "Write file: [path]. [N] bytes written. Status: [status]." |

#### 2.8 Tool: Bash Command + Output

**CLI Appearance**: Shows the command string, then the command output in a scrollable terminal-styled block.

**Mobile Component**:

```typescript
interface ToolCallBashContentProps {
  item: ToolCallBash;
  isOutputExpanded: boolean;
  onToggleOutputExpand: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallBashContent>` inside `<ToolCallCard>` |
| Header summary | Terminal icon + command text (truncated to 80 chars with ellipsis) |
| Command display | Full command in monospace, dark background (`#0D1117`), `$` prefix |
| Output display | Monospace text in scrollable container, dark background |
| Output truncation | Lines > 50: truncate with "Show all (N lines)" expander |
| ANSI rendering | Basic ANSI color codes rendered (16-color). Full ANSI in Terminal view. |
| Exit code | Badge showing exit code. Green for 0, red for non-zero |
| Stderr | Shown in orange/red text below stdout if present |
| Touch: long press command | Copy command to clipboard |
| Screen reader | "Bash command: [command]. Exit code: [code]. [N] lines of output. Status: [status]." |

#### 2.9 Tool: Glob/Grep Search Results

**CLI Appearance**: Shows the search pattern and matching file paths/lines.

**Mobile Component**:

```typescript
interface ToolCallSearchContentProps {
  item: ToolCallGlob | ToolCallGrep;
  expandedFiles: Set<string>;
  onToggleFile: (filePath: string) => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallSearchContent>` inside `<ToolCallCard>` |
| Header summary | Search icon + pattern + match count badge (e.g., "42 matches") |
| File list | Collapsible file tree. Each file shows match count. |
| Grep match lines | For Grep: show matching lines with highlighted search term, line numbers |
| Glob match files | For Glob: show file paths grouped by directory |
| Max displayed | 20 files, then "Show N more files" expander |
| Touch: tap file path | Opens file in file navigator (F13.7) if available |
| Touch: tap match line | Scrolls to that line in file viewer |
| Screen reader | "[Glob/Grep] search: [pattern]. [N] matches in [M] files. Status: [status]." |

#### 2.10 Tool: WebFetch

**CLI Appearance**: Shows the URL and a summary of the fetched content.

**Mobile Component**:

```typescript
interface ToolCallWebFetchContentProps {
  item: ToolCallWebFetch;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallWebFetchContent>` inside `<ToolCallCard>` |
| Header summary | Globe icon + URL (truncated to domain + path, full URL on expand) |
| Expanded view | Summary text from the fetch result. HTTP status badge. |
| URL display | Tappable link, opens in system browser |
| Touch: tap URL | Opens URL in device browser |
| Screen reader | "Web fetch: [domain]. Status code: [code]. Status: [status]." |

#### 2.11 Tool: Task (Subagent)

**CLI Appearance**: Shows subagent type, prompt, and result. Can be expanded to show the subagent's full tool call sequence.

**Mobile Component**:

```typescript
interface ToolCallTaskContentProps {
  item: ToolCallTask;
  isNestedTimelineExpanded: boolean;
  onToggleNestedTimeline: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ToolCallTaskContent>` inside `<ToolCallCard>` |
| Header summary | Agent icon + prompt text (truncated to 80 chars) |
| Result | The subagent's final result text when completed |
| Nested timeline | Full recursive rendering of the subagent's `TimelineItem[]` |
| Nesting visual | Indented by 16px, left border in `theme.colors.taskNesting` (`#FB923C` at 30% opacity) |
| Default state | Nested timeline collapsed, showing only prompt + result |
| Max nesting depth | 3 levels (Task within Task within Task). Deeper nesting shows "View in separate timeline" link. |
| Touch: expand nested | Reveals the full subagent timeline inline |
| Screen reader | "Sub-agent task: [prompt snippet]. Status: [status]. [N] nested events. Double tap to expand nested timeline." |

#### 2.12 Permission Request

**CLI Appearance**: Yellow `Warning: Allow tool_name?` text with `[y/n/a]` keyboard prompt. Blocks the session until resolved.

**Mobile Component**:

```typescript
interface PermissionRequestCardProps {
  item: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<PermissionRequestCard>` |
| Alignment | Full width, centered, with 16px horizontal margin |
| Background | `theme.colors.permissionBg` (`#2E2A1A` dark, `#FFF8E1` light) |
| Border | 2px left border, amber (`#FBBF24`) |
| Header | Warning icon + "Permission Required" in amber text |
| Tool name | Bold text: "Allow [Tool Name]?" |
| Description | Tool description and affected file path |
| Buttons | Three buttons stacked vertically: "Allow" (green), "Deny" (red), "Always Allow for Session" (blue) |
| Button sizes | Full width, 48px height, 8px border radius |
| Haptic | Medium impact haptic on button tap (iOS: `UIImpactFeedbackGenerator`, Android: `HapticFeedback.VIRTUAL_KEY`) |
| Pending animation | Subtle amber pulse animation on the card border (1s interval) |
| Resolved state | Card collapses to single line: "Allowed: [tool]" (green) or "Denied: [tool]" (red) |
| Push notification | Triggered when app is backgrounded and permission is pending (see Requirement 9) |
| Touch target | Each button minimum 48x44pt |
| Screen reader | "Permission request. Allow [tool name] to [description]? Three actions available: Allow, Deny, Always allow for session." |

#### 2.13 Permission Auto-Allowed

**CLI Appearance**: Brief flash of "Auto-allowed: [tool]" text that disappears quickly.

**Mobile Component**:

```typescript
interface PermissionResolvedInlineProps {
  item: PermissionResolved;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<PermissionResolvedInline>` |
| Alignment | Left-aligned inline with timeline |
| Display | Collapsed by default: shows nothing. In "Detailed" view mode, shows muted inline text. |
| Text | "Auto-allowed: [tool name]" in `theme.colors.muted`, 12px |
| Icon | Small green check icon |
| Touch: tap | Expands to show the rule that auto-allowed (e.g., "Always allow Read") |
| Screen reader | "Auto-allowed: [tool name] by rule: [rule]." |

#### 2.14 Error Display

**CLI Appearance**: Red text with the error message. Stack traces are shown in monospace.

**Mobile Component**:

```typescript
interface ErrorCardProps {
  item: ErrorItem;
  isStackTraceExpanded: boolean;
  onToggleStackTrace: () => void;
  onCopyError: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ErrorCard>` |
| Alignment | Full width with 16px horizontal margin |
| Background | `theme.colors.errorBg` (`#2E1A1A` dark, `#FFF0F0` light) |
| Border | 2px left border, red (`#EF4444`) |
| Error message | Bold red text, 15px |
| Stack trace | Monospace, 12px, collapsible. Collapsed by default. |
| Source badge | Small pill: "Agent" / "Tool" / "System" / "Network" |
| Copy button | Icon button top-right, copies full error with stack trace |
| Touch: tap | Expands stack trace if available |
| Screen reader | "Error: [message]. Source: [source]. [Has/No] stack trace. Double tap to [expand/collapse] details." |

#### 2.15 Cost/Token Display (Sticky Footer)

**CLI Appearance**: Bottom status bar showing model name, input/output token counts, and session cost.

**Mobile Component**:

```typescript
interface UsageFooterProps {
  latestUsage: UsageUpdate | null;
  sessionElapsed: number;    // milliseconds since session start
  isSessionActive: boolean;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<UsageFooter>` (sticky at bottom of session view) |
| Position | Fixed bottom, above tab bar / navigation bar |
| Height | 44px collapsed, 200px expanded |
| Background | `theme.colors.footerBg` (`#0D1117` dark, `#F6F8FA` light) with 0.95 opacity blur |
| Collapsed content | Model badge + token summary (e.g., "12.4K in / 3.2K out") + cost ("$0.42") |
| Expanded content (tap) | Detailed breakdown: input tokens, output tokens, cache read/write, total cost, cost-per-turn chart |
| Model badge | Pill with model-specific color: Opus = purple, Sonnet = blue, Haiku = green |
| Context window | Circular progress ring (24px diameter) next to model badge. Green < 50%, yellow 50-80%, red > 80% |
| Session timer | Elapsed time in HH:MM:SS format, left side of footer |
| Active indicator | Green pulse dot next to timer when session is active, grey when idle |
| Touch: tap footer | Toggles collapsed/expanded state |
| Screen reader | "Session usage. Model: [model]. Tokens: [in] input, [out] output. Cost: $[cost]. Context: [percent]% used. Session time: [elapsed]." |

#### 2.16 Model Indicator

**CLI Appearance**: Status bar shows current model name (e.g., "claude-opus-4-6").

**Mobile Component**: Rendered as part of `<UsageFooter>` (model badge) and also as a badge in the session header.

| Aspect | Specification |
|--------|---------------|
| Component | `<ModelBadge>` (reusable) |
| Display | Pill badge: "Opus 4.6" / "Sonnet 4.5" / "Haiku 3.5" |
| Colors | Opus: `#A78BFA` bg, Sonnet: `#60A5FA` bg, Haiku: `#34D399` bg. White text. |
| Size | Height 22px, horizontal padding 8px, border radius 11px, font 11px bold |
| Screen reader | "Model: [full model name]." |

#### 2.17 Context Window Usage

**CLI Appearance**: Progress bar or percentage in the status bar.

**Mobile Component**: Rendered as part of `<UsageFooter>` (circular progress ring).

| Aspect | Specification |
|--------|---------------|
| Component | `<ContextWindowRing>` (reusable) |
| Display | Circular progress indicator, 24px diameter in footer, 48px in expanded view |
| Colors | Green (`#34D399`) at 0-50%, yellow (`#FBBF24`) at 50-80%, red (`#EF4444`) at 80-100% |
| Animation | Smooth transition when usage changes (300ms ease-in-out) |
| Label | Percentage text centered inside ring (expanded view only) |
| Screen reader | "Context window: [percent]% used. [tokens used] of [max tokens] tokens." |

#### 2.18 Compact Notification

**CLI Appearance**: "Compacting conversation..." inline text during compaction.

**Mobile Component**:

```typescript
interface CompactNotificationCardProps {
  item: CompactNotification;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<CompactNotificationCard>` |
| Alignment | Centered in timeline |
| Display | Inline notification: icon + "Context compacted" + token delta |
| Text | "Context compacted: [before]K -> [after]K tokens" in `theme.colors.muted` |
| Icon | `scissors` (Lucide) in muted color |
| Background | Subtle divider line above and below |
| Screen reader | "Context compacted. Reduced from [before] to [after] tokens. Trigger: [auto/manual]." |

#### 2.19 Task List (Todos)

**CLI Appearance**: Checklist with status indicators (pending, in-progress, done).

**Mobile Component**:

```typescript
interface TaskListCardProps {
  tasks: Array<{
    id: string;
    text: string;
    status: 'pending' | 'in_progress' | 'done';
  }>;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<TaskListCard>` |
| Alignment | Full width, left-aligned |
| Background | `theme.colors.cardBg` |
| Items | Each task: checkbox + text. Pending: empty circle. In-progress: half-filled circle with spin. Done: filled green check. |
| Progress bar | Horizontal bar at top of card showing completion percentage |
| Touch: tap task | No interaction (read-only view of agent's task list) |
| Screen reader | "Task list. [N] of [M] tasks complete. [Task 1]: [status]. [Task 2]: [status]..." |

#### 2.20 Image Output

**CLI Appearance**: Inline image in terminal (iTerm2/Kitty protocol). Not visible in standard terminals.

**Mobile Component**:

```typescript
interface ImageOutputProps {
  uri: string;             // base64 data URI or remote URL
  alt: string;
  width: number;
  height: number;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<ImageOutput>` |
| Display | Native `<Image>` component, max width 100% of container, aspect ratio preserved |
| Interaction | Pinch-to-zoom via `react-native-gesture-handler`. Tap for fullscreen overlay. |
| Loading | Skeleton placeholder while loading, progressive reveal |
| Error | Broken image icon with "Image could not be loaded" text |
| Screen reader | "Image output: [alt text]." |

#### 2.21 Code Blocks

**CLI Appearance**: Syntax-highlighted fenced code blocks with language identifier.

**Mobile Component**:

```typescript
interface CodeBlockProps {
  code: string;
  language: string;
  showLineNumbers: boolean;
  maxLines?: number;
  onCopy: () => void;
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<CodeBlock>` (reusable, used within AssistantMessage, ToolCallRead, etc.) |
| Background | `#0D1117` (dark mode), `#F6F8FA` (light mode) |
| Font | `JetBrains Mono` or `SF Mono`, 13px |
| Language badge | Top-right corner pill showing detected language |
| Copy button | Icon button next to language badge, copies full code content |
| Line numbers | Optional grey gutter, 40px width |
| Horizontal scroll | Long lines scroll horizontally (no wrapping) |
| Max height | 400px, then internal scroll. Optional `maxLines` prop for truncation. |
| Border radius | 8px |
| Screen reader | "Code block. Language: [language]. [N] lines. Double tap to copy." |

#### 2.22 Markdown Tables

**CLI Appearance**: ASCII-rendered table with column alignment.

**Mobile Component**:

```typescript
interface MarkdownTableProps {
  headers: string[];
  rows: string[][];
  alignment: ('left' | 'center' | 'right')[];
}
```

| Aspect | Specification |
|--------|---------------|
| Component | `<MarkdownTable>` |
| Display | Native table with proper columns. Header row bold with bottom border. |
| Horizontal scroll | If table exceeds screen width, horizontal scroll with fade indicator at edges |
| Cell padding | 8px horizontal, 6px vertical |
| Alternating rows | Subtle alternating background (`theme.colors.tableRowAlt`) |
| Screen reader | "Table with [N] columns and [M] rows. Header: [col1], [col2]... Row 1: [val1], [val2]..." |

#### 2.23 Session Timer / Active Indicator

**CLI Appearance**: Status bar clock showing elapsed time. Activity indicator when the agent is processing.

**Mobile Component**: Rendered as part of `<UsageFooter>` (session timer) and session header (active indicator).

| Aspect | Specification |
|--------|---------------|
| Component | `<SessionTimer>` (reusable) |
| Display | HH:MM:SS elapsed time, updates every second when active |
| Active indicator | Green pulsing dot (2s pulse, 8px diameter) when agent is actively processing |
| Idle indicator | Grey static dot when waiting for user input |
| Disconnected | Red dot with "Disconnected" label when WebSocket connection is lost |
| Screen reader | "Session timer: [elapsed]. Session is [active/idle/disconnected]." |

#### Acceptance Criteria

- [ ] Every CLI visual element listed in the F13 spec has a corresponding mobile component
- [ ] Each component has a TypeScript props interface defined
- [ ] All components specify alignment, sizing, colors, and font specifications
- [ ] All interactive elements have a minimum touch target of 44x44pt (Apple HIG) or 48x48dp (Material Design)
- [ ] All components have screen reader labels defined
- [ ] Color values are specified for both dark and light themes
- [ ] Components use `theme.colors.*` references for all color values (no hardcoded colors in component logic)
- [ ] Tool call cards use consistent header/body/footer structure across all tool types
- [ ] Streaming states are visually distinct from completed states

---

### 3. Streaming Text Renderer (F13.2)

The streaming text renderer displays Claude's responses word-by-word as they arrive via WebSocket, maintaining 60fps performance on mid-range phones.

#### Architecture

```typescript
interface StreamingRendererConfig {
  /** Target frame interval in milliseconds (16.67ms = 60fps) */
  frameIntervalMs: number;
  /** Maximum characters to buffer before forcing a render */
  maxBufferSize: number;
  /** Cursor blink interval in milliseconds */
  cursorBlinkMs: number;
  /** Whether to parse markdown incrementally during streaming */
  incrementalMarkdown: boolean;
}

const DEFAULT_CONFIG: StreamingRendererConfig = {
  frameIntervalMs: 16,
  maxBufferSize: 256,
  cursorBlinkMs: 500,
  incrementalMarkdown: true,
};
```

#### Render Loop Pseudocode

```
State:
  buffer: string = ""                 // Accumulated but not yet rendered text
  renderedText: string = ""           // Text already committed to the rendered view
  markdownAST: MarkdownNode[] = []    // Incrementally built markdown tree
  cursorVisible: boolean = true       // Cursor blink state
  frameRequest: number | null = null  // requestAnimationFrame ID

On WebSocket chunk received (chunk: string):
  buffer += chunk
  if frameRequest is null:
    frameRequest = requestAnimationFrame(renderFrame)

function renderFrame():
  frameRequest = null

  // 1. Flush buffer to rendered text
  textToRender = buffer
  buffer = ""
  renderedText += textToRender

  // 2. Incremental markdown parse
  //    Only re-parse the new text, not the full document.
  //    Append new AST nodes to existing tree.
  newNodes = incrementalParse(textToRender, markdownAST)
  markdownAST = [...markdownAST, ...newNodes]

  // 3. If buffer has accumulated more text during parse, schedule next frame
  if buffer.length > 0:
    frameRequest = requestAnimationFrame(renderFrame)

  // 4. Trigger React re-render with new markdownAST
  setMarkdownAST(markdownAST)

On stream end:
  // Flush any remaining buffer
  renderedText += buffer
  buffer = ""
  // Final full markdown parse for correctness
  markdownAST = fullParse(renderedText)
  // Start cursor blink-out (blink 3 times then hide)
  startCursorFadeOut()
```

#### Buffer Management

```typescript
interface StreamBuffer {
  /** Raw text chunks not yet rendered */
  pending: string;
  /** Whether we're inside an incomplete markdown construct */
  inCodeBlock: boolean;
  inTable: boolean;
  /** Partial token (e.g., half a word split across chunks) */
  partialToken: string;
}
```

Partial token handling: When a chunk ends mid-word (detectable by not ending on whitespace or punctuation), hold the partial token in the buffer until the next chunk completes it. This prevents brief visual glitches from half-rendered words.

Code block handling: When the parser detects an opening ` ``` ` without a closing one, buffer the entire code block until the closing fence arrives. This prevents the code block from briefly rendering as inline text.

#### Cursor Animation

```typescript
interface CursorState {
  visible: boolean;
  blinkIntervalId: number | null;
  fadeOutRemaining: number;   // 3 blinks remaining after stream ends
}
```

- During streaming: solid cursor `|` after last character, no blink
- Stream paused (> 500ms without new chunk): cursor starts blinking at 500ms interval
- Stream ended: cursor blinks 3 times, then fades out over 200ms

#### Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Frame rate during streaming | 60fps (16.67ms frame budget) | React Native performance monitor |
| Time from chunk receipt to render | < 16ms | Profiler timestamp comparison |
| Memory growth during 10K word stream | < 5MB | Heap snapshot before/after |
| Markdown parse time per frame | < 8ms (half frame budget) | Profiler |

#### Acceptance Criteria

- [ ] Text appears word-by-word (not character-by-character) at 60fps
- [ ] Cursor is visible at the end of streaming text
- [ ] Cursor blinks when streaming is paused (> 500ms gap between chunks)
- [ ] Cursor blinks 3 times and fades out when stream completes
- [ ] Markdown is parsed incrementally during streaming (headers, bold, italic, lists render in real-time)
- [ ] Code blocks are buffered until the closing fence arrives before rendering
- [ ] Partial tokens (words split across chunks) are held until completed
- [ ] Performance: 60fps maintained on a mid-range phone (e.g., Pixel 6a, iPhone SE 3rd gen)
- [ ] A 10,000-word response streams without memory issues or frame drops
- [ ] Buffer is fully flushed and a final full markdown parse runs on stream completion

---

### 4. Diff Viewer Component (F13.3)

The diff viewer renders unified diffs with syntax highlighting, supporting both inline unified and side-by-side views.

#### Component Interface

```typescript
interface DiffViewerProps {
  /** Unified diff string (output of `diff -u` or generated from old/new strings) */
  diff: string;
  /** File path for language detection */
  filePath: string;
  /** Override language detection */
  language?: string;
  /** View mode */
  viewMode: 'unified' | 'side_by_side';
  /** Callback when view mode changes (swipe gesture on tablet) */
  onViewModeChange: (mode: 'unified' | 'side_by_side') => void;
  /** Maximum visible lines before collapse */
  maxVisibleLines?: number;
  /** Whether to show line numbers */
  showLineNumbers?: boolean;
  /** Theme override */
  theme?: 'dark' | 'light';
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged' | 'header';
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

interface DiffHunk {
  header: string;          // @@ -start,count +start,count @@
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface ParsedDiff {
  oldFile: string;
  newFile: string;
  hunks: DiffHunk[];
  stats: {
    additions: number;
    deletions: number;
    unchanged: number;
  };
}
```

#### Diff Parsing

The component parses unified diff format:

```
--- a/src/lib/context_loader.sh
+++ b/src/lib/context_loader.sh
@@ -10,7 +10,8 @@
 unchanged line
-removed line
+added line
+another added line
 unchanged line
```

#### Visual Specification

| Element | Unified View | Side-by-Side View |
|---------|-------------|-------------------|
| Added line | Green background (`#1A3A2A` dark / `#E6FFEC` light), `+` gutter marker | Green background on right panel only |
| Removed line | Red background (`#3A1A1A` dark / `#FFE6E6` light), `-` gutter marker | Red background on left panel only |
| Unchanged line | Default background, space gutter marker | Shown in both panels |
| Hunk header | `@@` line in muted blue, italic | Separator bar between panels |
| Line numbers | Old (left gutter) + new (right gutter) | Each panel has its own line number gutter |
| Gutter width | 80px (40px old + 40px new) | 40px per panel |

#### Collapse Behavior

Unchanged sections longer than 5 lines are collapsed:

```
  line 8  | unchanged
  --------+-----------------------------------
  [ Show 23 more unchanged lines ]
  --------+-----------------------------------
  line 32 | unchanged
- line 33 | removed content
+ line 33 | added content
```

The expander shows 10 lines at a time when tapped: "Show next 10 lines" / "Show all 23 lines".

#### Side-by-Side Gesture

On tablets (width >= 768px), a horizontal swipe gesture on the diff toggles between unified and side-by-side mode. The transition animates with a 300ms slide. On phones, side-by-side mode is not available (insufficient width).

#### Binary File Detection

If the diff content contains null bytes or the file extension matches known binary types (`.png`, `.jpg`, `.gif`, `.pdf`, `.zip`, `.wasm`, `.o`, `.so`, `.dylib`), the diff viewer shows a placeholder:

```
[Binary file changed — cannot display diff]
Old size: 24.5 KB → New size: 25.1 KB
```

#### Acceptance Criteria

- [ ] Unified diff format is correctly parsed into `DiffHunk[]` and `DiffLine[]` structures
- [ ] Added lines render with green background, removed with red
- [ ] Line numbers are displayed for both old and new file
- [ ] Syntax highlighting is applied within diff lines based on file extension
- [ ] Unchanged sections > 5 lines are collapsed with a "Show N more lines" expander
- [ ] Side-by-side mode is available on tablets (width >= 768px) and toggled via swipe
- [ ] Side-by-side transition animates smoothly (300ms)
- [ ] Binary files show a placeholder instead of attempting to render diff content
- [ ] Diff stats (additions, deletions) are shown in the header
- [ ] Long lines (> screen width) scroll horizontally within the diff viewer

---

### 5. Terminal Emulator Widget (F13.4)

For managed sessions, an embedded terminal emulator provides the raw PTY experience within the mobile/desktop app. This uses xterm.js running inside a React Native WebView.

#### Architecture

```
+---------------------------+
|   React Native App        |
|   +---------------------+ |
|   |   <WebView>         | |
|   |   +---------------+ | |
|   |   | xterm.js      | | |
|   |   | Terminal       | | |
|   |   +---------------+ | |
|   +---------------------+ |
|                           |
|   Bridge (postMessage):   |
|   RN -> WebView: data,    |
|     resize, theme          |
|   WebView -> RN: input,   |
|     selection, title       |
+---------------------------+
```

#### Component Interface

```typescript
interface TerminalWidgetProps {
  /** WebSocket URL for PTY data stream */
  wsUrl: string;
  /** Initial terminal dimensions */
  initialCols: number;
  initialRows: number;
  /** Theme for xterm.js */
  theme: XTermTheme;
  /** Whether to show the virtual keyboard input bar */
  showInputBar: boolean;
  /** Callback when terminal title changes (set by shell escape codes) */
  onTitleChange: (title: string) => void;
  /** Callback when user inputs text via virtual keyboard */
  onInput: (data: string) => void;
}

interface XTermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}
```

#### ANSI Support

| Feature | Support Level |
|---------|--------------|
| 16 colors (SGR 30-37, 40-47, 90-97, 100-107) | Full |
| 256 colors (SGR 38;5;N, 48;5;N) | Full |
| Truecolor (SGR 38;2;R;G;B, 48;2;R;G;B) | Full |
| Bold, italic, underline, strikethrough | Full |
| Cursor movement (CUU, CUD, CUF, CUB, CUP) | Full |
| Alternate screen buffer (DECSET 1049) | Full |
| Scroll regions (DECSTBM) | Full |
| Mouse tracking (basic button events) | Not supported (touch-based scrollback instead) |

#### Touch Interaction

| Gesture | Action |
|---------|--------|
| Vertical swipe | Scroll through terminal scrollback buffer |
| Horizontal swipe (two-finger) | Scroll horizontally if terminal is wider than viewport |
| Tap | Place cursor for keyboard input (if showInputBar is true) |
| Long press | Text selection mode (native iOS/Android selection handles) |
| Pinch | Zoom terminal font size (range: 10px to 24px) |

#### Virtual Keyboard Input Bar

When `showInputBar` is true, a toolbar appears above the system keyboard with:

- Special key buttons: `Tab`, `Ctrl`, `Esc`, `Up`, `Down`, `Left`, `Right`
- Each button sends the corresponding escape sequence to the PTY
- The text input field sends raw characters to the PTY
- `Enter` sends `\r`

#### WebView Bridge Protocol

Messages from React Native to WebView:

```typescript
type RNToWebViewMessage =
  | { type: 'write'; data: string }           // PTY data to render
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'setTheme'; theme: XTermTheme }
  | { type: 'clear' }
  | { type: 'scrollToBottom' };
```

Messages from WebView to React Native:

```typescript
type WebViewToRNMessage =
  | { type: 'input'; data: string }           // User keyboard input
  | { type: 'selection'; text: string }       // Text selection for copy
  | { type: 'titleChange'; title: string }    // Terminal title update
  | { type: 'ready' }                         // xterm.js initialized
  | { type: 'resize'; cols: number; rows: number }; // Fit addon resize
```

#### Performance Considerations

| Concern | Mitigation |
|---------|------------|
| WebView startup latency | Pre-load the WebView HTML in background when session is opened |
| Bridge message overhead | Batch PTY data into 16ms frames before sending to WebView |
| Memory usage of scrollback | Limit scrollback buffer to 5,000 lines (configurable) |
| Font rendering in WebView | Use system monospace font, preload Web Font if custom |
| React Native thread blocking | All WebView communication is async via postMessage |

#### When to Show Terminal vs Structured View

| Condition | Default View |
|-----------|-------------|
| Managed session + phone | Structured (card-based) |
| Managed session + tablet | Structured (card-based) |
| Managed session + desktop | Terminal (raw PTY) |
| Observed session (any device) | Structured (card-based) -- terminal not available |
| User explicitly toggles | Respect user choice, persisted per session |

#### Acceptance Criteria

- [ ] xterm.js renders inside a React Native WebView
- [ ] 16-color, 256-color, and truecolor ANSI sequences render correctly
- [ ] Cursor movement and alternate screen buffer work (e.g., `vim`, `htop` render correctly)
- [ ] Vertical swipe scrolls through scrollback buffer (up to 5,000 lines)
- [ ] Pinch-to-zoom adjusts terminal font size between 10px and 24px
- [ ] Virtual keyboard input bar sends correct escape sequences for special keys
- [ ] WebView bridge messages are batched at 16ms intervals to avoid flooding
- [ ] Terminal widget is not available for observed sessions (GC hooks only, no PTY access)
- [ ] Theme changes apply immediately to the terminal
- [ ] Long press activates text selection with native copy support

---

### 6. Dual View Mode (F13.5)

Users can toggle between "Structured" (card-based, pretty) and "Terminal" (raw PTY output) views of a session.

#### View Mode Interface

```typescript
type ViewMode = 'structured' | 'terminal';

interface ViewModeConfig {
  /** Current view mode */
  mode: ViewMode;
  /** Whether terminal view is available (only for managed sessions) */
  terminalAvailable: boolean;
  /** Persisted per-session preference */
  sessionPreference: ViewMode | null;
  /** Device default */
  deviceDefault: ViewMode;
}

interface ViewModeSwitcherProps {
  config: ViewModeConfig;
  onModeChange: (mode: ViewMode) => void;
}
```

#### Default View by Device and Session Type

| Device | Session Type | Default View | Terminal Available |
|--------|-------------|-------------|-------------------|
| Phone | Observed (GC hooks) | Structured | No |
| Phone | Managed (SDK + PTY) | Structured | Yes |
| Tablet | Observed (GC hooks) | Structured | No |
| Tablet | Managed (SDK + PTY) | Structured | Yes |
| Desktop (Tauri) | Observed (GC hooks) | Structured | No |
| Desktop (Tauri) | Managed (SDK + PTY) | Terminal | Yes |

#### Data Availability per View Mode

| Data | Structured View | Terminal View |
|------|----------------|---------------|
| User prompts | Full text | Raw terminal echo |
| Claude responses (managed) | Streaming text + markdown | Raw terminal rendering |
| Claude responses (observed) | Full text (post-turn) | Not available |
| Tool calls | Parsed cards with expand/collapse | Raw CLI output |
| Diffs | Syntax-highlighted diff viewer | Raw `+`/`-` lines in terminal |
| Bash output | Parsed with exit code | Raw terminal output with full ANSI |
| Thinking blocks | Dedicated card | "Thinking..." text in terminal |
| Permissions | Action sheet with buttons | `[y/n/a]` prompt in terminal |
| Usage stats | Sticky footer | Status bar in terminal |

#### View Mode Toggle UI

- **Component**: Segmented control in the session header
- **Labels**: "Structured" | "Terminal"
- **Disabled state**: "Terminal" is greyed out with "(unavailable)" for observed sessions
- **Transition**: Cross-fade animation, 200ms duration
- **Persistence**: View mode preference stored in `AsyncStorage` keyed by session ID

#### Acceptance Criteria

- [ ] View mode toggle is visible in the session header
- [ ] Structured view shows card-based rendering for all timeline items
- [ ] Terminal view shows raw PTY output via xterm.js widget
- [ ] Terminal option is disabled (greyed out) for observed sessions
- [ ] Default view matches the device/session type matrix above
- [ ] View mode is persisted per session in local storage
- [ ] Transition between modes animates with a 200ms cross-fade
- [ ] Switching to structured view from terminal does not lose scroll position
- [ ] Switching back to terminal from structured scrolls to the bottom (latest output)

---

### 7. Syntax Highlighting (F13.6)

Code blocks, file contents, and diff lines are syntax-highlighted based on language detection.

#### Language Detection

Language is detected from file extension. The following mapping is used:

```typescript
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.md': 'markdown',
  '.toml': 'toml',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.ex': 'elixir',
  '.exs': 'elixir',
};
```

For fenced code blocks in markdown (` ```language `), the language identifier is used directly.

#### Highlighting Engine

Two options, chosen based on platform:

| Platform | Engine | Reason |
|----------|--------|--------|
| React Native (mobile) | `highlight.js` via `react-native-syntax-highlighter` | Lighter weight, works in RN |
| Tauri (desktop) | `Shiki` | Superior accuracy, WASM-based, better performance on desktop |
| Web (dashboard) | `Shiki` | Same as desktop |

#### Lazy Loading

Language grammars are loaded on demand, not bundled at startup:

```typescript
interface HighlightManager {
  /** Loaded language grammars */
  loadedLanguages: Set<string>;

  /** Load a language grammar. Returns quickly if already loaded. */
  loadLanguage(language: string): Promise<void>;

  /** Highlight code. Loads language if needed. Falls back to plain text. */
  highlight(code: string, language: string): Promise<HighlightedCode>;
}

interface HighlightedCode {
  /** HTML or React Native elements with syntax colors applied */
  tokens: HighlightToken[];
  /** Language that was actually used (may differ from requested if fallback) */
  language: string;
}

interface HighlightToken {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}
```

**Bundle strategy**: The top 5 languages (JavaScript, TypeScript, Python, Bash, JSON) are included in the initial bundle. All others are loaded on first use and cached in memory.

#### Theme Colors

```typescript
interface SyntaxTheme {
  /** Token type to color mapping */
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  variable: string;
  type: string;
  operator: string;
  punctuation: string;
  property: string;
  constant: string;
  tag: string;       // HTML/XML tags
  attribute: string; // HTML/XML attributes
  regex: string;
  builtin: string;
}

const DARK_SYNTAX_THEME: SyntaxTheme = {
  keyword: '#FF7B72',
  string: '#A5D6FF',
  number: '#79C0FF',
  comment: '#8B949E',
  function: '#D2A8FF',
  variable: '#FFA657',
  type: '#FF7B72',
  operator: '#FF7B72',
  punctuation: '#C9D1D9',
  property: '#79C0FF',
  constant: '#79C0FF',
  tag: '#7EE787',
  attribute: '#79C0FF',
  regex: '#A5D6FF',
  builtin: '#FFA657',
};

const LIGHT_SYNTAX_THEME: SyntaxTheme = {
  keyword: '#CF222E',
  string: '#0A3069',
  number: '#0550AE',
  comment: '#6E7781',
  function: '#8250DF',
  variable: '#953800',
  type: '#CF222E',
  operator: '#CF222E',
  punctuation: '#24292F',
  property: '#0550AE',
  constant: '#0550AE',
  tag: '#116329',
  attribute: '#0550AE',
  regex: '#0A3069',
  builtin: '#953800',
};
```

#### Acceptance Criteria

- [ ] Code blocks detect language from file extension or markdown fence language identifier
- [ ] Top 5 languages (JS, TS, Python, Bash, JSON) are available without network loading
- [ ] Other languages are lazy-loaded on first use
- [ ] Dark and light syntax themes are fully specified with distinct colors for all token types
- [ ] Highlighting gracefully falls back to plain text if language detection fails
- [ ] Highlighting does not block the main thread (async with < 50ms parse time for files < 1000 lines)
- [ ] Syntax highlighting applies within diff viewer lines (not just standalone code blocks)
- [ ] The highlighting engine is `highlight.js` on React Native and `Shiki` on desktop/web

---

### 8. Prompt Input Component (F13.8)

The prompt input allows users to send messages to managed sessions from their mobile device or desktop app.

#### Component Interface

```typescript
interface PromptInputProps {
  /** Current input text (controlled) */
  value: string;
  /** Text change handler */
  onChange: (text: string) => void;
  /** Submit handler */
  onSubmit: () => void;
  /** Whether the agent is currently processing (disables submit) */
  isAgentBusy: boolean;
  /** Whether this is a managed session (input enabled) vs observed (input disabled) */
  isManaged: boolean;
  /** Prompt history for navigation */
  history: string[];
  /** Current position in prompt history (-1 = current input) */
  historyIndex: number;
  /** History navigation handler */
  onHistoryNavigate: (direction: 'up' | 'down') => void;
  /** File attachment handler */
  onAttachFile: () => void;
  /** Voice input handler (F6.10 integration point) */
  onVoiceInput: () => void;
  /** Attached files */
  attachments: Array<{ name: string; path: string; size: number }>;
  /** Remove an attachment */
  onRemoveAttachment: (index: number) => void;
}
```

#### Layout

```
+------------------------------------------------------+
| [Attached files chips]                               |
+------------------------------------------------------+
| Multi-line text input                                |
|                                                      |
|                                                      |
+------+------+--------+------+------------------------+
| [📎] | [🎤] | [Aa/md] |      |        [Send ▶]      |
+------+------+--------+------+------------------------+
  Attach Voice  Preview          Send button
```

#### Behavior

| Feature | Specification |
|---------|---------------|
| Auto-grow | Input grows from 1 line to max 8 lines as text is entered. Beyond 8 lines, internal scroll. |
| Markdown preview | Toggle button switches between raw text editing and rendered markdown preview |
| Prompt history | Swipe up on input area (mobile) or arrow-up key (desktop) navigates to previous prompts |
| History storage | Last 50 prompts stored in `AsyncStorage`, per-session |
| Voice input button | Opens voice recognition sheet (F6.10). Inserts transcribed text at cursor position. |
| File attachment | Opens system file picker. Attached files shown as removable chips above input. |
| Send button | Disabled when input is empty or agent is busy. Shows loading spinner when agent is processing. |
| Keyboard shortcuts (desktop) | `Enter`: submit. `Shift+Enter`: newline. `Ctrl+Up` / `Ctrl+Down`: history navigation. |
| Observed sessions | Input is disabled with placeholder "Read-only session. Take over to send prompts." |
| Max input length | 100,000 characters (matches Claude Code's practical limit) |

#### Accessibility

| Element | Label |
|---------|-------|
| Text input | "Message input. [N] characters. [Empty / Has text]." |
| Send button | "Send message. [Enabled / Disabled: agent is busy]." |
| Attach button | "Attach file." |
| Voice button | "Voice input." |
| Preview toggle | "Toggle markdown preview. Currently [editing / previewing]." |
| History gesture | "Swipe up to see previous messages." |

#### Acceptance Criteria

- [ ] Multiline text input auto-grows from 1 to 8 lines
- [ ] Markdown preview toggle renders the input text as formatted markdown
- [ ] Prompt history is navigable via swipe (mobile) or keyboard shortcuts (desktop)
- [ ] Last 50 prompts are persisted per session in local storage
- [ ] Voice input button is present and triggers the F6.10 voice recognition flow
- [ ] File attachment opens the system file picker and shows attached files as chips
- [ ] Send button is disabled when input is empty or agent is busy
- [ ] Desktop keyboard shortcuts work: Enter to send, Shift+Enter for newline
- [ ] Input is disabled with explanatory placeholder text for observed sessions
- [ ] Loading spinner appears on send button while agent is processing

---

### 9. Permission Action Sheet (F13.9)

When an agent requests permission (e.g., to run a bash command or write a file), a native action sheet presents the request to the user for approval.

#### Component Interface

```typescript
interface PermissionActionSheetProps {
  /** The permission request to display */
  request: PermissionRequest;
  /** Handler for allow action */
  onAllow: () => void;
  /** Handler for deny action */
  onDeny: () => void;
  /** Handler for "always allow this tool in this session" */
  onAlwaysAllow: () => void;
  /** Handler for dismiss (timeout or swipe down) */
  onDismiss: () => void;
  /** Auto-dismiss timeout in milliseconds (0 = no timeout) */
  autoTimeoutMs: number;
  /** Position in the permission queue (1 = frontmost) */
  queuePosition: number;
  /** Total permissions pending in queue */
  queueTotal: number;
}
```

#### Layout (Bottom Sheet)

```
+------------------------------------------------------+
|  ─────  (drag handle)                                |
|                                                      |
|  ⚠  Permission Required                 [1 of 3]    |
|                                                      |
|  Allow Bash to execute:                              |
|  ┌──────────────────────────────────────────────┐    |
|  │  $ rm -rf node_modules && npm install        │    |
|  └──────────────────────────────────────────────┘    |
|                                                      |
|  Working directory: /home/user/project               |
|                                                      |
|  ┌──────────────────────────────────────────────┐    |
|  │           ✓  Allow                           │    |
|  └──────────────────────────────────────────────┘    |
|  ┌──────────────────────────────────────────────┐    |
|  │           ✗  Deny                            │    |
|  └──────────────────────────────────────────────┘    |
|  ┌──────────────────────────────────────────────┐    |
|  │    ✓✓ Always Allow Bash (this session)       │    |
|  └──────────────────────────────────────────────┘    |
|                                                      |
|  Auto-dismiss in 4:32                                |
+------------------------------------------------------+
```

#### Behavior

| Feature | Specification |
|---------|---------------|
| Presentation | Native bottom sheet (iOS: `UISheetPresentationController`, Android: `BottomSheetDialog`) |
| Drag-to-dismiss | Swipe down dismisses the sheet. Same as timeout -- permission remains pending. |
| Haptic feedback | Medium impact on Allow tap. Warning haptic on Deny tap. |
| Button colors | Allow: green (`#22C55E`), Deny: red (`#EF4444`), Always Allow: blue (`#3B82F6`) |
| Button height | 52px each, 8px gap between buttons |
| Auto-dismiss | Countdown timer shown at bottom. Configurable, default 5 minutes (300,000ms). |
| Push notification | When app is backgrounded and a permission is pending, trigger a local push notification: "Agent needs permission: Allow [tool]?" |
| Permission queue | Multiple pending permissions are stacked. The sheet shows "[N of M]" indicator. Resolving one reveals the next. |
| Tool-specific details | For Bash: show the command. For Edit/Write: show the file path. For WebFetch: show the URL. |
| Timeout behavior | On timeout, permission remains in `pending` state. The agent continues to wait. User can re-open from the timeline. |

#### Push Notification Trigger

```typescript
interface PermissionNotification {
  title: string;        // "Permission Required"
  body: string;         // "Allow Bash: rm -rf node_modules?"
  data: {
    sessionId: string;
    permissionId: string;
    toolName: string;
  };
  /** Notification actions (iOS/Android) */
  actions: [
    { id: 'allow'; title: 'Allow' },
    { id: 'deny'; title: 'Deny' }
  ];
}
```

The push notification is triggered after 3 seconds of the app being backgrounded with a pending permission. This avoids triggering notifications when the user is briefly switching apps.

#### Acceptance Criteria

- [ ] Permission request displays as a native bottom sheet
- [ ] Tool name, description, and affected resource (file/command/URL) are shown
- [ ] Three action buttons: Allow (green), Deny (red), Always Allow for Session (blue)
- [ ] Haptic feedback fires on button taps (medium impact for Allow, warning for Deny)
- [ ] Auto-dismiss countdown is visible and configurable (default 5 minutes)
- [ ] Push notification triggers when app is backgrounded for > 3 seconds with pending permission
- [ ] Push notification actions (Allow/Deny) resolve the permission without opening the app
- [ ] Multiple pending permissions display as a queue with position indicator "[N of M]"
- [ ] Swipe-down dismisses the sheet without resolving the permission
- [ ] Resolving one permission automatically presents the next in queue

---

### 10. Search Within Session (F13.10)

Full-text search across all events in the current session with filtering and result navigation.

#### Component Interface

```typescript
interface SessionSearchProps {
  /** All timeline items in the current session */
  timeline: TimelineItem[];
  /** Whether search UI is visible */
  isOpen: boolean;
  /** Toggle search visibility */
  onToggle: () => void;
  /** Navigate to a specific timeline item */
  onNavigateToItem: (itemId: string) => void;
}

interface SearchState {
  query: string;
  filters: SearchFilters;
  results: SearchResult[];
  selectedResultIndex: number;
  isSearching: boolean;
}

interface SearchFilters {
  /** Filter by timeline item type */
  eventTypes: TimelineItem['type'][] | null;
  /** Filter by tool name (for tool_call items) */
  toolNames: string[] | null;
  /** Filter by file path (regex match) */
  filePathPattern: string | null;
  /** Filter by date range */
  dateRange: {
    start: string | null;  // ISO 8601
    end: string | null;    // ISO 8601
  };
}

interface SearchResult {
  /** The timeline item that matched */
  itemId: string;
  /** The type of the matched item */
  itemType: TimelineItem['type'];
  /** Snippet of text around the match (50 chars before + match + 50 chars after) */
  snippet: string;
  /** Character offset of the match within the snippet */
  matchStart: number;
  /** Length of the matched text */
  matchLength: number;
  /** Timestamp of the matched item */
  timestamp: string;
}
```

#### Search UI Layout

```
+------------------------------------------------------+
| [🔍 Search...                          ] [✕] [⚙]    |
+------------------------------------------------------+
| Filters: [All Types ▼] [All Tools ▼] [Date ▼]       |
+------------------------------------------------------+
| Results (23 matches)                    [< 3/23 >]   |
+------------------------------------------------------+
| 10:23 AM  [AssistantMessage]                         |
| ...the **context_loader** function needs to...       |
+------------------------------------------------------+
| 10:25 AM  [ToolCall: Edit]                           |
| ...context_loader.sh line 42: added validation...    |
+------------------------------------------------------+
| 10:31 AM  [ToolCall: Bash]                           |
| ...$ grep -r "context_loader" src/...               |
+------------------------------------------------------+
```

#### Search Behavior

| Feature | Specification |
|---------|---------------|
| Search scope | All text content within all timeline items: message text, tool inputs, tool outputs, file paths, error messages |
| Case sensitivity | Case-insensitive by default. Toggle for case-sensitive search. |
| Debounce | 300ms debounce on keystroke before executing search |
| Result limit | Display first 100 results. "Show more" loads next 100. |
| Highlighting | Matched text is highlighted in yellow (`#FBBF24`) within the snippet |
| Navigation | Arrow buttons or swipe between results. Tapping a result scrolls the timeline to that item. |
| Regex support | Toggle for regex mode (default: literal string match) |
| Filter chips | Tappable filter chips that narrow results by type, tool, file path, or date |
| Keyboard shortcut (desktop) | `Ctrl+F` / `Cmd+F` opens search |
| Persistence | Search query and filters persist while the session is open. Cleared on session close. |

#### Acceptance Criteria

- [ ] Full-text search matches across all timeline item content
- [ ] Search results show snippets with highlighted match text
- [ ] Tapping a search result scrolls the timeline to that item
- [ ] Filter by event type, tool name, file path, and date range
- [ ] Search is case-insensitive by default with a toggle for case-sensitive
- [ ] Regex mode toggle for pattern-based search
- [ ] 300ms debounce prevents excessive searching during typing
- [ ] First 100 results shown, with "Show more" pagination
- [ ] `Ctrl+F` / `Cmd+F` keyboard shortcut opens search on desktop
- [ ] Search results update in real-time as new events arrive during an active session

---

### 11. Session Scrubber (F13.11)

A timeline scrubber bar at the bottom of the screen enables rapid navigation through session history, similar to a video player scrubber.

#### Component Interface

```typescript
interface SessionScrubberProps {
  /** All timeline items, sorted by sequence */
  timeline: TimelineItem[];
  /** Currently visible item (the one at the center of the viewport) */
  currentItemId: string;
  /** Callback when user scrubs to a different position */
  onScrubTo: (itemId: string) => void;
  /** Whether scrubber is in dragging state */
  isDragging: boolean;
}

interface ScrubberTick {
  /** Normalized position (0.0 to 1.0) along the scrubber */
  position: number;
  /** The timeline item at this position */
  itemId: string;
  /** Visual category for tick styling */
  category: 'user_prompt' | 'error' | 'permission' | 'tool_call' | 'other';
  /** Timestamp for tooltip */
  timestamp: string;
}

interface ScrubberMinimap {
  /** Event density histogram: array of counts per time bucket */
  buckets: Array<{
    position: number;
    count: number;
    dominantType: TimelineItem['type'];
  }>;
  /** Number of buckets (fixed at 100 for scrubber width) */
  bucketCount: number;
}
```

#### Visual Specification

```
Timeline View
  |
  |  [ ... session events rendered above ... ]
  |
  +------------------------------------------------------+
  |  Scrubber Bar                                        |
  |  ┌──────────────────────────────────────────────────┐|
  |  │ ╎  ╎╎╎ ╎   ╎ ╎╎  ╎   ╎╎╎╎╎╎  ╎  ╎ ╎╎  ╎  ╎  │|
  |  │ ▲         ●              ▲              ▲      ●│|
  |  │ user     error           user           user  err│|
  |  │           ◄── [handle] ──►                      │|
  |  └──────────────────────────────────────────────────┘|
  |  10:15 AM                                  11:42 AM  |
  +------------------------------------------------------+
```

| Element | Specification |
|---------|---------------|
| Bar height | 32px |
| Tick marks | Vertical lines at significant events. Height: 8px (normal), 12px (significant). Color by category. |
| Tick colors | User prompt: blue, Error: red, Permission: amber, Tool call: grey, Other: `theme.colors.muted` |
| Handle | 20px wide draggable circle on the scrubber bar. Follows touch/mouse position. |
| Minimap | Semi-transparent histogram behind the tick marks showing event density over time |
| Snap behavior | When dragging near a significant tick (within 8px), snap to that tick |
| Tooltip | While dragging, show a floating tooltip above the handle: timestamp + event type preview |
| Time labels | Start time (left) and end time / "Now" (right) below the scrubber bar |
| Haptic | Light haptic on snap-to-tick while dragging |

#### Interaction

| Gesture | Action |
|---------|--------|
| Tap on scrubber bar | Jump to the event at that position |
| Drag handle | Smooth scrub through events, with snap-to-tick |
| Tap tick mark | Jump directly to that event |
| Long press tick mark | Show tooltip with event details |

#### Acceptance Criteria

- [ ] Scrubber bar is positioned at the bottom of the session view
- [ ] Tick marks appear at significant events (user prompts, errors, permissions)
- [ ] Dragging the handle scrolls the timeline to the corresponding event
- [ ] Snap-to-event behavior activates when dragging within 8px of a tick mark
- [ ] Minimap shows event density as a semi-transparent histogram
- [ ] Floating tooltip shows timestamp and event type while dragging
- [ ] Time labels show session start time and current/end time
- [ ] Haptic feedback fires on snap-to-tick (light impact)
- [ ] Scrubber updates in real-time as new events arrive (handle stays at "now" unless user has scrubbed back)
- [ ] Tapping a tick mark jumps directly to that event in the timeline

---

### 12. Responsive Layout (F13.13)

The layout adapts to three device categories: phone, tablet, and desktop, with distinct panel configurations for each.

#### Breakpoints

```typescript
interface LayoutBreakpoints {
  /** Phone: single column */
  phone: { maxWidth: 767 };
  /** Tablet: two-panel */
  tablet: { minWidth: 768; maxWidth: 1199 };
  /** Desktop: three-panel */
  desktop: { minWidth: 1200 };
}

type DeviceClass = 'phone' | 'tablet' | 'desktop';

function getDeviceClass(windowWidth: number): DeviceClass {
  if (windowWidth < 768) return 'phone';
  if (windowWidth < 1200) return 'tablet';
  return 'desktop';
}
```

#### Phone Layout (< 768px)

```
+----------------------------+
|  [←] Session Name    [⚙]  |  <- Header (56px)
+----------------------------+
|                            |
|  User prompt bubble        |
|                            |
|  Claude response bubble    |
|                            |
|  Tool call card            |
|                            |
|  Tool call card            |
|                            |
|  Claude response bubble    |
|                            |
+----------------------------+
|  [Scrubber bar]            |  <- Scrubber (32px)
+----------------------------+
|  Model | Tokens | Cost     |  <- Usage footer (44px)
+----------------------------+
|  [Prompt input area]       |  <- Input (auto-height)
+----------------------------+
```

- Single column, full-width cards
- Chat-style chronological flow
- Navigation: back button returns to session list
- Cards: max width 100%, 16px horizontal padding

#### Tablet Layout (768px - 1199px)

```
+------------------+-------------------------------+
|  Session List    |  [Session Name]         [⚙]  |
|  ┌────────────┐  |                               |
|  │ Session 1  │  |  User prompt bubble           |
|  │ Session 2  │◄─|                               |
|  │ Session 3  │  |  Claude response bubble       |
|  │ Session 4  │  |                               |
|  │ Session 5  │  |  Tool call card               |
|  └────────────┘  |                               |
|                  |  Claude response bubble       |
|                  +-------------------------------+
|                  |  [Scrubber bar]               |
|                  +-------------------------------+
|                  |  Model | Tokens | Cost        |
|                  +-------------------------------+
|                  |  [Prompt input area]          |
+------------------+-------------------------------+
     320px                 remaining width
```

- Two-panel split: session list (left, 320px fixed) + session detail (right, flex)
- Session list shows session name, agent name, last activity time, unread badge
- Selecting a session loads it in the right panel
- On portrait orientation: collapses to phone layout with swipe navigation

#### Desktop Layout (>= 1200px)

```
+------------+------------------+-------------------------------+
| Agents     |  Sessions        |  [Session Name]         [⚙]  |
| ┌────────┐ |  ┌────────────┐  |                               |
| │ Agent1 │ |  │ Session 1  │  |  User prompt bubble           |
| │ Agent2 │◄|──│ Session 2  │◄─|                               |
| │ Agent3 │ |  │ Session 3  │  |  Claude response bubble       |
| └────────┘ |  │ Session 4  │  |                               |
|            |  │ Session 5  │  |  Tool call card               |
|            |  └────────────┘  |                               |
|            |                  |  Claude response bubble       |
|            |                  +-------------------------------+
|            |                  |  [Scrubber bar]               |
|            |                  +-------------------------------+
|            |                  |  Model | Tokens | Cost        |
|            |                  +-------------------------------+
|            |                  |  [Prompt input area]          |
+------------+------------------+-------------------------------+
    240px          320px                remaining width
```

- Three-panel: agents (240px) + sessions (320px) + detail (flex)
- Agent panel shows connected agents with status indicators
- Session panel shows sessions for the selected agent
- Detail panel shows the full session rendering

#### Orientation Change

| Transition | Behavior |
|------------|----------|
| Phone: portrait -> landscape | Widen cards, more horizontal space for diffs/code. Same layout. |
| Tablet: portrait -> landscape | If width >= 768px in landscape, show two-panel. If portrait < 768px, show single column. |
| Tablet: landscape -> portrait | If width < 768px, collapse to phone layout with back navigation. |
| Desktop | No orientation change (always landscape). |

#### Acceptance Criteria

- [ ] Phone layout (< 768px) renders as single-column chat-style
- [ ] Tablet layout (768-1199px) renders as two-panel (session list + detail)
- [ ] Desktop layout (>= 1200px) renders as three-panel (agents + sessions + detail)
- [ ] Breakpoint transitions are smooth (no layout flash or content jump)
- [ ] Orientation changes correctly switch between layouts
- [ ] Panel widths are consistent: agents = 240px, sessions = 320px, detail = flex
- [ ] All panels maintain scroll position during layout transitions
- [ ] Tablet portrait mode correctly falls back to phone layout when width < 768px

---

### 13. Theme System (F13.14)

The theme system provides dark and light modes with color palette specifications that match the Claude Code terminal aesthetic.

#### Theme Interface

```typescript
interface AppTheme {
  mode: 'dark' | 'light';
  colors: ThemeColors;
  syntax: SyntaxTheme;
  spacing: ThemeSpacing;
  typography: ThemeTypography;
}

interface ThemeColors {
  // Backgrounds
  background: string;
  surface: string;
  cardBg: string;
  footerBg: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  muted: string;

  // Chat bubbles
  userBubble: string;
  userText: string;
  assistantBubble: string;
  assistantText: string;

  // Semantic
  success: string;
  warning: string;
  error: string;
  info: string;

  // Tool-specific accents
  toolRead: string;
  toolEdit: string;
  toolWrite: string;
  toolBash: string;
  toolSearch: string;
  toolWebFetch: string;
  toolTask: string;

  // Specialized
  thinkingBg: string;
  thinkingText: string;
  permissionBg: string;
  errorBg: string;
  codeBlockBg: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  tableRowAlt: string;
  taskNesting: string;
  scrubberBg: string;
  searchHighlight: string;

  // Borders
  border: string;
  borderActive: string;
}

interface ThemeSpacing {
  xs: number;   // 4
  sm: number;   // 8
  md: number;   // 16
  lg: number;   // 24
  xl: number;   // 32
}

interface ThemeTypography {
  fontFamily: {
    body: string;      // System font (SF Pro / Roboto)
    mono: string;      // JetBrains Mono / SF Mono
  };
  fontSize: {
    xs: number;    // 11
    sm: number;    // 13
    md: number;    // 15
    lg: number;    // 18
    xl: number;    // 22
    xxl: number;   // 28
  };
}
```

#### Dark Theme (Default)

```typescript
const DARK_THEME: AppTheme = {
  mode: 'dark',
  colors: {
    background: '#0D1117',
    surface: '#161B22',
    cardBg: '#1C1F2E',
    footerBg: '#0D1117',

    textPrimary: '#E6EDF3',
    textSecondary: '#8B949E',
    muted: '#484F58',

    userBubble: '#2A2D3E',
    userText: '#E6EDF3',
    assistantBubble: '#1A1D2E',
    assistantText: '#E6EDF3',

    success: '#34D399',
    warning: '#FBBF24',
    error: '#EF4444',
    info: '#60A5FA',

    toolRead: '#60A5FA',
    toolEdit: '#FBBF24',
    toolWrite: '#34D399',
    toolBash: '#A78BFA',
    toolSearch: '#F472B6',
    toolWebFetch: '#38BDF8',
    toolTask: '#FB923C',

    thinkingBg: '#1E1E2E',
    thinkingText: '#8B949E',
    permissionBg: '#2E2A1A',
    errorBg: '#2E1A1A',
    codeBlockBg: '#0D1117',
    diffAddedBg: '#1A3A2A',
    diffRemovedBg: '#3A1A1A',
    tableRowAlt: '#161B22',
    taskNesting: 'rgba(251, 146, 60, 0.3)',
    scrubberBg: '#161B22',
    searchHighlight: '#FBBF24',

    border: '#30363D',
    borderActive: '#58A6FF',
  },
  syntax: DARK_SYNTAX_THEME,
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  typography: {
    fontFamily: {
      body: 'System',
      mono: 'JetBrainsMono-Regular',
    },
    fontSize: { xs: 11, sm: 13, md: 15, lg: 18, xl: 22, xxl: 28 },
  },
};
```

#### Light Theme

```typescript
const LIGHT_THEME: AppTheme = {
  mode: 'light',
  colors: {
    background: '#FFFFFF',
    surface: '#F6F8FA',
    cardBg: '#FFFFFF',
    footerBg: '#F6F8FA',

    textPrimary: '#24292F',
    textSecondary: '#57606A',
    muted: '#8C959F',

    userBubble: '#E8EAED',
    userText: '#24292F',
    assistantBubble: '#FFFFFF',
    assistantText: '#24292F',

    success: '#1A7F37',
    warning: '#9A6700',
    error: '#CF222E',
    info: '#0969DA',

    toolRead: '#0969DA',
    toolEdit: '#9A6700',
    toolWrite: '#1A7F37',
    toolBash: '#8250DF',
    toolSearch: '#BF3989',
    toolWebFetch: '#0550AE',
    toolTask: '#BC4C00',

    thinkingBg: '#F5F5F7',
    thinkingText: '#57606A',
    permissionBg: '#FFF8E1',
    errorBg: '#FFF0F0',
    codeBlockBg: '#F6F8FA',
    diffAddedBg: '#E6FFEC',
    diffRemovedBg: '#FFE6E6',
    tableRowAlt: '#F6F8FA',
    taskNesting: 'rgba(188, 76, 0, 0.15)',
    scrubberBg: '#F6F8FA',
    searchHighlight: '#FFF2CC',

    border: '#D0D7DE',
    borderActive: '#0969DA',
  },
  syntax: LIGHT_SYNTAX_THEME,
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  typography: {
    fontFamily: {
      body: 'System',
      mono: 'JetBrainsMono-Regular',
    },
    fontSize: { xs: 11, sm: 13, md: 15, lg: 18, xl: 22, xxl: 28 },
  },
};
```

#### Theme Detection

| Source | Method |
|--------|--------|
| System preference | `Appearance.getColorScheme()` from React Native |
| User override | Stored in `AsyncStorage` under `theme_mode` |
| Session metadata | If session metadata includes a terminal color scheme, offer to match it |
| Priority | User override > Session metadata > System preference |

#### Acceptance Criteria

- [ ] Dark theme is the default, matching terminal aesthetics
- [ ] Light theme is fully specified with all color values
- [ ] Theme can be toggled by the user and persisted across app restarts
- [ ] System theme preference (OS dark/light mode) is detected and applied if no user override
- [ ] All components use `theme.colors.*` references, never hardcoded colors
- [ ] Syntax highlighting colors match the active theme (dark syntax for dark, light syntax for light)
- [ ] Theme transitions are instant (no animated color transitions)
- [ ] Tool-specific accent colors are consistently applied across all views

---

### 14. Notification Badges (F13.12)

Notification badges provide at-a-glance indicators of unread activity across sessions.

#### Badge Interface

```typescript
interface BadgeState {
  /** Per-session badge data */
  sessions: Map<string, SessionBadges>;
  /** Aggregate badge for app icon */
  appBadge: number;
}

interface SessionBadges {
  /** Unread user prompts (for observed sessions where another user may have prompted) */
  unreadPrompts: number;
  /** Pending permission requests awaiting approval */
  pendingPermissions: number;
  /** Unread errors */
  unreadErrors: number;
  /** Total unread events (all types) */
  totalUnread: number;
  /** Whether the session has any activity since last viewed */
  hasNewActivity: boolean;
}

interface BadgeComponentProps {
  count: number;
  type: 'default' | 'permission' | 'error';
  size: 'small' | 'medium';
}
```

#### Badge Visual Specification

| Badge Type | Color | Icon | Priority |
|-----------|-------|------|----------|
| Pending permissions | Amber (`#FBBF24`) | Warning triangle | Highest |
| Unread errors | Red (`#EF4444`) | Exclamation circle | High |
| Unread prompts | Blue (`#60A5FA`) | Message circle | Medium |
| General activity | Grey (`#8B949E`) | Dot | Low |

#### Badge Behavior

| Feature | Specification |
|---------|---------------|
| Session list badge | Combined count badge on each session row. Shows highest-priority badge type color. |
| App icon badge | Sum of pending permissions + unread errors across all sessions. Set via `Notifications.setBadgeCountAsync()`. |
| Badge clearing | Viewing a session clears all badges for that session. Scrolling marks items as read. |
| Real-time update | Badges update via WebSocket events without requiring a pull-to-refresh. |
| Overflow | Counts > 99 display as "99+" |
| Badge size | Small (16px diameter) for inline, medium (22px diameter) for session list |

#### Badge Rendering

```typescript
// Badge component specification
interface BadgeComponentSpec {
  small: {
    diameter: 16;
    fontSize: 10;
    minWidth: 16;
    paddingHorizontal: 4;
    borderRadius: 8;
  };
  medium: {
    diameter: 22;
    fontSize: 12;
    minWidth: 22;
    paddingHorizontal: 6;
    borderRadius: 11;
  };
}
```

#### Acceptance Criteria

- [ ] Per-session badge counts are displayed on the session list
- [ ] Badge types are color-coded: amber (permissions), red (errors), blue (prompts), grey (activity)
- [ ] App icon badge shows aggregate count of permissions + errors
- [ ] Viewing a session clears its badges
- [ ] Badges update in real-time via WebSocket
- [ ] Counts > 99 display as "99+"
- [ ] Badge priority: permissions > errors > prompts > activity (highest priority color shown)
- [ ] Badge state persists across app restarts (restored from local storage)

---

## Edge Cases

### E-1: Very Long Claude Response (10,000+ Words)

**Scenario**: Claude generates a response exceeding 10,000 words (approximately 40,000 characters), which would create a very tall component in the timeline.

**Expected behavior**: The `AssistantMessageBubble` uses virtualized rendering internally. Only the visible portion of the message is rendered. As the user scrolls within the message, content is lazily rendered. The `FlashList` (or equivalent virtualized list) that contains the entire timeline treats this as a single item with an estimated height, and the message itself manages its own internal virtualized scroll.

**Risk**: Without virtualization, a 10K-word message could consume 100MB+ of memory on mobile, causing the app to be killed by the OS.

**Mitigation**: Internal `FlashList` within the message component for paragraphs. Markdown parsing produces a paragraph-level node list, each paragraph rendered as a separate virtualized item. Estimated height is calculated from character count (approximately 20px per 80-char line).

---

### E-2: Rapid Tool Call Sequence (20 Tools in 5 Seconds)

**Scenario**: Claude executes a burst of tool calls in rapid succession (e.g., reading 20 files to understand a codebase). Each tool call produces two events (Requested + Completed), totaling 40 events in 5 seconds.

**Expected behavior**: Events are batched for rendering. The normalization layer queues incoming events and flushes to the rendering engine at most once per animation frame (60fps). The timeline scrolls smoothly to the bottom as new events arrive.

**Risk**: Without batching, 40 React state updates in 5 seconds could cause jank and dropped frames on mid-range phones.

**Mitigation**: Event batching with a 16ms flush interval. The `FlashList` uses `maintainVisibleContentPosition` to prevent scroll jumps when items are added above the viewport. Tool call cards use `React.memo` with `toolUseId` as the memo key to prevent unnecessary re-renders of completed cards.

---

### E-3: Binary File in Diff (Images, Compiled Files)

**Scenario**: An `Edit` tool call modifies a binary file (e.g., an image or compiled binary). The diff output contains non-printable characters or base64 content.

**Expected behavior**: The diff viewer detects binary content via null byte detection or file extension matching. It displays a placeholder card: "[Binary file changed -- cannot display diff]" with file sizes before and after.

**Risk**: Attempting to render binary data as text could crash the markdown parser or produce garbled output filling the screen.

**Mitigation**: Binary detection runs before diff parsing. Known binary extensions (`.png`, `.jpg`, `.gif`, `.bmp`, `.ico`, `.pdf`, `.zip`, `.tar`, `.gz`, `.wasm`, `.o`, `.so`, `.dylib`, `.exe`, `.dll`) bypass the diff renderer entirely. Content-based detection (null byte scan of first 512 bytes) catches unlisted binary types.

---

### E-4: Terminal Output with Complex ANSI (ncurses App, vim Inside Claude)

**Scenario**: A Bash tool call runs `vim`, `htop`, or another ncurses-based application. The output contains complex ANSI escape sequences: alternate screen buffer activation, cursor positioning, color attributes, and screen clearing.

**Expected behavior**: In Terminal view mode, xterm.js handles all ANSI sequences natively. In Structured view mode, the Bash tool output card strips complex ANSI sequences and shows only the final text content. A "View in Terminal" button on the card offers to switch to Terminal mode for the full rendering.

**Risk**: Structured view attempting to render ncurses ANSI output produces incomprehensible garbage.

**Mitigation**: ANSI stripping in structured mode using a regex-based stripper that removes all CSI sequences (`\x1b\[[0-9;]*[A-Za-z]`) and OSC sequences (`\x1b\][^\x07]*\x07`). The raw ANSI data is preserved in the `TimelineItem` for Terminal mode.

---

### E-5: Offline Mode -- Cached Events but No Live Connection

**Scenario**: The user opens the app while disconnected from their development machine. Previously synced session data is available in the local cache, but no live WebSocket connection exists.

**Expected behavior**: The app renders all cached timeline items normally. A persistent banner at the top shows "Offline -- showing cached data. Last updated: [timestamp]". Streaming indicators are not shown. The prompt input is disabled with "Offline -- cannot send messages". Permission action sheets are disabled with "Offline -- cannot respond to permissions".

**Risk**: The user might not realize they are viewing stale data, leading to confusion about session state.

**Mitigation**: The offline banner is prominent (amber background, full width) and non-dismissible. All real-time features (streaming, permissions, input) are clearly disabled with explanatory text. Cached timestamps are shown in relative format ("2 hours ago") to make staleness obvious.

---

### E-6: Low Memory Device -- Aggressive Component Recycling

**Scenario**: The app runs on a device with 2GB RAM (low-end Android phone). A session with 500+ events exceeds available memory if all components are kept in memory.

**Expected behavior**: The `FlashList` aggressively recycles off-screen components. Only ~20 visible items plus a 10-item buffer above and below are kept in memory. Tool call cards with expanded content are collapsed when scrolled off-screen and re-expanded when scrolled back (expansion state is stored in a lightweight state map, not in the component tree).

**Risk**: Memory warnings from the OS terminate the app.

**Mitigation**: `FlashList` with `estimatedItemSize` set per item type. Memory monitoring via `PerformanceObserver` API. When memory pressure is detected (iOS: `didReceiveMemoryWarning`, Android: `onTrimMemory`), reduce the buffer window from 10 to 3 items and force-collapse all off-screen tool cards. Syntax highlighting is disabled under memory pressure (plain text fallback).

---

### E-7: RTL Language in Prompts/Responses

**Scenario**: The user's prompts or Claude's responses contain Arabic, Hebrew, or other RTL (right-to-left) languages.

**Expected behavior**: Text direction is detected per paragraph using the first strong character algorithm (Unicode Bidirectional Algorithm). RTL paragraphs are rendered right-to-left. Mixed content (RTL + LTR) uses native bidirectional text support. Chat bubble alignment does NOT change (user is always right, Claude is always left) -- only text direction within bubbles changes.

**Risk**: Incorrect text direction makes content unreadable.

**Mitigation**: Use React Native's `writingDirection: 'auto'` style property on all text components. This delegates to the platform's native bidi algorithm. Code blocks always render LTR regardless of surrounding text direction.

---

### E-8: Very Wide Code Lines (200+ Characters)

**Scenario**: A code block or diff contains lines exceeding 200 characters (e.g., minified JavaScript, long SQL queries, data URIs).

**Expected behavior**: Long lines do NOT wrap. The code block or diff enables horizontal scrolling. A subtle shadow or fade effect at the right edge indicates more content is available. The horizontal scroll is independent of the vertical timeline scroll (two-axis scrolling).

**Risk**: Line wrapping in code blocks destroys readability and indentation structure.

**Mitigation**: Code blocks and diff viewers use `ScrollView` with `horizontal={true}` wrapping the content. `flexWrap: 'nowrap'` and `whiteSpace: 'pre'` prevent wrapping. A `LinearGradient` fade at the right edge (16px wide, from transparent to background color) indicates overflow.

---

### E-9: Mixed Content -- Markdown with Embedded Code Blocks with Embedded Diffs

**Scenario**: Claude's response contains markdown text, within which there are fenced code blocks, and within the text there are references to diffs. The markdown parser needs to correctly identify and render each content type.

**Expected behavior**: The markdown renderer processes content in a single pass, producing a tree of nodes: paragraph, heading, list, code block, inline code, etc. Code blocks within markdown are rendered using the `<CodeBlock>` component with syntax highlighting. If a code block contains diff content (detected by `diff` or `patch` language identifier, or by the presence of `---`/`+++`/`@@` patterns), it renders using the `<DiffViewer>` component instead.

**Risk**: Nested content types confuse the parser, producing garbled output.

**Mitigation**: The markdown parser (`react-native-markdown-display` or custom) produces an AST. A post-processing pass walks the AST and replaces code block nodes with the appropriate renderer based on the language identifier. Nesting depth is limited to 3 levels (markdown > code block > diff) -- deeper nesting falls back to plain text.

---

### E-10: Screen Reader / VoiceOver Navigation Through Tool Call Cards

**Scenario**: A visually impaired user navigates the session timeline using VoiceOver (iOS) or TalkBack (Android).

**Expected behavior**: Each timeline item is an accessible group (`accessibilityRole: 'summary'` or `'group'`). The screen reader announces the item type, key content, and status. Collapsed tool cards announce their summary; expanding a card announces the expanded content. Action buttons (Allow/Deny, Copy, Expand) have explicit `accessibilityLabel` values. The screen reader can navigate between items using swipe gestures (VoiceOver: left/right swipe) without getting trapped inside a single card.

**Risk**: Without proper accessibility, the app is unusable for screen reader users. Virtualized lists can trap focus or lose focus position.

**Mitigation**: Every component specifies `accessibilityLabel`, `accessibilityHint`, and `accessibilityRole` as detailed in the component specifications above. `FlashList` items use `accessibilityElementsHidden` for off-screen items to prevent the screen reader from announcing recycled content. Focus management: when a new permission request arrives, announce it immediately via `AccessibilityInfo.announceForAccessibility()`.

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | Event normalization: GC `SessionStarted` event produces `SystemNotification` with correct fields |
| T-2 | Event normalization: GC `ToolCallRequested` + `ToolCallCompleted` correlate into single `ToolCall` item |
| T-3 | Event normalization: SDK streaming events produce correctly-sequenced `AssistantMessage` updates |
| T-4 | Event normalization: Unknown event type produces `SystemNotification` fallback, does not crash |
| T-5 | Diff parser: Correctly parses unified diff into `DiffHunk[]` with line numbers |
| T-6 | Diff parser: Handles binary file detection (null bytes, known extensions) |
| T-7 | Diff parser: Handles empty diff (no changes) |
| T-8 | Language detection: File extension `.ts` maps to `typescript` |
| T-9 | Language detection: Unknown extension falls back to `plaintext` |
| T-10 | Theme: All `ThemeColors` keys are present in both dark and light themes |
| T-11 | Theme: Syntax theme colors are distinct (no duplicate values that would make code unreadable) |
| T-12 | Search: Full-text search matches across `UserMessage.text` and `AssistantMessage.text` |
| T-13 | Search: Filter by event type correctly narrows results |
| T-14 | Search: Case-insensitive search matches regardless of case |
| T-15 | Badges: Badge count increments on new event, decrements on session view |
| T-16 | Badges: Counts > 99 display as "99+" |
| T-17 | Streaming: Buffer holds partial tokens until completed |
| T-18 | Streaming: Code block content is buffered until closing fence |
| T-19 | Scrubber: Tick positions correctly map to timeline item indices |
| T-20 | Scrubber: Snap-to-tick activates within 8px threshold |
| T-21 | Layout: `getDeviceClass()` returns correct class for all breakpoints |
| T-22 | Layout: Phone layout renders at 375px width |
| T-23 | Layout: Tablet layout renders at 1024px width |
| T-24 | Layout: Desktop layout renders at 1440px width |

### Integration Tests

| Test | Description |
|------|-------------|
| T-25 | Full pipeline: GC JSONL events normalize, render as structured timeline, scrollable with FlashList |
| T-26 | Full pipeline: SDK streaming events produce real-time text streaming with cursor |
| T-27 | Permission flow: Permission request appears as action sheet, allow resolves it, card updates to "Allowed" |
| T-28 | Permission flow: Multiple pending permissions queue correctly, resolving one reveals next |
| T-29 | Search flow: Type query, results appear, tap result, timeline scrolls to matched item |
| T-30 | Dual view: Toggle from structured to terminal, xterm.js WebView loads, PTY data renders |
| T-31 | Dual view: Toggle for observed session shows terminal as disabled with explanation |
| T-32 | Theme toggle: Switching from dark to light updates all component colors correctly |
| T-33 | Responsive: Resize window from 1440px to 375px, layout transitions from 3-panel to 2-panel to 1-panel |
| T-34 | Offline: Disconnect WebSocket, verify offline banner appears, verify cached data still renders |
| T-35 | Diff viewer: Edit tool call renders unified diff with syntax highlighting and correct line numbers |
| T-36 | Diff viewer: Swipe gesture toggles side-by-side mode on tablet-width screen |
| T-37 | Streaming performance: 5000-word response streams at 60fps on test device |
| T-38 | Prompt input: Submit a prompt, verify it appears in the timeline as a UserMessage |
| T-39 | Prompt input: Arrow-up navigates through prompt history |
| T-40 | Notification badges: New events increment badge, viewing session clears badge |

### Manual Verification

| Test | Description |
|------|-------------|
| M-1 | Visual inspection of all tool call card types (Read, Edit, Write, Bash, Glob, Grep, WebFetch, Task) against CLI equivalents |
| M-2 | Stream a 2000-word Claude response on phone, verify smooth animation without frame drops |
| M-3 | Render a complex diff (100+ changed lines) with syntax highlighting, verify color correctness |
| M-4 | Open xterm.js terminal widget, run `vim`, verify cursor movement and alternate screen buffer work |
| M-5 | Navigate 500-event session using scrubber bar, verify snap-to-event and tooltip behavior |
| M-6 | Test VoiceOver (iOS) or TalkBack (Android) navigation through a 20-event session timeline |
| M-7 | Verify permission action sheet haptic feedback on physical device |
| M-8 | Test push notification for backgrounded permission request on physical device |
| M-9 | Verify RTL text rendering in Arabic or Hebrew prompts |
| M-10 | Test pinch-to-zoom on terminal widget, verify font size changes |
| M-11 | Test horizontal scroll on 200-char code line in diff viewer |
| M-12 | Verify nested Task tool call renders subagent timeline correctly to 3 levels deep |

---

## Definition of Done

- [ ] `TimelineItem` type system is fully implemented with all variants (UserMessage, AssistantMessage, ThinkingBlock, ToolCall variants, PermissionRequest, PermissionResolved, ErrorItem, SystemNotification, CompactNotification, UsageUpdate)
- [ ] Event normalization layer converts all 10 GC event types and all SDK streaming event types to `TimelineItem[]`
- [ ] Every CLI visual element from the F13 spec has a corresponding React Native component with defined props, layout, and accessibility
- [ ] Streaming text renderer achieves 60fps on mid-range phones with word-by-word display and cursor animation
- [ ] Diff viewer renders unified diffs with syntax highlighting, line numbers, and collapse/expand for long unchanged sections
- [ ] Terminal emulator widget renders PTY output via xterm.js in WebView with ANSI color support
- [ ] Dual view mode toggles between structured and terminal views with correct availability per session type
- [ ] Syntax highlighting supports top 20 languages with lazy grammar loading
- [ ] Prompt input component supports multiline, history, markdown preview, attachments, and keyboard shortcuts
- [ ] Permission action sheet presents native bottom sheet with allow/deny/always buttons and haptic feedback
- [ ] Session search provides full-text search with filters and result navigation
- [ ] Session scrubber enables timeline navigation with tick marks, snap-to-event, and minimap
- [ ] Responsive layout adapts correctly to phone, tablet, and desktop breakpoints
- [ ] Dark and light themes are fully specified and togglable with system preference detection
- [ ] Notification badges show per-session unread counts with type-based color coding
- [ ] All 10 edge cases have documented mitigation strategies with implementation guidance
- [ ] All 24 unit tests, 16 integration tests, and 12 manual verification tests pass
- [ ] Screen reader navigation works through the full session timeline on both iOS (VoiceOver) and Android (TalkBack)
