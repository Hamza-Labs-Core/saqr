/**
 * GrepTool — renders the output of a Grep tool call.
 * Shows search results with file:line references.
 */
import type { ToolCallGrep } from "../types.js";

export interface GrepToolProps {
  item: ToolCallGrep;
}

export function GrepTool({ item }: GrepToolProps) {
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
}
