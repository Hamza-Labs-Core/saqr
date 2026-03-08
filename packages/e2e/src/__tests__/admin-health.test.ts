import { describe, it, expect, beforeAll } from 'vitest';
import { ADMIN_URL, adminGet, waitForHealthy } from '../helpers/client.js';
import { assertSecurityHeaders } from '../helpers/assert-headers.js';

describe('admin-server health', () => {
  beforeAll(async () => {
    await waitForHealthy(ADMIN_URL);
  });

  it('GET /api/health returns 200 with status ok and service admin', async () => {
    const res = await adminGet('/api/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      service: string;
      timestamp: string;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('admin');
    expect(body.timestamp).toBeTruthy();
  });

  it('GET /api/health includes security headers', async () => {
    const res = await adminGet('/api/health');
    assertSecurityHeaders(res);
  });

  it('GET /api/admin/codeguard/curated without token returns 401', async () => {
    const res = await adminGet('/api/admin/codeguard/curated');
    expect(res.status).toBe(401);
  });

  it('GET /unknown-route returns 404', async () => {
    const res = await adminGet('/api/nonexistent');
    expect(res.status).toBe(404);
  });
});
