/**
 * saqrnest logout - Log out of Saqr Cloud.
 *
 * Usage:
 *   saqrnest logout
 *
 * Clears the auth token from ~/.saqr/sync.json.
 *
 * Options:
 *   --help, -h   Show help for this command
 */

import type { ParsedArgs } from "../bin/saqr.js";
import { info, success, warn, bold, cyan, dim } from "../utils/output.js";
import { loadConfig, saveConfig, getDefaultConfigDir } from "@saqr/sync-client";

function printLogoutHelp(): void {
  console.log(`
${bold("saqrnest logout")} - Log out of Saqr Cloud

${bold("USAGE")}
  ${cyan("saqrnest logout")}

${bold("OPTIONS")}
  ${dim("--help, -h")}   Show this help message
`);
}

export async function runLogout(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printLogoutHelp();
    return;
  }

  const config = loadConfig();

  if (!config.authToken) {
    warn("Not currently logged in.");
    return;
  }

  config.authToken = undefined;
  saveConfig(config);

  success("Logged out of Saqr Cloud.");
  info(`Config updated at ${dim(getDefaultConfigDir() + "/sync.json")}`);
}
