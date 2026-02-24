/**
 * saqr query - Query stored events from the event store.
 *
 * Usage:
 *   saqr query --type ToolCallCompleted --last 1h
 *   saqr query --session <id> --limit 50
 *   saqr query --project <id> --since 2026-02-20
 *
 * Queries the event store for historical events matching the given criteria.
 * Results are returned in chronological order.
 *
 * Options:
 *   --type <event_type>    Filter by unified event type
 *   --agent <provider>     Filter by agent provider
 *   --project <id>         Filter by project ID
 *   --session <id>         Filter by session ID
 *   --since <datetime>     Events after this timestamp (ISO 8601 or relative)
 *   --until <datetime>     Events before this timestamp
 *   --last <duration>      Events from the last duration (e.g., 1h, 30m, 2d)
 *   --limit <n>            Maximum number of events to return (default: 100)
 *   --offset <n>           Skip first n events
 *   --json                 Output raw JSON (newline-delimited)
 *   --count                Only show count of matching events
 *   --help, -h             Show help for this command
 */

import type { ParsedArgs } from "../bin/saqr.js";
import { error, info, header, table, bold, cyan, dim, gray } from "../utils/output.js";

function printQueryHelp(): void {
  console.log(`
${bold("saqr query")} - Query stored events

${bold("USAGE")}
  ${cyan("saqr query")} [options]

${bold("FILTER OPTIONS")}
  ${dim("--type <event_type>")}    Filter by unified event type
  ${dim("--agent <provider>")}     Filter by agent (claude-code|opencode|codex)
  ${dim("--project <id>")}         Filter by project ID
  ${dim("--session <id>")}         Filter by session ID

${bold("TIME OPTIONS")}
  ${dim("--since <datetime>")}     Events after this time (ISO 8601 or relative)
  ${dim("--until <datetime>")}     Events before this time
  ${dim("--last <duration>")}      Events from last duration (1h, 30m, 2d)

${bold("OUTPUT OPTIONS")}
  ${dim("--limit <n>")}            Max events to return (default: 100)
  ${dim("--offset <n>")}           Skip first n events
  ${dim("--json")}                 Output raw JSON (newline-delimited)
  ${dim("--count")}                Only show count of matching events
  ${dim("--help, -h")}             Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqr query --type ToolCallCompleted --last 1h
  ${dim("$")} saqr query --session abc123 --limit 50
  ${dim("$")} saqr query --project my-project-a3f7b2 --since 2026-02-20
  ${dim("$")} saqr query --agent claude-code --count
  ${dim("$")} saqr query --last 24h --json | jq '.event_type'
`);
}

/**
 * Parse a relative duration string like "1h", "30m", "2d" to milliseconds.
 */
function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return value * (multipliers[unit] ?? 0);
}

export async function runQuery(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printQueryHelp();
    return;
  }

  const type = args.flags["type"] as string | undefined;
  const agent = args.flags["agent"] as string | undefined;
  const project = args.flags["project"] as string | undefined;
  const session = args.flags["session"] as string | undefined;
  const since = args.flags["since"] as string | undefined;
  const until = args.flags["until"] as string | undefined;
  const last = args.flags["last"] as string | undefined;
  const limit = parseInt(args.flags["limit"] as string, 10) || 100;
  const offset = parseInt(args.flags["offset"] as string, 10) || 0;
  const jsonOutput = Boolean(args.flags["json"]);
  const countOnly = Boolean(args.flags["count"]);

  // Resolve --last to a --since timestamp
  let resolvedSince = since;
  if (last) {
    const ms = parseDuration(last);
    if (ms === null) {
      error(`Invalid duration: ${last}. Use formats like 1h, 30m, 2d`);
      process.exit(1);
    }
    resolvedSince = new Date(Date.now() - ms).toISOString();
  }

  // TODO: Implement event query
  // 1. Connect to daemon or read event store directly
  // 2. Build query with filters: type, agent, project, session, since, until
  // 3. Apply limit and offset
  // 4. If --count, return only the count
  // 5. If --json, output newline-delimited JSON
  // 6. Otherwise, format as a table

  // Build filter summary for display
  const filterParts: string[] = [];
  if (type) filterParts.push(`type=${type}`);
  if (agent) filterParts.push(`agent=${agent}`);
  if (project) filterParts.push(`project=${project}`);
  if (session) filterParts.push(`session=${session}`);
  if (resolvedSince) filterParts.push(`since=${resolvedSince}`);
  if (until) filterParts.push(`until=${until}`);

  if (filterParts.length > 0) {
    info(`Filters: ${filterParts.join(", ")}`);
  }
  info(`Limit: ${limit}, Offset: ${offset}`);

  if (countOnly) {
    // TODO: Execute count query
    console.log("0");
    return;
  }

  if (jsonOutput) {
    // TODO: Output events as newline-delimited JSON
    // const events = await eventStore.query({ type, agent, project, session, since: resolvedSince, until, limit, offset });
    // for (const event of events) {
    //   process.stdout.write(JSON.stringify(event) + "\n");
    // }
    info("TODO: JSON query output not yet implemented");
    return;
  }

  // TODO: Replace with actual query results
  header("Query Results");
  table(
    [
      { label: "Timestamp", width: 24 },
      { label: "Type", width: 22 },
      { label: "Agent", width: 14 },
      { label: "Session", width: 12 },
    ],
    [],
  );
  console.log();
  info("TODO: Event query not yet implemented");
  console.log(`${gray("0 events matched")}`);
}
