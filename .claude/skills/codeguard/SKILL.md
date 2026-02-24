---
name: codeguard
description: Manage codeguard security rules — list, add, disable, enable, browse, popular, install, history
---

# Codeguard Rule Manager

Manage the codeguard anti-pattern detection rules that run as PreToolUse hooks.

## Rule Layers

- **Global rules**: `~/.agentctx/codeguard-rules.json` — apply to all projects
- **Project rules**: `.claude/codeguard-rules.json` — override/extend global rules for this repo

Project rules with the same `id` override global rules entirely. New ids in project layer add to the set. Setting `enabled: false` in project layer suppresses a global rule for this repo only.

## Subcommands

Parse the user's input to determine which subcommand to run. Default to `list` if no subcommand is given.

### `/codeguard` or `/codeguard list`

Show all active rules (merged global + project). For each rule display:
- ID, severity (block/warn), enabled status
- Layer indicator: [global], [project], or [project override]
- Description
- File patterns and regex patterns (abbreviated if many)

Read both JSON files and merge them (project overrides global by id). Format as a clean table.

### `/codeguard add`

Interactively build a new rule. Ask the user for:
1. **id** — short kebab-case identifier (e.g., `no-any-type`)
2. **description** — what the rule catches
3. **severity** — `block` (prevents the edit) or `warn` (logs only)
4. **file_patterns** — which files to scan (e.g., `["*.ts", "*.js"]`)
5. **patterns** — grep -E regex patterns to match (ERE syntax, NOT PCRE)
6. **suggestion** — fix guidance shown to the developer
7. **exclude_patterns** (optional) — patterns that suppress false positives

By default write to project layer (`.claude/codeguard-rules.json`). If the user says `--global`, write to `~/.agentctx/codeguard-rules.json`.

Validate that each regex pattern is valid ERE by testing with `grep -E`. Reject invalid patterns before saving.

When writing, preserve existing rules in the file. Add the new rule to the `rules` array. Create the file with `{"version": 1, "rules": [...]}` if it doesn't exist.

### `/codeguard disable <id>`

Set `enabled: false` on a rule. Write to project layer as an override (copy the full rule from global with `enabled: false`). If the rule is already in the project layer, just flip the flag.

### `/codeguard enable <id>`

Set `enabled: true` on a rule. If the project layer has this rule just as a disable override (same as global but `enabled: false`), remove the project override entirely so the global rule takes effect. Otherwise set `enabled: true` in whichever layer has the rule.

### `/codeguard browse`

Show the **curated recommended rules** from the registry. These are hand-picked, high-confidence rules that most projects should use.

Server-backed: fetches from `{syncServerUrl}/api/codeguard/curated`. Falls back to local registry at `packages/gc-core/src/codeguard/registry.json` if server is unreachable. Display as a table:
- ID, severity, category
- Description
- Installs count (shows how widely used)
- Whether already installed locally (check merged rules)

Optionally filter by category: `/codeguard browse web-security`

### `/codeguard popular`

Show **all registry rules ranked by install count** (most popular first). This is the community signal — rules that the most users have enabled. Built from real telemetry data (opt-in users who share anonymous rule usage stats).

Server-backed: fetches from `{syncServerUrl}/api/codeguard/popular`. Falls back to local registry at `packages/gc-core/src/codeguard/registry.json` if server is unreachable. Display:
- Rank, ID, installs count, severity, category
- Description (one line)
- Whether already installed locally

Optionally filter by category: `/codeguard popular injection`

### `/codeguard install <id>`

Install a rule from the registry into local config.

1. Look up the rule in `packages/gc-core/src/codeguard/registry.json`
2. If not found, report error
3. Check if rule already exists in merged local config — if so, report it's already installed
4. Strip registry metadata (`category`, `tags`, `curated`, `installs`)
5. Write the rule to project layer (`.claude/codeguard-rules.json`) by default, or `--global` for user layer
6. Confirm installation with rule details

### `/codeguard search <term>`

Search the registry by keyword. Matches against id, description, tags, and category. Returns results ranked by install count.

Example: `/codeguard search jwt` finds `jwt-no-verify`

### `/codeguard history`

Query recent codeguard violations. Check if the daemon socket exists at `~/.agentctx/daemon.sock`:
- If daemon is running: `curl --unix-socket ~/.agentctx/daemon.sock http://localhost/api/codeguard/violations`
- If not: report that the daemon is not running and history is unavailable

Display: timestamp, file, rule id, action (blocked/warned), matched pattern.

## File Format

```json
{
  "version": 1,
  "rules": [
    {
      "id": "rule-id",
      "description": "What the rule catches",
      "severity": "block",
      "enabled": true,
      "file_patterns": ["*.ts", "*.js"],
      "patterns": ["regex-pattern-1", "regex-pattern-2"],
      "exclude_patterns": ["test-pattern"],
      "suggestion": "How to fix the issue"
    }
  ]
}
```

## Registry

The rule registry at `packages/gc-core/src/codeguard/registry.json` contains all discoverable rules with metadata:
- `curated: true/false` — whether it's in the recommended list
- `installs: number` — popularity count (community signal)
- `category: string` — for filtering (web-security, injection, auth, cryptography, secrets, code-quality, typescript)
- `tags: string[]` — for search

The registry currently has 21 rules: 9 curated + 12 community.

## Important

- Always use `grep -E` compatible regex (ERE), not PCRE. No `\d`, `\w`, or lookaheads.
- Test pattern validity before saving by running `echo 'test' | grep -qE 'pattern'`
- Never overwrite the entire rules file — always merge with existing rules
- Show clear feedback after each operation
