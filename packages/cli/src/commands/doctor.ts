/**
 * saqr doctor - Run health checks on the saqr system.
 *
 * Usage:
 *   saqr doctor              Run all health checks
 *   saqr doctor --verbose    Show detailed diagnostic output
 *
 * Checks:
 *   - Daemon connectivity (socket exists, responds to ping)
 *   - Installed integrations and their hook status
 *   - Agent detection (which agents are installed on the system)
 *   - Event store accessibility and integrity
 *   - Configuration validity
 *
 * Options:
 *   --verbose      Show detailed diagnostic output
 *   --json         Output results as JSON
 *   --help, -h     Show help for this command
 */

import { readFile, access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  symbols,
} from "../utils/output.js";

const execFileAsync = promisify(execFile);

function printDoctorHelp(): void {
  console.log(`
${bold("saqr doctor")} - Run health checks on the saqr system

${bold("USAGE")}
  ${cyan("saqr doctor")} [options]

${bold("OPTIONS")}
  ${dim("--verbose")}      Show detailed diagnostic output
  ${dim("--json")}         Output results as JSON
  ${dim("--help, -h")}     Show this help message

${bold("CHECKS")}
  ${symbols.bullet} Daemon connectivity (socket, ping/pong)
  ${symbols.bullet} Installed integrations and hook status
  ${symbols.bullet} Agent detection (Claude Code, OpenCode, Codex)
  ${symbols.bullet} Event store accessibility
  ${symbols.bullet} Configuration validity

${bold("EXAMPLES")}
  ${dim("$")} saqr doctor
  ${dim("$")} saqr doctor --verbose
  ${dim("$")} saqr doctor --json
`);
}

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  details?: string;
}

async function checkDaemon(verbose: boolean): Promise<CheckResult> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const socketPath = join(home, ".agentctx", "daemon.sock");
  const pidPath = join(home, ".agentctx", "daemon.pid");

  // Check if daemon socket exists
  try {
    await access(socketPath, fsConstants.F_OK);
    // Check PID file
    try {
      const pidContent = await readFile(pidPath, "utf-8");
      const pid = parseInt(pidContent.trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0); // Check if process exists
          return {
            name: "Daemon",
            status: "pass",
            message: `Running (PID ${pid})`,
            details: verbose ? `Socket: ${socketPath}, PID: ${pid}` : undefined,
          };
        } catch {
          return {
            name: "Daemon",
            status: "warn",
            message: "Socket exists but process not running (stale)",
            details: verbose ? `Stale PID file: ${pidPath}` : undefined,
          };
        }
      }
    } catch {
      // No PID file
    }

    return {
      name: "Daemon",
      status: "warn",
      message: "Socket exists but no PID file found",
      details: verbose ? `Socket: ${socketPath}` : undefined,
    };
  } catch {
    return {
      name: "Daemon",
      status: "warn",
      message: "Not running (no socket found)",
      details: verbose ? `Expected socket at: ${socketPath}` : undefined,
    };
  }
}

