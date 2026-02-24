/**
 * Tests for popular codeguard rules moderation handlers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleListPopular,
  handleHidePopular,
  handleUnhidePopular,
} from '../codeguard/popular-handlers.js';
import type { AdminEnv, PopularRulesData } from '../types.js';
import { createMockAdminEnv } from './helpers/mock-env.js';

/**
 * Seed REGISTRY_KV with popular rules data.
 */
async function seedPopularRules(env: AdminEnv, rules?: PopularRulesData): Promise<void> {
  const data: PopularRulesData = rules ?? {
    updated: '2025-01-15T10:00:00.000Z',
    rules: [
      {
        rule: {
          id: 'no-eval',
          description: 'Blocks usage of eval()',
          severity: 'block',
          enabled: true,
          file_patterns: ['**/*.js', '**/*.ts'],
          patterns: ['\\beval\\s*\\('],
          exclude_patterns: [],
          suggestion: 'Avoid eval() for security reasons.',
        },
        total_installs: 1500,
        total_blocks: 320,
        hidden: false,
        first_seen: '2024-06-01T00:00:00.000Z',
        last_updated: '2025-01-10T12:00:00.000Z',
      },
      {
        rule: {
          id: 'no-any-type',
          description: 'Warns on explicit any type usage',
          severity: 'warn',
          enabled: true,
          file_patterns: ['**/*.ts'],
          patterns: [':\\s*any\\b'],
          exclude_patterns: ['**/*.test.ts'],
          suggestion: 'Use specific types instead of any.',
        },
        total_installs: 980,
        total_blocks: 45,
        hidden: false,
        first_seen: '2024-07-15T00:00:00.000Z',
        last_updated: '2025-01-12T08:00:00.000Z',
      },
      {
        rule: {
          id: 'no-todo-comments',
          description: 'Flags TODO comments',
          severity: 'warn',
          enabled: true,
          file_patterns: ['**/*'],
          patterns: ['//\\s*TODO'],
          exclude_patterns: [],
          suggestion: 'Track TODOs in issue tracker instead.',
        },
        total_installs: 50,
        total_blocks: 0,
        hidden: true,
        first_seen: '2024-12-01T00:00:00.000Z',
        last_updated: '2025-01-05T14:00:00.000Z',
      },
    ],
  };

  await env.REGISTRY_KV.put('codeguard:popular', JSON.stringify(data));
}

describe('Popular Handlers', () => {
  let env: AdminEnv;

  beforeEach(() => {
    env = createMockAdminEnv();
  });

  describe('handleListPopular', () => {
    it('should return empty list when no popular rules exist in KV', async () => {
      const response = await handleListPopular(env);

      expect(response.status).toBe(200);
      const body = await response.json() as { rules: unknown[]; total: number; hidden_count: number };
      expect(body.rules).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.hidden_count).toBe(0);
    });

    it('should return all popular rules including hidden ones', async () => {
      await seedPopularRules(env);

      const response = await handleListPopular(env);

      expect(response.status).toBe(200);
      const body = await response.json() as { rules: Array<{ rule: { id: string }; hidden: boolean }>; total: number; hidden_count: number };
      expect(body.total).toBe(3);
      expect(body.hidden_count).toBe(1);
      expect(body.rules).toHaveLength(3);

      const ids = body.rules.map(r => r.rule.id);
      expect(ids).toContain('no-eval');
      expect(ids).toContain('no-any-type');
      expect(ids).toContain('no-todo-comments');

      // Verify the hidden rule is included
      const hiddenRule = body.rules.find(r => r.rule.id === 'no-todo-comments');
      expect(hiddenRule?.hidden).toBe(true);
    });
  });

  describe('handleHidePopular', () => {
    it('should hide an existing popular rule', async () => {
      await seedPopularRules(env);

      const response = await handleHidePopular(env, 'no-eval');

      expect(response.status).toBe(200);
      const body = await response.json() as { rule_id: string; hidden: boolean };
      expect(body.rule_id).toBe('no-eval');
      expect(body.hidden).toBe(true);

      // Verify persisted
      const listResponse = await handleListPopular(env);
      const listBody = await listResponse.json() as { rules: Array<{ rule: { id: string }; hidden: boolean }>; hidden_count: number };
      const rule = listBody.rules.find(r => r.rule.id === 'no-eval');
      expect(rule?.hidden).toBe(true);
      expect(listBody.hidden_count).toBe(2); // no-todo-comments was already hidden
    });

    it('should return 404 when hiding a nonexistent popular rule', async () => {
      await seedPopularRules(env);

      const response = await handleHidePopular(env, 'nonexistent-rule');

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('not_found');
      expect(body.message).toContain('nonexistent-rule');
    });
  });

  describe('handleUnhidePopular', () => {
    it('should unhide a hidden popular rule', async () => {
      await seedPopularRules(env);

      // no-todo-comments is already hidden in seed data
      const response = await handleUnhidePopular(env, 'no-todo-comments');

      expect(response.status).toBe(200);
      const body = await response.json() as { rule_id: string; hidden: boolean };
      expect(body.rule_id).toBe('no-todo-comments');
      expect(body.hidden).toBe(false);

      // Verify persisted
      const listResponse = await handleListPopular(env);
      const listBody = await listResponse.json() as { rules: Array<{ rule: { id: string }; hidden: boolean }>; hidden_count: number };
      const rule = listBody.rules.find(r => r.rule.id === 'no-todo-comments');
      expect(rule?.hidden).toBe(false);
      expect(listBody.hidden_count).toBe(0);
    });

    it('should return 404 when unhiding a nonexistent popular rule', async () => {
      await seedPopularRules(env);

      const response = await handleUnhidePopular(env, 'nonexistent-rule');

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('not_found');
      expect(body.message).toContain('nonexistent-rule');
    });
  });
});
