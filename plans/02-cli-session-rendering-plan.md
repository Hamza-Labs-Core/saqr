# Implementation Plan: Story 02 -- CLI Session Rendering on Mobile & Desktop

**Date**: 2026-02-22
**Story**: 08-cli-session-rendering
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (90-130 hours)
**Prerequisites**: Expo/React Native project scaffolded (Story 01), GC event store operational (Stories 01-05), WebSocket sync layer functional (Story 06/09).
**Product Spec**: F13 (CLI Session Rendering) -- all sub-features F13.1 through F13.14.

### Relationship to Other Stories

This is the **foundational UI story**. It produces the complete component library and rendering infrastructure that all other UI stories consume:

- **Story 01** (Event Capture): GC JSONL events are the primary input to the Event Normalization Layer (Task 1)
- **Story 06/09** (Sync/Transport): WebSocket delivers real-time events and SDK stream chunks to the rendering engine
- **Story 01** (Mobile App Shell): Provides the Expo/React Native project scaffold where all components live
- **Story 04** (Session Timeline/List, F14): Consumes `TimelineItem[]` and the component registry defined here
- **Story 05** (Agent Cards, F15): Uses `TimelineItem` types and tool call card components from here
- **Story 06** (Desktop App, F18): Uses the same component library via Tauri WebView rendering

### Amendment Impacts on This Plan

No design amendments modify this story. The `TimelineItem` type system and component registry are net-new UI work with no conflicts against the existing CQRS write-side amendments.

---

## Task Dependency Graph

```
Task 1: Theme System & Design Tokens
  |
  +---> Task 2: TimelineItem Type System & Event Normalization Layer
  |       |
  |       +---> Task 3: Core Timeline Components (User/Assistant/System Messages)
  |       |       |
  |       |       +---> Task 4: Streaming Text Renderer
  |       |       |
  |       |       +---> Task 5: Tool Call Card Components (all 8 tool types)
  |       |       |       |
  |       |       |       +---> Task 6: Diff Viewer Component
  |       |       |       |
  |       |       |       +---> Task 7: Syntax Highlighting Engine
  |       |       |
  |       |       +---> Task 8: Permission Components (Action Sheet + Auto-Allowed)
  |       |
  |       +---> Task 9: Usage Footer & Model Badge Components
  |
  +---> Task 10: Terminal Emulator Widget (xterm.js in WebView)
  |       |
  |       +---> Task 11: Dual View Mode (Structured vs Terminal)
  |
  +---> Task 12: Prompt Input Component
  |
  +---> Task 13: Search Within Session
  |
  +---> Task 14: Session Scrubber
  |
  +---> Task 15: Notification Badges
  |
  +---> Task 16: Responsive Layout System
  |
  +---> Task 17: Integration Tests & Manual Verification
```

---

## Tasks

### Task 1: Theme System & Design Tokens

**Description**

Create the complete theme system with dark and light mode specifications, design tokens for spacing and typography, and the React context provider that makes the theme available to all components. This is the first task because every subsequent component references `theme.colors.*`, `theme.spacing.*`, and `theme.typography.*`.

**Prerequisites/Inputs**

- Expo/React Native project scaffold (Story 01).
- No runtime dependencies on other tasks.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/theme/types.ts` | Create | TypeScript interfaces for `AppTheme`, `ThemeColors`, `SyntaxTheme`, `ThemeSpacing`, `ThemeTypography` |
| `src/theme/dark.ts` | Create | `DARK_THEME` constant with all color values from Story 02 spec |
| `src/theme/light.ts` | Create | `LIGHT_THEME` constant with all color values from Story 02 spec |
| `src/theme/syntax.ts` | Create | `DARK_SYNTAX_THEME` and `LIGHT_SYNTAX_THEME` constants |
| `src/theme/ThemeProvider.tsx` | Create | React context provider with system preference detection and user override |
| `src/theme/useTheme.ts` | Create | `useTheme()` hook for consuming the theme in components |
| `src/theme/index.ts` | Create | Barrel export for theme module |

**Type Definitions**

```typescript
// src/theme/types.ts
interface AppTheme {
  mode: 'dark' | 'light';
  colors: ThemeColors;
  syntax: SyntaxTheme;
  spacing: ThemeSpacing;
  typography: ThemeTypography;
}

interface ThemeColors {
  background: string;
  surface: string;
  cardBg: string;
  footerBg: string;
  textPrimary: string;
  textSecondary: string;
  muted: string;
  userBubble: string;
  userText: string;
  assistantBubble: string;
  assistantText: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  toolRead: string;
  toolEdit: string;
  toolWrite: string;
  toolBash: string;
  toolSearch: string;
  toolWebFetch: string;
  toolTask: string;
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
  border: string;
  borderActive: string;
}
```

**ThemeProvider Architecture**

```typescript
// src/theme/ThemeProvider.tsx
// Priority: User override (AsyncStorage 'theme_mode') > System preference (Appearance.getColorScheme())
// Exposes: { theme, setThemeMode, toggleTheme }
// Persistence: AsyncStorage key 'theme_mode' with values 'dark' | 'light' | 'system'
```

**Acceptance Criteria**

- [ ] `AppTheme` interface is fully typed with all 40+ color keys from the Story 02 spec
- [ ] `DARK_THEME` constant contains all color values matching the spec (e.g., `background: '#0D1117'`)
- [ ] `LIGHT_THEME` constant contains all color values matching the spec (e.g., `background: '#FFFFFF'`)
- [ ] `ThemeProvider` detects system color scheme via `Appearance.getColorScheme()`
- [ ] User override persists to `AsyncStorage` and takes priority over system preference
- [ ] `useTheme()` hook returns the current `AppTheme` object
- [ ] Theme transitions are instant (no animated color transitions)
- [ ] All `ThemeColors` keys are present in both dark and light themes (compile-time TypeScript check)

**Edge Cases**

- System preference returns `null` on some Android versions: default to dark mode.
- AsyncStorage read fails on first launch: default to system preference, then dark.
- Orientation change should not reset the user's theme override.

**Estimated Complexity**: S (Small) -- ~3-4 hours

---

### Task 2: TimelineItem Type System & Event Normalization Layer

**Description**

Define the complete `TimelineItem` discriminated union type system and implement the normalization functions that convert GC hook events and SDK `AgentStreamEvent` objects into the unified `TimelineItem[]` array. This is the data layer that drives all rendering -- no component can function without it.

The normalization layer handles three concerns:
1. **Type mapping**: Converting source event fields to `TimelineItem` fields.
2. **Correlation**: Merging `ToolCallRequested` + `ToolCallCompleted` into a single `ToolCall` item via `toolUseId`.
3. **Sequencing**: Assigning monotonically increasing `sequence` numbers.

**Prerequisites/Inputs**

- GC event schema from Story 01 (event_type, data fields).
- SDK `AgentStreamEvent` type definitions from the Claude SDK.
- Task 1 completed (theme types are referenced for consistent typing patterns).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/types/timeline.ts` | Create | All `TimelineItem` type definitions (the full discriminated union from Story 02 spec) |
| `src/normalization/normalizeGCEvent.ts` | Create | `normalizeGCEvent(event: GCEvent, existingItems: Map<string, TimelineItem>): TimelineItem[]` |
| `src/normalization/normalizeSDKEvent.ts` | Create | `normalizeSDKEvent(event: AgentStreamEvent, existingItems: Map<string, TimelineItem>): TimelineItem[]` |
| `src/normalization/mergeIntoTimeline.ts` | Create | `mergeIntoTimeline(timeline: TimelineItem[], newItems: TimelineItem[]): TimelineItem[]` |
| `src/normalization/index.ts` | Create | Barrel export |
| `__tests__/normalization/normalizeGCEvent.test.ts` | Create | Unit tests T-1 through T-4 |
| `__tests__/normalization/mergeIntoTimeline.test.ts` | Create | Merge/correlation tests |

**GC Event Mapping Table**

| GC `event_type` | TimelineItem `type` | Key Field Mapping |
|---|---|---|
| `SessionStarted` | `system_notification` (category: `session_start`) | `data.model` -> `metadata.model` |
| `UserPromptReceived` | `user_message` | `data.prompt` -> `text` |
| `ToolCallRequested` | `tool_call` (status: `running`) | `data.tool_name` -> `toolName`, creates tool-specific variant |
| `ToolCallCompleted` | `tool_call` (status: `completed`) | Merges with existing `running` item via `data.tool_use_id` |
| `ToolCallFailed` | `tool_call` (status: `failed`) | Merges with existing `running` item, sets `error` |
| `AgentSpawned` | `system_notification` (category: `agent_spawned`) | Creates nested `ToolCallTask` if correlated |
| `AgentCompleted` | `system_notification` (category: `agent_completed`) | Updates nested timeline in `ToolCallTask` |
| `TurnCompleted` | `assistant_message` (streamingState: `completed`) | `data.response` -> `text` |
| `CompactionTriggered` | `compact_notification` | `data.tokens_before`, `data.tokens_after` |
| `SessionEnded` | `system_notification` (category: `session_end`) | End marker |

**Correlation Logic**

```typescript
function mergeIntoTimeline(
  timeline: TimelineItem[],
  newItems: TimelineItem[]
): TimelineItem[] {
  // For each new item:
  // 1. If it has a toolUseId and an existing item with the same toolUseId exists:
  //    a. Merge fields (status, output, durationMs, error)
  //    b. Replace the existing item in-place (preserve sequence/position)
  // 2. Otherwise: append to the timeline
  // 3. Sort by sequence number
}
```

**Unknown Event Handling**

Events with unrecognized `event_type` produce a `SystemNotification` with:
- `category: 'session_start'` (neutral category)
- `message: 'Unknown event: ${event_type}'`
- `metadata: { rawEvent: event }` (preserve full event for debugging)

This prevents crashes on forward-incompatible events.

**Acceptance Criteria**

