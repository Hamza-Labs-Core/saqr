#!/usr/bin/env node

/**
 * saqr - CLI tool for the Saqr multi-agent hook system.
 *
 * Manages agent integrations, the event daemon, and provides
 * diagnostic and monitoring utilities.
 *
 * Usage:
 *   saqr <command> [options]
 *
 * Commands:
 *   install    Install hook integrations for coding agents
 *   doctor     Run health checks on installed integrations
 *   start      Start the saqr event daemon
 *   stop       Stop the saqr event daemon
 *   status     Show daemon and agent status
 *   watch      Live-stream events from the daemon
 *   query      Query stored events
 *   agent      Manage agent sessions (start|stop|attach|list)
 *
 * Options:
 *   --help, -h       Show help
 *   --version, -v    Show version
 */

import { runInstall } from "../commands/install.js";
import { runDoctor } from "../commands/doctor.js";
import { runStart } from "../commands/start.js";
import { runStop } from "../commands/stop.js";
import { runStatus } from "../commands/status.js";
import { runWatch } from "../commands/watch.js";
import { runQuery } from "../commands/query.js";
import { runAgent } from "../commands/agent.js";
import { error, bold, dim, cyan } from "../utils/output.js";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Minimal hand-rolled argument parser.
 *
 * Supports:
 *   --flag           -> { flag: true }
 *   --key=value      -> { key: "value" }
 *   --key value      -> { key: "value" }
 *   -f               -> { f: true }
 *   positional args
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--") {
      // Everything after -- is positional
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        const key = arg.slice(2, eqIndex);
        flags[key] = arg.slice(eqIndex + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Short flags: -f or -f value
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (key.length === 1 && next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }

    i++;
  }

  const command = positional.shift();
  return { command, positional, flags };
}

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
${bold("saqr")} - Multi-agent hook system CLI

${bold("USAGE")}
  ${cyan("saqr")} <command> [options]

${bold("COMMANDS")}
  ${cyan("install")}    Install hook integrations for coding agents
  ${cyan("doctor")}     Run health checks on installed integrations
  ${cyan("start")}      Start the saqr event daemon
  ${cyan("stop")}       Stop the saqr event daemon
  ${cyan("status")}     Show daemon and agent status
  ${cyan("watch")}      Live-stream events from the daemon
  ${cyan("query")}      Query stored events
  ${cyan("agent")}      Manage agent sessions ${dim("(start|stop|attach|list)")}

${bold("OPTIONS")}
  ${dim("--help, -h")}       Show this help message
  ${dim("--version, -v")}    Show version

${bold("EXAMPLES")}
  ${dim("$")} saqr install --claude-code
  ${dim("$")} saqr doctor
  ${dim("$")} saqr start
  ${dim("$")} saqr status
  ${dim("$")} saqr watch --filter SessionStarted
  ${dim("$")} saqr query --type ToolCallCompleted --last 1h
  ${dim("$")} saqr agent list
`);
}

function printVersion(): void {
  // TODO: read version from package.json at build time
  console.log("saqr 0.1.0");
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  install: runInstall,
  doctor: runDoctor,
  start: runStart,
  stop: runStop,
  status: runStatus,
  watch: runWatch,
  query: runQuery,
  agent: runAgent,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Global flags handled before command dispatch
  if (args.flags["help"] || args.flags["h"]) {
    printHelp();
    process.exit(0);
  }

  if (args.flags["version"] || args.flags["v"]) {
    printVersion();
    process.exit(0);
  }

  if (!args.command) {
    printHelp();
    process.exit(0);
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    error(`Unknown command: ${args.command}`);
    console.log(`\nRun ${cyan("saqr --help")} for available commands.`);
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    process.exit(1);
  }
}

main();
