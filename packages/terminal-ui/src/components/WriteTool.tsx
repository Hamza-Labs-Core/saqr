/**
 * WriteTool — renders the output of a Write tool call.
 * Shows bytes written and detected language.
 */
import type { ToolCallWrite } from "../types.js";

export interface WriteToolProps {
  item: ToolCallWrite;
}

export function WriteTool({ item }: WriteToolProps) {
  if (!item.output) return null;

  return (
    <div style={{ color: "var(--saqr-success)" }}>
      Wrote {item.output.bytesWritten} bytes
      {item.output.language ? ` (${item.output.language})` : ""}
    </div>
  );
}
