/**
 * EditTool — renders the output of an Edit tool call.
 * Shows diff output with syntax-aware formatting.
 */
import type { ToolCallEdit } from "../types.js";

export interface EditToolProps {
  item: ToolCallEdit;
}

export function EditTool({ item }: EditToolProps) {
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
}