async function checkClaudeCode(verbose: boolean): Promise<CheckResult> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const settingsPath = join(home, ".claude", "settings.json");
  const hookBinPath = join(home, ".agentctx", "bin", "agentctx-hook");
  const issues: string[] = [];

  // Check 1: Claude Code binary or directory
  let agentFound = false;
  try {
    await execFileAsync("which", ["claude"]);
    agentFound = true;
  } catch {
    try {
      const s = await stat(join(home, ".claude"));
      agentFound = s.isDirectory();
    } catch {
      // Not found
    }
  }

  if (!agentFound) {
    return {
      name: "Claude Code Hooks",
      status: "skip",
      message: "Claude Code not detected",
      details: verbose ? "Neither 'claude' binary nor ~/.claude/ directory found" : undefined,
    };
  }

  // Check 2: settings.json exists and is valid
  let settingsObj: Record<string, unknown> = {};
  try {
    const content = await readFile(settingsPath, "utf-8");
    settingsObj = JSON.parse(content);
  } catch {
    return {
      name: "Claude Code Hooks",
      status: "fail",
      message: "settings.json missing or invalid",
      details: verbose ? `Expected at: ${settingsPath}` : undefined,
    };
  }

  // Check 3: All 10 hooks present
  const hooks = (settingsObj.hooks ?? {}) as Record<string, unknown[]>;
  const expectedHooks = [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop",
    "PreCompact", "SessionEnd",
  ];

  let hookCount = 0;
  const missingHooks: string[] = [];
  for (const hookName of expectedHooks) {
    const entries = (hooks[hookName] ?? []) as Record<string, unknown>[];
    if (entries.some((h) => String(h.command ?? "").includes("agentctx-hook"))) {
      hookCount++;
    } else {
      missingHooks.push(hookName);
    }
  }

  if (hookCount < 10) {
    issues.push(`${hookCount}/10 hooks registered`);
    if (verbose && missingHooks.length > 0) {
      issues.push(`Missing: ${missingHooks.join(", ")}`);
    }
  }

  // Check 4: agentctx-hook is executable
  try {
    await access(hookBinPath, fsConstants.X_OK);
  } catch {
    issues.push("agentctx-hook not executable");
  }

  // Check 5: Detect stale GC hooks
  let staleGcHooks = 0;
  for (const entries of Object.values(hooks)) {
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry === "object" && entry !== null && "command" in entry) {
          if (String((entry as Record<string, unknown>).command ?? "").includes("gc-hook")) {
            staleGcHooks++;
          }
        }
      }
    }
  }
  if (staleGcHooks > 0) {
    issues.push(`${staleGcHooks} stale GlobalContext hooks found. Run: saqr install --claude-code`);
  }

  if (issues.length === 0 && hookCount === 10) {
    return {
      name: "Claude Code Hooks",
      status: "pass",
      message: `${hookCount}/10 hooks registered`,
      details: verbose ? `Settings: ${settingsPath}` : undefined,
    };
  }

  return {
    name: "Claude Code Hooks",
    status: hookCount < 10 ? "fail" : (staleGcHooks > 0 ? "warn" : "pass"),
    message: issues.join("; "),
    details: verbose ? `Settings: ${settingsPath}` : undefined,
  };
}

async function checkOpenCode(verbose: boolean): Promise<CheckResult> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const pluginDir = join(home, ".opencode", "plugins", "agentctx");

  // Check if OpenCode is installed
  let agentFound = false;
  try {
    await execFileAsync("which", ["opencode"]);
    agentFound = true;
  } catch {
    try {
      const s = await stat(join(home, ".opencode"));
      agentFound = s.isDirectory();
    } catch {
      // Not found
    }
  }

  if (!agentFound) {
    return {
      name: "OpenCode Hooks",
      status: "skip",
      message: "OpenCode not detected",
      details: verbose ? "Neither 'opencode' binary nor ~/.opencode/ directory found" : undefined,
    };
  }

  // Check plugin
  try {
    const content = await readFile(join(pluginDir, "plugin.json"), "utf-8");
    const manifest = JSON.parse(content);
    const eventCount = Array.isArray(manifest.events) ? manifest.events.length : 0;

    if (eventCount === 9) {
      return {
        name: "OpenCode Hooks",
        status: "pass",
        message: `Plugin installed (${eventCount}/9 events)`,
        details: verbose ? `Plugin: ${pluginDir}` : undefined,
      };
    }

    return {
      name: "OpenCode Hooks",
      status: "warn",
      message: `Plugin has ${eventCount}/9 event subscriptions`,
      details: verbose ? `Plugin: ${pluginDir}` : undefined,
    };
  } catch {
    return {
      name: "OpenCode Hooks",
      status: "fail",
      message: "Plugin not installed or invalid",
      details: verbose ? `Expected at: ${pluginDir}` : undefined,
    };
  }
}

async function checkCodex(verbose: boolean): Promise<CheckResult> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const configPath = join(home, ".agentctx", "integrations", "codex", "watcher.json");

  // Check if Codex is installed
  let agentFound = false;
  try {
    await execFileAsync("which", ["codex"]);
    agentFound = true;
  } catch {
    try {
      const s = await stat(join(home, ".codex"));
      agentFound = s.isDirectory();
    } catch {
      // Not found
    }
  }

  if (!agentFound) {
    return {
      name: "Codex Hooks",
      status: "skip",
      message: "Codex not detected",
      details: verbose ? "Neither 'codex' binary nor ~/.codex/ directory found" : undefined,
    };
  }

  // Check watcher config
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);

    if (config.enabled) {
      return {
        name: "Codex Hooks",
        status: "pass",
        message: "Watcher configured and enabled",
        details: verbose ? `Config: ${configPath}, Session dir: ${config.session_dir}` : undefined,
      };
    }

    return {
      name: "Codex Hooks",
      status: "warn",
      message: "Watcher configured but disabled",
    };
  } catch {
    return {
      name: "Codex Hooks",
      status: "fail",
      message: "Watcher not configured",
      details: verbose ? `Expected at: ${configPath}` : undefined,
    };
  }
}

