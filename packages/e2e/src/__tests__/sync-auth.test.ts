import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  SYNC_URL,
  syncPost,
  makeUniqueEmail,
  TEST_PASSWORD,
  waitForHealthy,
  deleteTestAccount,
} from '../helpers/client.js';
import { assertSecurityHeaders } from '../helpers/assert-headers.js';

describe('sync-server auth', () => {
  const email = makeUniqueEmail();
  let token: string;

  beforeAll(async () => {
    await waitForHealthy(SYNC_URL);
  });

  afterAll(async () => {
    if (token) {
      await deleteTestAccount(token);
    }
  });

  // ── Registration ────────────────────────────────────────────────

  it('POST /api/auth/register → 201 with token and user', async () => {
    const res = await syncPost('/api/auth/register', {
      email,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(201);
    assertSecurityHeaders(res);

    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      user: { user_id: string; email: string; tier: string };
    };
    expect(body.access_token).toBeTruthy();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.user.email).toBe(email.toLowerCase().trim());
    expect(body.user.user_id).toMatch(/^usr_/);
    expect(body.user.tier).toBe('free');

    token = body.access_token;
  });

  it('duplicate register → 409 email_exists', async () => {
    const res = await syncPost('/api/auth/register', {
      email,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('email_exists');
  });

  it('register with invalid email → 400', async () => {
    const res = await syncPost('/api/auth/register', {
      email: 'not-an-email',
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it('register with short password → 400', async () => {
    const res = await syncPost('/api/auth/register', {
      email: makeUniqueEmail(),
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  // ── Login ───────────────────────────────────────────────────────

  it('POST /api/auth/login → 200 with token', async () => {
    const res = await syncPost('/api/auth/login', {
      email,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      access_token: string;
      user: { user_id: string; email: string };
    };
    expect(body.access_token).toBeTruthy();
    expect(body.user.email).toBe(email.toLowerCase().trim());

    // Update token in case register token expired
    token = body.access_token;
  });

  it('login with wrong password → 401', async () => {
    const res = await syncPost('/api/auth/login', {
      email,
      password: 'wrong-password-definitely',
    });
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_credentials');
  });

  it('login with missing fields → 400', async () => {
    const res = await syncPost('/api/auth/login', { email });
    expect(res.status).toBe(400);
  });
});
