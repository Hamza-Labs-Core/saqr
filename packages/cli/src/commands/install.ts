/**
 * saqr install - Install hook integrations for coding agents.
 *
 * Usage:
 *   saqr install --claude-code   Install Claude Code hooks via settings.json
 *   saqr install --opencode      Install OpenCode plugin hooks
 *   saqr install --codex         Install Codex JSONL protocol hooks
 *   saqr install --all           Install all detected agent integrations
 *
 * Options:
 *   --force       Overwrite existing hook configuration
 *   --dry-run     Show what would be installed without writing files
 *   --help, -h    Show help for this command
 */

import { readFile, writeFile, mkdir, access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ParsedArgs } from "../bin/saqr.js";
import { error, info, success, warn, header, bold, cyan, dim } from "../utils/output.js";

const execFileAsync = promisify(execFile);

function printInstallHelp(): void {
  console.log(`
${bold("saqr install")} - Install hook integrations for coding agents

${bold("USAGE")}
  ${cyan("saqr install")} <integration> [options]

${bold("INTEGRATIONS")}
  ${cyan("--claude-code")}    Install Claude Code hooks via settings.json
  ${cyan("--opencode")}       Install OpenCode plugin hooks via .opencode/plugins/
  ${cyan("--codex")}          Install Codex JSONL protocol hooks via session watcher
  ${cyan("--all")}            Install all detected agent integrations

${bold("OPTIONS")}
  ${dim("--force")}       Overwrite existing hook configuration
  ${dim("--dry-run")}     Show what would be installed without writing files
  ${dim("--help, -h")}    Show this help message

${bold("EXAMPLES")}
  ${dim("$")} saqr install --claude-code
  ${dim("$")} saqr install --opencode --force
  ${dim("$")} saqr install --all --dry-run
`);
}

/**
 * Detect which agents are installed on the system.
 */
async function detectAgents(): Promise<string[]> {
  const found: string[] = [];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";

  // Claude Code
  try {
    await execFileAsync("which", ["claude"]);
    found.push("claude-code");
  } catch {
    try {
      const s = await stat(join(home, ".claude"));
      if (s.isDirectory()) found.push("claude-code");
    } catch {
      // Not found
    }
  }

  // OpenCode
  try {
    await execFileAsync("which", ["opencode"]);
    found.push("opencode");
  } catch {
    try {
      const s = await stat(join(home, ".opencode"));
      if (s.isDirectory()) found.push("opencode");
    } catch {
      // Not found
    }
  }

  // Codex
  try {
    await execFileAsync("which", ["codex"]);
    found.push("codex");
  } catch {
    try {
      const s = await stat(join(home, ".codex"));
      if (s.isDirectory()) found.push("codex");
    } catch {
      // Not found
    }
  }

  return found;
}

/**
 * The 10 Claude Code hook definitions.
 */
const CLAUDE_CODE_HOOKS = [
  { native: "SessionStart", unified: "SessionStarted", async: false, timeout: 5000 },
  { native: "UserPromptSubmit", unified: "UserPromptReceived", async: false, timeout: 5000 },
  { native: "PreToolUse", unified: "ToolCallRequested", async: true, timeout: 5000, matcher: ".*" },
  { native: "PostToolUse", unified: "ToolCallCompleted", async: true, timeout: 5000, matcher: ".*" },
  { native: "PostToolUseFailure", unified: "ToolCallFailed", async: true, timeout: 5000, matcher: ".*" },
  { native: "SubagentStart", unified: "AgentSpawned", async: true, timeout: 5000, matcher: ".*" },
  { native: "SubagentStop", unified: "AgentCompleted", async: true, timeout: 5000, matcher: ".*" },
  { native: "Stop", unified: "TurnCompleted", async: true, timeout: 5000 },
  { native: "PreCompact", unified: "CompactionTriggered", async: false, timeout: 5000 },
  { native: "SessionEnd", unified: "SessionEnded", async: true, timeout: 5000 },
] as const;

async function installClaudeCode(flags: Record<string, string | boolean>): Promise<void> {
  const dryRun = Boolean(flags["dry-run"]);
  const force = Boolean(flags["force"]);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";

  header("Claude Code Integration");

  if (dryRun) {
    info("Dry run mode - no files will be written");
  }

  if (force) {
    warn("Force mode: existing hooks will be overwritten");
  }

  const settingsPath = join(home, ".claude", "settings.json");
  const hookBinPath = join(home, ".agentctx", "bin", "agentctx-hook");

  // 1. Read existing settings
  let settings: Record<string, unknown> = {};
  try {
    const content = await readFile(settingsPath, "utf-8");
    settings = JSON.parse(content);
    info(`Found existing settings.json at ${settingsPath}`);
  } catch {
    info("No existing settings.json found, will create new");
  }

  // 2. Detect existing GC hooks
  const hooks: Record<string, unknown[]> = (settings.hooks as Record<string, unknown[]>) ?? {};
  let gcHookCount = 0;
  for (const entries of Object.values(hooks)) {
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry === "object" && entry !== null && "command" in entry) {
          const cmd = String((entry as Record<string, unknown>).command ?? "");
          if (cmd.includes("gc-hook")) gcHookCount++;
        }
      }
    }
  }
  if (gcHookCount > 0) {
    info(`Detected ${gcHookCount} existing GlobalContext hooks (will migrate)`);
  }

  if (dryRun) {
    info("Would install the following 10 hooks:");
    for (const h of CLAUDE_CODE_HOOKS) {
      info(`  ${h.native} -> ${h.unified} (${h.async ? "async" : "sync"})`);
    }
    return;
  }

  // 3. Build hook configuration
  for (const hookDef of CLAUDE_CODE_HOOKS) {
    const hookEntry: Record<string, unknown> = {
      type: "command",
      command: `${hookBinPath} claude-code ${hookDef.unified}`,
      async: hookDef.async,
      timeout: hookDef.timeout,
    };

    if ("matcher" in hookDef && hookDef.matcher !== undefined) {
      hookEntry.matcher = hookDef.matcher;
    }

    const existing = (hooks[hookDef.native] ?? []) as Record<string, unknown>[];
    const userHooks = existing.filter((h) => {
      const cmd = String(h.command ?? "");
      return !cmd.includes("gc-hook") && !cmd.includes("agentctx-hook");
    });

    hooks[hookDef.native] = [hookEntry, ...userHooks];
  }

  settings.hooks = hooks;

  // 4. Create backup
  try {
    await access(settingsPath, fsConstants.F_OK);
    const ts = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
    const backupPath = `${settingsPath}.bak.${ts}`;
    const content = await readFile(settingsPath, "utf-8");
    await writeFile(backupPath, content, "utf-8");
    info(`Backup created: ${backupPath}`);
  } catch {
    // No file to backup
  }

  // 5. Write settings.json
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  success(`Claude Code hooks installed (10 events) at ${settingsPath}`);
}

