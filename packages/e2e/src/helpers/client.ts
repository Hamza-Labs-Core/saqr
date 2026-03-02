export const SYNC_URL =
  process.env.E2E_SYNC_URL ?? 'https://saqr-sync-preview.workers.dev';

export const ADMIN_URL =
  process.env.E2E_ADMIN_URL ?? 'https://saqr-admin-preview.workers.dev';

export const TEST_PASSWORD = 'e2e-Secure-Pass-12345';

export function makeUniqueEmail(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-${ts}-${rand}@test.saqr.dev`;
}

// ── Sync-server fetch helpers ───────────────────────────────────────

export async function syncGet(
  path: string,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${SYNC_URL}${path}`, { method: 'GET', headers });
}

export async function syncPost(
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${SYNC_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export async function syncDelete(
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${SYNC_URL}${path}`, {
    method: 'DELETE',
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

// ── Admin-server fetch helpers ──────────────────────────────────────

export async function adminGet(
  path: string,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${ADMIN_URL}${path}`, { method: 'GET', headers });
}

// ── Cold-start retry ────────────────────────────────────────────────

export async function waitForHealthy(
  url: string,
  maxAttempts = 10,
  delayMs = 3_000,
): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // network error — retry
    }
    if (i < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `${url}/api/health not healthy after ${maxAttempts} attempts`,
  );
}

// ── Account lifecycle helpers ───────────────────────────────────────

export interface TestAccount {
  email: string;
  token: string;
  userId: string;
}

export async function createTestAccount(): Promise<TestAccount> {
  const email = makeUniqueEmail();
  const res = await syncPost('/api/auth/register', {
    email,
    password: TEST_PASSWORD,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Register failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    user: { user_id: string };
  };
  return { email, token: data.access_token, userId: data.user.user_id };
}

export async function deleteTestAccount(token: string): Promise<void> {
  await syncDelete(
    '/api/account',
    { confirmation: 'DELETE MY ACCOUNT' },
    token,
  );
}
