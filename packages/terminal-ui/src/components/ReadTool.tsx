/**
 * ReadTool — renders the output of a Read tool call.
 * Shows file content with line count and language detection.
 */
import type { ToolCallRead } from "../types.js";

export interface ReadToolProps {
  item: ToolCallRead;
}

export function ReadTool({ item }: ReadToolProps) {
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
}
