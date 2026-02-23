/**
 * Extracts all searchable text from a TimelineItem.
 *
 * Each item type produces different searchable content:
 * - UserMessage: prompt text
 * - AssistantMessage: response text
 * - ToolCall: tool name, file paths, commands, outputs
 * - ErrorItem: error message, stack trace
 * - SystemNotification: message text
 * - etc.
 *
 * @module search/extractSearchableText
 */

import type { TimelineItem } from "../types/timeline.js";

/**
 * Extracts all searchable text from a timeline item as a single string.
 * Different fields are joined with newlines for matching.
 *
 * @param item - The timeline item to extract text from.
 * @returns A string containing all searchable text.
 */
export function extractSearchableText(item: TimelineItem): string {
  const parts: string[] = [];

  switch (item.type) {
    case "user_message":
      parts.push(item.text);
      if (item.attachments.length > 0) {
        parts.push(...item.attachments);
      }
      break;

    case "assistant_message":
      parts.push(item.text);
      parts.push(item.model);
      break;

    case "thinking_block":
      parts.push(item.text);
      break;

    case "tool_call":
      parts.push(item.toolName);
      extractToolCallText(item, parts);
      break;

    case "permission_request":
      parts.push(item.toolName);
      parts.push(item.description);
      if (item.filePath) parts.push(item.filePath);
      break;

    case "permission_resolved":
      parts.push(item.toolName);
      parts.push(item.rule);
      if (item.filePath) parts.push(item.filePath);
      break;

    case "error":
      parts.push(item.message);
      if (item.stackTrace) parts.push(item.stackTrace);
      parts.push(item.errorSource);
      break;

    case "system_notification":
      parts.push(item.message);
      parts.push(item.category);
      break;

    case "compact_notification":
      parts.push(`Compaction: ${item.tokensBefore} -> ${item.tokensAfter}`);
      break;

    case "usage_update":
      parts.push(item.model);
      break;
  }

  return parts.filter(Boolean).join("\n");
}

function extractToolCallText(item: TimelineItem & { type: "tool_call" }, parts: string[]): void {
  switch (item.toolName) {
    case "Read":
      parts.push(item.input.filePath);
      if (item.output?.content) parts.push(item.output.content);
      break;

    case "Edit":
      parts.push(item.input.filePath);
      parts.push(item.input.oldString);
      parts.push(item.input.newString);
      if (item.output?.diff) parts.push(item.output.diff);
      break;

    case "Write":
      parts.push(item.input.filePath);
      parts.push(item.input.content);
      break;

    case "Bash":
      parts.push(item.input.command);
      if (item.input.description) parts.push(item.input.description);
      if (item.output?.stdout) parts.push(item.output.stdout);
      if (item.output?.stderr) parts.push(item.output.stderr);
      break;

    case "Glob":
      parts.push(item.input.pattern);
      if (item.input.path) parts.push(item.input.path);
      if (item.output?.matches) parts.push(...item.output.matches);
      break;

    case "Grep":
      parts.push(item.input.pattern);
      if (item.input.path) parts.push(item.input.path);
      if (item.output?.matches) {
        for (const match of item.output.matches) {
          parts.push(match.file);
          parts.push(match.content);
        }
      }
      break;

    case "WebFetch":
      parts.push(item.input.url);
      parts.push(item.input.prompt);
      if (item.output?.summary) parts.push(item.output.summary);
      break;

    case "Task":
      parts.push(item.input.prompt);
      if (item.input.description) parts.push(item.input.description);
      if (item.output?.result) parts.push(item.output.result);
      break;
  }

  if (item.error) parts.push(item.error);
}