- [ ] All 10 GC event types map to a corresponding `TimelineItem` variant (T-1)
- [ ] `ToolCallRequested` + `ToolCallCompleted` are correlated via `toolUseId` into a single `ToolCall` item (T-2)
- [ ] SDK streaming events produce correctly-sequenced `AssistantMessage` updates (T-3)
- [ ] Unknown event types produce a `SystemNotification` fallback, do not crash (T-4)
- [ ] Tool calls use a sub-discriminated union based on `toolName` (Read, Edit, Write, Bash, Glob, Grep, WebFetch, Task)
- [ ] Streaming state transitions are correctly represented (`streaming` -> `completed` | `interrupted`)
- [ ] The `normalizeGCEvent` and `normalizeSDKEvent` functions are pure (no side effects, deterministic)
- [ ] Nested timelines for `ToolCallTask` items are recursively normalized
- [ ] Sequence numbers are monotonically increasing within a session

**Edge Cases**

- `ToolCallCompleted` arrives before `ToolCallRequested` (out-of-order events): create a synthetic `running` item and immediately transition it to `completed`.
- `ToolCallCompleted` with no matching `ToolCallRequested`: create a standalone `completed` tool call item.
- Multiple events in a single batch all referencing the same `toolUseId`: process in sequence order.
- `AgentSpawned` without a corresponding `ToolCallTask`: create the `SystemNotification` without nesting.

**Estimated Complexity**: L (Large) -- ~8-10 hours

---

### Task 3: Core Timeline Components (User/Assistant/System Messages)

**Description**

Implement the React Native components for the three message-type timeline items: `UserMessageBubble`, `AssistantMessageBubble` (completed/non-streaming state), and system notification inline items (`SystemNotificationInline`, `CompactNotificationCard`, `ErrorCard`). These components form the basic chat-style view that all sessions display.

**Prerequisites/Inputs**

- Task 1 (theme system) -- for `theme.colors.*` references.
- Task 2 (type system) -- for `TimelineItem` prop types.
- `react-native-markdown-display` or equivalent markdown rendering library.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/timeline/UserMessageBubble.tsx` | Create | User prompt chat bubble (right-aligned, monospace, truncation at 10 lines) |
| `src/components/timeline/AssistantMessageBubble.tsx` | Create | Claude response bubble (left-aligned, markdown rendering, model badge) |
| `src/components/timeline/ThinkingBlockCard.tsx` | Create | Collapsible thinking/reasoning card with pulse animation |
| `src/components/timeline/SystemNotificationInline.tsx` | Create | Centered muted notification (session start/end, model change, etc.) |
| `src/components/timeline/CompactNotificationCard.tsx` | Create | Context compaction notification with token delta |
| `src/components/timeline/ErrorCard.tsx` | Create | Error display with red border, collapsible stack trace |
| `src/components/timeline/TimelineItemRenderer.tsx` | Create | Switch/registry component that dispatches to the correct component based on `item.type` |
| `src/components/common/ModelBadge.tsx` | Create | Reusable model pill badge (Opus=purple, Sonnet=blue, Haiku=green) |
| `src/components/common/CodeBlock.tsx` | Create | Reusable code block with language badge, copy button, line numbers, horizontal scroll |
| `src/components/common/MarkdownTable.tsx` | Create | Native table rendering with horizontal scroll |
| `src/components/common/ImageOutput.tsx` | Create | Image with pinch-to-zoom and fullscreen tap |

**Component Specifications (from Story 02)**

`UserMessageBubble`:
- Right-aligned, max width 85% of screen
- Background: `theme.colors.userBubble`
- Font: Monospace (JetBrains Mono / SF Mono), 14px
- Border radius: 16px (top-left, top-right, bottom-left), 4px (bottom-right)
- Truncation: Lines > 10 collapse with "Show more"
- Timestamp below bubble, right-aligned
- Attachment chips below text
- Minimum touch target 44x44pt
- Screen reader label: "Your message: [first 100 chars]. Sent at [time]."

`AssistantMessageBubble`:
- Left-aligned, max width 90% of screen
- Background: `theme.colors.assistantBubble`
- Font: System font (SF Pro / Roboto), 15px
- Full markdown rendering (headers, bold, italic, lists, links, code blocks, tables)
- Model badge above message (small pill with model color)
- Screen reader label: "Claude's response: [first 200 chars]. [Streaming/Complete]. Model: [model name]."

`ThinkingBlockCard`:
- Full width with 16px margin
- Collapsed by default (48px header)
- Brain icon + "Thinking..." header with pulse animation during streaming
- Expand/collapse via `Animated.spring` (damping: 15, stiffness: 150)
- Duration badge on completion (e.g., "12.3s")
- Max expanded height 500px, then internal scroll

`ErrorCard`:
- 2px left border, red (`#EF4444`)
- Error source badge pill: Agent / Tool / System / Network
- Collapsible stack trace in monospace
- Copy button top-right

`TimelineItemRenderer` (Component Registry):
```typescript
function TimelineItemRenderer({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case 'user_message':       return <UserMessageBubble item={item} />;
    case 'assistant_message':  return <AssistantMessageBubble item={item} />;
    case 'thinking_block':     return <ThinkingBlockCard item={item} />;
    case 'tool_call':          return <ToolCallCard item={item} />;
    case 'permission_request': return <PermissionRequestCard item={item} />;
    case 'permission_resolved':return <PermissionResolvedInline item={item} />;
    case 'error':              return <ErrorCard item={item} />;
    case 'system_notification':return <SystemNotificationInline item={item} />;
    case 'compact_notification':return <CompactNotificationCard item={item} />;
    case 'usage_update':       return null; // Rendered by UsageFooter, not inline
  }
}
```

**Acceptance Criteria**

- [ ] `UserMessageBubble` renders right-aligned with monospace font, truncation, and timestamp
- [ ] `AssistantMessageBubble` renders left-aligned with full markdown (headers, bold, italic, lists, code blocks, tables)
- [ ] `ThinkingBlockCard` collapses/expands with spring animation, shows duration badge
- [ ] `ErrorCard` shows red border, error message, collapsible stack trace, source badge, and copy button
- [ ] `SystemNotificationInline` renders centered muted text with appropriate icon per category
- [ ] `CompactNotificationCard` shows token delta (before -> after) with scissors icon
- [ ] `TimelineItemRenderer` dispatches to the correct component for all 10 item types
- [ ] `ModelBadge` shows correct color per model family (Opus=purple, Sonnet=blue, Haiku=green)
- [ ] `CodeBlock` renders with language badge, copy button, line numbers, and horizontal scroll
- [ ] All components use `theme.colors.*` references (no hardcoded colors)
- [ ] All interactive elements have minimum 44x44pt touch targets
- [ ] All components have `accessibilityLabel` and `accessibilityRole` defined

**Edge Cases**

- User prompt with 0 characters (empty string after trimming): render a minimal bubble with "(empty prompt)" in muted text.
- Assistant response with deeply nested markdown (e.g., list inside blockquote inside list): cap nesting depth at 6 levels, render deeper content as plain text.
- Error with no stack trace (`stackTrace: null`): hide the expand button, show only the error message.
- System notification with unknown category: render with a generic info icon.

**Estimated Complexity**: L (Large) -- ~10-12 hours

---

### Task 4: Streaming Text Renderer

**Description**

Implement the real-time streaming text renderer that displays Claude's responses word-by-word as WebSocket chunks arrive. This is a performance-critical component that must maintain 60fps on mid-range phones while incrementally parsing markdown.

**Prerequisites/Inputs**

- Task 3 (`AssistantMessageBubble` component as the container).
- Task 1 (theme).
- WebSocket event delivery from Story 06/09.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/streaming/StreamingTextRenderer.tsx` | Create | Core streaming component with buffer management and incremental markdown |
| `src/components/streaming/useStreamBuffer.ts` | Create | Custom hook for chunk buffering and frame-rate-limited flushing |
| `src/components/streaming/CursorAnimation.tsx` | Create | Blinking cursor component with fade-out on stream end |
| `src/components/streaming/incrementalMarkdown.ts` | Create | Incremental markdown parser that appends new AST nodes |
| `__tests__/streaming/useStreamBuffer.test.ts` | Create | Tests T-17, T-18 (partial token, code block buffering) |

**Buffer Management Architecture**

```typescript
interface StreamBuffer {
  pending: string;         // Accumulated but not yet rendered text
  renderedText: string;    // Text committed to the view
  inCodeBlock: boolean;    // Whether we're inside an unclosed code fence
  inTable: boolean;        // Whether we're inside a markdown table
  partialToken: string;    // Word split across chunk boundaries
}

