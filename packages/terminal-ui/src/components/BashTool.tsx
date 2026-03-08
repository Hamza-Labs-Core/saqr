/**
 * BashTool — renders the output of a Bash tool call.
 * Shows stdout/stderr with exit code badge.
 */
import type { ToolCallBash } from "../types.js";

export interface BashToolProps {
  item: ToolCallBash;
}

export function BashTool({ item }: BashToolProps) {
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
}
