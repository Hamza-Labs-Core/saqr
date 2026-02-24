/**
 * Tests for Codeguard Public Read Endpoints — No auth required.
 *
 * Covers:
 * - GET /api/codeguard/curated — curated rules from REGISTRY_KV
 * - GET /api/codeguard/popular — popular rules sorted by installs, hidden excluded
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetCurated, handleGetPopular } from '../codeguard/public-handlers.js';
import { createMockEnv } from './helpers/mock-env.js';
import type { Env } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCuratedData(rules: Array<Record<string, unknown>>, version = 1) {
  return JSON.stringify({
    version,
    updated: '2026-02-20T12:00:00Z',
    updated_by: 'admin@saqr.dev',
    rules,
  });
}

function makePopularData(rules: Array<Record<string, unknown>>) {
  return JSON.stringify({
    updated: '2026-02-20T12:00:00Z',
    rules,
  });
}

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    description: 'Test rule',
    severity: 'warn',
    enabled: true,
    file_patterns: ['*.ts'],
    patterns: ['console\\.log'],
    exclude_patterns: [],
    suggestion: 'Remove console.log',
    order: 0,
    ...overrides,
  };
}

function makePopularEntry(overrides: Record<string, unknown> = {}) {
  const { rule: ruleOverrides, ...rest } = overrides as { rule?: Record<string, unknown> };
  return {
    rule: {
      id: 'rule-1',
      description: 'Test rule',
      severity: 'warn',
      enabled: true,
      file_patterns: ['*.ts'],
      patterns: ['console\\.log'],
      exclude_patterns: [],
      suggestion: 'Remove console.log',
      ...ruleOverrides,
    },
    total_installs: 100,
    total_blocks: 50,
    hidden: false,
    first_seen: '2026-01-01T00:00:00Z',
    last_updated: '2026-02-20T12:00:00Z',
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Codeguard Public Handlers', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  // -----------------------------------------------------------------------
  // handleGetCurated
  // -----------------------------------------------------------------------

  describe('handleGetCurated', () => {
    it('should return empty array when KV has no curated data', async () => {
      const response = await handleGetCurated(env);
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.version).toBe(0);
      expect(body.updated).toBeNull();
      expect(body.rules).toEqual([]);
    });

    it('should return rules sorted by order when seeded', async () => {
      const rules = [
        makeRule({ id: 'rule-b', order: 2 }),
        makeRule({ id: 'rule-a', order: 1 }),
        makeRule({ id: 'rule-c', order: 0 }),
      ];
      await (env.REGISTRY_KV as any).put('codeguard:curated', makeCuratedData(rules, 3));

      const response = await handleGetCurated(env);
      expect(response.status).toBe(200);

      const body = await response.json() as { version: number; updated: string; rules: Array<{ id: string; order: number }> };
      expect(body.version).toBe(3);
      expect(body.updated).toBe('2026-02-20T12:00:00Z');
      expect(body.rules).toHaveLength(3);
      expect(body.rules[0].id).toBe('rule-c');
      expect(body.rules[1].id).toBe('rule-a');
      expect(body.rules[2].id).toBe('rule-b');
    });

    it('should filter out disabled rules', async () => {
      const rules = [
        makeRule({ id: 'enabled-1', enabled: true, order: 0 }),
        makeRule({ id: 'disabled-1', enabled: false, order: 1 }),
        makeRule({ id: 'enabled-2', enabled: true, order: 2 }),
      ];
      await (env.REGISTRY_KV as any).put('codeguard:curated', makeCuratedData(rules));

      const response = await handleGetCurated(env);
      const body = await response.json() as { rules: Array<{ id: string }> };

      expect(body.rules).toHaveLength(2);
      const ids = body.rules.map(r => r.id);
      expect(ids).toContain('enabled-1');
      expect(ids).toContain('enabled-2');
      expect(ids).not.toContain('disabled-1');
    });
  });

  // -----------------------------------------------------------------------
  // handleGetPopular
  // -----------------------------------------------------------------------

  describe('handleGetPopular', () => {
    it('should return empty array when KV has no popular data', async () => {
      const url = new URL('https://sync.test.dev/api/codeguard/popular');
      const response = await handleGetPopular(env, url);
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.updated).toBeNull();
      expect(body.rules).toEqual([]);
    });

    it('should return non-hidden rules sorted by installs descending', async () => {
      const rules = [
        makePopularEntry({ rule: { id: 'low' }, total_installs: 10 }),
        makePopularEntry({ rule: { id: 'high' }, total_installs: 500 }),
        makePopularEntry({ rule: { id: 'mid' }, total_installs: 100 }),
      ];
      await (env.REGISTRY_KV as any).put('codeguard:popular', makePopularData(rules));

      const url = new URL('https://sync.test.dev/api/codeguard/popular');
      const response = await handleGetPopular(env, url);
      expect(response.status).toBe(200);

      const body = await response.json() as { rules: Array<{ rule: { id: string }; total_installs: number }> };
      expect(body.rules).toHaveLength(3);
      expect(body.rules[0].rule.id).toBe('high');
      expect(body.rules[0].total_installs).toBe(500);
      expect(body.rules[1].rule.id).toBe('mid');
      expect(body.rules[2].rule.id).toBe('low');
    });

    it('should exclude hidden rules from results', async () => {
      const rules = [
        makePopularEntry({ rule: { id: 'visible' }, total_installs: 200, hidden: false }),
        makePopularEntry({ rule: { id: 'hidden-1' }, total_installs: 999, hidden: true }),
        makePopularEntry({ rule: { id: 'also-visible' }, total_installs: 50, hidden: false }),
      ];
      await (env.REGISTRY_KV as any).put('codeguard:popular', makePopularData(rules));

      const url = new URL('https://sync.test.dev/api/codeguard/popular');
      const response = await handleGetPopular(env, url);
      const body = await response.json() as { rules: Array<{ rule: { id: string } }> };

      expect(body.rules).toHaveLength(2);
      const ids = body.rules.map(r => r.rule.id);
      expect(ids).toContain('visible');
      expect(ids).toContain('also-visible');
      expect(ids).not.toContain('hidden-1');
    });

    it('should filter by ?category= query parameter', async () => {
      const rules = [
        makePopularEntry({ rule: { id: 'sec-1', category: 'security' }, total_installs: 100 }),
        makePopularEntry({ rule: { id: 'perf-1', category: 'performance' }, total_installs: 200 }),
        makePopularEntry({ rule: { id: 'sec-2', category: 'security' }, total_installs: 50 }),
      ];
      await (env.REGISTRY_KV as any).put('codeguard:popular', makePopularData(rules));

      const url = new URL('https://sync.test.dev/api/codeguard/popular?category=security');
      const response = await handleGetPopular(env, url);
      const body = await response.json() as { rules: Array<{ rule: { id: string } }> };

      expect(body.rules).toHaveLength(2);
      const ids = body.rules.map(r => r.rule.id);
      expect(ids).toContain('sec-1');
      expect(ids).toContain('sec-2');
      expect(ids).not.toContain('perf-1');
    });

    it('should respect ?limit= query parameter', async () => {
      const rules = [
        makePopularEntry({ rule: { id: 'a' }, total_installs: 300 }),
        makePopularEntry({ rule: { id: 'b' }, total_installs: 200 }),
        makePopularEntry({ rule: { id: 'c' }, total_installs: 100 }),
      ];
      await (env.REGISTRY_KV as any).put('codeguard:popular', makePopularData(rules));

      const url = new URL('https://sync.test.dev/api/codeguard/popular?limit=2');
      const response = await handleGetPopular(env, url);
      const body = await response.json() as { rules: Array<{ rule: { id: string } }> };

      expect(body.rules).toHaveLength(2);
      // Should be the top 2 by installs
      expect(body.rules[0].rule.id).toBe('a');
      expect(body.rules[1].rule.id).toBe('b');
    });
  });
});
