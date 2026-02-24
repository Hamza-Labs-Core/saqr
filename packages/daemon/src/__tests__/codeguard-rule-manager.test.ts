/**
 * Tests for Codeguard RuleManager — CRUD operations and merge logic.
 *
 * Covers:
 * - Loading rules from files
 * - Saving rules to files
 * - CRUD operations (add, update, delete)
 * - Merge logic (project overrides global)
 * - Enable/disable flow
 * - Regex validation
 * - Duplicate ID rejection
 * - Reset to defaults
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuleManager, type CodeguardRule, type CodeguardRulesFile } from "../codeguard/rule-manager.js";

describe("RuleManager", () => {
  let tempDir: string;
  let agentctxDir: string;
  let projectDir: string;
  let manager: RuleManager;

  const sampleRule: CodeguardRule = {
    id: "test-rule",
    description: "A test rule",
    severity: "block",
    enabled: true,
    file_patterns: ["*.ts"],
    patterns: ["\\beval\\s*\\("],
    exclude_patterns: ["\\.test\\."],
    suggestion: "Don't use eval",
  };

  const globalRulesFile: CodeguardRulesFile = {
    version: 1,
    rules: [
      {
        id: "cors-wildcard",
        description: "CORS wildcard",
        severity: "block",
        enabled: true,
        file_patterns: ["*.ts"],
        patterns: ["cors.*origin.*\\*"],
        exclude_patterns: [],
        suggestion: "Use explicit origins",
      },
      {
        id: "eval-usage",
        description: "No eval",
        severity: "block",
        enabled: true,
        file_patterns: ["*.ts", "*.js"],
        patterns: ["\\beval\\s*\\("],
        exclude_patterns: [],
        suggestion: "Use JSON.parse",
      },
    ],
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codeguard-test-"));
    agentctxDir = join(tempDir, ".agentctx");
    projectDir = join(tempDir, "project");

    await mkdir(agentctxDir, { recursive: true });
    await mkdir(join(projectDir, ".claude"), { recursive: true });

    // Write global rules
    await writeFile(
      join(agentctxDir, "codeguard-rules.json"),
      JSON.stringify(globalRulesFile, null, 2),
    );

    manager = new RuleManager({ agentctxDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  describe("loadMergedRules", () => {
    it("should load global rules when no project rules exist", async () => {
      const rules = await manager.loadMergedRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].id).toBe("cors-wildcard");
      expect(rules[0].layer).toBe("global");
      expect(rules[1].id).toBe("eval-usage");
      expect(rules[1].layer).toBe("global");
    });

    it("should merge project rules over global rules", async () => {
      const projectRules: CodeguardRulesFile = {
        version: 1,
        rules: [
          {
            id: "eval-usage",
            description: "Eval is fine here",
            severity: "warn",
            enabled: true,
            file_patterns: ["*.ts"],
            patterns: ["\\beval\\s*\\("],
            exclude_patterns: [],
            suggestion: "Be careful",
          },
        ],
      };
      await writeFile(
        join(projectDir, ".claude", "codeguard-rules.json"),
        JSON.stringify(projectRules, null, 2),
      );

      const rules = await manager.loadMergedRules(projectDir);
      expect(rules).toHaveLength(2);

      const evalRule = rules.find((r) => r.id === "eval-usage")!;
      expect(evalRule.description).toBe("Eval is fine here");
      expect(evalRule.severity).toBe("warn");
      expect(evalRule.layer).toBe("project");
    });

    it("should add new project rules alongside global rules", async () => {
      const projectRules: CodeguardRulesFile = {
        version: 1,
        rules: [
          {
            id: "no-any-type",
            description: "No any type",
            severity: "block",
            enabled: true,
            file_patterns: ["*.ts"],
            patterns: [":\\s*any\\b"],
            exclude_patterns: [],
            suggestion: "Use a specific type",
          },
        ],
      };
      await writeFile(
        join(projectDir, ".claude", "codeguard-rules.json"),
        JSON.stringify(projectRules, null, 2),
      );

      const rules = await manager.loadMergedRules(projectDir);
      expect(rules).toHaveLength(3);
      expect(rules.map((r) => r.id)).toContain("no-any-type");
    });

    it("should return empty array when no rules files exist", async () => {
      const emptyManager = new RuleManager({ agentctxDir: join(tempDir, "nonexistent") });
      const rules = await emptyManager.loadMergedRules();
      expect(rules).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  describe("addRule", () => {
    it("should add a rule to the project layer", async () => {
      await manager.addRule(sampleRule, "project", projectDir);

      const content = JSON.parse(
        await readFile(join(projectDir, ".claude", "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      expect(content.rules).toHaveLength(1);
      expect(content.rules[0].id).toBe("test-rule");
    });

    it("should add a rule to the global layer", async () => {
      await manager.addRule(sampleRule, "global");

      const content = JSON.parse(
        await readFile(join(agentctxDir, "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      expect(content.rules).toHaveLength(3); // 2 existing + 1 new
      expect(content.rules[2].id).toBe("test-rule");
    });

    it("should reject duplicate rule ids", async () => {
      await manager.addRule(sampleRule, "project", projectDir);
      await expect(
        manager.addRule(sampleRule, "project", projectDir),
      ).rejects.toThrow("already exists");
    });
  });

  describe("updateRule", () => {
    it("should update an existing global rule", async () => {
      await manager.updateRule("cors-wildcard", { severity: "warn" }, "global");

      const content = JSON.parse(
        await readFile(join(agentctxDir, "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      const rule = content.rules.find((r) => r.id === "cors-wildcard")!;
      expect(rule.severity).toBe("warn");
    });

    it("should throw if rule not found", async () => {
      await expect(
        manager.updateRule("nonexistent", { severity: "warn" }, "global"),
      ).rejects.toThrow("not found");
    });
  });

  describe("deleteRule", () => {
    it("should delete a rule from the global layer", async () => {
      await manager.deleteRule("eval-usage", "global");

      const content = JSON.parse(
        await readFile(join(agentctxDir, "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      expect(content.rules).toHaveLength(1);
      expect(content.rules[0].id).toBe("cors-wildcard");
    });

    it("should throw if rule not found", async () => {
      await expect(
        manager.deleteRule("nonexistent", "global"),
      ).rejects.toThrow("not found");
    });
  });

  // -----------------------------------------------------------------------
  // Enable / Disable
  // -----------------------------------------------------------------------

  describe("disableRule", () => {
    it("should create a project override to disable a global rule", async () => {
      await manager.disableRule("eval-usage", projectDir);

      const content = JSON.parse(
        await readFile(join(projectDir, ".claude", "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      expect(content.rules).toHaveLength(1);
      expect(content.rules[0].id).toBe("eval-usage");
      expect(content.rules[0].enabled).toBe(false);
    });

    it("should flip existing project rule to disabled", async () => {
      // First add a rule, then disable it
      await manager.addRule(sampleRule, "project", projectDir);
      await manager.disableRule("test-rule", projectDir);

      const content = JSON.parse(
        await readFile(join(projectDir, ".claude", "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      const rule = content.rules.find((r) => r.id === "test-rule")!;
      expect(rule.enabled).toBe(false);
    });

    it("should throw if rule not found anywhere", async () => {
      await expect(manager.disableRule("nonexistent", projectDir)).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("enableRule", () => {
    it("should remove a disable-only project override", async () => {
      // Disable first (creates project override)
      await manager.disableRule("eval-usage", projectDir);

      // Enable (should remove project override since it's just a disable)
      await manager.enableRule("eval-usage", projectDir);

      const content = JSON.parse(
        await readFile(join(projectDir, ".claude", "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      expect(content.rules).toHaveLength(0);
    });

    it("should flip a custom project rule to enabled", async () => {
      const disabledRule = { ...sampleRule, enabled: false };
      await manager.addRule(disabledRule, "project", projectDir);
      await manager.enableRule("test-rule", projectDir);

      const content = JSON.parse(
        await readFile(join(projectDir, ".claude", "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      expect(content.rules[0].enabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe("validateRule", () => {
    it("should reject rules with empty id", async () => {
      const bad = { ...sampleRule, id: "" };
      await expect(manager.addRule(bad, "project", projectDir)).rejects.toThrow(
        "non-empty string id",
      );
    });

    it("should reject non-kebab-case ids", async () => {
      const bad = { ...sampleRule, id: "CamelCase" };
      await expect(manager.addRule(bad, "project", projectDir)).rejects.toThrow(
        "kebab-case",
      );
    });

    it("should reject invalid regex patterns", async () => {
      const bad = { ...sampleRule, patterns: ["[invalid"] };
      await expect(manager.addRule(bad, "project", projectDir)).rejects.toThrow(
        "Invalid regex",
      );
    });

    it("should reject rules with no patterns", async () => {
      const bad = { ...sampleRule, patterns: [] };
      await expect(manager.addRule(bad, "project", projectDir)).rejects.toThrow(
        "at least one pattern",
      );
    });

    it("should reject rules with empty description", async () => {
      const bad = { ...sampleRule, description: "" };
      await expect(manager.addRule(bad, "project", projectDir)).rejects.toThrow(
        "non-empty description",
      );
    });

    it("should reject invalid severity", async () => {
      const bad = { ...sampleRule, severity: "error" as "block" };
      await expect(manager.addRule(bad, "project", projectDir)).rejects.toThrow(
        "severity must be",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("resetToDefaults", () => {
    it("should reset global rules to defaults", async () => {
      const defaultsPath = join(tempDir, "defaults.json");
      const defaults: CodeguardRulesFile = {
        version: 1,
        rules: [{ ...sampleRule, id: "default-rule" }],
      };
      await writeFile(defaultsPath, JSON.stringify(defaults, null, 2));

      const managerWithDefaults = new RuleManager({
        agentctxDir,
        defaultRulesPath: defaultsPath,
      });
      await managerWithDefaults.resetToDefaults();

      const content = JSON.parse(
        await readFile(join(agentctxDir, "codeguard-rules.json"), "utf-8"),
      ) as CodeguardRulesFile;
      expect(content.rules).toHaveLength(1);
      expect(content.rules[0].id).toBe("default-rule");
    });

    it("should throw if no defaults path configured", async () => {
      await expect(manager.resetToDefaults()).rejects.toThrow(
        "No default rules path",
      );
    });
  });
});
