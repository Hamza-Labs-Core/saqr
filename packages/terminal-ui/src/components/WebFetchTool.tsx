/**
 * WebFetchTool — renders the output of a WebFetch tool call.
 * Shows HTTP status code and content summary.
 */
import type { ToolCallWebFetch } from "../types.js";

export interface WebFetchToolProps {
  item: ToolCallWebFetch;
}

export function WebFetchTool({ item }: WebFetchToolProps) {
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
}
