/**
 * saqr watch - Live-stream events from the daemon.
 *
 * Usage:
 *   saqr watch                          Stream all events
 *   saqr watch --filter SessionStarted  Stream only matching event types
 *   saqr watch --agent claude-code      Stream events from a specific agent
 *
 * Connects to the daemon and streams events in real-time. Events are displayed
 * as they arrive, formatted for terminal output.
 *
 * Options:
 *   --filter <type>     Filter by unified event type (can be repeated)
 *   --agent <provider>  Filter by agent provider (claude-code|opencode|codex)
 *   --project <id>      Filter by project ID
 *   --session <id>      Filter by session ID
 *   --json              Output raw JSON events (one per line)
 *   --compact           Compact single-line output
 *   --help, -h          Show help for this command
 */

import type { ParsedArgs } from "../bin/saqr.js";
import { error, info, header, bold, cyan, dim, green, yellow, gray } from "../utils/output.js";

function printWatchHelp(): void {
  console.log(`
${bold("saqr watch")} - Live-stream events from the daemon

${bold("USAGE")}
  ${cyan("saqr watch")} [options]

${bold("OPTIONS")}
  ${dim("--filter <type>")}     Filter by unified event type (repeatable)
  ${dim("--agent <provider>")}  Filter by agent (claude-code|opencode|codex)
  ${dim("--project <id>")}      Filter by project ID
  ${dim("--session <id>")}      Filter by session ID
  ${dim("--json")}              Output raw JSON (newline-delimited)
  ${dim("--compact")}           Compact single-line output
  ${dim("--help, -h")}          Show this help message

${bold("EVENT TYPES")}
  SessionStarted, UserPromptReceived, ToolCallRequested,
  ToolCallCompleted, ToolCallFailed, AgentSpawned,
  AgentCompleted, TurnCompleted, CompactionTriggered,
  SessionEnded, PermissionRequested, PermissionResponded

${bold("EXAMPLES")}
  ${dim("$")} saqr watch
  ${dim("$")} saqr watch --filter SessionStarted --filter SessionEnded
  ${dim("$")} saqr watch --agent claude-code --compact
  ${dim("$")} saqr watch --json | jq .event_type
`);
}

export async function runWatch(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printWatchHelp();
    return;
  }

  const filter = args.flags["filter"];
  const agent = args.flags["agent"] as string | undefined;
  const project = args.flags["project"] as string | undefined;
  const session = args.flags["session"] as string | undefined;
  const jsonOutput = Boolean(args.flags["json"]);
  const compact = Boolean(args.flags["compact"]);

  // Normalize filter to array
  const filters: string[] = [];
  if (typeof filter === "string") {
    filters.push(filter);
  }
  // TODO: Support repeated --filter flags (requires parser enhancement)

  // TODO: Implement live event streaming
  // 1. Connect to daemon via socket or HTTP SSE endpoint
  // 2. Subscribe to event stream with filters
  // 3. For each incoming event:
  //    a. If --json, write raw JSON + newline to stdout
  //    b. If --compact, format single-line summary
  //    c. Otherwise, format multi-line event display with colors
  // 4. Handle Ctrl+C gracefully (close connection, clean exit)
  // 5. Handle daemon disconnection (reconnect or exit with message)

  info("Connecting to saqr daemon...");

  if (filters.length > 0) {
    info(`Filtering: ${filters.join(", ")}`);
  }
  if (agent) {
    info(`Agent: ${agent}`);
  }
  if (project) {
    info(`Project: ${project}`);
  }
  if (session) {
    info(`Session: ${session}`);
  }

  console.log();
  info("TODO: Live event streaming not yet implemented");
  info("Press Ctrl+C to exit");

  // TODO: Replace with actual event stream consumption
  // const stream = await daemon.subscribe({ filters, agent, project, session });
  // for await (const event of stream) {
  //   if (jsonOutput) {
  //     process.stdout.write(JSON.stringify(event) + "\n");
  //   } else if (compact) {
  //     formatCompactEvent(event);
  //   } else {
  //     formatEvent(event);
  //   }
  // }
}