// Hook: useStreamBuffer(config: StreamingRendererConfig)
// Returns: { renderedText, markdownAST, cursorState, onChunkReceived, onStreamEnd }
// Internally uses requestAnimationFrame to batch renders at 60fps
```

**Render Loop**

1. WebSocket chunk arrives -> append to `pending` buffer.
2. If no `requestAnimationFrame` is scheduled, schedule one.
3. On animation frame:
   a. Move `pending` to `renderedText` (flush).
   b. Check for partial token at end (not whitespace/punctuation) -- hold it back in `partialToken`.
   c. Check for unclosed code fence -- hold entire block in buffer until fence closes.
   d. Incrementally parse the new text into markdown AST nodes.
   e. If more text accumulated during parse, schedule another frame.
   f. Trigger React re-render with updated AST.
4. On stream end: flush all buffers, run full markdown parse for correctness, start cursor fade-out.

**Cursor Animation States**

| State | Visual |
|---|---|
| Streaming (chunks arriving) | Solid `\|` cursor after last character |
| Paused (> 500ms gap) | Blinking `\|` at 500ms interval |
| Stream ended | Blink 3 times, then fade out over 200ms |

**Performance Targets**

| Metric | Target |
|---|---|
| Frame rate during streaming | 60fps (16.67ms frame budget) |
| Chunk-to-render latency | < 16ms |
| Memory growth during 10K-word stream | < 5MB |
| Markdown parse time per frame | < 8ms (half frame budget) |

**Acceptance Criteria**

- [ ] Text appears word-by-word (not character-by-character) at 60fps
- [ ] Cursor is visible at the end of streaming text (solid during active streaming)
- [ ] Cursor blinks when streaming is paused (> 500ms gap between chunks)
- [ ] Cursor blinks 3 times and fades out when stream completes
- [ ] Markdown is parsed incrementally during streaming (headers, bold, italic, lists render in real-time)
- [ ] Code blocks are buffered until the closing fence arrives before rendering (T-18)
- [ ] Partial tokens (words split across chunks) are held until completed (T-17)
- [ ] Performance: 60fps maintained on a mid-range phone (Pixel 6a, iPhone SE 3rd gen)
- [ ] A 10,000-word response streams without memory issues or frame drops (T-37)
- [ ] Buffer is fully flushed and a final full markdown parse runs on stream completion

**Edge Cases**

- Chunk arrives with 0 bytes: ignore silently, do not schedule a frame.
- Chunk arrives with 50KB+ (burst after network pause): split into sub-chunks for incremental rendering, process across multiple frames.
- Stream interrupted (WebSocket close without `message_stop`): set `streamingState: 'interrupted'`, stop cursor, show "Stream interrupted" indicator.
- Markdown table split across chunks: buffer until the table is complete (detected by a line not starting with `|` after a `|`-prefixed line).

**Estimated Complexity**: L (Large) -- ~8-10 hours

---

### Task 5: Tool Call Card Components (All 8 Tool Types)

**Description**

Implement the generic `ToolCallCard` wrapper and all 8 tool-specific content components. Each tool call renders as a card with a consistent header (icon + name + status badge + duration) and tool-specific expanded content.

**Prerequisites/Inputs**

- Task 2 (ToolCall type variants).
- Task 3 (`TimelineItemRenderer` dispatches `tool_call` items here).
- Task 1 (theme -- tool-specific accent colors).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/tools/ToolCallCard.tsx` | Create | Generic wrapper: icon + name + path + status badge + duration + expand/collapse |
| `src/components/tools/ToolCallReadContent.tsx` | Create | File icon + path + syntax-highlighted content with line numbers |
| `src/components/tools/ToolCallEditContent.tsx` | Create | Edit icon + path + change summary + diff viewer (delegates to Task 6) |
| `src/components/tools/ToolCallWriteContent.tsx` | Create | Create icon + path + file size + syntax-highlighted content |
| `src/components/tools/ToolCallBashContent.tsx` | Create | Terminal icon + command + output in monospace, exit code badge, stderr in red |
| `src/components/tools/ToolCallSearchContent.tsx` | Create | Search icon + pattern + collapsible file tree (handles both Glob and Grep) |
| `src/components/tools/ToolCallWebFetchContent.tsx` | Create | Globe icon + URL + summary + status code badge |
| `src/components/tools/ToolCallTaskContent.tsx` | Create | Agent icon + prompt + result + nested timeline (recursive, max 3 levels) |
| `src/components/tools/toolIconMap.ts` | Create | Tool name -> Lucide icon name + color mapping |
| `__tests__/components/ToolCallCard.test.tsx` | Create | Snapshot tests for all 8 tool types |

**Generic ToolCallCard Structure**

```
+--[icon]-- ToolName: filepath/command -------- [status badge] [duration] --+
|                                                                           |
|  [Tool-specific content]                                                  |
|                                                                           |
+-- left border (color = status: blue/green/red) --------------------------+
```

| Element | Detail |
|---|---|
| Left border | 1px, blue (running), green (completed), red (failed) |
| Default state | Collapsed for completed, expanded for running or failed |
| Border radius | 8px |
| Shadow | `elevation: 2` (Android), `shadowOffset: {0, 1}` (iOS) |
| Header touch target | Full header row, minimum 48px height |

**Tool Icon Mapping**

| toolName | Icon (Lucide) | Color |
|---|---|---|
| Read | `file-text` | `#60A5FA` (blue) |
| Edit | `file-edit` | `#FBBF24` (amber) |
| Write | `file-plus` | `#34D399` (green) |
| Bash | `terminal` | `#A78BFA` (purple) |
| Glob | `search` | `#F472B6` (pink) |
| Grep | `search-code` | `#F472B6` (pink) |
| WebFetch | `globe` | `#38BDF8` (cyan) |
| Task | `git-branch` | `#FB923C` (orange) |

**ToolCallBashContent specifics**:
- Command display: full command in monospace, dark background (`#0D1117`), `$` prefix.
- Output truncation: > 50 lines collapsed with "Show all (N lines)" expander.
- Basic ANSI color rendering (16-color) in structured view. Full ANSI in terminal view.
- Exit code badge: green for 0, red for non-zero.
- Stderr shown in orange/red text below stdout if present.
- Long press on command: copy to clipboard.

**ToolCallTaskContent specifics**:
- Nested timeline rendering: recursively renders the subagent's `TimelineItem[]`.
- Nesting visual: indented by 16px, left border in `theme.colors.taskNesting`.
- Max nesting depth: 3 levels. Deeper nesting shows "View in separate timeline" link.
- Default state: nested timeline collapsed, showing only prompt + result.

**Acceptance Criteria**

- [ ] `ToolCallCard` renders consistent header with icon, tool name, file path/command, status badge, and duration
- [ ] All 8 tool-specific content components render correctly for their tool type
- [ ] Status badge colors: blue (running), green (completed), red (failed) with label text
- [ ] Collapsed by default for completed tool calls, expanded for running or failed
- [ ] `ToolCallBashContent` truncates output at 50 lines with expander
- [ ] `ToolCallBashContent` shows exit code badge with correct color
- [ ] `ToolCallSearchContent` renders collapsible file tree with match counts
- [ ] `ToolCallTaskContent` renders nested timeline recursively up to 3 levels
- [ ] All tool cards have screen reader labels following the pattern from spec
- [ ] Long press on Bash command copies to clipboard

**Edge Cases**

- Tool call with `output: null` (still running or crashed before output): show a loading skeleton or "Awaiting result..." placeholder.
- Bash command with 10,000+ lines of output: virtualize the output container with `FlashList` for the line items.
- Task tool with empty nested timeline: show "No subagent activity recorded."
- Glob/Grep with 500+ matches: show first 20 files with "Show N more files" expander.
- Tool call with very long file path: truncate middle of path with ellipsis, show full path on expand.

**Estimated Complexity**: L (Large) -- ~10-12 hours

---

### Task 6: Diff Viewer Component

**Description**

Implement the unified diff viewer that renders file changes with syntax highlighting, line numbers, red/green backgrounds for added/removed lines, and side-by-side mode on tablets.

**Prerequisites/Inputs**

- Task 5 (`ToolCallEditContent` delegates diff rendering here).
- Task 7 (syntax highlighting engine -- can be developed in parallel, with a plain-text fallback initially).
- Task 1 (theme -- `diffAddedBg`, `diffRemovedBg` colors).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/diff/DiffViewer.tsx` | Create | Main diff viewer component with unified and side-by-side modes |
| `src/components/diff/DiffLine.tsx` | Create | Single diff line component with gutter, background, and syntax highlighting |
| `src/components/diff/parseDiff.ts` | Create | `parseDiff(diffString: string): ParsedDiff` -- unified diff parser |
| `src/components/diff/isBinaryFile.ts` | Create | Binary file detection (null bytes + extension list) |
| `__tests__/diff/parseDiff.test.ts` | Create | Tests T-5, T-6, T-7 (diff parsing, binary detection, empty diff) |

**Diff Parser**

```typescript
interface ParsedDiff {
  oldFile: string;
  newFile: string;
  hunks: DiffHunk[];
  stats: { additions: number; deletions: number; unchanged: number; };
}

interface DiffHunk {
  header: string;           // @@ -start,count +start,count @@
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged' | 'header';
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}
```

**Visual Specification**

| Line type | Background (dark) | Background (light) | Gutter marker |
|---|---|---|---|
| Added | `#1A3A2A` | `#E6FFEC` | `+` |
| Removed | `#3A1A1A` | `#FFE6E6` | `-` |
| Unchanged | Default | Default | Space |
| Hunk header | Muted blue | Muted blue | `@@` |

**Collapse Behavior**

Unchanged sections > 5 lines are collapsed with "Show N more lines" expander. Tapping expands 10 lines at a time or all remaining lines.

**Side-by-Side Mode**

- Available on tablets (width >= 768px).
- Toggle via swipe gesture or explicit button.
- Transition: 300ms slide animation.
- Left panel: old file. Right panel: new file.
- Each panel has its own line number gutter.

**Binary File Detection**

```typescript
function isBinaryFile(filePath: string, content: string): boolean {
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.pdf',
    '.zip', '.tar', '.gz', '.wasm', '.o', '.so', '.dylib',
    '.exe', '.dll', '.class'
  ]);
  const ext = path.extname(filePath).toLowerCase();
  if (binaryExtensions.has(ext)) return true;
  // Check first 512 bytes for null bytes
  return content.slice(0, 512).includes('\0');
}
```

Binary files display: `[Binary file changed -- cannot display diff]` with old/new file sizes.

**Acceptance Criteria**

- [ ] Unified diff format is correctly parsed into `DiffHunk[]` and `DiffLine[]` structures (T-5)
- [ ] Added lines render with green background, removed lines with red background
- [ ] Line numbers are displayed for both old and new file in dual gutters
- [ ] Syntax highlighting is applied within diff lines based on file extension
- [ ] Unchanged sections > 5 lines are collapsed with "Show N more lines" expander
- [ ] Side-by-side mode is available on tablets (width >= 768px) and toggled via swipe
- [ ] Side-by-side transition animates smoothly (300ms)
- [ ] Binary files show a placeholder instead of attempting to render diff content (T-6)
- [ ] Diff stats (additions, deletions) are shown in the header
- [ ] Long lines (> screen width) scroll horizontally within the diff viewer
- [ ] Empty diff (no changes) is handled gracefully (T-7) -- shows "No changes"

