/**
 * Codeguard Public Read Endpoints — No auth required.
 *
 * GET /api/codeguard/curated  → Curated rules from REGISTRY_KV
 * GET /api/codeguard/popular  → Popular rules (hidden excluded), sorted by installs desc
 */

import type { Env } from '../types.js';
import { jsonResponse } from '../helpers.js';

// ---------------------------------------------------------------------------
// Types (inline — mirrors admin-server types)
// ---------------------------------------------------------------------------

interface CuratedRulesData {
  version: number;
  updated: string;
  updated_by: string;
  rules: Array<{
    id: string;
    description: string;
    severity: string;
    enabled: boolean;
    file_patterns: string[];
    patterns: string[];
    exclude_patterns: string[];
    suggestion: string;
    order: number;
  }>;
}

interface PopularRuleEntry {
  rule: {
    id: string;
    description: string;
    severity: string;
    enabled: boolean;
    file_patterns: string[];
    patterns: string[];
    exclude_patterns: string[];
    suggestion: string;
  };
  total_installs: number;
  total_blocks: number;
  hidden: boolean;
  first_seen: string;
  last_updated: string;
}

interface PopularRulesData {
  updated: string;
  rules: PopularRuleEntry[];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/codeguard/curated — Public read of curated rules.
 */
export async function handleGetCurated(env: Env): Promise<Response> {
  const raw = await env.REGISTRY_KV.get('codeguard:curated');
  if (!raw) {
    return jsonResponse(200, { version: 0, updated: null, rules: [] });
  }

  const data = JSON.parse(raw) as CuratedRulesData;
  // Sort by order for display
  const rules = data.rules
    .filter(r => r.enabled)
    .sort((a, b) => a.order - b.order);

  return jsonResponse(200, {
    version: data.version,
    updated: data.updated,
    rules,
  });
}

/**
 * GET /api/codeguard/popular — Public read of popular rules.
 * Filters hidden entries. Supports ?category= and ?limit= params.
 */
export async function handleGetPopular(env: Env, url: URL): Promise<Response> {
  const raw = await env.REGISTRY_KV.get('codeguard:popular');
  if (!raw) {
    return jsonResponse(200, { updated: null, rules: [] });
  }

  const data = JSON.parse(raw) as PopularRulesData;

  // Filter hidden entries (admin-only visibility)
  let rules = data.rules.filter(r => !r.hidden);

  // Optional category filter
  const category = url.searchParams.get('category');
  if (category) {
    rules = rules.filter(r => {
      const ruleAny = r.rule as Record<string, unknown>;
      return ruleAny.category === category;
    });
  }

  // Sort by total_installs descending
  rules.sort((a, b) => b.total_installs - a.total_installs);

  // Optional limit
  const limitStr = url.searchParams.get('limit');
  if (limitStr) {
    const limit = parseInt(limitStr);
    if (limit > 0) {
      rules = rules.slice(0, limit);
    }
  }

  return jsonResponse(200, {
    updated: data.updated,
    rules: rules.map(r => ({
      rule: r.rule,
      total_installs: r.total_installs,
      total_blocks: r.total_blocks,
      first_seen: r.first_seen,
      last_updated: r.last_updated,
    })),
  });
}
