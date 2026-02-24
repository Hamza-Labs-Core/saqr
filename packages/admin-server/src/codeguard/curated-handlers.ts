/**
 * Curated Rules CRUD Handlers — Admin management of recommended codeguard rules.
 *
 * KV key: codeguard:curated
 * Storage format: CuratedRulesData { version, updated, updated_by, rules[] }
 */

import type { AdminEnv, AdminAuthContext, CuratedRule, CuratedRulesData } from '../types.js';
import { jsonResponse, errorResponse, isValidRuleId, isValidRegex } from '../helpers.js';

const CURATED_KEY = 'codeguard:curated';

async function loadCurated(env: AdminEnv): Promise<CuratedRulesData> {
  const raw = await env.REGISTRY_KV.get(CURATED_KEY);
  if (!raw) {
    return { version: 1, updated: new Date().toISOString(), updated_by: '', rules: [] };
  }
  return JSON.parse(raw) as CuratedRulesData;
}

async function saveCurated(env: AdminEnv, data: CuratedRulesData): Promise<void> {
  await env.REGISTRY_KV.put(CURATED_KEY, JSON.stringify(data));
}

/**
 * Validate a curated rule payload.
 */
function validateRule(body: Record<string, unknown>): string | null {
  if (!body.id || typeof body.id !== 'string' || !isValidRuleId(body.id as string)) {
    return 'Invalid or missing "id" (must be kebab-case, 1-64 chars)';
  }
  if (!body.description || typeof body.description !== 'string' || (body.description as string).length === 0) {
    return 'Missing or empty "description"';
  }
  if (body.severity !== 'block' && body.severity !== 'warn') {
    return 'Invalid "severity" (must be "block" or "warn")';
  }
  if (!Array.isArray(body.file_patterns) || body.file_patterns.length === 0) {
    return 'Missing or empty "file_patterns" array';
  }
  if (!Array.isArray(body.patterns) || body.patterns.length === 0) {
    return 'Missing or empty "patterns" array';
  }
  for (const pattern of body.patterns as string[]) {
    if (typeof pattern !== 'string' || !isValidRegex(pattern)) {
      return `Invalid regex pattern: "${pattern}"`;
    }
  }
  if (body.exclude_patterns !== undefined && !Array.isArray(body.exclude_patterns)) {
    return '"exclude_patterns" must be an array';
  }
  if (body.exclude_patterns) {
    for (const pattern of body.exclude_patterns as string[]) {
      if (typeof pattern !== 'string') {
        return 'All exclude_patterns must be strings';
      }
    }
  }
  if (!body.suggestion || typeof body.suggestion !== 'string') {
    return 'Missing or invalid "suggestion"';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/codeguard/curated — List all curated rules.
 */
export async function handleListCurated(env: AdminEnv): Promise<Response> {
  const data = await loadCurated(env);
  return jsonResponse(200, {
    version: data.version,
    updated: data.updated,
    rules: data.rules,
  });
}

/**
 * POST /api/admin/codeguard/curated — Add a new curated rule.
 */
export async function handleAddCurated(
  request: Request,
  env: AdminEnv,
  authCtx: AdminAuthContext,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  const validationError = validateRule(body);
  if (validationError) {
    return errorResponse(400, 'validation_error', validationError);
  }

  const data = await loadCurated(env);

  // Check for duplicate id
  if (data.rules.some(r => r.id === body.id)) {
    return errorResponse(409, 'duplicate_id', `Rule with id "${body.id}" already exists`);
  }

  const now = new Date().toISOString();
  const maxOrder = data.rules.reduce((max, r) => Math.max(max, r.order), 0);

  const newRule: CuratedRule = {
    id: body.id as string,
    description: body.description as string,
    severity: body.severity as 'block' | 'warn',
    enabled: body.enabled !== false,
    file_patterns: body.file_patterns as string[],
    patterns: body.patterns as string[],
    exclude_patterns: (body.exclude_patterns as string[]) || [],
    suggestion: body.suggestion as string,
    order: typeof body.order === 'number' ? body.order : maxOrder + 1,
    added_at: now,
    added_by: authCtx.userId,
  };

  data.rules.push(newRule);
  data.version += 1;
  data.updated = now;
  data.updated_by = authCtx.userId;

  await saveCurated(env, data);

  return jsonResponse(201, { rule: newRule });
}

/**
 * PUT /api/admin/codeguard/curated/:id — Update an existing curated rule.
 */
export async function handleUpdateCurated(
  request: Request,
  env: AdminEnv,
  authCtx: AdminAuthContext,
  ruleId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse(400, 'invalid_body', 'Request body must be valid JSON');
  }

  const data = await loadCurated(env);
  const index = data.rules.findIndex(r => r.id === ruleId);
  if (index === -1) {
    return errorResponse(404, 'not_found', `Rule "${ruleId}" not found`);
  }

  const existing = data.rules[index];

  // Validate updated patterns if provided
  if (body.patterns) {
    if (!Array.isArray(body.patterns) || (body.patterns as string[]).length === 0) {
      return errorResponse(400, 'validation_error', 'patterns must be a non-empty array');
    }
    for (const pattern of body.patterns as string[]) {
      if (typeof pattern !== 'string' || !isValidRegex(pattern)) {
        return errorResponse(400, 'validation_error', `Invalid regex pattern: "${pattern}"`);
      }
    }
  }

  if (body.severity !== undefined && body.severity !== 'block' && body.severity !== 'warn') {
    return errorResponse(400, 'validation_error', 'severity must be "block" or "warn"');
  }

  const now = new Date().toISOString();
  const updated: CuratedRule = {
    ...existing,
    description: typeof body.description === 'string' ? body.description : existing.description,
    severity: (body.severity as 'block' | 'warn') || existing.severity,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
    file_patterns: Array.isArray(body.file_patterns) ? body.file_patterns as string[] : existing.file_patterns,
    patterns: Array.isArray(body.patterns) ? body.patterns as string[] : existing.patterns,
    exclude_patterns: Array.isArray(body.exclude_patterns) ? body.exclude_patterns as string[] : existing.exclude_patterns,
    suggestion: typeof body.suggestion === 'string' ? body.suggestion : existing.suggestion,
    order: typeof body.order === 'number' ? body.order : existing.order,
  };

  data.rules[index] = updated;
  data.version += 1;
  data.updated = now;
  data.updated_by = authCtx.userId;

  await saveCurated(env, data);

  return jsonResponse(200, { rule: updated });
}

/**
 * DELETE /api/admin/codeguard/curated/:id — Remove a curated rule.
 */
export async function handleDeleteCurated(
  env: AdminEnv,
  authCtx: AdminAuthContext,
  ruleId: string,
): Promise<Response> {
  const data = await loadCurated(env);
  const index = data.rules.findIndex(r => r.id === ruleId);
  if (index === -1) {
    return errorResponse(404, 'not_found', `Rule "${ruleId}" not found`);
  }

  data.rules.splice(index, 1);
  data.version += 1;
  data.updated = new Date().toISOString();
  data.updated_by = authCtx.userId;

  await saveCurated(env, data);

  return jsonResponse(200, { deleted: ruleId });
}
