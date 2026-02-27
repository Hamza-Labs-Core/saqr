/**
 * UserMessage — right-aligned chat bubble showing the user's prompt.
 */
import type { UserMessage as UserMessageType } from "../types.js";

export interface UserMessageProps {
  item: UserMessageType;
}

export function UserMessage({ item }: UserMessageProps) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "flex-end",
      marginBottom: "var(--saqr-space-md)",
    }}>
      <div style={{
        maxWidth: "80%",
        background: "var(--saqr-user-bubble)",
        color: "var(--saqr-user-text)",
        padding: "var(--saqr-space-sm) var(--saqr-space-md)",
        borderRadius: "12px 12px 2px 12px",
        fontSize: "var(--saqr-font-md)",
        fontFamily: "var(--saqr-font-system)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {item.text}
        {item.hasAttachments && item.attachments.length > 0 && (
          <div style={{
            marginTop: "var(--saqr-space-xs)",
            fontSize: "var(--saqr-font-sm)",
            color: "var(--saqr-muted)",
          }}>
            {item.attachments.length} file{item.attachments.length !== 1 ? "s" : ""} attached
          </div>
        )}
      </div>
    </div>
  );
}