**Edge Cases**

- Diff with only additions (new file): all lines green, no old line numbers.
- Diff with only deletions (file removed): all lines red, no new line numbers.
- Diff with 1000+ changed lines: use `FlashList` for virtualized rendering of diff lines.
- Malformed diff string (missing `@@` header): show raw text with a warning "Could not parse diff."
- Diff where old/new strings are identical: show "No changes detected."

**Estimated Complexity**: M (Medium) -- ~6-8 hours

---

### Task 7: Syntax Highlighting Engine

**Description**

Implement the syntax highlighting engine with language detection from file extensions, lazy grammar loading, and dark/light theme support. On React Native, use `highlight.js`; on desktop/web (Tauri), use `Shiki`.

**Prerequisites/Inputs**

- Task 1 (syntax theme colors).
- `highlight.js` npm package (for React Native).
- `shiki` npm package (for desktop/web builds).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/highlighting/languageDetection.ts` | Create | `detectLanguage(filePath: string): string` -- extension-to-language mapping (40+ mappings from spec) |
| `src/highlighting/HighlightManager.ts` | Create | Async highlight manager with lazy loading and caching |
| `src/highlighting/highlightjs.ts` | Create | React Native adapter using `highlight.js` |
| `src/highlighting/shiki.ts` | Create | Desktop/web adapter using `Shiki` (WASM-based) |
| `src/highlighting/index.ts` | Create | Platform-aware barrel export |
| `__tests__/highlighting/languageDetection.test.ts` | Create | Tests T-8, T-9 (extension mapping, fallback) |

**Language Detection Mapping**

The full 40+ extension mapping from the Story 02 spec (`.js`->`javascript`, `.ts`->`typescript`, `.py`->`python`, `.sh`->`bash`, `.json`->`json`, etc.). Fenced code blocks in markdown use the language identifier directly.

**HighlightManager Interface**

```typescript
interface HighlightManager {
  loadedLanguages: Set<string>;
  loadLanguage(language: string): Promise<void>;
  highlight(code: string, language: string): Promise<HighlightedCode>;
}

interface HighlightedCode {
  tokens: HighlightToken[];
  language: string;  // Actual language used (may differ if fallback)
}

interface HighlightToken {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}
```

**Bundle Strategy**

- **Initial bundle**: JavaScript, TypeScript, Python, Bash, JSON (top 5).
- **Lazy-loaded**: All other languages loaded on first use, cached in memory.
- Grammar files are loaded from bundled assets (not network) to avoid latency.

**Performance Constraints**

- Highlighting must not block the main thread.
- Parse time target: < 50ms for files under 1000 lines.
- For files > 1000 lines: process in 500-line chunks across multiple animation frames.

**Acceptance Criteria**

- [ ] Code blocks detect language from file extension or markdown fence identifier (T-8)
- [ ] Top 5 languages (JS, TS, Python, Bash, JSON) are available without additional loading
- [ ] Other languages are lazy-loaded on first use and cached (T-9 fallback for unknown)
- [ ] Dark and light syntax themes are fully specified with distinct colors for all token types
- [ ] Highlighting gracefully falls back to plain text if language detection fails
- [ ] Highlighting does not block the main thread (< 50ms parse time for < 1000 lines)
- [ ] Syntax highlighting applies within diff viewer lines (not just standalone code blocks)
- [ ] The highlighting engine is `highlight.js` on React Native and `Shiki` on desktop/web

**Edge Cases**

- File with no extension (e.g., `Makefile`, `Dockerfile`): check filename-based rules (`Makefile` -> `makefile`, `Dockerfile` -> `dockerfile`).
- Very large file (> 5000 lines): highlight only the visible portion, lazily highlight as user scrolls.
- Language grammar fails to load: fall back to plain text, log warning.
- Code with mixed languages (e.g., HTML with embedded JS): use the primary language for the file, do not attempt multi-language highlighting.

**Estimated Complexity**: M (Medium) -- ~6-8 hours

---

### Task 8: Permission Components (Action Sheet + Auto-Allowed)

**Description**

Implement the permission request action sheet (native bottom sheet with Allow/Deny/Always buttons, haptic feedback, push notification integration) and the auto-allowed inline indicator.

**Prerequisites/Inputs**

- Task 2 (`PermissionRequest` and `PermissionResolved` timeline item types).
- Task 1 (theme -- `permissionBg`, `warning` colors).
- `@gorhom/bottom-sheet` or platform-native bottom sheet library.
- `expo-haptics` for haptic feedback.
- `expo-notifications` for push notification triggers.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/permissions/PermissionActionSheet.tsx` | Create | Native bottom sheet with 3 action buttons, haptic feedback, countdown timer |
| `src/components/permissions/PermissionRequestCard.tsx` | Create | Inline timeline card for permission requests (used in structured view) |
| `src/components/permissions/PermissionResolvedInline.tsx` | Create | Subtle auto-allowed inline indicator (collapsed by default) |
| `src/components/permissions/PermissionQueue.tsx` | Create | Manages queue of pending permissions, shows "[N of M]" indicator |
| `src/components/permissions/usePermissionNotification.ts` | Create | Hook to trigger push notification when app is backgrounded with pending permission |
| `__tests__/components/PermissionActionSheet.test.tsx` | Create | Permission flow tests (T-27, T-28) |

**PermissionActionSheet Layout**

```
+------------------------------------------------------+
|  -----  (drag handle)                                |
|                                                      |
|  Warning  Permission Required              [1 of 3]  |
|                                                      |
|  Allow Bash to execute:                              |
|  +--------------------------------------------------+|
|  |  $ rm -rf node_modules && npm install            ||
|  +--------------------------------------------------+|
|                                                      |
|  Working directory: /home/user/project               |
|                                                      |
|  [       Allow        ] (green, #22C55E)             |
|  [       Deny         ] (red, #EF4444)               |
|  [ Always Allow Bash  ] (blue, #3B82F6)              |
|                                                      |
|  Auto-dismiss in 4:32                                |
+------------------------------------------------------+
```

**Haptic Feedback**

| Action | Haptic Type |
|---|---|
| Tap Allow | `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)` |
| Tap Deny | `Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)` |
| Tap Always Allow | `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)` |

**Push Notification Trigger**

```typescript
// usePermissionNotification hook
// When: app transitions to background state (AppState 'inactive' -> 'background')
//   AND a PermissionRequest with resolution 'pending' exists
//   AND app has been backgrounded for >= 3 seconds (debounce)
// Then: schedule local push notification via expo-notifications
// Notification includes actionable buttons: "Allow" / "Deny"
// Resolving via notification sends the action via WebSocket to the agent
```

**Auto-dismiss Timer**

Default: 5 minutes (300,000ms). Configurable via `autoTimeoutMs` prop. Shows countdown `MM:SS` at bottom of sheet. On timeout, permission remains `pending` (does not auto-deny).

**Acceptance Criteria**

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
- [ ] `PermissionResolvedInline` is collapsed by default, shows "Auto-allowed: [tool]" in muted text on expand

**Edge Cases**

- 10+ permissions pending simultaneously: queue processes in order; the "[N of M]" counter updates as each is resolved.
- Permission resolved externally (e.g., user allowed on their machine's CLI): update the card to "Allowed" without user action on mobile.
- App killed while permission pending: on next launch, check for stale pending permissions and update their status from the sync layer.
- Permission for a tool not in the icon map: use a generic settings icon.

**Estimated Complexity**: L (Large) -- ~8-10 hours

---

### Task 9: Usage Footer & Model Badge Components

**Description**

Implement the sticky footer bar that displays model name, token counts, session cost, context window usage, and session timer. The footer has a collapsed (44px) and expanded (200px) state.

**Prerequisites/Inputs**

- Task 2 (`UsageUpdate` timeline item type).
- Task 1 (theme -- `footerBg` color).
- Task 3 (`ModelBadge` component, already created in Task 3).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/footer/UsageFooter.tsx` | Create | Sticky footer with collapsed/expanded states |
| `src/components/footer/ContextWindowRing.tsx` | Create | Circular progress indicator for context window usage |
| `src/components/footer/SessionTimer.tsx` | Create | HH:MM:SS elapsed timer with active/idle/disconnected indicators |
| `src/components/footer/TokenBreakdown.tsx` | Create | Expanded view: input/output/cache read/write token details |

**UsageFooter Layout**

Collapsed (44px): `[SessionTimer] [ModelBadge] [ContextRing] [TokenSummary] [Cost]`
Expanded (200px, on tap): Full breakdown with cost-per-turn chart.

**ContextWindowRing Specification**

- 24px diameter in footer, 48px in expanded view.
- Color gradient: green (`#34D399`) at 0-50%, yellow (`#FBBF24`) at 50-80%, red (`#EF4444`) at 80-100%.
- Smooth 300ms transition animation when usage changes.
- Percentage label centered inside ring (expanded view only).

**SessionTimer Specification**

- HH:MM:SS format, updates every second when active.
- Active: green pulsing dot (2s pulse, 8px diameter).
- Idle: grey static dot.
- Disconnected: red dot with "Disconnected" label.

**Acceptance Criteria**

- [ ] Footer is sticky at the bottom of the session view, above any tab bar
- [ ] Collapsed state shows model badge, token summary, cost, and context ring
- [ ] Expanded state (on tap) shows full token breakdown and cost details
- [ ] `ContextWindowRing` color shifts green -> yellow -> red based on usage percentage
- [ ] `SessionTimer` shows elapsed time and updates every second when active
- [ ] Active indicator: green pulsing dot. Idle: grey dot. Disconnected: red dot + label.
- [ ] Model badge shows correct color per model family
- [ ] Screen reader label follows spec format for usage information

**Edge Cases**

- No `UsageUpdate` events received yet: show "---" placeholders for all values.
- Session cost > $99.99: show full value without truncation (e.g., "$123.45").
- Context window at exactly 100%: show red ring, percentage "100%", no overflow rendering.
- Disconnected state: freeze the timer at last known value, show red dot.

**Estimated Complexity**: M (Medium) -- ~4-6 hours

---

### Task 10: Terminal Emulator Widget (xterm.js in WebView)

**Description**

Implement the embedded terminal emulator that renders raw PTY output inside a React Native WebView using xterm.js. This provides the "Terminal" view mode for managed sessions.

**Prerequisites/Inputs**

- Task 1 (theme -- xterm.js theme colors mapping).
- `react-native-webview` for the WebView container.
- `xterm.js` and `xterm-addon-fit` bundled as a static HTML asset.
- WebSocket PTY data stream from the managed session.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/terminal/TerminalWidget.tsx` | Create | React Native component wrapping WebView with xterm.js |
| `src/components/terminal/TerminalInputBar.tsx` | Create | Virtual keyboard toolbar with special key buttons (Tab, Ctrl, Esc, arrows) |
| `src/components/terminal/terminalBridge.ts` | Create | Bridge protocol: RN <-> WebView message types and handlers |
| `assets/terminal/terminal.html` | Create | Self-contained HTML file with xterm.js, fit addon, and bridge listener |
| `assets/terminal/xterm.min.js` | Create (bundle) | Bundled xterm.js library |
| `assets/terminal/xterm.css` | Create (bundle) | xterm.js styles |

**Architecture**

```
React Native App
  +-- <TerminalWidget>
  |     +-- <WebView source={terminal.html}>
  |     |     +-- xterm.js Terminal instance
  |     |     +-- xterm-addon-fit (auto-resize)
  |     |     +-- postMessage bridge listener
  |     +-- <TerminalInputBar> (above system keyboard)
  |           +-- [Tab] [Ctrl] [Esc] [Up] [Down] [Left] [Right]
```

**Bridge Protocol**

RN -> WebView messages:
```typescript
type RNToWebView =
  | { type: 'write'; data: string }          // PTY data to render
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'setTheme'; theme: XTermTheme }
  | { type: 'clear' }
  | { type: 'scrollToBottom' };