async function installOpenCode(flags: Record<string, string | boolean>): Promise<void> {
  const dryRun = Boolean(flags["dry-run"]);
  const force = Boolean(flags["force"]);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";

  header("OpenCode Integration");

  if (dryRun) {
    info("Dry run mode - no files will be written");
  }

  if (force) {
    warn("Force mode: existing plugin will be overwritten");
  }

  const pluginDir = join(home, ".opencode", "plugins", "agentctx");

  // Check if already installed
  try {
    await access(join(pluginDir, "plugin.json"), fsConstants.F_OK);
    if (!force) {
      info("OpenCode plugin already installed. Use --force to overwrite.");
      return;
    }
  } catch {
    // Not installed
  }

  if (dryRun) {
    info("Would create OpenCode plugin at:");
    info(`  ${pluginDir}/plugin.json`);
    info(`  ${pluginDir}/index.ts`);
    info(`  ${pluginDir}/event-handler.ts`);
    return;
  }

  await mkdir(pluginDir, { recursive: true });

  // Write plugin manifest
  const manifest = {
    name: "agentctx",
    version: "1.0.0",
    description: "AgentContext event capture for OpenCode sessions",
    author: "AgentContext",
    events: [
      "session.created", "session.deleted", "session.idle",
      "session.compacted", "message.updated", "tool.execute.before",
      "tool.execute.after", "permission.asked", "permission.replied",
    ],
    entrypoint: "index.ts",
  };
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );

  // Write stub files
  await writeFile(
    join(pluginDir, "index.ts"),
    '// AgentContext OpenCode Plugin\nexport default { name: "agentctx" };\n',
    "utf-8",
  );
  await writeFile(
    join(pluginDir, "event-handler.ts"),
    "// AgentContext OpenCode event handler\n",
    "utf-8",
  );

  success(`OpenCode plugin installed (9 event subscriptions) at ${pluginDir}`);
}

async function installCodex(flags: Record<string, string | boolean>): Promise<void> {
  const dryRun = Boolean(flags["dry-run"]);
  const force = Boolean(flags["force"]);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";

  header("Codex Integration");

  if (dryRun) {
    info("Dry run mode - no files will be written");
  }

  if (force) {
    warn("Force mode: existing watcher config will be overwritten");
  }

  const configDir = join(home, ".agentctx", "integrations", "codex");
  const sessionDir = join(home, ".codex", "sessions");

  if (dryRun) {
    info("Would configure Codex session watcher:");
    info(`  Config: ${configDir}/watcher.json`);
    info(`  Session dir: ${sessionDir}`);
    return;
  }

  await mkdir(configDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const watcherConfig = {
    enabled: true,
    session_dir: sessionDir,
    protocol: "jsonl",
    message_types: [
      "tool_use", "tool_result", "tool_error",
      "turn_end", "permission", "permission_response",
    ],
    created_at: new Date().toISOString(),
  };

  await writeFile(
    join(configDir, "watcher.json"),
    JSON.stringify(watcherConfig, null, 2) + "\n",
    "utf-8",
  );

  success(`Codex session watcher configured at ${configDir}`);
}

export async function runInstall(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] || args.flags["h"]) {
    printInstallHelp();
    return;
  }

  const claudeCode = Boolean(args.flags["claude-code"]);
  const opencode = Boolean(args.flags["opencode"]);
  const codex = Boolean(args.flags["codex"]);
  const all = Boolean(args.flags["all"]);

  if (!claudeCode && !opencode && !codex && !all) {
    error("No integration specified.");
    console.log(`\nRun ${cyan("saqr install --help")} for usage.\n`);
    process.exit(1);
  }

  let installed = 0;

  if (all) {
    header("Auto-detecting installed agents...");
    const detected = await detectAgents();
    if (detected.length === 0) {
      info("No agents detected on this system.");
    } else {
      info(`Detected agents: ${detected.join(", ")}`);
    }

    if (detected.includes("claude-code") || claudeCode) {
      await installClaudeCode(args.flags);
      installed++;
    }

    if (detected.includes("opencode") || opencode) {
      await installOpenCode(args.flags);
      installed++;
    }

    if (detected.includes("codex") || codex) {
      await installCodex(args.flags);
      installed++;
    }
  } else {
    if (claudeCode) {
      await installClaudeCode(args.flags);
      installed++;
    }

    if (opencode) {
      await installOpenCode(args.flags);
      installed++;
    }

    if (codex) {
      await installCodex(args.flags);
      installed++;
    }
  }

  console.log();
  success(`Processed ${installed} integration(s).`);
}
