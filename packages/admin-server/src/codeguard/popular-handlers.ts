/**
 * Popular Rules Moderation Handlers — Admin hide/unhide of problematic popular rules.
 *
 * KV key: codeguard:popular
 * Storage format: PopularRulesData { updated, rules[] }
 *
 * Admin sees ALL entries (including hidden). The public read endpoint
 * in sync-server filters hidden entries out.
 */

import type { AdminEnv, PopularRulesData } from '../types.js';
import { jsonResponse, errorResponse } from '../helpers.js';

const POPULAR_KEY = 'codeguard:popular';

async function loadPopular(env: AdminEnv): Promise<PopularRulesData> {
  const raw = await env.REGISTRY_KV.get(POPULAR_KEY);
  if (!raw) {
    return { updated: new Date().toISOString(), rules: [] };
  }
  return JSON.parse(raw) as PopularRulesData;
}

async function savePopular(env: AdminEnv, data: PopularRulesData): Promise<void> {
  await env.REGISTRY_KV.put(POPULAR_KEY, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/codeguard/popular — List all popular rules (including hidden).
 */
export async function handleListPopular(env: AdminEnv): Promise<Response> {
  const data = await loadPopular(env);
  return jsonResponse(200, {
    updated: data.updated,
    rules: data.rules,
    total: data.rules.length,
    hidden_count: data.rules.filter(r => r.hidden).length,
  });
}

/**
 * POST /api/admin/codeguard/popular/:id/hide — Hide a problematic rule.
 */
export async function handleHidePopular(
  env: AdminEnv,
  ruleId: string,
): Promise<Response> {
  const data = await loadPopular(env);
  const entry = data.rules.find(r => r.rule.id === ruleId);
  if (!entry) {
    return errorResponse(404, 'not_found', `Popular rule "${ruleId}" not found`);
  }

  entry.hidden = true;
  data.updated = new Date().toISOString();

  await savePopular(env, data);

  return jsonResponse(200, { rule_id: ruleId, hidden: true });
}

/**
 * POST /api/admin/codeguard/popular/:id/unhide — Restore a hidden rule.
 */
export async function handleUnhidePopular(
  env: AdminEnv,
  ruleId: string,
): Promise<Response> {
  const data = await loadPopular(env);
  const entry = data.rules.find(r => r.rule.id === ruleId);
  if (!entry) {
    return errorResponse(404, 'not_found', `Popular rule "${ruleId}" not found`);
  }

  entry.hidden = false;
  data.updated = new Date().toISOString();

  await savePopular(env, data);

  return jsonResponse(200, { rule_id: ruleId, hidden: false });
}
