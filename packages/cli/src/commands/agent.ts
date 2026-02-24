/**
 * saqr agent - Manage agent sessions.
 *
 * Usage:
 *   saqr agent list                    List all known agent sessions
 *   saqr agent start <provider>        Start an agent session
 *   saqr agent stop <session-id>       Stop an agent session
 *   saqr agent attach <session-id>     Attach to a running session's event stream
 *
 * Options:
 *   --json         Output results as JSON
 *   --verbose      Show detailed information
 *   --help, -h     Show help for this command
 */

import type { ParsedArgs } from "../bin/saqr.js";
import {
  error,
  info,
  success,
  warn,
  header,
  table,
  bold,
  cyan,
  dim,
  green,
  red,
  yellow,
  gray,
} from "../utils/output.js";

function printAgentHelp(): void {
  console.log(`
${bold("saqr agent")} - Manage agent sessions

${bold("USAGE")}
  ${cyan("saqr agent")} <subcommand> [args] [options]

${bold("SUBCOMMANDS")}
  ${cyan("list")}                     List all known agent sessions
  ${cyan("start")} <provider>         Start an agent session
  ${cyan("stop")} <session-id>        Stop an agent session
  ${cyan("attach")} <session-id>      Attach to a session's event stream

${bold("PROVIDERS")}
  claude-code, opencode, codex

${bold("OPTIONS")}
  ${dim("--json")}         Output results as JSON
  ${dim("--verbose")}      Show detailed information
  ${dim("--help, -h")}     Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqr agent list
  ${dim("$")} saqr agent start claude-code
  ${dim("$")} saqr agent stop abc123-def456
  ${dim("$")} saqr agent attach abc123-def456
  ${dim("$")} saqr agent list --json
`);
}

/**
 * Format a session state for display with color.
 */
function formatState(state: string): string {
  switch (state) {
    case "detected":
      return gray(state);
    case "observed":
      return cyan(state);
    case "managed":
      return green(state);
    case "resumed":
      return yellow(state);
    case "closed":
      return dim(state);
    default:
      return state;
  }
}