```

WebView -> RN messages:
```typescript
type WebViewToRN =
  | { type: 'input'; data: string }          // User keyboard input
  | { type: 'selection'; text: string }      // Text selection for copy
  | { type: 'titleChange'; title: string }   // Terminal title update
  | { type: 'ready' }                        // xterm.js initialized
  | { type: 'resize'; cols: number; rows: number }; // fit addon resize
```

**ANSI Support**: Full 16-color, 256-color, and truecolor. Bold, italic, underline, strikethrough. Cursor movement (CUU, CUD, CUF, CUB, CUP). Alternate screen buffer (DECSET 1049). Scroll regions (DECSTBM). No mouse tracking (touch replaces it).

**Touch Interactions**

| Gesture | Action |
|---|---|
| Vertical swipe | Scroll through scrollback buffer (max 5,000 lines) |
| Tap | Place cursor for keyboard input |
| Long press | Text selection mode (native handles) |
| Pinch | Zoom font size (10px to 24px) |

**Performance**

- Pre-load WebView HTML in background when session is opened (before user switches to terminal view).
- Batch PTY data into 16ms frames before sending to WebView.
- Scrollback buffer limited to 5,000 lines (configurable).

**Acceptance Criteria**

- [ ] xterm.js renders inside a React Native WebView
- [ ] 16-color, 256-color, and truecolor ANSI sequences render correctly
- [ ] Cursor movement and alternate screen buffer work (e.g., `vim`, `htop` render correctly)
- [ ] Vertical swipe scrolls through scrollback buffer (up to 5,000 lines)
- [ ] Pinch-to-zoom adjusts terminal font size between 10px and 24px
- [ ] Virtual keyboard input bar sends correct escape sequences for special keys
- [ ] WebView bridge messages are batched at 16ms intervals
- [ ] Terminal widget is not available for observed sessions (GC hooks only, no PTY access)
- [ ] Theme changes apply immediately to the terminal
- [ ] Long press activates text selection with native copy support

**Edge Cases**

- WebView fails to load (old Android WebView): show error message "Terminal view requires a modern WebView" with a link to update.
- Bridge message arrives before xterm.js `ready` event: queue messages and replay after `ready`.
- Very rapid PTY output (e.g., `cat large_file.txt`): batch aggressively, skip rendering intermediate states if > 100ms behind.
- User types in virtual keyboard while PTY is producing output: input and output are independent streams, no blocking.

**Estimated Complexity**: L (Large) -- ~8-10 hours

---

### Task 11: Dual View Mode (Structured vs Terminal)

**Description**

Implement the view mode toggle that switches between "Structured" (card-based, parsed events) and "Terminal" (raw PTY via xterm.js) views of a session. The toggle lives in the session header as a segmented control.

**Prerequisites/Inputs**

- Task 10 (terminal widget for Terminal mode).
- Task 3 + Task 5 (timeline components for Structured mode).
- `AsyncStorage` for persisting view mode preference per session.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/session/ViewModeSwitcher.tsx` | Create | Segmented control: "Structured" | "Terminal" |
| `src/components/session/SessionView.tsx` | Create | Container that renders either structured timeline or terminal widget based on mode |
| `src/hooks/useViewMode.ts` | Create | Hook managing view mode state, defaults, and persistence |

**Default View by Device and Session Type**

| Device | Session Type | Default | Terminal Available |
|---|---|---|---|
| Phone | Observed (GC hooks) | Structured | No |
| Phone | Managed (SDK + PTY) | Structured | Yes |
| Tablet | Observed | Structured | No |
| Tablet | Managed | Structured | Yes |
| Desktop (Tauri) | Observed | Structured | No |
| Desktop (Tauri) | Managed | Terminal | Yes |

**View Mode Toggle UI**

- Segmented control in session header.
- Labels: "Structured" | "Terminal".
- "Terminal" is greyed out with "(unavailable)" tooltip for observed sessions.
- Transition: 200ms cross-fade animation.
- Persistence: `AsyncStorage` key `view_mode_${sessionId}`.

**Acceptance Criteria**

- [ ] View mode toggle is visible in the session header (T-30, T-31)
- [ ] Structured view shows card-based rendering for all timeline items
- [ ] Terminal view shows raw PTY output via xterm.js widget
- [ ] Terminal option is disabled (greyed out) for observed sessions
- [ ] Default view matches the device/session type matrix
- [ ] View mode is persisted per session in AsyncStorage
- [ ] Transition between modes animates with a 200ms cross-fade
- [ ] Switching to structured from terminal preserves scroll position
- [ ] Switching to terminal from structured scrolls to the bottom (latest output)

**Edge Cases**

- Managed session that loses PTY connection: show "Terminal disconnected" in terminal mode with a "Switch to Structured" button.
- User switches to terminal mode mid-stream: terminal should catch up to current PTY state (replay buffered data).
- First render of terminal mode: show loading skeleton while WebView initializes.

**Estimated Complexity**: S (Small) -- ~3-4 hours

---

### Task 12: Prompt Input Component

**Description**

Implement the multiline prompt input with auto-grow, markdown preview toggle, prompt history navigation, file attachments, voice input button integration point, and keyboard shortcuts for desktop.

**Prerequisites/Inputs**

- Task 1 (theme).
- `expo-document-picker` for file attachment.
- Session WebSocket for sending prompts (Story 06/09).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/input/PromptInput.tsx` | Create | Main prompt input component with auto-grow, buttons, and attachments |
| `src/components/input/PromptHistory.ts` | Create | `usePromptHistory(sessionId)` hook managing last 50 prompts in AsyncStorage |
| `src/components/input/AttachmentChip.tsx` | Create | Removable file chip showing name + size |
| `src/components/input/MarkdownPreview.tsx` | Create | Rendered markdown preview of the input text |
| `__tests__/components/PromptInput.test.tsx` | Create | Tests T-38, T-39 (submit, history navigation) |

**Layout**

```
+------------------------------------------------------+
| [Attached files chips]                               |
+------------------------------------------------------+
| Multi-line text input (1 to 8 lines auto-grow)      |
|                                                      |
+------+------+--------+------+------------------------+
| [Attach] [Voice] [Preview]  |      [Send]           |
+------+------+--------+------+------------------------+
```

**Behavior**

| Feature | Specification |
|---|---|
| Auto-grow | 1 line -> max 8 lines. Beyond 8, internal scroll. |
| Markdown preview | Toggle between raw text and rendered markdown |
| History | Swipe up (mobile) or Ctrl+Up/Down (desktop) navigates last 50 prompts |
| Voice input | Button opens voice recognition (F6.10 integration point -- not implemented here) |
| File attachment | Opens `expo-document-picker`, shows chips above input |
| Send button | Disabled when empty or agent busy. Shows spinner when processing. |
| Desktop shortcuts | Enter: submit. Shift+Enter: newline. Ctrl+Up/Down: history. |
| Observed sessions | Disabled with "Read-only session. Take over to send prompts." |
| Max length | 100,000 characters |

**Acceptance Criteria**

- [ ] Multiline text input auto-grows from 1 to 8 lines (T-38)
- [ ] Markdown preview toggle renders input as formatted markdown
- [ ] Prompt history navigable via swipe (mobile) or keyboard shortcuts (desktop) (T-39)
- [ ] Last 50 prompts persisted per session in AsyncStorage
- [ ] Voice input button is present (triggers integration point for F6.10)
- [ ] File attachment opens system file picker, shows chips
- [ ] Send button disabled when empty or agent busy
- [ ] Desktop keyboard shortcuts: Enter to send, Shift+Enter for newline
- [ ] Input disabled with explanatory text for observed sessions
- [ ] Loading spinner on send button while agent is processing

**Edge Cases**

- Paste of 100,000+ characters: truncate silently at 100,000 and show a toast "Input truncated to 100,000 characters."
- Attachment of a 100MB+ file: show error "File too large. Maximum: 10MB."
- Rapid Enter key presses: debounce submit at 500ms to prevent double-send.
- Keyboard dismissal on iOS: input area should not jump or overlay content.

**Estimated Complexity**: M (Medium) -- ~5-6 hours

---

### Task 13: Search Within Session

**Description**

Implement full-text search across all events in the current session with filter chips (event type, tool name, file path, date range), result highlighting, and navigation to matched items.

**Prerequisites/Inputs**

- Task 2 (TimelineItem types for search indexing).
- Task 3 (timeline must support scroll-to-item for result navigation).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/search/SessionSearch.tsx` | Create | Search UI: input bar + filters + results list |
| `src/components/search/SearchFilters.tsx` | Create | Filter chips: event type, tool name, file path, date range |
| `src/components/search/SearchResult.tsx` | Create | Single search result: snippet with highlighted match |
| `src/search/searchTimeline.ts` | Create | `searchTimeline(timeline, query, filters): SearchResult[]` -- pure search function |
| `src/search/extractSearchableText.ts` | Create | Extracts all searchable text from a `TimelineItem` |
| `__tests__/search/searchTimeline.test.ts` | Create | Tests T-12, T-13, T-14 (full-text, filter, case-insensitive) |

