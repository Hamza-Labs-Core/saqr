/**
 * saqrnest start - Start the SaqrNest daemon.
 *
 * Usage:
 *   saqrnest start                Start the daemon in the background
 *   saqrnest start --foreground   Start the daemon in the foreground
 *
 * Options:
 *   --foreground, -f    Run in the foreground (don't daemonize)
 *   --port <port>       HTTP API port (default: 3100)
 *   --log-level <lvl>   Log level: debug, info, warn, error (default: info)
 *   --help, -h          Show help for this command
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ParsedArgs } from "../bin/saqr.js";
import { error, info, success, spinner, bold, cyan, dim } from "../utils/output.js";

const DEFAULT_PORT = 3100;

function getPidPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".saqr", "daemon.pid");
}

function readPid(): number | null {
  try {
    const content = fs.readFileSync(getPidPath(), "utf8").trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process doesn't exist — stale PID file
      fs.unlinkSync(getPidPath());
      return null;
    }
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  const pidPath = getPidPath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(pid), "utf8");
}

async function waitForHealth(
  port: number,
  timeoutMs: number = 10000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function printStartHelp(): void {
  console.log(`
${bold("saqrnest start")} - Start the SaqrNest daemon

${bold("USAGE")}
  ${cyan("saqrnest start")} [options]

${bold("OPTIONS")}
  ${dim("--foreground, -f")}    Run in the foreground (don't daemonize)
  ${dim("--port <port>")}       HTTP API port (default: ${DEFAULT_PORT})
  ${dim("--log-level <lvl>")}   Log level: debug, info, warn, error (default: info)
  ${dim("--help, -h")}          Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqrnest start
  ${dim("$")} saqrnest start --foreground
  ${dim("$")} saqrnest start --port 3100 --log-level debug
`);
}

export async function runStart(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printStartHelp();
    return;
  }

  const foreground = Boolean(args.flags["foreground"] || args.flags["f"]);
  const port = parseInt(args.flags["port"] as string, 10) || DEFAULT_PORT;
  const logLevel = (args.flags["log-level"] as string) ?? "info";

  // Check if already running
  const existingPid = readPid();
  if (existingPid !== null) {
    info(`Daemon is already running (PID ${existingPid}).`);
    return;
  }

  if (foreground) {
    info(`Starting daemon in foreground (port: ${port}, log-level: ${logLevel})`);

    // Dynamic import to avoid loading daemon code in other commands
    const { Daemon } = await import("@saqr/daemon");
    const { loadConfig } = await import("@saqr/daemon");

    const config = loadConfig({
      server: { port, host: "127.0.0.1" },
      logLevel: logLevel as "debug" | "info" | "warn" | "error",
    });

    const daemon = new Daemon(config);

    // Write PID file
    writePid(process.pid);

    // Set up signal handlers
    const shutdown = async () => {
      info("Shutting down...");
      try {
        await daemon.stop();
      } catch {
        // Already stopped
      }
      try {
        fs.unlinkSync(getPidPath());
      } catch {
        // Ignore
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await daemon.start();
    success(`Daemon started on port ${port} (PID ${process.pid})`);

    // Keep process alive
    await new Promise(() => {});
  } else {
    const spin = spinner("Starting SaqrNest daemon...");

    // Ensure log directory exists and open a log file for the spawned process stderr
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const logDir = path.join(home, ".saqr", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFd = fs.openSync(path.join(logDir, "daemon.log"), "a");

    // Spawn self with --foreground in background, stderr → log file
    const child = spawn(
      process.execPath,
      [...(process.execArgv || []), ...getEntryArgs(), "start", "--foreground", "--port", String(port), "--log-level", logLevel],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      },
    );
    fs.closeSync(logFd);
    child.unref();

    if (!child.pid) {
      spin.fail("Failed to spawn daemon process.");
      return;
    }

    // Poll for health
    const healthy = await waitForHealth(port);

    if (healthy) {
      spin.succeed(
        `SaqrNest daemon started (PID ${child.pid}, port ${port})`,
      );
    } else {
      spin.fail(
        "Daemon process spawned but health check timed out. Check logs.",
      );
    }
  }
}

/**
 * Get the entry point arguments for re-spawning this process.
 * Handles both ts-node, SEA, and regular node execution.
 */
function getEntryArgs(): string[] {
  // process.argv[1] is the script path
  const script = process.argv[1];
  if (script) {
    return [script];
  }
  return [];
}
