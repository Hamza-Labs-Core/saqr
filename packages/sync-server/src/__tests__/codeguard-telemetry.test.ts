/**
 * Tests for Codeguard Telemetry Ingestion — Authed, consent-gated.
 *
 * Covers:
 * - Payload validation (body, rules array, rule id, scope)
 * - Delta computation (new rules, block delta, rule removal)
 * - Popular aggregation updates
 * - Rate limiting (30 min window)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleTelemetryPush } from '../codeguard/telemetry-handlers.js';
import { createMockEnv, createMockAuthCtx } from './helpers/mock-env.js';
import type { Env, AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelemetryRequest(body: unknown): Request {
  return new Request('https://sync.test.dev/api/codeguard/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeInvalidJsonRequest(): Request {
  return new Request('https://sync.test.dev/api/codeguard/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not valid json{{{',
  });
}

function makeUserSnapshot(
  rules: Array<{ id: string; scope: string; blocks: number }>,
) {
  return JSON.stringify({
    rules,
    updated_at: '2026-02-20T10:00:00Z',
  });
}

function makePopularData(
  rules: Array<Record<string, unknown>>,
) {
  return JSON.stringify({
    updated: '2026-02-20T10:00:00Z',
    rules,
  });
}

function makePopularEntry(overrides: Record<string, unknown> = {}) {
  const { rule: ruleOverrides, ...rest } = overrides as { rule?: Record<string, unknown> };
  return {
    rule: {
      id: 'rule-1',
      description: '',
      severity: 'warn',
      enabled: true,
      file_patterns: [],
      patterns: [],
      exclude_patterns: [],
      suggestion: '',
      ...ruleOverrides,
    },
    total_installs: 0,
    total_blocks: 0,
    hidden: false,
    first_seen: '2026-02-20T10:00:00Z',
    last_updated: '2026-02-20T10:00:00Z',
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Codeguard Telemetry Handlers', () => {
  let env: Env;
  let authCtx: AuthContext;

  beforeEach(() => {
    env = createMockEnv();
    authCtx = createMockAuthCtx({ userId: 'usr_telem_001' });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('payload validation', () => {
    it('should accept valid telemetry payload and return 200', async () => {
      const request = makeTelemetryRequest({
        rules: [
          { id: 'rule-a', scope: 'global', blocks: 5 },
          { id: 'rule-b', scope: 'project', blocks: 0 },
        ],
      });

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(200);

      const body = await response.json() as { accepted: number; deltas_applied: number };
      expect(body.accepted).toBe(2);
      expect(body.deltas_applied).toBe(2);
    });

    it('should reject invalid JSON body with 400', async () => {
      const request = makeInvalidJsonRequest();

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(400);

      const body = await response.json() as { error: string };
      expect(body.error).toBe('invalid_body');
    });

    it('should reject body missing rules array with 400', async () => {
      const request = makeTelemetryRequest({ data: 'no rules here' });

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(400);

      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('validation_error');
      expect(body.message).toContain('rules');
    });

    it('should reject a rule with no id with 400', async () => {
      const request = makeTelemetryRequest({
        rules: [{ scope: 'global', blocks: 1 }],
      });

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(400);

      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('validation_error');
      expect(body.message).toContain('id');
    });

    it('should reject a rule with invalid scope with 400', async () => {
      const request = makeTelemetryRequest({
        rules: [{ id: 'rule-x', scope: 'workspace', blocks: 0 }],
      });

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(400);

      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('validation_error');
      expect(body.message).toContain('scope');
    });
  });

  // -----------------------------------------------------------------------
  // Delta computation
  // -----------------------------------------------------------------------

  describe('delta computation', () => {
    it('should create popular entries on first telemetry send', async () => {
      const request = makeTelemetryRequest({
        rules: [
          { id: 'new-rule-1', scope: 'global', blocks: 3 },
          { id: 'new-rule-2', scope: 'project', blocks: 0 },
        ],
      });

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(200);

      // Verify popular data was created in KV
      const popularRaw = await env.REGISTRY_KV.get('codeguard:popular');
      expect(popularRaw).not.toBeNull();

      const popular = JSON.parse(popularRaw!) as { rules: Array<{ rule: { id: string }; total_installs: number; total_blocks: number }> };
      expect(popular.rules).toHaveLength(2);

      const r1 = popular.rules.find(r => r.rule.id === 'new-rule-1');
      expect(r1).toBeDefined();
      expect(r1!.total_installs).toBe(1);
      expect(r1!.total_blocks).toBe(3);

      const r2 = popular.rules.find(r => r.rule.id === 'new-rule-2');
      expect(r2).toBeDefined();
      expect(r2!.total_installs).toBe(1);
      expect(r2!.total_blocks).toBe(0);
    });

    it('should only count block delta on re-send (not reinstall)', async () => {
      // Seed previous snapshot: rule-a had 5 blocks
      const snapshotKey = `codeguard:telemetry:${authCtx.userId}`;
      await (env.REGISTRY_KV as any).put(
        snapshotKey,
        makeUserSnapshot([{ id: 'rule-a', scope: 'global', blocks: 5 }]),
      );

      // Seed existing popular data
      await (env.REGISTRY_KV as any).put(
        'codeguard:popular',
        makePopularData([
          makePopularEntry({ rule: { id: 'rule-a' }, total_installs: 10, total_blocks: 50 }),
        ]),
      );

      // Now send again with rule-a at 8 blocks (delta = 3)
      const request = makeTelemetryRequest({
        rules: [{ id: 'rule-a', scope: 'global', blocks: 8 }],
      });

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(200);

      const body = await response.json() as { deltas_applied: number };
      expect(body.deltas_applied).toBe(1); // One delta: block increment

      // Check popular data: installs unchanged, blocks incremented by 3
      const popularRaw = await env.REGISTRY_KV.get('codeguard:popular');
      const popular = JSON.parse(popularRaw!) as { rules: Array<{ rule: { id: string }; total_installs: number; total_blocks: number }> };
      const entry = popular.rules.find(r => r.rule.id === 'rule-a');
      expect(entry).toBeDefined();
      expect(entry!.total_installs).toBe(10); // unchanged
      expect(entry!.total_blocks).toBe(53);   // 50 + 3
    });

    it('should decrement installs when a rule is removed from user list', async () => {
      // Seed previous snapshot with rule-a and rule-b
      const snapshotKey = `codeguard:telemetry:${authCtx.userId}`;
      await (env.REGISTRY_KV as any).put(
        snapshotKey,
        makeUserSnapshot([
          { id: 'rule-a', scope: 'global', blocks: 5 },
          { id: 'rule-b', scope: 'project', blocks: 2 },
        ]),
      );

      // Seed popular data
      await (env.REGISTRY_KV as any).put(
        'codeguard:popular',
        makePopularData([
          makePopularEntry({ rule: { id: 'rule-a' }, total_installs: 10, total_blocks: 50 }),
          makePopularEntry({ rule: { id: 'rule-b' }, total_installs: 5, total_blocks: 20 }),
        ]),
      );

      // Send with only rule-a (rule-b removed)
      const request = makeTelemetryRequest({
        rules: [{ id: 'rule-a', scope: 'global', blocks: 5 }],
      });

      const response = await handleTelemetryPush(request, env, authCtx);
      expect(response.status).toBe(200);

      // Check popular data
      const popularRaw = await env.REGISTRY_KV.get('codeguard:popular');
      const popular = JSON.parse(popularRaw!) as { rules: Array<{ rule: { id: string }; total_installs: number; total_blocks: number }> };

      const entryA = popular.rules.find(r => r.rule.id === 'rule-a');
      expect(entryA!.total_installs).toBe(10); // unchanged (blocks also unchanged)

      const entryB = popular.rules.find(r => r.rule.id === 'rule-b');
      expect(entryB!.total_installs).toBe(4); // decremented from 5 to 4
      expect(entryB!.total_blocks).toBe(20);  // blocks unchanged on removal
    });
  });

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  describe('rate limiting', () => {
    it('should rate limit second push within 30 minute window', async () => {
      // First push should succeed
      const request1 = makeTelemetryRequest({
        rules: [{ id: 'rule-x', scope: 'global', blocks: 1 }],
      });
      const response1 = await handleTelemetryPush(request1, env, authCtx);
      expect(response1.status).toBe(200);

      // Second push immediately should be rate limited
      const request2 = makeTelemetryRequest({
        rules: [{ id: 'rule-x', scope: 'global', blocks: 2 }],
      });
      const response2 = await handleTelemetryPush(request2, env, authCtx);
      expect(response2.status).toBe(429);

      const body = await response2.json() as { error: string; retry_after_seconds: number };
      expect(body.error).toBe('rate_limited');
      expect(body.retry_after_seconds).toBeGreaterThan(0);
    });
  });
});
