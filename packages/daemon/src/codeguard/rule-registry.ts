/**
 * Codeguard Rule Registry — Browse and install rules from a curated catalog.
 *
 * Provides two discovery views:
 * - **Curated**: Hand-picked recommended rules (curated: true)
 * - **Popular**: All rules ranked by install count
 *
 * Users browse these lists and install rules into their local config
 * (global or project layer) via RuleManager.
 */

import { readFile } from "node:fs/promises";
import type { CodeguardRule } from "./rule-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryRule extends CodeguardRule {
  /** Category for grouping (e.g., "web-security", "injection", "auth") */
  category: string;
  /** Searchable tags */
  tags: string[];
  /** Whether this rule is in the curated recommended list */
  curated: boolean;
  /** Number of users/projects using this rule */
  installs: number;
}

export interface RegistryFile {
  version: number;
  updated: string;
  rules: RegistryRule[];
}

export interface BrowseOptions {
  /** Filter by category */
  category?: string;
  /** Search term (matches id, description, tags) */
  search?: string;
  /** Max results to return */
  limit?: number;
}

// ---------------------------------------------------------------------------
// RuleRegistry
// ---------------------------------------------------------------------------

export class RuleRegistry {
  private registryPath: string;
  private cache: RegistryFile | null = null;
  private serverUrl?: string;
  private serverCache: {
    curated?: { data: RegistryRule[]; fetchedAt: number };
    popular?: { data: RegistryRule[]; fetchedAt: number };
  } = {};
  private cacheTtlMs = 3_600_000; // 1 hour

  constructor(registryPath: string, options?: { serverUrl?: string }) {
    this.registryPath = registryPath;
    this.serverUrl = options?.serverUrl;
  }

  /**
   * Load the registry file (cached after first load).
   */
  async load(): Promise<RegistryFile> {
    if (this.cache) return this.cache;

    const content = await readFile(this.registryPath, "utf-8");
    this.cache = JSON.parse(content) as RegistryFile;
    return this.cache;
  }

  /**
   * Clear the cached registry (for reload after updates).
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Browse curated rules — the recommended list.
   * When serverUrl is configured, tries fetching from server first (with 1h cache TTL).
   * Falls back to local file if server is unreachable.
   */
  async curated(options?: BrowseOptions): Promise<RegistryRule[]> {
    if (this.serverUrl) {
      const cached = this.serverCache.curated;
      const now = Date.now();
      if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
        let rules = [...cached.data];
        rules = this.applyFilters(rules, options);
        return rules.sort((a, b) => b.installs - a.installs);
      }
      try {
        const response = await fetch(`${this.serverUrl}/api/codeguard/registry/curated`);
        if (response.ok) {
          const data = (await response.json()) as { rules: RegistryRule[] };
          const serverRules = Array.isArray(data.rules) ? data.rules : [];
          this.serverCache.curated = { data: serverRules, fetchedAt: now };
          let rules = [...serverRules];
          rules = this.applyFilters(rules, options);
          return rules.sort((a, b) => b.installs - a.installs);
        }
      } catch {
        // Server unreachable — fall back to local file
      }
    }
    const registry = await this.load();
    let rules = registry.rules.filter((r) => r.curated);
    rules = this.applyFilters(rules, options);
    return rules.sort((a, b) => b.installs - a.installs);
  }

  /**
   * Browse popular rules — ranked by install count.
   * When serverUrl is configured, tries fetching from server first (with 1h cache TTL).
   * Falls back to local file if server is unreachable.
   */
  async popular(options?: BrowseOptions): Promise<RegistryRule[]> {
    if (this.serverUrl) {
      const cached = this.serverCache.popular;
      const now = Date.now();
      if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
        let rules = [...cached.data];
        rules = this.applyFilters(rules, options);
        return rules.sort((a, b) => b.installs - a.installs);
      }
      try {
        const response = await fetch(`${this.serverUrl}/api/codeguard/registry/popular`);
        if (response.ok) {
          const data = (await response.json()) as { rules: RegistryRule[] };
          const serverRules = Array.isArray(data.rules) ? data.rules : [];
          this.serverCache.popular = { data: serverRules, fetchedAt: now };
          let rules = [...serverRules];
          rules = this.applyFilters(rules, options);
          return rules.sort((a, b) => b.installs - a.installs);
        }
      } catch {
        // Server unreachable — fall back to local file
      }
    }
    const registry = await this.load();
    let rules = [...registry.rules];
    rules = this.applyFilters(rules, options);
    return rules.sort((a, b) => b.installs - a.installs);
  }

  /**
   * Get all unique categories in the registry.
   */
  async categories(): Promise<string[]> {
    const registry = await this.load();
    const cats = new Set(registry.rules.map((r) => r.category));
    return Array.from(cats).sort();
  }

  /**
   * Search rules by term (matches id, description, tags, category).
   */
  async search(term: string, options?: BrowseOptions): Promise<RegistryRule[]> {
    const registry = await this.load();
    const lower = term.toLowerCase();
    let rules = registry.rules.filter(
      (r) =>
        r.id.toLowerCase().includes(lower) ||
        r.description.toLowerCase().includes(lower) ||
        r.category.toLowerCase().includes(lower) ||
        r.tags.some((t) => t.toLowerCase().includes(lower)),
    );
    rules = this.applyFilters(rules, options);
    return rules.sort((a, b) => b.installs - a.installs);
  }

  /**
   * Get a single rule by id.
   */
  async get(id: string): Promise<RegistryRule | undefined> {
    const registry = await this.load();
    return registry.rules.find((r) => r.id === id);
  }

  /**
   * Extract a CodeguardRule from a RegistryRule (strips registry metadata).
   * Used when installing a registry rule into local config.
   */
  toLocalRule(registryRule: RegistryRule): CodeguardRule {
    return {
      id: registryRule.id,
      description: registryRule.description,
      severity: registryRule.severity,
      enabled: true,
      file_patterns: registryRule.file_patterns,
      patterns: registryRule.patterns,
      exclude_patterns: registryRule.exclude_patterns,
      suggestion: registryRule.suggestion,
    };
  }

  /**
   * Get the total number of rules in the registry.
   */
  async count(): Promise<number> {
    const registry = await this.load();
    return registry.rules.length;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private applyFilters(
    rules: RegistryRule[],
    options?: BrowseOptions,
  ): RegistryRule[] {
    if (!options) return rules;

    if (options.category) {
      rules = rules.filter((r) => r.category === options.category);
    }

    if (options.search) {
      const lower = options.search.toLowerCase();
      rules = rules.filter(
        (r) =>
          r.id.toLowerCase().includes(lower) ||
          r.description.toLowerCase().includes(lower) ||
          r.tags.some((t) => t.toLowerCase().includes(lower)),
      );
    }

    if (options.limit && options.limit > 0) {
      rules = rules.slice(0, options.limit);
    }

    return rules;
  }
}
