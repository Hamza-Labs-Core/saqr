/**
 * Tests for user management handlers — list, details, promote, demote.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleListUsers,
  handleGetUser,
  handlePromoteUser,
  handleDemoteUser,
} from '../users/user-handlers.js';
import type { AdminEnv, KVUserRecord } from '../types.js';
import {
  createMockAdminEnv,
  seedAdminUser,
  seedRegularUser,
} from './helpers/mock-env.js';

describe('User Handlers', () => {
  let env: AdminEnv;

  beforeEach(() => {
    env = createMockAdminEnv();
  });

  describe('handleListUsers', () => {
    it('should return a list of seeded users', async () => {
      await seedAdminUser(env, 'usr_admin001', 'admin1@saqr.dev');
      await seedRegularUser(env, 'usr_user001', 'user1@saqr.dev');
      await seedRegularUser(env, 'usr_user002', 'user2@saqr.dev');

      const url = new URL('https://admin.test.dev/api/admin/users');
      const response = await handleListUsers(env, url);

      expect(response.status).toBe(200);
      const body = await response.json() as {
        users: Array<{ userId: string; email: string; role: string; tier: string }>;
        total: number;
        has_more: boolean;
      };
      expect(body.total).toBe(3);
      expect(body.has_more).toBe(false);
      expect(body.users).toHaveLength(3);

      const emails = body.users.map(u => u.email);
      expect(emails).toContain('admin1@saqr.dev');
      expect(emails).toContain('user1@saqr.dev');
      expect(emails).toContain('user2@saqr.dev');

      const admin = body.users.find(u => u.email === 'admin1@saqr.dev');
      expect(admin?.role).toBe('admin');

      const user = body.users.find(u => u.email === 'user1@saqr.dev');
      expect(user?.role).toBe('user');
    });
  });

  describe('handleGetUser', () => {
    it('should return user details by userId', async () => {
      await seedRegularUser(env, 'usr_user789', 'details@saqr.dev');

      const response = await handleGetUser(env, 'usr_user789');

      expect(response.status).toBe(200);
      const body = await response.json() as {
        userId: string;
        email: string;
        tier: string;
        role: string;
        createdAt: string;
      };
      expect(body.userId).toBe('usr_user789');
      expect(body.email).toBe('details@saqr.dev');
      expect(body.tier).toBe('free');
      expect(body.role).toBe('user');
      expect(body.createdAt).toBeDefined();
    });

    it('should return 404 for a nonexistent user', async () => {
      const response = await handleGetUser(env, 'usr_nonexistent');

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('not_found');
    });
  });

  describe('handlePromoteUser', () => {
    it('should promote a regular user to admin', async () => {
      await seedRegularUser(env, 'usr_promote_me', 'promote@saqr.dev');

      const response = await handlePromoteUser(env, 'usr_promote_me');

      expect(response.status).toBe(200);
      const body = await response.json() as { userId: string; email: string; role: string };
      expect(body.userId).toBe('usr_promote_me');
      expect(body.email).toBe('promote@saqr.dev');
      expect(body.role).toBe('admin');

      // Verify persisted in KV
      const rawRecord = await env.AUTH_KV.get('user:promote@saqr.dev');
      expect(rawRecord).not.toBeNull();
      const record = JSON.parse(rawRecord!) as KVUserRecord;
      expect(record.role).toBe('admin');
    });

    it('should return 404 when promoting a nonexistent user', async () => {
      const response = await handlePromoteUser(env, 'usr_ghost');

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('not_found');
    });
  });

  describe('handleDemoteUser', () => {
    it('should demote an admin user to regular user', async () => {
      await seedAdminUser(env, 'usr_demote_me', 'demote@saqr.dev');

      const response = await handleDemoteUser(env, 'usr_demote_me');

      expect(response.status).toBe(200);
      const body = await response.json() as { userId: string; email: string; role: string };
      expect(body.userId).toBe('usr_demote_me');
      expect(body.email).toBe('demote@saqr.dev');
      expect(body.role).toBe('user');

      // Verify persisted in KV
      const rawRecord = await env.AUTH_KV.get('user:demote@saqr.dev');
      expect(rawRecord).not.toBeNull();
      const record = JSON.parse(rawRecord!) as KVUserRecord;
      expect(record.role).toBe('user');
    });

    it('should return 404 when demoting a nonexistent user', async () => {
      const response = await handleDemoteUser(env, 'usr_ghost');

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('not_found');
    });
  });
});