**Search Behavior**

| Feature | Detail |
|---|---|
| Scope | All text: message text, tool inputs, tool outputs, file paths, error messages |
| Case sensitivity | Case-insensitive by default, toggle for case-sensitive |
| Debounce | 300ms after last keystroke |
| Result limit | First 100, then "Show more" loads next 100 |
| Highlight | Matched text in yellow (`theme.colors.searchHighlight`) |
| Regex | Toggle for regex mode (default: literal) |
| Navigation | Arrow buttons or swipe. Tap result scrolls timeline to item. |
| Desktop shortcut | Ctrl+F / Cmd+F opens search |
| Persistence | Query and filters persist while session is open |
| Real-time | Results update as new events arrive |

**`searchTimeline` Function**

```typescript
function searchTimeline(
  timeline: TimelineItem[],
  query: string,
  filters: SearchFilters
): SearchResult[] {
  // 1. Extract searchable text from each item (extractSearchableText)
  // 2. Apply filters (type, tool, file path regex, date range)
  // 3. Match query against text (literal or regex, case-insensitive by default)
  // 4. For each match: generate snippet (50 chars before + match + 50 chars after)
  // 5. Return sorted by timestamp
}
```

**Acceptance Criteria**

- [ ] Full-text search matches across all timeline item content (T-12)
- [ ] Search results show snippets with highlighted match text
- [ ] Tapping a search result scrolls the timeline to that item (T-29)
- [ ] Filter by event type, tool name, file path, and date range (T-13)
- [ ] Case-insensitive by default with toggle (T-14)
- [ ] Regex mode toggle for pattern-based search
- [ ] 300ms debounce prevents excessive searching during typing
- [ ] First 100 results shown, with "Show more" pagination
- [ ] Ctrl+F / Cmd+F keyboard shortcut opens search on desktop
- [ ] Search results update in real-time as new events arrive

**Edge Cases**

- Empty query: show no results (not "all items").
- Query matching 10,000+ items: return first 100 immediately, paginate.
- Regex with syntax error: show "Invalid regex" error below the search input, do not crash.
- Search while session is streaming: new events are included in results in real-time.
- Search text that appears in binary/base64 content: matches are valid but snippets may not be human-readable.

**Estimated Complexity**: M (Medium) -- ~6-8 hours

---

### Task 14: Session Scrubber

**Description**

Implement the timeline scrubber bar at the bottom of the session view that enables rapid navigation through session history. The scrubber shows tick marks at significant events, a draggable handle, an event density minimap, and a floating tooltip during drag.

**Prerequisites/Inputs**

- Task 2 (TimelineItem for tick mark generation).
- Task 3 (timeline must support scroll-to-item for scrubber navigation).
- `react-native-gesture-handler` for drag gestures.
- `expo-haptics` for snap-to-tick feedback.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/scrubber/SessionScrubber.tsx` | Create | Main scrubber bar component |
| `src/components/scrubber/ScrubberTick.tsx` | Create | Individual tick mark with category coloring |
| `src/components/scrubber/ScrubberMinimap.tsx` | Create | Event density histogram overlay |
| `src/components/scrubber/ScrubberTooltip.tsx` | Create | Floating tooltip showing timestamp + event type |
| `src/components/scrubber/useScrubberData.ts` | Create | Hook computing tick positions and minimap buckets from timeline |
| `__tests__/scrubber/useScrubberData.test.ts` | Create | Tests T-19, T-20 (tick positions, snap threshold) |

**Visual Specification**

- Bar height: 32px.
- Tick marks: vertical lines at significant events. Height: 8px (normal), 12px (significant: user prompts, errors, permissions).
- Tick colors: User prompt=blue, Error=red, Permission=amber, Tool call=grey.
- Handle: 20px wide draggable circle.
- Minimap: semi-transparent histogram behind tick marks showing event density.
- Snap: within 8px of a tick, snap to it with light haptic.
- Tooltip: floating above handle during drag showing timestamp + event type.
- Time labels: start time (left) and end/"Now" (right).

**Interactions**

| Gesture | Action |
|---|---|
| Tap on bar | Jump to event at that position |
| Drag handle | Smooth scrub with snap-to-tick |
| Tap tick mark | Jump directly to that event |
| Long press tick | Show tooltip with event details |

**Minimap Computation**

```typescript
function computeMinimap(timeline: TimelineItem[], bucketCount: number = 100): ScrubberMinimap {
  // Divide the session duration into `bucketCount` equal time slots
  // Count events per slot, identify dominant type per slot
  // Return normalized density values (0.0 to 1.0)
}
```

**Acceptance Criteria**

- [ ] Scrubber bar is positioned at bottom of session view (T-19)
- [ ] Tick marks at significant events (user prompts, errors, permissions)
- [ ] Dragging handle scrolls timeline to corresponding event
- [ ] Snap-to-event within 8px of a tick mark (T-20)
- [ ] Minimap shows event density as semi-transparent histogram
- [ ] Floating tooltip shows timestamp and event type during drag
- [ ] Time labels show session start time and current/end time
- [ ] Haptic feedback fires on snap-to-tick (light impact)
- [ ] Scrubber updates in real-time as new events arrive
- [ ] Tapping a tick mark jumps directly to that event

**Edge Cases**

- Session with only 1 event: scrubber shows a single tick, handle cannot be dragged.
- Session with 10,000+ events: minimap bucket count is fixed at 100, ticks are sampled (show only significant events to avoid visual clutter).
- Active session: handle stays at "now" (right end) unless user has explicitly scrubbed back. New events extend the timeline rightward.
- Very short session (< 5 seconds): time labels show seconds-resolution, not just minutes.

**Estimated Complexity**: M (Medium) -- ~5-6 hours

---

### Task 15: Notification Badges

**Description**

Implement per-session notification badges showing unread counts by type (permissions, errors, prompts, general activity). Badges appear in the session list, drive the app icon badge count, and clear when a session is viewed.

**Prerequisites/Inputs**

- Task 2 (TimelineItem types for badge categorization).
- `expo-notifications` for app icon badge count (`setBadgeCountAsync`).
- `AsyncStorage` for persisting badge state across app restarts.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/components/badges/Badge.tsx` | Create | Reusable badge component (small: 16px, medium: 22px) |
| `src/badges/BadgeManager.ts` | Create | Singleton managing badge state per session, persistence, and app icon badge |
| `src/badges/useBadges.ts` | Create | Hook for consuming badge data in components |
| `__tests__/badges/BadgeManager.test.ts` | Create | Tests T-15, T-16 (increment/decrement, overflow) |

**Badge Types and Colors**

| Type | Color | Priority |
|---|---|---|
| Pending permissions | Amber (`#FBBF24`) | Highest |
| Unread errors | Red (`#EF4444`) | High |
| Unread prompts | Blue (`#60A5FA`) | Medium |
| General activity | Grey (`#8B949E`) | Low |

**Badge Behavior**

| Feature | Detail |
|---|---|
| Session list | Combined count badge on each session row, highest-priority color |
| App icon | Sum of pending permissions + unread errors across all sessions |
| Clearing | Viewing a session clears all badges for it. Scrolling marks items as `read: true`. |
| Real-time | Badges update via WebSocket events |
| Overflow | Counts > 99 display as "99+" |
| Persistence | Badge state in AsyncStorage, restored on app launch |

**Badge Component Sizes**

| Size | Diameter | Font Size | Min Width | Padding Horizontal | Border Radius |
|---|---|---|---|---|---|
| Small | 16px | 10px | 16px | 4px | 8px |
| Medium | 22px | 12px | 22px | 6px | 11px |

**Acceptance Criteria**

- [ ] Per-session badge counts displayed on session list (T-15, T-40)
- [ ] Badge types color-coded: amber (permissions), red (errors), blue (prompts), grey (activity)
- [ ] App icon badge shows aggregate count of permissions + errors
- [ ] Viewing a session clears its badges
- [ ] Badges update in real-time via WebSocket
- [ ] Counts > 99 display as "99+" (T-16)
- [ ] Badge priority: permissions > errors > prompts > activity
- [ ] Badge state persists across app restarts

**Edge Cases**

- Session viewed but new events arrive while viewing: only new events since last scroll position get badges.
- All sessions have 0 unread: app icon badge is cleared (set to 0).
- Badge state corrupted in AsyncStorage: reset to 0 and rebuild from last known read positions.

**Estimated Complexity**: S (Small) -- ~3-4 hours

---

### Task 16: Responsive Layout System

**Description**

Implement the responsive layout system that adapts to three device categories: phone (single column), tablet (two-panel), and desktop (three-panel). Includes breakpoint detection, panel width management, and orientation change handling.

**Prerequisites/Inputs**