/**
 * Format a relative time string from a date.
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

async function agentList(flags: Record<string, string | boolean>): Promise<void> {
  const jsonOutput = Boolean(flags["json"]);
  const verbose = Boolean(flags["verbose"]);

  // Connect to the daemon via HTTP to fetch sessions.
  // For now this uses a placeholder that reports no sessions when
  // the daemon is not reachable. The daemon HTTP API will be fully
  // wired in a later story.
  let sessions: Array<{
    sessionId: string;
    agentProvider: string;
    state: string;
    detectedAt: string;
    pid?: number;
    projectId: string;
  }> = [];

  try {
    const res = await fetch("http://127.0.0.1:7399/api/sessions");
    if (res.ok) {
      sessions = await res.json() as typeof sessions;
    }
  } catch {
    // Daemon not running — fall through to empty output
  }

  if (jsonOutput) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  header("Agent Sessions");

  if (sessions.length === 0) {
    console.log();
    info("No active sessions detected.");
    console.log(
      `${gray("Start an agent or ensure the daemon is running: ")}${cyan("saqr start")}`,
    );
    return;
  }

  table(
    [
      { label: "Session ID", width: 20 },
      { label: "Agent", width: 14 },
      { label: "State", width: 12 },
      { label: "Detected", width: 14 },
      { label: "PID", width: 8, align: "right" },
    ],
    sessions.map((s) => [
      s.sessionId.slice(0, 18),
      s.agentProvider,
      s.state,
      formatRelativeTime(new Date(s.detectedAt)),
      s.pid ? String(s.pid) : gray("-"),
    ]),
  );

  console.log();
  info(`${sessions.length} session(s) found`);
}

async function agentStart(provider: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!provider) {
    error("Missing provider argument.");
    console.log(`\nUsage: ${cyan("saqr agent start <provider>")}`);
    console.log(`Providers: claude-code, opencode, codex\n`);
    process.exit(1);
  }

  const validProviders = ["claude-code", "opencode", "codex"];
  if (!validProviders.includes(provider)) {
    error(`Unknown provider: ${provider}`);
    console.log(`Valid providers: ${validProviders.join(", ")}\n`);
    process.exit(1);
  }

  // TODO: Implement agent start
  // 1. Verify the agent is installed on the system
  // 2. Verify hooks are installed for this agent
  // 3. Verify daemon is running
  // 4. Launch the agent process
  // 5. Wait for SessionStarted event confirmation
  // 6. Report session ID and connection details

  info(`Starting ${provider} agent session...`);
  info("TODO: Agent start not yet implemented");
}

async function agentStop(sessionId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!sessionId) {
    error("Missing session ID argument.");
    console.log(`\nUsage: ${cyan("saqr agent stop <session-id>")}\n`);
    process.exit(1);
  }

  // TODO: Implement agent stop
  // 1. Connect to daemon
  // 2. Look up session by ID
  // 3. Send stop signal to agent process
  // 4. Wait for SessionEnded event confirmation
  // 5. Report result

  info(`Stopping session ${sessionId}...`);
  info("TODO: Agent stop not yet implemented");
}

async function agentAttach(sessionId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!sessionId) {
    error("Missing session ID argument.");
    console.log(`\nUsage: ${cyan("saqr agent attach <session-id>")}\n`);
    process.exit(1);
  }

  const jsonOutput = Boolean(flags["json"]);

  info(`Attaching to session ${sessionId}...`);

  // Connect to the daemon's SSE/WebSocket endpoint for timeline streaming.
  // The daemon exposes /api/sessions/:id/timeline as an EventSource endpoint.
  // When the daemon HTTP API is fully wired (later story), this will use
  // real SSE. For now, attempt connection and handle failure gracefully.
  let connected = false;
  const controller = new AbortController();

  // Handle Ctrl+C
  const onSigint = () => {
    console.log(`\n${dim("Detached from session")} ${sessionId}`);
    controller.abort();
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  try {
    const res = await fetch(
      `http://127.0.0.1:7399/api/sessions/${sessionId}/timeline`,
      { signal: controller.signal },
    );

    if (!res.ok) {
      error(`Failed to attach: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    if (!res.body) {
      error("No stream body from daemon.");
      process.exit(1);
    }

    connected = true;
    success(`Attached to session ${sessionId}`);
    console.log(`${dim("Press Ctrl+C to detach")}\n`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      // SSE events come as "data: {...}\n\n"
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        try {
          const item = JSON.parse(payload);
          if (jsonOutput) {
            console.log(JSON.stringify(item));
          } else {
            const ts = new Date(item.timestamp).toLocaleTimeString();
            console.log(
              `${dim(ts)} ${cyan(item.eventType)} ${dim("#" + item.sequence)} ${gray(JSON.stringify(item.data).slice(0, 80))}`,
            );
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    }

    info("Session stream ended.");
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      // User pressed Ctrl+C
      return;
    }
    if (!connected) {
      error("Could not connect to daemon. Is it running?");
      console.log(
        `${gray("Start the daemon with: ")}${cyan("saqr start")}`,
      );
      process.exit(1);
    }
    error(`Stream error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

export async function runAgent(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printAgentHelp();
    return;
  }

  const subcommand = args.positional[0];

  if (!subcommand) {
    error("No subcommand specified.");
    console.log(`\nRun ${cyan("saqr agent --help")} for usage.\n`);
    process.exit(1);
  }

  switch (subcommand) {
    case "list":
      await agentList(args.flags);
      break;

    case "start":
      await agentStart(args.positional[1], args.flags);
      break;

    case "stop":
      await agentStop(args.positional[1], args.flags);
      break;

    case "attach":
      await agentAttach(args.positional[1], args.flags);
      break;

    default:
      error(`Unknown subcommand: ${subcommand}`);
      console.log(`\nValid subcommands: list, start, stop, attach`);
      console.log(`Run ${cyan("saqr agent --help")} for usage.\n`);
      process.exit(1);
  }
}
