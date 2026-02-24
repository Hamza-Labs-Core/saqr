/**
 * saqr start - Start the saqr event daemon.
 *
 * Usage:
 *   saqr start                Start the daemon in the background
 *   saqr start --foreground   Start the daemon in the foreground
 *
 * The daemon listens on a Unix domain socket for incoming events from
 * agent hook integrations and writes them to the event store.
 *
 * Options:
 *   --foreground, -f    Run in the foreground (don't daemonize)
 *   --port <port>       HTTP API port (default: auto)
 *   --socket <path>     Unix socket path (default: $XDG_RUNTIME_DIR/saqr.sock)
 *   --log-level <lvl>   Log level: debug, info, warn, error (default: info)
 *   --help, -h          Show help for this command
 */

import type { ParsedArgs } from "../bin/saqr.js";
import { error, info, success, spinner, bold, cyan, dim } from "../utils/output.js";

function printStartHelp(): void {
  console.log(`
${bold("saqr start")} - Start the saqr event daemon

${bold("USAGE")}
  ${cyan("saqr start")} [options]

${bold("OPTIONS")}
  ${dim("--foreground, -f")}    Run in the foreground (don't daemonize)
  ${dim("--port <port>")}       HTTP API port (default: auto)
  ${dim("--socket <path>")}     Unix socket path
  ${dim("--log-level <lvl>")}   Log level: debug, info, warn, error (default: info)
  ${dim("--help, -h")}          Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqr start
  ${dim("$")} saqr start --foreground
  ${dim("$")} saqr start --port 3100 --log-level debug
`);
}

export async function runStart(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printStartHelp();
    return;
  }

  const foreground = Boolean(args.flags["foreground"] || args.flags["f"]);
  const port = args.flags["port"] as string | undefined;
  const socketPath = args.flags["socket"] as string | undefined;
  const logLevel = (args.flags["log-level"] as string) ?? "info";

  // TODO: Implement daemon start
  // 1. Check if daemon is already running (check PID file / socket)
  // 2. If already running, report and exit
  // 3. Validate configuration
  // 4. If --foreground, start daemon in current process
  // 5. Otherwise, spawn daemon as detached child process
  // 6. Wait for daemon to be ready (poll socket)
  // 7. Write PID file
  // 8. Report success with connection details

  if (foreground) {
    info(`Starting daemon in foreground mode (log-level: ${logLevel})`);
    if (port) info(`HTTP API port: ${port}`);
    if (socketPath) info(`Socket path: ${socketPath}`);

    // TODO: Start daemon process in foreground
    // await daemon.start({ foreground: true, port, socketPath, logLevel });
    info("TODO: Foreground daemon start not yet implemented");
  } else {
    const spin = spinner("Starting saqr daemon...");

    // TODO: Start daemon process in background
    // const result = await daemon.start({ foreground: false, port, socketPath, logLevel });

    // Simulated delay for scaffold
    spin.succeed("TODO: Background daemon start not yet implemented");
  }
}
