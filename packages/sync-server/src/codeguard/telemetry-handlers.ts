/**
 * Codeguard Telemetry Ingestion — Authed, consent-gated.
 *
 * POST /api/codeguard/telemetry
 *
 * Accepts anonymous rule usage stats: rule IDs, scope, block counts.
 * No file paths, no content, no project names — privacy-safe.
 *
 * Uses delta computation to avoid double-counting on re-sends.
 * Stores per-user snapshots for next delta, updates popular aggregation.
 */

import type { Env, AuthContext } from '../types.js';
import { jsonResponse, errorResponse } from '../helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TelemetryRule {
  id: string;
  scope: 'global' | 'project';
  blocks: number;
}

interface TelemetryPayload {
  rules: TelemetryRule[];
}

interface UserSnapshot {
  rules: TelemetryRule[];
  updated_at: string;
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
// Rate limit key
// ---------------------------------------------------------------------------

const RATE_LIMIT_SECONDS = 30 * 60; // 30 minutes between pushes

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/codeguard/telemetry — Ingest rule usage telemetry.
 *
 * Requires JWT auth + rule_telemetry consent.
 */
export async function handleTelemetryPush(
  request: Request,
  env: Env,
  authCtx: AuthContext,
): Promise<Response> {
  // Parse body
  let body: TelemetryPayload;
  try {
    body = await request.json() as TelemetryPayload;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  // Validate payload
  if (!body.rules || !Array.isArray(body.rules)) {
    return errorResponse(400, 'validation_error', 'Body must contain a "rules" array');
  }

  for (const rule of body.rules) {
    if (!rule.id || typeof rule.id !== 'string') {
      return errorResponse(400, 'validation_error', 'Each rule must have a string "id"');
    }
    if (rule.scope !== 'global' && rule.scope !== 'project') {
      return errorResponse(400, 'validation_error', `Invalid scope for rule "${rule.id}": must be "global" or "project"`);
    }
    if (typeof rule.blocks !== 'number' || rule.blocks < 0) {
      return errorResponse(400, 'validation_error', `Invalid blocks count for rule "${rule.id}"`);
    }
  }

  // Check rate limit
  const rateLimitKey = `codeguard:telemetry:rate:${authCtx.userId}`;
  const lastPush = await env.REGISTRY_KV.get(rateLimitKey);
  if (lastPush) {
    const elapsed = Date.now() - new Date(lastPush).getTime();
    if (elapsed < RATE_LIMIT_SECONDS * 1000) {
      const retryAfter = Math.ceil((RATE_LIMIT_SECONDS * 1000 - elapsed) / 1000);
      return errorResponse(429, 'rate_limited', 'Telemetry push rate limited', {
        retry_after_seconds: retryAfter,
      });
    }
  }

  // Load previous snapshot
  const snapshotKey = `codeguard:telemetry:${authCtx.userId}`;
  const prevRaw = await env.REGISTRY_KV.get(snapshotKey);
  const prevSnapshot: UserSnapshot | null = prevRaw ? JSON.parse(prevRaw) : null;
  const prevMap = new Map<string, TelemetryRule>();
  if (prevSnapshot) {
    for (const r of prevSnapshot.rules) {
      prevMap.set(r.id, r);
    }
  }

  // Build current map
  const currentMap = new Map<string, TelemetryRule>();
  for (const r of body.rules) {
    currentMap.set(r.id, r);
  }

  // Compute deltas
  const deltas: Array<{ id: string; installDelta: number; blockDelta: number }> = [];

  // New or updated rules
  for (const [id, current] of currentMap) {
    const prev = prevMap.get(id);
    if (!prev) {
      // New rule: full install + all blocks
      deltas.push({ id, installDelta: 1, blockDelta: current.blocks });
    } else {
      // Existing rule: only block delta (installs unchanged)
      const blockDelta = Math.max(0, current.blocks - prev.blocks);
      if (blockDelta > 0) {
        deltas.push({ id, installDelta: 0, blockDelta });
      }
    }
  }

  // Removed rules (in prev but not in current)
  for (const [id] of prevMap) {
    if (!currentMap.has(id)) {
      deltas.push({ id, installDelta: -1, blockDelta: 0 });
    }
  }

  // Update popular aggregation
  if (deltas.length > 0) {
    const popularRaw = await env.REGISTRY_KV.get('codeguard:popular');
    const popularData: PopularRulesData = popularRaw
      ? JSON.parse(popularRaw)
      : { updated: new Date().toISOString(), rules: [] };

    const now = new Date().toISOString();
    const ruleMap = new Map(popularData.rules.map(r => [r.rule.id, r]));

    for (const delta of deltas) {
      const existing = ruleMap.get(delta.id);
      if (existing) {
        existing.total_installs = Math.max(0, existing.total_installs + delta.installDelta);
        existing.total_blocks = Math.max(0, existing.total_blocks + delta.blockDelta);
        existing.last_updated = now;
      } else if (delta.installDelta > 0) {
        // New popular entry — minimal rule info (just id)
        ruleMap.set(delta.id, {
          rule: {
            id: delta.id,
            description: '',
            severity: 'warn',
            enabled: true,
            file_patterns: [],
            patterns: [],
            exclude_patterns: [],
            suggestion: '',
          },
          total_installs: delta.installDelta,
          total_blocks: delta.blockDelta,
          hidden: false,
          first_seen: now,
          last_updated: now,
        });
      }
    }

    popularData.rules = Array.from(ruleMap.values());
    popularData.updated = now;
    await env.REGISTRY_KV.put('codeguard:popular', JSON.stringify(popularData));
  }

  // Store new snapshot
  const newSnapshot: UserSnapshot = {
    rules: body.rules,
    updated_at: new Date().toISOString(),
  };
  await env.REGISTRY_KV.put(snapshotKey, JSON.stringify(newSnapshot));

  // Update rate limit
  await env.REGISTRY_KV.put(rateLimitKey, new Date().toISOString(), {
    expirationTtl: RATE_LIMIT_SECONDS,
  });

  return jsonResponse(200, {
    accepted: body.rules.length,
    deltas_applied: deltas.length,
  });
}
