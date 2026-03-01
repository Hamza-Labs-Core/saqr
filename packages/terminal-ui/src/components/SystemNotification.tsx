/**
 * SystemNotification + CompactNotification + UsageUpdate components.
 */
import type { SystemNotification as SystemNotificationType, CompactNotification as CompactNotificationType, UsageUpdate as UsageUpdateType } from "../types.js";

export interface SystemNotificationProps {
  item: SystemNotificationType;
}

export function SystemNotification({ item }: SystemNotificationProps) {
  return (
    <div style={{
      textAlign: "center",
      padding: "var(--saqr-space-xs) 0",
      fontSize: "var(--saqr-font-sm)",
      color: "var(--saqr-muted)",
      fontFamily: "var(--saqr-font-mono)",
    }}>
      {item.message}
    </div>
  );
}

export interface CompactNotificationProps {
  item: CompactNotificationType;
}

export function CompactNotification({ item }: CompactNotificationProps) {
  const reduction = item.tokensBefore > 0
    ? Math.round((1 - item.tokensAfter / item.tokensBefore) * 100)
    : 0;

  return (
    <div style={{
      textAlign: "center",
      padding: "var(--saqr-space-xs) 0",
      fontSize: "var(--saqr-font-sm)",
      color: "var(--saqr-info)",
      fontFamily: "var(--saqr-font-mono)",
    }}>
      Context compacted ({item.trigger}): {item.tokensBefore.toLocaleString()} {"\u2192"} {item.tokensAfter.toLocaleString()} tokens (-{reduction}%)
    </div>
  );
}

export interface UsageUpdateProps {
  item: UsageUpdateType;
}

export function UsageUpdate({ item }: UsageUpdateProps) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      padding: "var(--saqr-space-xs) var(--saqr-space-md)",
      fontSize: "var(--saqr-font-xs)",
      color: "var(--saqr-muted)",
      fontFamily: "var(--saqr-font-mono)",
      borderTop: "1px solid var(--saqr-border)",
    }}>
      <span>{item.model}</span>
      <span>In: {item.inputTokens.toLocaleString()} | Out: {item.outputTokens.toLocaleString()}</span>
      <span>${item.sessionCostUsd.toFixed(4)}</span>
      <span>Context: {Math.round((item.contextWindowUsage / item.contextWindowMax) * 100)}%</span>
    </div>
  );
}
