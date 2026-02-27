/**
 * TaskTool — renders the output of a Task (agent spawn) tool call.
 * Shows the agent result in a nested container.
 */
import type { ToolCallTask } from "../types.js";

export interface TaskToolProps {
  item: ToolCallTask;
}

export function TaskTool({ item }: TaskToolProps) {
  if (!item.output) return null;

  return (
    <div style={{
      background: "var(--saqr-task-nesting)",
      padding: "var(--saqr-space-sm)",
      borderRadius: "4px",
    }}>
      {item.output.result && (
        <div style={{ color: "var(--saqr-text-secondary)", whiteSpace: "pre-wrap" }}>
          {item.output.result}
        </div>
      )}
    </div>
  );
}
