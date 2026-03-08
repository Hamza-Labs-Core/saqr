/**
 * ToolCall — renders a tool call with sub-variant based on toolName.
 *
 * Each tool gets its own dedicated sub-component for output rendering.
 * The header chrome and error display are shared.
 */
import type { ToolCall as ToolCallType } from "../types.js";
import { getToolColorVar } from "../theme.js";
import { ReadTool } from "./ReadTool.js";
import { EditTool } from "./EditTool.js";
import { WriteTool } from "./WriteTool.js";
import { BashTool } from "./BashTool.js";
import { GlobTool } from "./GlobTool.js";
import { GrepTool } from "./GrepTool.js";
import { WebFetchTool } from "./WebFetchTool.js";
import { TaskTool } from "./TaskTool.js";

export interface ToolCallProps {
  item: ToolCallType;
}

export function ToolCall({ item }: ToolCallProps) {
  const toolColor = getToolColorVar(item.toolName);
  const isRunning = item.status === "running" || item.status === "pending";

  return (
    <div style={{
      marginBottom: "var(--saqr-space-sm)",
      border: "1px solid var(--saqr-border)",
      borderRadius: "8px",
      borderLeft: `3px solid ${toolColor}`,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--saqr-space-sm)",
        padding: "var(--saqr-space-xs) var(--saqr-space-md)",
        background: "var(--saqr-surface)",
        fontSize: "var(--saqr-font-sm)",
        fontFamily: "var(--saqr-font-mono)",
      }}>
        <span style={{ color: toolColor, fontWeight: 600 }}>{item.toolName}</span>
        <ToolSummary item={item} />
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px" }}>
          {isRunning && <span style={{ color: "var(--saqr-info)" }}>Running...</span>}
          {item.status === "completed" && item.durationMs !== null && (
            <span style={{ color: "var(--saqr-muted)" }}>{item.durationMs}ms</span>
          )}
          {item.status === "failed" && <span style={{ color: "var(--saqr-error)" }}>Failed</span>}
        </span>
      </div>

      {/* Body — delegates to per-tool sub-component */}
      {item.status !== "pending" && (
        <div style={{
          padding: "var(--saqr-space-sm) var(--saqr-space-md)",
          fontSize: "var(--saqr-font-sm)",
          fontFamily: "var(--saqr-font-mono)",
        }}>
          <ToolBody item={item} />
        </div>
      )}

      {/* Error */}
      {item.error && (
        <div style={{
          padding: "var(--saqr-space-xs) var(--saqr-space-md)",
          background: "var(--saqr-error-bg)",
          color: "var(--saqr-error)",
          fontSize: "var(--saqr-font-sm)",
        }}>
          {item.error}
        </div>
      )}
    </div>
  );
}

/** Short summary in the header (file path, command, pattern). */
function ToolSummary({ item }: { item: ToolCallType }) {
  switch (item.toolName) {
    case "Read":
      return <span style={{ color: "var(--saqr-text-secondary)" }}>{item.input.filePath}</span>;
    case "Edit":
      return <span style={{ color: "var(--saqr-text-secondary)" }}>{item.input.filePath}</span>;
    case "Write":
      return <span style={{ color: "var(--saqr-text-secondary)" }}>{item.input.filePath}</span>;
    case "Bash":
      return (
        <span style={{ color: "var(--saqr-text-secondary)", maxWidth: "400px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.input.description ?? item.input.command}
        </span>
      );
    case "Glob":
      return <span style={{ color: "var(--saqr-text-secondary)" }}>{item.input.pattern}</span>;
    case "Grep":
      return <span style={{ color: "var(--saqr-text-secondary)" }}>{item.input.pattern}</span>;
    case "WebFetch":
      return <span style={{ color: "var(--saqr-text-secondary)" }}>{item.input.url}</span>;
    case "Task":
      return <span style={{ color: "var(--saqr-text-secondary)" }}>{item.input.description ?? "Agent"}</span>;
    default:
      return null;
  }
}

/** Delegates to the appropriate per-tool sub-component. */
function ToolBody({ item }: { item: ToolCallType }) {
  switch (item.toolName) {
    case "Read":
      return <ReadTool item={item} />;
    case "Edit":
      return <EditTool item={item} />;
    case "Write":
      return <WriteTool item={item} />;
    case "Bash":
      return <BashTool item={item} />;
    case "Glob":
      return <GlobTool item={item} />;
    case "Grep":
      return <GrepTool item={item} />;
    case "WebFetch":
      return <WebFetchTool item={item} />;
    case "Task":
      return <TaskTool item={item} />;
    default:
      return null;
  }
}
