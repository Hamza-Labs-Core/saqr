/**
 * ThinkingBlock — collapsible reasoning block.
 */
import { useState } from "react";
import type { ThinkingBlock as ThinkingBlockType } from "../types.js";

export interface ThinkingBlockProps {
  item: ThinkingBlockType;
}

export function ThinkingBlock({ item }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const isStreaming = item.streamingState === "streaming";

  return (
    <div style={{
      marginBottom: "var(--saqr-space-sm)",
      background: "var(--saqr-thinking-bg)",
      border: "1px solid var(--saqr-border)",
      borderRadius: "8px",
      overflow: "hidden",
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          padding: "var(--saqr-space-xs) var(--saqr-space-md)",
          background: "none",
          border: "none",
          color: "var(--saqr-thinking-text)",
          fontSize: "var(--saqr-font-sm)",
          fontFamily: "var(--saqr-font-mono)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "var(--saqr-space-xs)",
        }}
      >
        <span>{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>Thinking{isStreaming ? "..." : ""}</span>
        {item.durationMs !== null && (
          <span style={{ marginLeft: "auto" }}>
            {(item.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </button>

      {expanded && (
        <div style={{
          padding: "var(--saqr-space-sm) var(--saqr-space-md)",
          borderTop: "1px solid var(--saqr-border)",
          fontSize: "var(--saqr-font-sm)",
          color: "var(--saqr-thinking-text)",
          whiteSpace: "pre-wrap",
          fontFamily: "var(--saqr-font-system)",
          maxHeight: "300px",
          overflowY: "auto",
        }}>
          {item.text}
        </div>
      )}
    </div>
  );
}
