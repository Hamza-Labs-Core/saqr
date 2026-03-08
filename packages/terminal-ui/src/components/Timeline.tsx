/**
 * Timeline — scrollable timeline container that renders TimelineItem[].
 *
 * Dispatches to the correct sub-component based on the item's type discriminator.
 */
import { useRef, useEffect } from "react";
import type { TimelineItem } from "../types.js";
import {
  isUserMessage,
  isAssistantMessage,
  isThinkingBlock,
  isToolCall,
  isPermissionRequest,
  isErrorItem,
  isSystemNotification,
  isCompactNotification,
  isUsageUpdate,
} from "../types.js";
import { UserMessage } from "./UserMessage.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolCall } from "./ToolCall.js";
import { PermissionRequest } from "./PermissionRequest.js";
import { ErrorBlock } from "./ErrorBlock.js";
import { SystemNotification, CompactNotification, UsageUpdate } from "./SystemNotification.js";

export interface TimelineProps {
  /** Timeline items to render, sorted by sequence. */
  items: TimelineItem[];

  /** Auto-scroll to bottom on new items (default: true). */
  autoScroll?: boolean;

  /** Callback when a permission is approved. */
  onPermissionApprove?: (permissionId: string) => void;

  /** Callback when a permission is denied. */
  onPermissionDeny?: (permissionId: string) => void;
}

export function Timeline({
  items,
  autoScroll = true,
  onPermissionApprove,
  onPermissionDeny,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [items.length, autoScroll]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: "auto",
        padding: "var(--saqr-space-md)",
        background: "var(--saqr-bg)",
        fontFamily: "var(--saqr-font-system)",
      }}
    >
      {items.map((item) => (
        <TimelineItemRenderer
          key={item.id}
          item={item}
          onPermissionApprove={onPermissionApprove}
          onPermissionDeny={onPermissionDeny}
        />
      ))}

      {items.length === 0 && (
        <div style={{
          textAlign: "center",
          padding: "var(--saqr-space-xxl) 0",
          color: "var(--saqr-muted)",
          fontSize: "var(--saqr-font-md)",
        }}>
          Waiting for events...
        </div>
      )}
    </div>
  );
}

interface TimelineItemRendererProps {
  item: TimelineItem;
  onPermissionApprove?: (permissionId: string) => void;
  onPermissionDeny?: (permissionId: string) => void;
}

function TimelineItemRenderer({ item, onPermissionApprove, onPermissionDeny }: TimelineItemRendererProps) {
  if (isUserMessage(item)) return <UserMessage item={item} />;
  if (isAssistantMessage(item)) return <AssistantMessage item={item} />;
  if (isThinkingBlock(item)) return <ThinkingBlock item={item} />;
  if (isToolCall(item)) return <ToolCall item={item} />;
  if (isPermissionRequest(item)) {
    return (
      <PermissionRequest
        item={item}
        onApprove={onPermissionApprove}
        onDeny={onPermissionDeny}
      />
    );
  }
  if (isErrorItem(item)) return <ErrorBlock item={item} />;
  if (isSystemNotification(item)) return <SystemNotification item={item} />;
  if (isCompactNotification(item)) return <CompactNotification item={item} />;
  if (isUsageUpdate(item)) return <UsageUpdate item={item} />;

  return null;
}