async function checkAgentDetection(verbose: boolean): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";

  const agents = [
    { name: "Claude Code", binary: "claude", dir: ".claude" },
    { name: "OpenCode", binary: "opencode", dir: ".opencode" },
    { name: "Codex", binary: "codex", dir: ".codex" },
  ];

  for (const agent of agents) {
    let version = "unknown";
    let found = false;

    try {
      const { stdout } = await execFileAsync("which", [agent.binary]);
      found = true;
      try {
        const { stdout: ver } = await execFileAsync(agent.binary, ["--version"]);
        version = ver.trim().split("\n")[0];
      } catch {
        // Version unavailable
      }
    } catch {
      try {
        const s = await stat(join(home, agent.dir));
        if (s.isDirectory()) {
          found = true;
          version = "directory found (binary not in PATH)";
        }
      } catch {
        // Not found
      }
    }

    results.push({
      name: `Agent: ${agent.name}`,
      status: found ? "pass" : "skip",
      message: found ? `Found (${version})` : "Not installed",
      details: verbose ? `Binary: ${agent.binary}, Config dir: ~/${agent.dir}` : undefined,
    });
  }

  return results;
}

async function checkEventStore(verbose: boolean): Promise<CheckResult> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const eventsDir = join(home, ".saqr", "events");
  const legacyDir = join(home, ".claude-context", "events");

  // Check Saqr events directory
  try {
    const s = await stat(eventsDir);
    if (s.isDirectory()) {
      return {
        name: "Event Store",
        status: "pass",
        message: `Accessible at ${eventsDir}`,
        details: verbose ? `Path: ${eventsDir}` : undefined,
      };
    }
  } catch {
    // Check legacy path
  }

  // Check legacy GlobalContext path
  try {
    const s = await stat(legacyDir);
    if (s.isDirectory()) {
      return {
        name: "Event Store",
        status: "pass",
        message: `Legacy path accessible at ${legacyDir}`,
        details: verbose ? `Legacy path: ${legacyDir}. Consider migrating.` : undefined,
      };
    }
  } catch {
    // Not found
  }

  return {
    name: "Event Store",
    status: "warn",
    message: "Event store directory not found",
    details: verbose ? `Expected at: ${eventsDir}` : undefined,
  };
}

function statusSymbol(status: "pass" | "warn" | "fail" | "skip"): string {
  switch (status) {
    case "pass":
      return green("PASS");
    case "warn":
      return yellow("WARN");
    case "fail":
      return red("FAIL");
    case "skip":
      return dim("SKIP");
  }
}

export async function runDoctor(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printDoctorHelp();
    return;
  }

  const verbose = Boolean(args.flags["verbose"]);
  const jsonOutput = Boolean(args.flags["json"]);

  header("Saqr System Health Check");

  const allResults: CheckResult[] = [];

  // Run all checks
  allResults.push(await checkDaemon(verbose));
  allResults.push(await checkClaudeCode(verbose));
  allResults.push(await checkOpenCode(verbose));
  allResults.push(await checkCodex(verbose));
  allResults.push(...(await checkAgentDetection(verbose)));
  allResults.push(await checkEventStore(verbose));

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
    return;
  }

  // Display results
  console.log();
  table(
    [
      { label: "Check", width: 24 },
      { label: "Status", width: 8 },
      { label: "Message" },
    ],
    allResults.map((r) => [r.name, statusSymbol(r.status), r.message]),
  );

  if (verbose) {
    const withDetails = allResults.filter((r) => r.details);
    if (withDetails.length > 0) {
      console.log();
      for (const r of withDetails) {
        console.log(`${dim(r.name + ":")} ${r.details}`);
      }
    }
  }

  // Summary
  const passed = allResults.filter((r) => r.status === "pass").length;
  const warned = allResults.filter((r) => r.status === "warn").length;
  const failed = allResults.filter((r) => r.status === "fail").length;
  const skipped = allResults.filter((r) => r.status === "skip").length;

  console.log();
  if (failed > 0) {
    error(`${failed} check(s) failed, ${warned} warning(s), ${passed} passed, ${skipped} skipped`);
    process.exit(1);
  } else if (warned > 0) {
    warn(`${warned} warning(s), ${passed} passed, ${skipped} skipped`);
  } else {
    success(`All ${passed} checks passed (${skipped} skipped)`);
  }
}
