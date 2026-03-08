/**
 * saqrnest stop - Stop the SaqrNest daemon.
 *
 * Usage:
 *   saqrnest stop              Gracefully stop the daemon
 *   saqrnest stop --force      Force-kill the daemon process
 *
 * Options:
 *   --force         Force-kill the daemon (SIGKILL instead of SIGTERM)
 *   --timeout <ms>  Graceful shutdown timeout in ms (default: 5000)
 *   --help, -h      Show help for this command
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedArgs } from "../bin/saqr.js";
import { error, info, success, warn, spinner, bold, cyan, dim } from "../utils/output.js";

function getPidPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".saqr", "daemon.pid");
}

function readPid(): number | null {
  try {
    const content = fs.readFileSync(getPidPath(), "utf8").trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Stale PID file
      fs.unlinkSync(getPidPath());
      return null;
    }
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupPidFile(): void {
  try {
    fs.unlinkSync(getPidPath());
  } catch {
    // Ignore
  }
}

function printStopHelp(): void {
  console.log(`
${bold("saqrnest stop")} - Stop the SaqrNest daemon

${bold("USAGE")}
  ${cyan("saqrnest stop")} [options]

${bold("OPTIONS")}
  ${dim("--force")}          Force-kill the daemon (SIGKILL)
  ${dim("--timeout <ms>")}   Graceful shutdown timeout in ms (default: 5000)
  ${dim("--help, -h")}       Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqrnest stop
  ${dim("$")} saqrnest stop --force
  ${dim("$")} saqrnest stop --timeout 10000
`);
}

export async function runStop(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printStopHelp();
    return;
  }

  const force = Boolean(args.flags["force"]);
  const timeout = parseInt(args.flags["timeout"] as string, 10) || 5000;

  const pid = readPid();
  if (pid === null) {
    warn("Daemon is not running.");
    return;
  }

  if (force) {
    warn(`Force-killing daemon (PID ${pid})...`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may have already exited
    }
    cleanupPidFile();
    success("Daemon force-killed.");
    return;
  }

  const spin = spinner(`Stopping SaqrNest daemon (PID ${pid})...`);

  // Send SIGTERM for graceful shutdown
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    spin.succeed("Daemon already stopped.");
    cleanupPidFile();
    return;
  }

  // Wait for process to exit
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!isProcessAlive(pid)) {
      cleanupPidFile();
      spin.succeed("SaqrNest daemon stopped.");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Timeout — process didn't exit
  spin.fail(`Daemon did not stop within ${timeout}ms.`);
  warn("Use --force to force-kill the daemon.");
}
