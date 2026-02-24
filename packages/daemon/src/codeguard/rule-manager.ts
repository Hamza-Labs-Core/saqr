/**
 * Codeguard Rule Manager — CRUD operations for security anti-pattern rules.
 *
 * Manages two rule layers:
 * - Global rules: ~/.agentctx/codeguard-rules.json (all projects)
 * - Project rules: $PROJECT_DIR/.claude/codeguard-rules.json (per-repo overrides)
 *
 * Merge semantics: project rules with matching `id` override global rules.
 * New project rules extend the global set. Project `enabled: false` suppresses
 * a global rule for that repo only.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuleSeverity = "block" | "warn";

export interface CodeguardRule {
  /** Short kebab-case identifier */
  id: string;
  /** Human-readable description of what the rule catches */
  description: string;
  /** block = prevent the edit, warn = log only */
  severity: RuleSeverity;
  /** Whether the rule is active */
  enabled: boolean;
  /** Glob patterns for files to scan (e.g., ["*.ts", "*.js"]) */
  file_patterns: string[];
  /** grep -E (ERE) regex patterns to match against content */
  patterns: string[];
  /** Patterns that suppress false positives */
  exclude_patterns: string[];
  /** Fix guidance shown when the rule triggers */
  suggestion: string;
}

export interface CodeguardRulesFile {
  version: number;
  rules: CodeguardRule[];
}

export type RuleLayer = "global" | "project";

export interface MergedRule extends CodeguardRule {
  /** Which layer this rule came from after merging */
  layer: RuleLayer;
}

// ---------------------------------------------------------------------------
// RuleManager
// ---------------------------------------------------------------------------

export class RuleManager {
  private globalRulesPath: string;
  private defaultRulesPath: string | undefined;

