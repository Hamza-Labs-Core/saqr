import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  SYNC_URL,
  syncGet,
  syncPost,
  syncDelete,
  waitForHealthy,
  createTestAccount,
  deleteTestAccount,
  type TestAccount,
} from '../helpers/client.js';
import { assertSecurityHeaders } from '../helpers/assert-headers.js';

describe('sync-server machines', () => {
  let account: TestAccount;
  const machineId = `e2e-machine-${Date.now()}`;

  beforeAll(async () => {
    await waitForHealthy(SYNC_URL);
    account = await createTestAccount();
  });

  afterAll(async () => {
    if (account?.token) {
      await deleteTestAccount(account.token);
    }
  });

  it('GET /api/machines without token → 401', async () => {
    const res = await syncGet('/api/machines');
    expect(res.status).toBe(401);
  });

  it('GET /api/machines (authed, empty) → 200', async () => {
    const res = await syncGet('/api/machines', account.token);
    expect(res.status).toBe(200);
    assertSecurityHeaders(res);

    const body = (await res.json()) as { machines: unknown[] };
    expect(Array.isArray(body.machines)).toBe(true);
    expect(body.machines.length).toBe(0);
  });

  it('POST /api/machines → 201', async () => {
    const res = await syncPost(
      '/api/machines',
      {
        machine_id: machineId,
        name: 'E2E Test Machine',
        os: 'linux',
        arch: 'x64',
        hostname: 'e2e-host',
      },
      account.token,
    );
    expect(res.status).toBe(201);
    assertSecurityHeaders(res);

    const body = (await res.json()) as {
      machine_id: string;
      name: string;
      registered_at: string;
    };
    expect(body.machine_id).toBe(machineId);
    expect(body.name).toBe('E2E Test Machine');
    expect(body.registered_at).toBeTruthy();
  });

  it('GET /api/machines shows the registered machine', async () => {
    const res = await syncGet('/api/machines', account.token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      machines: Array<{
        machine_id: string;
        name: string;
        os: string;
        arch: string;
        hostname: string;
        is_active: number;
      }>;
    };
    expect(body.machines.length).toBe(1);

    const machine = body.machines[0];
    expect(machine.machine_id).toBe(machineId);
    expect(machine.name).toBe('E2E Test Machine');
    expect(machine.os).toBe('linux');
    expect(machine.arch).toBe('x64');
    expect(machine.hostname).toBe('e2e-host');
    expect(machine.is_active).toBe(1);
  });

  it('DELETE /api/machines/:id → 200', async () => {
    const res = await syncDelete(
      `/api/machines/${machineId}`,
      undefined,
      account.token,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      deleted: boolean;
      machine_id: string;
    };
    expect(body.deleted).toBe(true);
    expect(body.machine_id).toBe(machineId);
  });

  it('GET /api/machines is empty after deletion', async () => {
    const res = await syncGet('/api/machines', account.token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { machines: unknown[] };
    expect(body.machines.length).toBe(0);
  });
});