- Task 3 + Task 5 (timeline components that render inside the detail panel).
- Task 9 (usage footer positioned at the bottom of the detail panel).
- Task 14 (scrubber positioned above the footer).
- Task 12 (prompt input positioned below the footer).

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `src/layout/ResponsiveLayout.tsx` | Create | Root layout component that renders 1/2/3 panels based on breakpoint |
| `src/layout/useDeviceClass.ts` | Create | Hook: `useDeviceClass(): 'phone' | 'tablet' | 'desktop'` using `useWindowDimensions()` |
| `src/layout/PanelContainer.tsx` | Create | Reusable panel container with fixed/flex width |
| `src/layout/breakpoints.ts` | Create | Breakpoint constants and `getDeviceClass(width)` function |
| `__tests__/layout/breakpoints.test.ts` | Create | Tests T-21 through T-24 (breakpoint classification) |

**Breakpoints**

```typescript
const BREAKPOINTS = {
  phone: { maxWidth: 767 },
  tablet: { minWidth: 768, maxWidth: 1199 },
  desktop: { minWidth: 1200 },
};

function getDeviceClass(windowWidth: number): DeviceClass {
  if (windowWidth < 768) return 'phone';
  if (windowWidth < 1200) return 'tablet';
  return 'desktop';
}
```

**Panel Configurations**

| Device | Panels | Widths |
|---|---|---|
| Phone | Detail only | 100% |
| Tablet | Session list + Detail | 320px + flex |
| Desktop | Agents + Sessions + Detail | 240px + 320px + flex |

**Orientation Handling**

| Transition | Behavior |
|---|---|
| Tablet portrait -> landscape | If width >= 768px: two-panel. If < 768px: phone layout. |
| Tablet landscape -> portrait | If width < 768px: collapse to phone layout with back navigation. |
| Desktop | Always landscape (no orientation change). |

**Acceptance Criteria**

- [ ] Phone layout (< 768px) renders as single-column (T-22)
- [ ] Tablet layout (768-1199px) renders as two-panel (T-23)
- [ ] Desktop layout (>= 1200px) renders as three-panel (T-24)
- [ ] Breakpoint transitions are smooth (no layout flash) (T-21)
- [ ] Orientation changes correctly switch between layouts (T-33)
- [ ] Panel widths: agents=240px, sessions=320px, detail=flex
- [ ] All panels maintain scroll position during layout transitions
- [ ] Tablet portrait mode falls back to phone layout when width < 768px

**Edge Cases**

- Rapid orientation changes (flipping device): debounce layout recalculation at 100ms.
- Window resize on desktop (Tauri): smooth panel width transitions.
- Split-screen mode on iPad/Android: correctly detect reduced width and adapt layout.
- Detail panel with no session selected: show empty state with "Select a session" message.

**Estimated Complexity**: M (Medium) -- ~5-6 hours

---

### Task 17: Integration Tests & Manual Verification

**Description**

Create the comprehensive test suite covering all integration test scenarios (T-25 through T-40) and document the manual verification checklist (M-1 through M-12). This task validates that all components work together end-to-end.

**Prerequisites/Inputs**

- All tasks 1-16 completed.
- Testing framework: Jest + React Native Testing Library.
- Detox or Maestro for E2E/device tests.

**Implementation Details**

**Files to Create/Modify**

| File | Action | Purpose |
|---|---|---|
| `__tests__/integration/gcEventPipeline.test.ts` | Create | T-25: GC JSONL -> normalize -> render structured timeline |
| `__tests__/integration/sdkStreamingPipeline.test.ts` | Create | T-26: SDK streaming -> real-time text with cursor |
| `__tests__/integration/permissionFlow.test.ts` | Create | T-27, T-28: Permission request -> action sheet -> resolution |
| `__tests__/integration/searchFlow.test.ts` | Create | T-29: Search -> results -> navigate to item |
| `__tests__/integration/dualView.test.ts` | Create | T-30, T-31: Structured/terminal toggle |
| `__tests__/integration/themeToggle.test.ts` | Create | T-32: Dark/light theme switching |
| `__tests__/integration/responsiveLayout.test.ts` | Create | T-33: Layout transitions across breakpoints |
| `__tests__/integration/offlineMode.test.ts` | Create | T-34: Offline banner, cached data rendering |
| `__tests__/integration/diffViewer.test.ts` | Create | T-35, T-36: Diff rendering, side-by-side swipe |
| `__tests__/integration/streamingPerformance.test.ts` | Create | T-37: 5000-word streaming at 60fps |
| `__tests__/integration/promptInput.test.ts` | Create | T-38, T-39: Submit prompt, history navigation |
| `__tests__/integration/badges.test.ts` | Create | T-40: Badge increment/decrement on events |
| `docs/MANUAL-VERIFICATION-08.md` | Create (only if requested) | M-1 through M-12 checklist |

**Integration Test Details**

| Test | What It Validates |
|---|---|
| T-25 | GC JSONL events normalize -> render as structured timeline scrollable with FlashList |
| T-26 | SDK streaming events produce real-time text streaming with cursor |
| T-27 | Permission request -> action sheet -> allow -> card updates to "Allowed" |
| T-28 | Multiple permissions queue correctly, resolving one reveals next |
| T-29 | Type search query -> results appear -> tap result -> timeline scrolls to item |
| T-30 | Toggle structured -> terminal, xterm.js WebView loads, PTY data renders |
| T-31 | Toggle for observed session shows terminal as disabled |
| T-32 | Switch dark -> light, all component colors update correctly |
| T-33 | Resize 1440px -> 375px: 3-panel -> 2-panel -> 1-panel transitions |
| T-34 | Disconnect WebSocket, offline banner appears, cached data renders |
| T-35 | Edit tool call renders unified diff with highlighting and line numbers |
| T-36 | Swipe on diff toggles side-by-side on tablet-width screen |
| T-37 | 5000-word response streams at 60fps on test device |
| T-38 | Submit prompt, appears in timeline as UserMessage |
| T-39 | Arrow-up navigates through prompt history |
| T-40 | New events increment badge, viewing session clears badge |

**Manual Verification Checklist (M-1 through M-12)**

1. Visual inspection of all 8 tool card types against CLI equivalents
2. Stream 2000-word response on phone, verify smooth animation
3. Render complex diff (100+ lines) with syntax highlighting
4. Open xterm.js, run `vim`, verify cursor and alternate screen buffer
5. Navigate 500-event session with scrubber, verify snap-to-event
6. Test VoiceOver/TalkBack navigation through 20-event timeline
7. Verify permission haptic feedback on physical device
8. Test push notification for backgrounded permission request
9. Verify RTL text rendering in Arabic/Hebrew prompts
10. Test pinch-to-zoom on terminal widget
11. Test horizontal scroll on 200-char code line in diff viewer
12. Verify nested Task tool call renders to 3 levels deep

**Acceptance Criteria**

- [ ] All 16 integration tests (T-25 through T-40) pass
- [ ] All 24 unit tests (T-1 through T-24, created in prior tasks) pass
- [ ] Manual verification checklist (M-1 through M-12) completed and documented
- [ ] No TypeScript compiler errors across the entire component library
- [ ] All components render correctly in both dark and light themes
- [ ] Screen reader navigation works on iOS (VoiceOver) and Android (TalkBack) for full session timeline

**Estimated Complexity**: L (Large) -- ~10-12 hours

---

## File Summary

All file paths are relative to the React Native project root (e.g., `/home/meywd/GlobalContext/mobile/` or similar Expo project directory).

