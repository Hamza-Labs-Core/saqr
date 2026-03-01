/**
 * PermissionRequest — approve/deny buttons wired to WebSocket.
 */
import type { PermissionRequest as PermissionRequestType } from "../types.js";

export interface PermissionRequestProps {
  item: PermissionRequestType;
  onApprove?: (permissionId: string) => void;
  onDeny?: (permissionId: string) => void;
}

export function PermissionRequest({ item, onApprove, onDeny }: PermissionRequestProps) {
  const isPending = item.resolution === "pending";

  return (
    <div style={{
      marginBottom: "var(--saqr-space-sm)",
      background: "var(--saqr-permission-bg)",
      border: "1px solid var(--saqr-warning)",
      borderRadius: "8px",
      padding: "var(--saqr-space-sm) var(--saqr-space-md)",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--saqr-space-sm)",
        marginBottom: "var(--saqr-space-xs)",
      }}>
        <span style={{ color: "var(--saqr-warning)", fontWeight: 600 }}>Permission Required</span>
        <span style={{ color: "var(--saqr-text-secondary)", fontSize: "var(--saqr-font-sm)" }}>
          {item.toolName}
        </span>
      </div>

      <div style={{
        fontSize: "var(--saqr-font-sm)",
        color: "var(--saqr-text-primary)",
        marginBottom: "var(--saqr-space-sm)",
      }}>
        {item.description}
      </div>

      {item.filePath && (
        <div style={{
          fontSize: "var(--saqr-font-sm)",
          color: "var(--saqr-text-secondary)",
          fontFamily: "var(--saqr-font-mono)",
          marginBottom: "var(--saqr-space-sm)",
        }}>
          {item.filePath}
        </div>
      )}

      {isPending && (
        <div style={{ display: "flex", gap: "var(--saqr-space-sm)" }}>
          <button
            onClick={() => onApprove?.(item.id)}
            style={{
              padding: "4px 16px",
              background: "var(--saqr-success)",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "var(--saqr-font-sm)",
            }}
          >
            Allow
          </button>
          <button
            onClick={() => onDeny?.(item.id)}
            style={{
              padding: "4px 16px",
              background: "var(--saqr-error)",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "var(--saqr-font-sm)",
            }}
          >
            Deny
          </button>
        </div>
      )}

      {!isPending && (
        <div style={{
          fontSize: "var(--saqr-font-sm)",
          color: item.resolution === "allowed" || item.resolution === "always_allowed"
            ? "var(--saqr-success)"
            : "var(--saqr-error)",
        }}>
          {item.resolution === "allowed" && "Allowed"}
          {item.resolution === "always_allowed" && "Always allowed"}
          {item.resolution === "denied" && "Denied"}
          {item.resolution === "timed_out" && "Timed out"}
        </div>
      )}
    </div>
  );
}
