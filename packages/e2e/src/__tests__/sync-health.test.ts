import { describe, it, expect, beforeAll } from 'vitest';
import { SYNC_URL, syncGet, waitForHealthy } from '../helpers/client.js';
import { assertSecurityHeaders } from '../helpers/assert-headers.js';

describe('sync-server health', () => {
  beforeAll(async () => {
    await waitForHealthy(SYNC_URL);
  });

  it('GET /api/health returns 200 with status ok', async () => {
    const res = await syncGet('/api/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeTruthy();
  });

  it('GET /api/health includes security headers', async () => {
    const res = await syncGet('/api/health');
    assertSecurityHeaders(res);
  });

  it('GET /unknown-route returns 404', async () => {
    const res = await syncGet('/api/nonexistent');
    expect(res.status).toBe(404);
  });
});
