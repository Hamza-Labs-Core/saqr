/**
 * ErrorBlock — error display with recoverable indicator.
 */
import type { ErrorItem } from "../types.js";

export interface ErrorBlockProps {
  item: ErrorItem;
}

export function ErrorBlock({ item }: ErrorBlockProps) {
  return (
    <div style={{
      marginBottom: "var(--saqr-space-sm)",
      background: "var(--saqr-error-bg)",
      border: "1px solid var(--saqr-error)",
      borderRadius: "8px",
      padding: "var(--saqr-space-sm) var(--saqr-space-md)",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--saqr-space-sm)",
        marginBottom: "var(--saqr-space-xs)",
      }}>
        <span style={{ color: "var(--saqr-error)", fontWeight: 600 }}>Error</span>
        <span style={{ fontSize: "var(--saqr-font-xs)", color: "var(--saqr-muted)" }}>
          {item.errorSource}
        </span>
        {item.isRecoverable && (
          <span style={{
            fontSize: "var(--saqr-font-xs)",
            color: "var(--saqr-warning)",
            background: "var(--saqr-permission-bg)",
            padding: "1px 6px",
            borderRadius: "3px",
          }}>
            recoverable
          </span>
        )}
      </div>
      <div style={{
        fontSize: "var(--saqr-font-sm)",
        color: "var(--saqr-text-primary)",
        whiteSpace: "pre-wrap",
      }}>
        {item.message}
      </div>
    </div>
  );
}
