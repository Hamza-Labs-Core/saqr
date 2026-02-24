/**
 * saqr stop - Stop the saqr event daemon.
 *
 * Usage:
 *   saqr stop              Gracefully stop the daemon
 *   saqr stop --force      Force-kill the daemon process
 *
 * Options:
 *   --force         Force-kill the daemon (SIGKILL instead of SIGTERM)
 *   --timeout <ms>  Graceful shutdown timeout in ms (default: 5000)
 *   --help, -h      Show help for this command
 */

import type { ParsedArgs } from "../bin/saqr.js";
import { error, info, success, warn, spinner, bold, cyan, dim } from "../utils/output.js";

function printStopHelp(): void {
  console.log(`
${bold("saqr stop")} - Stop the saqr event daemon

${bold("USAGE")}
  ${cyan("saqr stop")} [options]

${bold("OPTIONS")}
  ${dim("--force")}          Force-kill the daemon (SIGKILL)
  ${dim("--timeout <ms>")}   Graceful shutdown timeout in ms (default: 5000)
  ${dim("--help, -h")}       Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqr stop
  ${dim("$")} saqr stop --force
  ${dim("$")} saqr stop --timeout 10000
`);
}

export async function runStop(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printStopHelp();
    return;
  }

  const force = Boolean(args.flags["force"]);
  const timeout = parseInt(args.flags["timeout"] as string, 10) || 5000;

  // TODO: Implement daemon stop
  // 1. Check if daemon is running (check PID file / socket)
  // 2. If not running, report and exit
  // 3. If --force, send SIGKILL to daemon PID
  // 4. Otherwise, send SIGTERM and wait for graceful shutdown
  // 5. Poll for daemon exit within --timeout
  // 6. If timeout exceeded without exit, warn and optionally force-kill
  // 7. Clean up PID file and socket
  // 8. Report success

  if (force) {
    warn("Force-killing daemon...");
    // TODO: Send SIGKILL to daemon PID
    // await daemon.stop({ force: true });
    info("TODO: Force stop not yet implemented");
  } else {
    const spin = spinner("Stopping saqr daemon...");

    // TODO: Graceful daemon shutdown
    // await daemon.stop({ force: false, timeout });

    spin.succeed("TODO: Graceful stop not yet implemented");
  }
}
