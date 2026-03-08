import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  SYNC_URL,
  syncGet,
  syncDelete,
  waitForHealthy,
  createTestAccount,
  type TestAccount,
} from '../helpers/client.js';
import { assertSecurityHeaders } from '../helpers/assert-headers.js';

describe('sync-server account', () => {
  let account: TestAccount;

  beforeAll(async () => {
    await waitForHealthy(SYNC_URL);
    account = await createTestAccount();
  });

  afterAll(async () => {
    // Self-cleans: the final test deletes the account.
    // If it didn't run or failed, try cleanup anyway.
    try {
      await syncDelete(
        '/api/account',
        { confirmation: 'DELETE MY ACCOUNT' },
        account?.token,
      );
    } catch {
      // already deleted — ignore
    }
  });

  it('GET /api/account → 200 with user info', async () => {
    const res = await syncGet('/api/account', account.token);
    expect(res.status).toBe(200);
    assertSecurityHeaders(res);

    const body = (await res.json()) as {
      user_id: string;
      email: string;
      tier: string;
      email_verified: boolean;
      storage_used_bytes: number;
      created_at: string;
    };
    expect(body.user_id).toBe(account.userId);
    expect(body.email).toBe(account.email);
    expect(body.tier).toBe('free');
    expect(body.email_verified).toBe(false);
    expect(typeof body.storage_used_bytes).toBe('number');
    expect(body.created_at).toBeTruthy();
  });

  it('GET /api/account without token → 401', async () => {
    const res = await syncGet('/api/account');
    expect(res.status).toBe(401);
  });

  it('DELETE /api/account with wrong confirmation → 400', async () => {
    const res = await syncDelete(
      '/api/account',
      { confirmation: 'wrong' },
      account.token,
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_confirmation');
  });

  it('DELETE /api/account → 200', async () => {
    const res = await syncDelete(
      '/api/account',
      { confirmation: 'DELETE MY ACCOUNT' },
      account.token,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      deleted: boolean;
      user_id: string;
      deletion_id: string;
      crypto_shredded: boolean;
    };
    expect(body.deleted).toBe(true);
    expect(body.user_id).toBe(account.userId);
    expect(body.deletion_id).toMatch(/^del_/);
    expect(body.crypto_shredded).toBe(true);
  });
});