| File | Action | Task(s) |
|---|---|---|
| `src/theme/types.ts` | Create | 1 |
| `src/theme/dark.ts` | Create | 1 |
| `src/theme/light.ts` | Create | 1 |
| `src/theme/syntax.ts` | Create | 1 |
| `src/theme/ThemeProvider.tsx` | Create | 1 |
| `src/theme/useTheme.ts` | Create | 1 |
| `src/types/timeline.ts` | Create | 2 |
| `src/normalization/normalizeGCEvent.ts` | Create | 2 |
| `src/normalization/normalizeSDKEvent.ts` | Create | 2 |
| `src/normalization/mergeIntoTimeline.ts` | Create | 2 |
| `src/components/timeline/UserMessageBubble.tsx` | Create | 3 |
| `src/components/timeline/AssistantMessageBubble.tsx` | Create | 3 |
| `src/components/timeline/ThinkingBlockCard.tsx` | Create | 3 |
| `src/components/timeline/SystemNotificationInline.tsx` | Create | 3 |
| `src/components/timeline/CompactNotificationCard.tsx` | Create | 3 |
| `src/components/timeline/ErrorCard.tsx` | Create | 3 |
| `src/components/timeline/TimelineItemRenderer.tsx` | Create | 3 |
| `src/components/common/ModelBadge.tsx` | Create | 3 |
| `src/components/common/CodeBlock.tsx` | Create | 3 |
| `src/components/common/MarkdownTable.tsx` | Create | 3 |
| `src/components/common/ImageOutput.tsx` | Create | 3 |
| `src/components/streaming/StreamingTextRenderer.tsx` | Create | 4 |
| `src/components/streaming/useStreamBuffer.ts` | Create | 4 |
| `src/components/streaming/CursorAnimation.tsx` | Create | 4 |
| `src/components/streaming/incrementalMarkdown.ts` | Create | 4 |
| `src/components/tools/ToolCallCard.tsx` | Create | 5 |
| `src/components/tools/ToolCallReadContent.tsx` | Create | 5 |
| `src/components/tools/ToolCallEditContent.tsx` | Create | 5 |
| `src/components/tools/ToolCallWriteContent.tsx` | Create | 5 |
| `src/components/tools/ToolCallBashContent.tsx` | Create | 5 |
| `src/components/tools/ToolCallSearchContent.tsx` | Create | 5 |
| `src/components/tools/ToolCallWebFetchContent.tsx` | Create | 5 |
| `src/components/tools/ToolCallTaskContent.tsx` | Create | 5 |
| `src/components/tools/toolIconMap.ts` | Create | 5 |
| `src/components/diff/DiffViewer.tsx` | Create | 6 |
| `src/components/diff/DiffLine.tsx` | Create | 6 |
| `src/components/diff/parseDiff.ts` | Create | 6 |
| `src/components/diff/isBinaryFile.ts` | Create | 6 |
| `src/highlighting/languageDetection.ts` | Create | 7 |
| `src/highlighting/HighlightManager.ts` | Create | 7 |
| `src/highlighting/highlightjs.ts` | Create | 7 |
| `src/highlighting/shiki.ts` | Create | 7 |
| `src/components/permissions/PermissionActionSheet.tsx` | Create | 8 |
| `src/components/permissions/PermissionRequestCard.tsx` | Create | 8 |
| `src/components/permissions/PermissionResolvedInline.tsx` | Create | 8 |
| `src/components/permissions/PermissionQueue.tsx` | Create | 8 |
| `src/components/permissions/usePermissionNotification.ts` | Create | 8 |
| `src/components/footer/UsageFooter.tsx` | Create | 9 |
| `src/components/footer/ContextWindowRing.tsx` | Create | 9 |
| `src/components/footer/SessionTimer.tsx` | Create | 9 |
| `src/components/footer/TokenBreakdown.tsx` | Create | 9 |
| `src/components/terminal/TerminalWidget.tsx` | Create | 10 |
| `src/components/terminal/TerminalInputBar.tsx` | Create | 10 |
| `src/components/terminal/terminalBridge.ts` | Create | 10 |
| `assets/terminal/terminal.html` | Create | 10 |
| `src/components/session/ViewModeSwitcher.tsx` | Create | 11 |
| `src/components/session/SessionView.tsx` | Create | 11 |
| `src/hooks/useViewMode.ts` | Create | 11 |
| `src/components/input/PromptInput.tsx` | Create | 12 |
| `src/components/input/PromptHistory.ts` | Create | 12 |
| `src/components/input/AttachmentChip.tsx` | Create | 12 |
| `src/components/input/MarkdownPreview.tsx` | Create | 12 |
| `src/components/search/SessionSearch.tsx` | Create | 13 |
| `src/components/search/SearchFilters.tsx` | Create | 13 |
| `src/components/search/SearchResult.tsx` | Create | 13 |
| `src/search/searchTimeline.ts` | Create | 13 |
| `src/search/extractSearchableText.ts` | Create | 13 |
| `src/components/scrubber/SessionScrubber.tsx` | Create | 14 |
| `src/components/scrubber/ScrubberTick.tsx` | Create | 14 |
| `src/components/scrubber/ScrubberMinimap.tsx` | Create | 14 |
| `src/components/scrubber/ScrubberTooltip.tsx` | Create | 14 |
| `src/components/scrubber/useScrubberData.ts` | Create | 14 |
| `src/components/badges/Badge.tsx` | Create | 15 |
| `src/badges/BadgeManager.ts` | Create | 15 |
| `src/badges/useBadges.ts` | Create | 15 |
| `src/layout/ResponsiveLayout.tsx` | Create | 16 |
| `src/layout/useDeviceClass.ts` | Create | 16 |
| `src/layout/PanelContainer.tsx` | Create | 16 |
| `src/layout/breakpoints.ts` | Create | 16 |
| `__tests__/normalization/*.test.ts` | Create | 2 |
| `__tests__/streaming/*.test.ts` | Create | 4 |
| `__tests__/diff/*.test.ts` | Create | 6 |
| `__tests__/highlighting/*.test.ts` | Create | 7 |
| `__tests__/search/*.test.ts` | Create | 13 |
| `__tests__/scrubber/*.test.ts` | Create | 14 |
| `__tests__/badges/*.test.ts` | Create | 15 |
| `__tests__/layout/*.test.ts` | Create | 16 |
| `__tests__/integration/*.test.ts` | Create | 17 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone | Estimated Duration |
|-------|-------|-----------|-------------------|
| **Phase 1: Foundation** | Task 1 (Theme), Task 2 (Types + Normalization) | Theme and data layer ready | ~2 days |
| **Phase 2: Core Components** | Task 3 (Messages), Task 7 (Syntax Highlighting) | Basic chat-style rendering works | ~2 days |
| **Phase 3: Streaming & Tools** | Task 4 (Streaming), Task 5 (Tool Cards), Task 6 (Diff Viewer) | Full structured view | ~3 days |
| **Phase 4: Interactions** | Task 8 (Permissions), Task 12 (Prompt Input) | Two-way interaction with agents | ~2 days |
| **Phase 5: Terminal** | Task 10 (Terminal Widget), Task 11 (Dual View) | Terminal view available | ~2 days |
| **Phase 6: Navigation & Chrome** | Task 9 (Footer), Task 13 (Search), Task 14 (Scrubber), Task 15 (Badges), Task 16 (Layout) | Full chrome and navigation | ~2-3 days |
| **Phase 7: Testing** | Task 17 (Integration Tests) | All tests pass | ~2 days |

Tasks 1 and 2 must complete before anything else. Within Phase 2, Tasks 3 and 7 can run in parallel. Within Phase 3, Tasks 4, 5, and 6 can be partially parallelized (Task 6 depends on Task 5 but can start diff parsing independently). Within Phase 6, all tasks are independent and can be parallelized across developers.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 60fps streaming on mid-range phones | Medium | High (core UX) | Buffer management with frame-rate limiting. Profile early on Pixel 6a. Fallback: disable incremental markdown during streaming, parse only on completion. |
| xterm.js WebView bridge latency | Medium | Medium (terminal view lag) | Batch messages at 16ms intervals. Pre-load WebView. Fallback: increase batch interval to 33ms (30fps). |
| `highlight.js` bundle size on React Native | Low | Medium (app size) | Lazy-load language grammars. Only bundle top 5 languages. Use dynamic imports for the rest. |
| React Native markdown library limitations | Medium | Medium (missing features) | Evaluate `react-native-markdown-display` vs `react-native-render-html`. May need a custom parser for tables and nested code blocks. |
| FlashList performance with heterogeneous item heights | Medium | High (scroll jank) | Set `estimatedItemSize` per item type. Use `getItemType` to help FlashList recycle correctly. Profile with 500+ item sessions. |
| Permission push notifications not working on all devices | Medium | Low (convenience feature) | Push notifications are a nice-to-have for permissions. The in-app action sheet is the primary flow. Test on both iOS and Android. |
| Side-by-side diff on smaller tablets (768-900px) | Low | Low (readability) | At widths 768-900px, side-by-side may be too cramped. Add a minimum effective width check (900px) and only enable side-by-side above that. |
| AsyncStorage limits for badge/history persistence | Low | Low (data loss on overflow) | AsyncStorage on Android has a 6MB default limit. Badge state and 50 prompts per session are well under this. Monitor if many sessions accumulate. |
| RTL text rendering inconsistencies | Low | Medium (unreadable text) | Rely on React Native's `writingDirection: 'auto'`. Test with Arabic/Hebrew content early. Code blocks always render LTR. |
| Orientation changes causing layout flash | Low | Medium (visual glitch) | Debounce orientation change handler at 100ms. Use `LayoutAnimation` for smooth transitions. |

---

## Notes for Implementation

1. **The `TimelineItem` type system is the contract** between the normalization layer and all UI components. Changes to these types cascade to every component. Freeze the type definitions in Task 2 before starting Tasks 3-16.

2. **`React.memo` everywhere** -- every timeline component should be wrapped in `React.memo` with a comparison function based on the item's `id` and relevant mutable fields (e.g., `streamingState`, `status`, `read`). This prevents re-rendering 500 cards when one event updates.

3. **FlashList over FlatList** -- `@shopify/flash-list` provides significantly better performance for heterogeneous lists. Use `getItemType` to return the `TimelineItem.type` string, which helps FlashList recycle views within the same type pool.

4. **Theme colors are the single source of truth** -- no component may hardcode a color value. Every color reference must go through `theme.colors.*`. This enables theming and makes visual audits trivial (grep for hex codes in component files -- there should be none).

5. **Accessibility is not optional** -- every component specifies screen reader labels in the story spec. These must be implemented as part of the component, not as a follow-up. The manual verification checklist (M-6) specifically tests VoiceOver and TalkBack navigation.

6. **Terminal view is managed-session-only** -- the terminal widget requires a PTY stream, which is only available for managed sessions (started via SDK). Observed sessions (GC hooks) have no PTY data. The dual view toggle must enforce this constraint.

7. **The normalization layer is pure and testable** -- `normalizeGCEvent` and `normalizeSDKEvent` are pure functions with no side effects. They take an event and existing state, and return new timeline items. This makes them trivially unit-testable.

8. **All third-party dependencies should be evaluated for React Native compatibility**: `highlight.js` (confirmed RN-compatible), `@gorhom/bottom-sheet` (confirmed), `react-native-webview` (confirmed), `expo-haptics` (confirmed), `expo-notifications` (confirmed).

---

## Effort Estimates

| Task | Complexity | Estimate |
|---|---|---|
| Task 1: Theme System & Design Tokens | S | 3-4 hours |
| Task 2: TimelineItem Type System & Normalization | L | 8-10 hours |
| Task 3: Core Timeline Components | L | 10-12 hours |
| Task 4: Streaming Text Renderer | L | 8-10 hours |
| Task 5: Tool Call Card Components (8 types) | L | 10-12 hours |
| Task 6: Diff Viewer Component | M | 6-8 hours |
| Task 7: Syntax Highlighting Engine | M | 6-8 hours |
| Task 8: Permission Components | L | 8-10 hours |
| Task 9: Usage Footer & Model Badge | M | 4-6 hours |
| Task 10: Terminal Emulator Widget | L | 8-10 hours |
| Task 11: Dual View Mode | S | 3-4 hours |
| Task 12: Prompt Input Component | M | 5-6 hours |
| Task 13: Search Within Session | M | 6-8 hours |
| Task 14: Session Scrubber | M | 5-6 hours |
| Task 15: Notification Badges | S | 3-4 hours |
| Task 16: Responsive Layout System | M | 5-6 hours |
| Task 17: Integration Tests | L | 10-12 hours |
| **Total** | | **~109-136 hours (~14-17 working days)** |
