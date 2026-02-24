/**
 * Tests for curated codeguard rules CRUD handlers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleListCurated,
  handleAddCurated,
  handleUpdateCurated,
  handleDeleteCurated,
} from '../codeguard/curated-handlers.js';
import type { AdminEnv, AdminAuthContext, CuratedRule } from '../types.js';
import { createMockAdminEnv, createRequest } from './helpers/mock-env.js';

function makeAuthCtx(overrides?: Partial<AdminAuthContext>): AdminAuthContext {
  return {
    userId: 'usr_admin123',
    email: 'admin@saqr.dev',
    role: 'admin',
    ...overrides,
  };
}

function validRuleBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'no-hardcoded-secrets',
    description: 'Detects hardcoded API keys and secrets',
    severity: 'block',
    file_patterns: ['**/*.ts', '**/*.js'],
    patterns: ['(api_key|secret)\\s*=\\s*["\'][^"\']+["\']'],
    exclude_patterns: ['**/*.test.ts'],
    suggestion: 'Use environment variables instead of hardcoding secrets.',
    ...overrides,
  };
}

describe('Curated Handlers', () => {
  let env: AdminEnv;
  let authCtx: AdminAuthContext;

  beforeEach(() => {
    env = createMockAdminEnv();
    authCtx = makeAuthCtx();
  });

  describe('handleListCurated', () => {
    it('should return empty array when no curated rules exist', async () => {
      const response = await handleListCurated(env);

      expect(response.status).toBe(200);
      const body = await response.json() as { version: number; rules: CuratedRule[] };
      expect(body.version).toBe(1);
      expect(body.rules).toEqual([]);
    });

    it('should return rules after adding them', async () => {
      // Add a rule first
      const addReq = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody());
      await handleAddCurated(addReq, env, authCtx);

      const response = await handleListCurated(env);

      expect(response.status).toBe(200);
      const body = await response.json() as { version: number; rules: CuratedRule[] };
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0].id).toBe('no-hardcoded-secrets');
    });
  });

  describe('handleAddCurated', () => {
    it('should add a new curated rule and return 201', async () => {
      const request = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody());

      const response = await handleAddCurated(request, env, authCtx);

      expect(response.status).toBe(201);
      const body = await response.json() as { rule: CuratedRule };
      expect(body.rule.id).toBe('no-hardcoded-secrets');
      expect(body.rule.description).toBe('Detects hardcoded API keys and secrets');
      expect(body.rule.severity).toBe('block');
      expect(body.rule.enabled).toBe(true);
      expect(body.rule.added_by).toBe('usr_admin123');
      expect(body.rule.file_patterns).toEqual(['**/*.ts', '**/*.js']);
      expect(body.rule.patterns).toHaveLength(1);
      expect(body.rule.exclude_patterns).toEqual(['**/*.test.ts']);
    });

    it('should return 409 when adding a rule with duplicate id', async () => {
      const request1 = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody());
      await handleAddCurated(request1, env, authCtx);

      const request2 = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody());
      const response = await handleAddCurated(request2, env, authCtx);

      expect(response.status).toBe(409);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('duplicate_id');
    });

    it('should return 400 for an invalid regex pattern', async () => {
      const request = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody({
        patterns: ['(unclosed-group'],
      }));

      const response = await handleAddCurated(request, env, authCtx);

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('validation_error');
      expect(body.message).toContain('Invalid regex pattern');
    });

    it('should return 400 when required fields are missing', async () => {
      const request = createRequest('POST', '/api/admin/codeguard/curated', {
        id: 'some-rule',
        // missing description, severity, file_patterns, patterns, suggestion
      });

      const response = await handleAddCurated(request, env, authCtx);

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('validation_error');
    });

    it('should return 400 when id is not valid kebab-case', async () => {
      const request = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody({
        id: 'Invalid_ID',
      }));

      const response = await handleAddCurated(request, env, authCtx);

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('validation_error');
      expect(body.message).toContain('id');
    });
  });

  describe('handleUpdateCurated', () => {
    it('should update an existing rule and persist changes', async () => {
      // Add a rule first
      const addReq = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody());
      await handleAddCurated(addReq, env, authCtx);

      // Update it
      const updateReq = createRequest('PUT', '/api/admin/codeguard/curated/no-hardcoded-secrets', {
        description: 'Updated description for secret detection',
        severity: 'warn',
      });
      const response = await handleUpdateCurated(updateReq, env, authCtx, 'no-hardcoded-secrets');

      expect(response.status).toBe(200);
      const body = await response.json() as { rule: CuratedRule };
      expect(body.rule.description).toBe('Updated description for secret detection');
      expect(body.rule.severity).toBe('warn');
      // Unchanged fields should be preserved
      expect(body.rule.file_patterns).toEqual(['**/*.ts', '**/*.js']);

      // Verify persisted by listing
      const listResponse = await handleListCurated(env);
      const listBody = await listResponse.json() as { rules: CuratedRule[] };
      expect(listBody.rules[0].description).toBe('Updated description for secret detection');
    });

    it('should return 404 when updating a nonexistent rule', async () => {
      const updateReq = createRequest('PUT', '/api/admin/codeguard/curated/nonexistent', {
        description: 'New description',
      });
      const response = await handleUpdateCurated(updateReq, env, authCtx, 'nonexistent');

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('not_found');
    });
  });

  describe('handleDeleteCurated', () => {
    it('should delete an existing rule and remove it from the list', async () => {
      // Add a rule
      const addReq = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody());
      await handleAddCurated(addReq, env, authCtx);

      const response = await handleDeleteCurated(env, authCtx, 'no-hardcoded-secrets');

      expect(response.status).toBe(200);
      const body = await response.json() as { deleted: string };
      expect(body.deleted).toBe('no-hardcoded-secrets');

      // Verify removed
      const listResponse = await handleListCurated(env);
      const listBody = await listResponse.json() as { rules: CuratedRule[] };
      expect(listBody.rules).toHaveLength(0);
    });

    it('should return 404 when deleting a nonexistent rule', async () => {
      const response = await handleDeleteCurated(env, authCtx, 'nonexistent');

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('not_found');
    });
  });

  describe('version tracking', () => {
    it('should increment version on each mutation', async () => {
      // Initial list — version 1
      const list0 = await handleListCurated(env);
      const body0 = await list0.json() as { version: number };
      expect(body0.version).toBe(1);

      // Add first rule — version 2
      const addReq1 = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody());
      await handleAddCurated(addReq1, env, authCtx);

      const list1 = await handleListCurated(env);
      const body1 = await list1.json() as { version: number };
      expect(body1.version).toBe(2);

      // Add second rule — version 3
      const addReq2 = createRequest('POST', '/api/admin/codeguard/curated', validRuleBody({
        id: 'no-console-log',
        description: 'No console.log in production',
        patterns: ['console\\.log'],
      }));
      await handleAddCurated(addReq2, env, authCtx);

      const list2 = await handleListCurated(env);
      const body2 = await list2.json() as { version: number };
      expect(body2.version).toBe(3);

      // Update rule — version 4
      const updateReq = createRequest('PUT', '/api/admin/codeguard/curated/no-console-log', {
        severity: 'warn',
      });
      await handleUpdateCurated(updateReq, env, authCtx, 'no-console-log');

      const list3 = await handleListCurated(env);
      const body3 = await list3.json() as { version: number };
      expect(body3.version).toBe(4);

      // Delete rule — version 5
      await handleDeleteCurated(env, authCtx, 'no-console-log');

      const list4 = await handleListCurated(env);
      const body4 = await list4.json() as { version: number };
      expect(body4.version).toBe(5);
    });
  });
});
