/**
 * saqrnest login - Authenticate with Saqr Cloud via device code flow.
 *
 * Usage:
 *   saqrnest login                    Login to Saqr Cloud
 *   saqrnest login --server <url>     Login to a custom sync server
 *
 * Implements RFC 8628 Device Authorization Grant:
 * 1. POST /api/auth/device-code to get a user code
 * 2. Opens browser to verification URL
 * 3. Polls /api/auth/device-poll until approved
 * 4. Saves JWT token to ~/.saqr/sync.json
 *
 * Options:
 *   --server <url>   Sync server URL (default: https://sync.saqr.dev)
 *   --no-browser     Don't auto-open browser
 *   --help, -h       Show help for this command
 */

import { exec } from "node:child_process";
import type { ParsedArgs } from "../bin/saqr.js";
import {
  error,
  info,
  success,
  warn,
  spinner,
  bold,
  cyan,
  dim,
  green,
  yellow,
} from "../utils/output.js";
import {
  loadConfig,
  saveConfig,
  getDefaultConfigDir,
} from "@saqr/sync-client";
import type { DeviceCodeResponse } from "@saqr/shared";

const DEFAULT_SERVER = "https://sync.saqr.dev";
const CLIENT_ID = "saqr-cli";
const POLL_INTERVAL_MS = 5000;

function printLoginHelp(): void {
  console.log(`
${bold("saqrnest login")} - Authenticate with Saqr Cloud

${bold("USAGE")}
  ${cyan("saqrnest login")} [options]

${bold("OPTIONS")}
  ${dim("--server <url>")}   Sync server URL (default: ${DEFAULT_SERVER})
  ${dim("--no-browser")}     Don't auto-open browser
  ${dim("--help, -h")}       Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqrnest login
  ${dim("$")} saqrnest login --server https://my-sync.example.com
`);
}

/**
 * Open a URL in the default browser (best-effort, no throw).
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {
    /* ignore errors — browser open is best-effort */
  });
}

export async function runLogin(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printLoginHelp();
    return;
  }

  const serverUrl = (args.flags["server"] as string) || DEFAULT_SERVER;
  const noBrowser = Boolean(args.flags["no-browser"]);

  // Check if already logged in
  const existingConfig = loadConfig();
  if (existingConfig.authToken) {
    warn("Already logged in. Run `saqrnest logout` first to re-authenticate.");
    return;
  }

  // Step 1: Request device code
  const spin = spinner("Requesting device code...");

  let deviceCodeResponse: DeviceCodeResponse;
  try {
    const res = await fetch(`${serverUrl}/api/auth/device-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });

    if (!res.ok) {
      const body = await res.text();
      spin.fail(`Failed to request device code: ${res.status} ${body}`);
      return;
    }

    deviceCodeResponse = (await res.json()) as DeviceCodeResponse;
  } catch (err) {
    spin.fail(
      `Failed to connect to ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  spin.stop();

  // Step 2: Show user code and verification URL
  console.log();
  console.log(
    `  ${bold("Your code:")}  ${green(bold(deviceCodeResponse.user_code))}`,
  );
  console.log();
  console.log(
    `  Open this URL to authenticate:`,
  );
  console.log(
    `  ${cyan(deviceCodeResponse.verification_uri_complete)}`,
  );
  console.log();

  // Step 3: Auto-open browser
  if (!noBrowser) {
    openBrowser(deviceCodeResponse.verification_uri_complete);
    info("Browser opened. Waiting for approval...");
  } else {
    info("Open the URL above in your browser and enter the code.");
  }

  // Step 4: Poll for approval
  const pollSpin = spinner("Waiting for approval...");
  const deadline =
    Date.now() + deviceCodeResponse.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const res = await fetch(`${serverUrl}/api/auth/device-poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_code: deviceCodeResponse.device_code,
          client_id: CLIENT_ID,
        }),
      });

      if (res.ok) {
        // Approved — we have tokens
        const tokenData = (await res.json()) as {
          access_token: string;
          refresh_token?: string;
          token_type: string;
          expires_in: number;
        };

        pollSpin.stop();

        // Step 5: Save to config
        const config = loadConfig();
        config.authToken = tokenData.access_token;
        config.serverUrl = serverUrl;
        config.enabled = true;
        saveConfig(config);

        // Decode email from JWT payload (base64url)
        let email = "unknown";
        try {
          const parts = tokenData.access_token.split(".");
          if (parts.length >= 2) {
            const payload = JSON.parse(
              Buffer.from(parts[1], "base64url").toString(),
            );
            if (payload.email) {
              email = payload.email;
            }
          }
        } catch {
          /* ignore decode errors */
        }

        // Step 6: Print success
        console.log();
        success(`Logged in as ${bold(email)}`);
        info(`Config saved to ${dim(getDefaultConfigDir() + "/sync.json")}`);
        return;
      }

      // Check error type
      const errBody = (await res.json()) as { error: string };

      if (errBody.error === "authorization_pending") {
        // Still waiting — continue polling
        continue;
      }

      if (errBody.error === "access_denied") {
        pollSpin.fail("Login denied by user.");
        return;
      }

      if (errBody.error === "expired_token") {
        pollSpin.fail("Device code expired. Please run `saqrnest login` again.");
        return;
      }

      // Unexpected error
      pollSpin.fail(`Unexpected error: ${errBody.error}`);
      return;
    } catch (err) {
      // Network error — keep trying
      pollSpin.update(
        `Waiting for approval... (connection error, retrying)`,
      );
    }
  }

  pollSpin.fail("Device code expired. Please run `saqrnest login` again.");
}
