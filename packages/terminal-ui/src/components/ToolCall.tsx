/**
 * ToolCall — renders a tool call with sub-variant based on toolName.
 *
 * Each tool gets its own dedicated rendering: file content, diff view,
 * bash output, file list, search results, etc.
 */
import type { ToolCall as ToolCallType } from "../types.js";
import { getToolColorVar } from "../theme.js";

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

      {/* Body — sub-variant rendering */}
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

/** Tool-specific output rendering. */
function ToolBody({ item }: { item: ToolCallType }) {
  switch (item.toolName) {
    case "Read":
      if (!item.output) return null;
      return (
        <div>
          {item.output.lineCount !== null && (
            <div style={{ color: "var(--saqr-muted)", marginBottom: "4px" }}>
              {item.output.lineCount} lines{item.output.language ? ` (${item.output.language})` : ""}
            </div>
          )}
          {item.output.content && (
            <pre style={{
              background: "var(--saqr-code-block-bg)",
              padding: "var(--saqr-space-sm)",
              borderRadius: "4px",
              overflow: "auto",
              maxHeight: "300px",
              margin: 0,
              whiteSpace: "pre-wrap",
              fontSize: "var(--saqr-font-sm)",
            }}>
              {item.output.content}
            </pre>
          )}
        </div>
      );

    case "Edit":
      if (!item.output) return null;
      return (
        <pre style={{
          background: "var(--saqr-code-block-bg)",
          padding: "var(--saqr-space-sm)",
          borderRadius: "4px",
          overflow: "auto",
          maxHeight: "300px",
          margin: 0,
          whiteSpace: "pre-wrap",
          fontSize: "var(--saqr-font-sm)",
        }}>
          {item.output.diff ?? `Edit applied to ${item.input.filePath}`}
        </pre>
      );

    case "Write":
      if (!item.output) return null;
      return (
        <div style={{ color: "var(--saqr-success)" }}>
          Wrote {item.output.bytesWritten} bytes
          {item.output.language ? ` (${item.output.language})` : ""}
        </div>
      );

    case "Bash":
      if (!item.output) return null;
      return (
        <div>
          <pre style={{
            background: "var(--saqr-code-block-bg)",
            padding: "var(--saqr-space-sm)",
            borderRadius: "4px",
            overflow: "auto",
            maxHeight: "300px",
            margin: 0,
            whiteSpace: "pre-wrap",
            fontSize: "var(--saqr-font-sm)",
          }}>
            {item.output.stdout ?? ""}
            {item.output.stderr ? `\n${item.output.stderr}` : ""}
          </pre>
          {item.output.exitCode !== null && item.output.exitCode !== 0 && (
            <div style={{ color: "var(--saqr-error)", marginTop: "4px" }}>
              Exit code: {item.output.exitCode}
            </div>
          )}
        </div>
      );

    case "Glob":
      if (!item.output) return null;
      return (
        <div>
          <div style={{ color: "var(--saqr-muted)", marginBottom: "4px" }}>
            {item.output.matchCount} match{item.output.matchCount !== 1 ? "es" : ""}
          </div>
          <div style={{ maxHeight: "200px", overflow: "auto" }}>
            {item.output.matches.slice(0, 20).map((m, i) => (
              <div key={i} style={{ color: "var(--saqr-text-secondary)" }}>{m}</div>
            ))}
            {item.output.matches.length > 20 && (
              <div style={{ color: "var(--saqr-muted)" }}>
                ...and {item.output.matches.length - 20} more
              </div>
            )}
          </div>
        </div>
      );

    case "Grep":
      if (!item.output) return null;
      return (
        <div>
          <div style={{ color: "var(--saqr-muted)", marginBottom: "4px" }}>
            {item.output.matchCount} match{item.output.matchCount !== 1 ? "es" : ""}
          </div>
          <div style={{ maxHeight: "200px", overflow: "auto" }}>
            {item.output.matches.slice(0, 10).map((m, i) => (
              <div key={i} style={{ borderBottom: "1px solid var(--saqr-border)", padding: "2px 0" }}>
                <span style={{ color: "var(--saqr-info)" }}>{m.file}:{m.line}</span>
                <span style={{ color: "var(--saqr-text-secondary)", marginLeft: "8px" }}>{m.content}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "WebFetch":
      if (!item.output) return null;
      return (
        <div>
          {item.output.statusCode !== null && (
            <div style={{
              color: item.output.statusCode < 400 ? "var(--saqr-success)" : "var(--saqr-error)",
              marginBottom: "4px",
            }}>
              HTTP {item.output.statusCode}
            </div>
          )}
          {item.output.summary && (
            <div style={{ color: "var(--saqr-text-secondary)", whiteSpace: "pre-wrap" }}>
              {item.output.summary}
            </div>
          )}
        </div>
      );

    case "Task":
      if (!item.output) return null;
      return (
        <div style={{
          background: "var(--saqr-task-nesting)",
          padding: "var(--saqr-space-sm)",
          borderRadius: "4px",
        }}>
          {item.output.result && (
            <div style={{ color: "var(--saqr-text-secondary)", whiteSpace: "pre-wrap" }}>
              {item.output.result}
            </div>
          )}
        </div>
      );

    default:
      return null;
  }
}
