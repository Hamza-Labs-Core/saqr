/**
 * Tests for Codeguard RuleRegistry — Browse and install from curated catalog.
 *
 * Covers:
 * - Loading registry from file
 * - Curated list (filtered, sorted by installs)
 * - Popular list (all rules, sorted by installs)
 * - Search by term (id, description, tags, category)
 * - Category listing
 * - Single rule lookup
 * - Converting registry rule to local rule (strip metadata)
 * - Filtering by category
 * - Limit option
 * - Cache behavior
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuleRegistry, type RegistryFile } from "../codeguard/rule-registry.js";

describe("RuleRegistry", () => {
  let tempDir: string;
  let registryPath: string;
  let registry: RuleRegistry;

  const sampleRegistry: RegistryFile = {
    version: 1,
    updated: "2026-02-23",
    rules: [
      {
        id: "eval-usage",
        description: "eval() enables code injection",
        severity: "block",
        enabled: true,
        category: "injection",
        tags: ["eval", "code-injection", "owasp"],
        curated: true,
        installs: 5130,
        file_patterns: ["*.ts", "*.js"],
        patterns: ["\\beval\\s*\\("],
        exclude_patterns: [],
        suggestion: "Use JSON.parse()",
      },
      {
        id: "hardcoded-secret",
        description: "Hardcoded secrets get committed and leaked",
        severity: "block",
        enabled: true,
        category: "secrets",
        tags: ["password", "api-key", "credentials"],
        curated: true,
        installs: 5340,
        file_patterns: ["*.ts", "*.js"],
        patterns: ["password\\s*="],
        exclude_patterns: [],
        suggestion: "Use env vars",
      },
      {
        id: "no-any-type",
        description: "TypeScript any defeats the type system",
        severity: "warn",
        enabled: true,
        category: "typescript",
        tags: ["typescript", "types", "strict"],
        curated: false,
        installs: 3890,
        file_patterns: ["*.ts"],
        patterns: [":\\s*any\\b"],
        exclude_patterns: [],
        suggestion: "Use unknown",
      },
      {
        id: "shell-injection",
        description: "User input in shell commands enables command injection",
        severity: "block",
        enabled: true,
        category: "injection",
        tags: ["shell", "exec", "command-injection"],
        curated: false,
        installs: 2980,
        file_patterns: ["*.ts", "*.js"],
        patterns: ["exec\\(.*\\$\\{"],
        exclude_patterns: [],
        suggestion: "Use execFile()",
      },
      {
        id: "insecure-cookie",
        description: "Cookies without Secure flag are vulnerable",
        severity: "warn",
        enabled: true,
        category: "web-security",
        tags: ["cookie", "session", "auth"],
        curated: false,
        installs: 2210,
        file_patterns: ["*.ts", "*.js"],
        patterns: ["res\\.cookie"],
        exclude_patterns: [],
        suggestion: "Set secure: true",
      },
    ],
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codeguard-registry-test-"));
    registryPath = join(tempDir, "registry.json");
    await writeFile(registryPath, JSON.stringify(sampleRegistry, null, 2));
    registry = new RuleRegistry(registryPath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  describe("load", () => {
    it("should load registry from file", async () => {
      const data = await registry.load();
      expect(data.version).toBe(1);
      expect(data.rules).toHaveLength(5);
    });

    it("should cache after first load", async () => {
      const first = await registry.load();
      const second = await registry.load();
      expect(first).toBe(second); // same reference
    });

    it("should clear cache on clearCache()", async () => {
      const first = await registry.load();
      registry.clearCache();
      const second = await registry.load();
      expect(first).not.toBe(second); // different reference
      expect(first).toEqual(second); // same data
    });
  });

  // -----------------------------------------------------------------------
  // Curated
  // -----------------------------------------------------------------------

  describe("curated", () => {
    it("should return only curated rules", async () => {
      const rules = await registry.curated();
      expect(rules).toHaveLength(2);
      expect(rules.every((r) => r.curated)).toBe(true);
    });

    it("should sort curated rules by installs descending", async () => {
      const rules = await registry.curated();
      expect(rules[0].id).toBe("hardcoded-secret"); // 5340
      expect(rules[1].id).toBe("eval-usage"); // 5130
    });

    it("should filter curated by category", async () => {
      const rules = await registry.curated({ category: "injection" });
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("eval-usage");
    });
  });

  // -----------------------------------------------------------------------
  // Popular
  // -----------------------------------------------------------------------

  describe("popular", () => {
    it("should return all rules sorted by installs", async () => {
      const rules = await registry.popular();
      expect(rules).toHaveLength(5);
      expect(rules[0].id).toBe("hardcoded-secret"); // 5340
      expect(rules[1].id).toBe("eval-usage"); // 5130
      expect(rules[4].id).toBe("insecure-cookie"); // 2210
    });

    it("should respect limit option", async () => {
      const rules = await registry.popular({ limit: 3 });
      expect(rules).toHaveLength(3);
    });

    it("should filter popular by category", async () => {
      const rules = await registry.popular({ category: "injection" });
      expect(rules).toHaveLength(2);
      expect(rules[0].id).toBe("eval-usage"); // 5130
      expect(rules[1].id).toBe("shell-injection"); // 2980
    });
  });

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  describe("search", () => {
    it("should find rules by id", async () => {
      const rules = await registry.search("eval");
      expect(rules.some((r) => r.id === "eval-usage")).toBe(true);
    });

    it("should find rules by tag", async () => {
      const rules = await registry.search("owasp");
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("eval-usage");
    });

    it("should find rules by description keyword", async () => {
      const rules = await registry.search("TypeScript");
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("no-any-type");
    });

    it("should find rules by category", async () => {
      const rules = await registry.search("injection");
      expect(rules).toHaveLength(2);
    });

    it("should return empty for no match", async () => {
      const rules = await registry.search("nonexistent-xyz");
      expect(rules).toHaveLength(0);
    });

    it("should be case-insensitive", async () => {
      const rules = await registry.search("EVAL");
      expect(rules.some((r) => r.id === "eval-usage")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Categories
  // -----------------------------------------------------------------------

  describe("categories", () => {
    it("should return unique sorted categories", async () => {
      const cats = await registry.categories();
      expect(cats).toEqual(["injection", "secrets", "typescript", "web-security"]);
    });
  });

  // -----------------------------------------------------------------------
  // Single Lookup
  // -----------------------------------------------------------------------

  describe("get", () => {
    it("should return a rule by id", async () => {
      const rule = await registry.get("eval-usage");
      expect(rule).toBeDefined();
      expect(rule!.installs).toBe(5130);
    });

    it("should return undefined for unknown id", async () => {
      const rule = await registry.get("nonexistent");
      expect(rule).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Convert to Local
  // -----------------------------------------------------------------------

  describe("toLocalRule", () => {
    it("should strip registry metadata", async () => {
      const registryRule = (await registry.get("eval-usage"))!;
      const local = registry.toLocalRule(registryRule);

      expect(local.id).toBe("eval-usage");
      expect(local.enabled).toBe(true);
      expect(local.patterns).toEqual(["\\beval\\s*\\("]);
      // Should not have registry-only fields
      expect((local as Record<string, unknown>).category).toBeUndefined();
      expect((local as Record<string, unknown>).tags).toBeUndefined();
      expect((local as Record<string, unknown>).curated).toBeUndefined();
      expect((local as Record<string, unknown>).installs).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Count
  // -----------------------------------------------------------------------

  describe("count", () => {
    it("should return total number of rules", async () => {
      const count = await registry.count();
      expect(count).toBe(5);
    });
  });
});
