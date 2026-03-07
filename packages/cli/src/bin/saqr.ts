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

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runLogin } from "../commands/login.js";
import { runLogout } from "../commands/logout.js";
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
${bold("saqrnest")} - Multi-agent hook system CLI

${bold("USAGE")}
  ${cyan("saqrnest")} <command> [options]

${bold("GETTING STARTED")}
  ${cyan("login")}      Authenticate with Saqr Cloud
  ${cyan("logout")}     Log out of Saqr Cloud
  ${cyan("start")}      Start the SaqrNest daemon
  ${cyan("status")}     Show daemon and agent status

${bold("COMMANDS")}
  ${cyan("install")}    Install hook integrations for coding agents
  ${cyan("doctor")}     Run health checks on installed integrations
  ${cyan("start")}      Start the SaqrNest daemon
  ${cyan("stop")}       Stop the SaqrNest daemon
  ${cyan("status")}     Show daemon and agent status
  ${cyan("watch")}      Live-stream events from the daemon
  ${cyan("query")}      Query stored events
  ${cyan("agent")}      Manage agent sessions ${dim("(start|stop|attach|list)")}

${bold("OPTIONS")}
  ${dim("--help, -h")}       Show this help message
  ${dim("--version, -v")}    Show version

${bold("EXAMPLES")}
  ${dim("$")} saqrnest login
  ${dim("$")} saqrnest start
  ${dim("$")} saqrnest status
  ${dim("$")} saqrnest install --claude-code
  ${dim("$")} saqrnest doctor
  ${dim("$")} saqrnest watch --filter SessionStarted
  ${dim("$")} saqrnest query --type ToolCallCompleted --last 1h
  ${dim("$")} saqrnest agent list
`);
}

function printVersion(): void {
  // TODO: read version from package.json at build time
  console.log("saqrnest 0.1.0");
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  login: runLogin,
  logout: runLogout,
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
    console.log(`\nRun ${cyan("saqrnest --help")} for available commands.`);
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

// Only run main() when executed directly, not when imported as a module (e.g. tests)
const __filename = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === __filename) {
  main();
}
