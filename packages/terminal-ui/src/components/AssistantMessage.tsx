/**
 * AssistantMessage — streaming markdown response with model badge.
 */
import type { AssistantMessage as AssistantMessageType } from "../types.js";

export interface AssistantMessageProps {
  item: AssistantMessageType;
}

export function AssistantMessage({ item }: AssistantMessageProps) {
  const isStreaming = item.streamingState === "streaming";

  return (
    <div style={{
      marginBottom: "var(--saqr-space-md)",
    }}>
      {/* Model badge */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--saqr-space-xs)",
        marginBottom: "var(--saqr-space-xs)",
      }}>
        <span style={{
          fontSize: "var(--saqr-font-sm)",
          color: "var(--saqr-muted)",
          fontFamily: "var(--saqr-font-mono)",
        }}>
          {item.model}
        </span>
        {item.outputTokens !== null && (
          <span style={{
            fontSize: "var(--saqr-font-xs)",
            color: "var(--saqr-muted)",
          }}>
            ({item.outputTokens} tokens)
          </span>
        )}
      </div>

      {/* Response content */}
      <div style={{
        background: "var(--saqr-assistant-bubble)",
        color: "var(--saqr-assistant-text)",
        padding: "var(--saqr-space-sm) var(--saqr-space-md)",
        borderRadius: "12px 12px 12px 2px",
        fontSize: "var(--saqr-font-md)",
        fontFamily: "var(--saqr-font-system)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        lineHeight: 1.6,
      }}>
        {item.text}
        {isStreaming && (
          <span style={{
            display: "inline-block",
            width: "6px",
            height: "16px",
            background: "var(--saqr-text-primary)",
            marginLeft: "2px",
            animation: "saqr-blink 1s step-end infinite",
          }} />
        )}
      </div>

      {item.streamingState === "interrupted" && (
        <div style={{
          fontSize: "var(--saqr-font-sm)",
          color: "var(--saqr-warning)",
          marginTop: "var(--saqr-space-xs)",
        }}>
          Response interrupted
        </div>
      )}
    </div>
  );
}
