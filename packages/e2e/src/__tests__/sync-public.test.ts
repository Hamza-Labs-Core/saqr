import { describe, it, expect, beforeAll } from 'vitest';
import { SYNC_URL, syncGet, waitForHealthy } from '../helpers/client.js';
import { assertSecurityHeaders } from '../helpers/assert-headers.js';

describe('sync-server public endpoints', () => {
  beforeAll(async () => {
    await waitForHealthy(SYNC_URL);
  });

  describe('GET /api/codeguard/curated', () => {
    it('returns 200 with rules array', async () => {
      const res = await syncGet('/api/codeguard/curated');
      expect(res.status).toBe(200);
      assertSecurityHeaders(res);

      const body = (await res.json()) as {
        version: number;
        updated: string | null;
        rules: unknown[];
      };
      expect(typeof body.version).toBe('number');
      expect(Array.isArray(body.rules)).toBe(true);
    });

    it('every rule has the expected shape', async () => {
      const res = await syncGet('/api/codeguard/curated');
      const body = (await res.json()) as {
        rules: Array<{
          id: string;
          description: string;
          severity: string;
          enabled: boolean;
          file_patterns: string[];
          patterns: string[];
        }>;
      };

      for (const rule of body.rules) {
        expect(typeof rule.id).toBe('string');
        expect(typeof rule.description).toBe('string');
        expect(['block', 'warn']).toContain(rule.severity);
        expect(rule.enabled).toBe(true);
        expect(Array.isArray(rule.file_patterns)).toBe(true);
        expect(Array.isArray(rule.patterns)).toBe(true);
      }
    });
  });

  describe('GET /api/codeguard/popular', () => {
    it('returns 200 with rules array', async () => {
      const res = await syncGet('/api/codeguard/popular');
      expect(res.status).toBe(200);
      assertSecurityHeaders(res);

      const body = (await res.json()) as {
        updated: string | null;
        rules: unknown[];
      };
      expect(Array.isArray(body.rules)).toBe(true);
    });

    it('every entry has expected fields', async () => {
      const res = await syncGet('/api/codeguard/popular');
      const body = (await res.json()) as {
        rules: Array<{
          rule: { id: string; description: string };
          total_installs: number;
          total_blocks: number;
        }>;
      };

      for (const entry of body.rules) {
        expect(typeof entry.rule.id).toBe('string');
        expect(typeof entry.rule.description).toBe('string');
        expect(typeof entry.total_installs).toBe('number');
        expect(typeof entry.total_blocks).toBe('number');
      }
    });
  });
});
