/**
 * GlobTool — renders the output of a Glob tool call.
 * Shows file match list with count.
 */
import type { ToolCallGlob } from "../types.js";

export interface GlobToolProps {
  item: ToolCallGlob;
}

export function GlobTool({ item }: GlobToolProps) {
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
}
