/**
 * saqrnest status - Show daemon and agent status.
 *
 * Usage:
 *   saqrnest status              Show summary status
 *   saqrnest status --verbose    Show detailed status
 *
 * Options:
 *   --verbose      Show detailed status information
 *   --json         Output results as JSON
 *   --help, -h     Show help for this command
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedArgs } from "../bin/saqr.js";
import {
  info,
  header,
  table,
  bold,
  cyan,
  dim,
  green,
  red,
  yellow,
} from "../utils/output.js";

const DEFAULT_PORT = 3100;

function getPidPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".saqr", "daemon.pid");
}

function getSyncConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".saqr", "sync.json");
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
      return null;
    }
  } catch {
    return null;
  }
}

interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${mins % 60}m`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function printStatusHelp(): void {
  console.log(`
${bold("saqrnest status")} - Show daemon and agent status

${bold("USAGE")}
  ${cyan("saqrnest status")} [options]

${bold("OPTIONS")}
  ${dim("--verbose")}      Show detailed status information
  ${dim("--json")}         Output results as JSON
  ${dim("--help, -h")}     Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqrnest status
  ${dim("$")} saqrnest status --verbose
  ${dim("$")} saqrnest status --json
`);
}

export async function runStatus(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printStatusHelp();
    return;
  }

  const verbose = Boolean(args.flags["verbose"]);
  const jsonOutput = Boolean(args.flags["json"]);
  const port = parseInt(args.flags["port"] as string, 10) || DEFAULT_PORT;

  // Check daemon status via health endpoint
  let health: HealthResponse | null = null;
  let daemonRunning = false;
  const pid = readPid();

  if (pid !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        health = (await res.json()) as HealthResponse;
        daemonRunning = true;
      }
    } catch {
      // Health check failed — daemon not responding
    }
  }

  // Check sync/login status
  let syncConfig: { enabled?: boolean; authToken?: string; serverUrl?: string } = {};
  try {
    const content = fs.readFileSync(getSyncConfigPath(), "utf8");
    syncConfig = JSON.parse(content);
  } catch {
    // No config file
  }

  const loggedIn = Boolean(syncConfig.authToken);

  if (jsonOutput) {
    console.log(JSON.stringify({
      daemon: {
        running: daemonRunning,
        pid: pid ?? undefined,
        version: health?.version,
        uptime: health?.uptime,
        port,
      },
      sync: {
        loggedIn,
        enabled: syncConfig.enabled ?? false,
        serverUrl: syncConfig.serverUrl,
      },
    }, null, 2));
    return;
  }

  // Daemon section
  header("Daemon");
  if (daemonRunning && health) {
    console.log(`  State:   ${green("running")}`);
    console.log(`  PID:     ${bold(String(pid))}`);
    console.log(`  Port:    ${bold(String(port))}`);
    console.log(`  Version: ${dim(health.version)}`);
    console.log(`  Uptime:  ${dim(formatUptime(health.uptime))}`);
  } else if (pid !== null) {
    console.log(`  State:   ${yellow("process found but not responding")}`);
    console.log(`  PID:     ${bold(String(pid))}`);
  } else {
    console.log(`  State:   ${red("stopped")}`);
  }

  // Sync section
  header("Saqr Cloud");
  if (loggedIn) {
    // Decode email from JWT
    let email = "authenticated";
    try {
      const parts = syncConfig.authToken!.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString(),
        );
        if (payload.email) email = payload.email;
      }
    } catch {
      // Ignore decode errors
    }
    console.log(`  Login:   ${green("logged in")} (${bold(email)})`);
    console.log(`  Sync:    ${syncConfig.enabled ? green("enabled") : yellow("disabled")}`);
    if (syncConfig.serverUrl) {
      console.log(`  Server:  ${dim(syncConfig.serverUrl)}`);
    }
  } else {
    console.log(`  Login:   ${dim("not logged in")}`);
    console.log(`  ${dim('Run "saqrnest login" to authenticate.')}`);
  }

  // Agents section (only if daemon is running)
  if (daemonRunning) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      if (res.ok) {
        const data = (await res.json()) as { sessions: Array<{ sessionId: string; agentProvider: string; status: string; model?: string }> };
        header("Sessions");
        if (data.sessions.length === 0) {
          console.log(`  ${dim("No active sessions")}`);
        } else {
          table(
            [
              { label: "Session", width: 16 },
              { label: "Provider", width: 14 },
              { label: "Status", width: 12 },
              { label: "Model", width: 20 },
            ],
            data.sessions.map((s) => [
              s.sessionId.slice(0, 12) + "...",
              s.agentProvider,
              s.status,
              s.model ?? dim("n/a"),
            ]),
          );
        }
      }
    } catch {
      // Ignore session fetch errors
    }
  }

  if (verbose) {
    header("Configuration");
    console.log(`  PID file:     ${dim(getPidPath())}`);
    console.log(`  Sync config:  ${dim(getSyncConfigPath())}`);
    console.log(`  Data dir:     ${dim(path.join(process.env.HOME ?? "/tmp", ".saqr"))}`);
  }

  console.log();
}