  constructor(options?: {
    agentctxDir?: string;
    defaultRulesPath?: string;
  }) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const agentctxDir = options?.agentctxDir ?? join(home, ".agentctx");
    this.globalRulesPath = join(agentctxDir, "codeguard-rules.json");
    this.defaultRulesPath = options?.defaultRulesPath;
  }

  // -------------------------------------------------------------------------
  // File I/O
  // -------------------------------------------------------------------------

  private async loadRulesFile(path: string): Promise<CodeguardRulesFile> {
    try {
      await access(path, fsConstants.R_OK);
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as CodeguardRulesFile;
      return {
        version: parsed.version ?? 1,
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      };
    } catch {
      return { version: 1, rules: [] };
    }
  }

  private async saveRulesFile(
    path: string,
    data: CodeguardRulesFile,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  private projectRulesPath(projectDir: string): string {
    return join(projectDir, ".claude", "codeguard-rules.json");
  }

  // -------------------------------------------------------------------------
  // Merge Logic
  // -------------------------------------------------------------------------

  /**
   * Load and merge global + project rules.
   * Project rules override global rules by matching `id`.
   */
  async loadMergedRules(projectDir?: string): Promise<MergedRule[]> {
    const globalFile = await this.loadRulesFile(this.globalRulesPath);
    const merged = new Map<string, MergedRule>();

    // Add global rules
    for (const rule of globalFile.rules) {
      merged.set(rule.id, { ...rule, layer: "global" });
    }

    // Overlay project rules (override by id)
    if (projectDir) {
      const projectFile = await this.loadRulesFile(
        this.projectRulesPath(projectDir),
      );
      for (const rule of projectFile.rules) {
        merged.set(rule.id, { ...rule, layer: "project" });
      }
    }

    return Array.from(merged.values());
  }

  // -------------------------------------------------------------------------
  // Read Operations
  // -------------------------------------------------------------------------

  async listRules(projectDir?: string): Promise<MergedRule[]> {
    return this.loadMergedRules(projectDir);
  }

  async getRule(
    id: string,
    projectDir?: string,
  ): Promise<MergedRule | undefined> {
    const rules = await this.loadMergedRules(projectDir);
    return rules.find((r) => r.id === id);
  }

  // -------------------------------------------------------------------------
  // Write Operations
  // -------------------------------------------------------------------------

  /**
   * Add a new rule. Throws if a rule with the same id already exists in the target layer.
   */
  async addRule(
    rule: CodeguardRule,
    layer: RuleLayer = "project",
    projectDir?: string,
  ): Promise<void> {
    this.validateRule(rule);

    const path =
      layer === "global"
        ? this.globalRulesPath
        : this.projectRulesPath(projectDir!);
    const file = await this.loadRulesFile(path);

    if (file.rules.some((r) => r.id === rule.id)) {
      throw new Error(`Rule with id '${rule.id}' already exists in ${layer} layer`);
    }

    file.rules.push(rule);
    await this.saveRulesFile(path, file);
  }

  /**
   * Update an existing rule in the specified layer.
   */
  async updateRule(
    id: string,
    updates: Partial<Omit<CodeguardRule, "id">>,
    layer: RuleLayer = "project",
    projectDir?: string,
  ): Promise<void> {
    const path =
      layer === "global"
        ? this.globalRulesPath
        : this.projectRulesPath(projectDir!);
    const file = await this.loadRulesFile(path);

    const idx = file.rules.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new Error(`Rule '${id}' not found in ${layer} layer`);
    }

    file.rules[idx] = { ...file.rules[idx], ...updates };

    if (updates.patterns) {
      this.validatePatterns(updates.patterns);
    }

    await this.saveRulesFile(path, file);
  }

  /**
   * Disable a rule. Writes to project layer as an override.
   */
  async disableRule(id: string, projectDir?: string): Promise<void> {
    const projectPath = this.projectRulesPath(projectDir!);
    const projectFile = await this.loadRulesFile(projectPath);

    const existingIdx = projectFile.rules.findIndex((r) => r.id === id);
    if (existingIdx !== -1) {
      // Already in project layer — just flip the flag
      projectFile.rules[existingIdx].enabled = false;
    } else {
      // Copy from global and disable
      const globalFile = await this.loadRulesFile(this.globalRulesPath);
      const globalRule = globalFile.rules.find((r) => r.id === id);
      if (!globalRule) {
        throw new Error(`Rule '${id}' not found`);
      }
      projectFile.rules.push({ ...globalRule, enabled: false });
    }

    await this.saveRulesFile(projectPath, projectFile);
  }

  /**
   * Enable a rule. If the project layer only has a disable override, remove it.
   */
  async enableRule(id: string, projectDir?: string): Promise<void> {
    const projectPath = this.projectRulesPath(projectDir!);
    const projectFile = await this.loadRulesFile(projectPath);

    const existingIdx = projectFile.rules.findIndex((r) => r.id === id);
    if (existingIdx !== -1) {
      const projectRule = projectFile.rules[existingIdx];

      // Check if this is just a disable override of a global rule
      const globalFile = await this.loadRulesFile(this.globalRulesPath);
      const globalRule = globalFile.rules.find((r) => r.id === id);

      if (
        globalRule &&
        !projectRule.enabled &&
        projectRule.description === globalRule.description
      ) {
        // It's just a disable override — remove it so global takes effect
        projectFile.rules.splice(existingIdx, 1);
      } else {
        // It's a custom project rule — flip the flag
        projectFile.rules[existingIdx].enabled = true;
      }
    } else {
      // Not in project layer — check if it's disabled in global
      const globalFile = await this.loadRulesFile(this.globalRulesPath);
      const globalIdx = globalFile.rules.findIndex((r) => r.id === id);
      if (globalIdx !== -1) {
        globalFile.rules[globalIdx].enabled = true;
        await this.saveRulesFile(this.globalRulesPath, globalFile);
        return;
      }
      throw new Error(`Rule '${id}' not found`);
    }

    await this.saveRulesFile(projectPath, projectFile);
  }

  /**
   * Delete a rule from the specified layer.
   */
  async deleteRule(
    id: string,
    layer: RuleLayer = "project",
    projectDir?: string,
  ): Promise<void> {
    const path =
      layer === "global"
        ? this.globalRulesPath
        : this.projectRulesPath(projectDir!);
    const file = await this.loadRulesFile(path);

    const idx = file.rules.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new Error(`Rule '${id}' not found in ${layer} layer`);
    }

    file.rules.splice(idx, 1);
    await this.saveRulesFile(path, file);
  }

  /**
   * Reset global rules to defaults.
   */
  async resetToDefaults(): Promise<void> {
    if (!this.defaultRulesPath) {
      throw new Error("No default rules path configured");
    }
    const defaults = await this.loadRulesFile(this.defaultRulesPath);
    await this.saveRulesFile(this.globalRulesPath, defaults);
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Validate a rule. Throws on invalid data.
   */
  validateRule(rule: CodeguardRule): void {
    if (!rule.id || typeof rule.id !== "string") {
      throw new Error("Rule must have a non-empty string id");
    }
    if (!/^[a-z0-9-]+$/.test(rule.id)) {
      throw new Error("Rule id must be kebab-case (lowercase alphanumeric and hyphens)");
    }
    if (!rule.description || typeof rule.description !== "string") {
      throw new Error("Rule must have a non-empty description");
    }
    if (rule.severity !== "block" && rule.severity !== "warn") {
      throw new Error("Rule severity must be 'block' or 'warn'");
    }
    if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) {
      throw new Error("Rule must have at least one pattern");
    }
    this.validatePatterns(rule.patterns);
    if (rule.exclude_patterns) {
      this.validatePatterns(rule.exclude_patterns);
    }
  }

  /**
   * Validate that all patterns are valid regular expressions.
   */
  private validatePatterns(patterns: string[]): void {
    for (const pattern of patterns) {
      try {
        new RegExp(pattern);
      } catch (err) {
        throw new Error(
          `Invalid regex pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
