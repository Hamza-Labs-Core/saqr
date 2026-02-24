/**
 * Mock Cloudflare Workers environment bindings for testing.
 *
 * Provides mock implementations of KVNamespace, R2Bucket,
 * DurableObjectNamespace, DurableObjectState, and SqlStorage.
 */

import type { Env, AuthContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock KV Namespace
// ---------------------------------------------------------------------------

export class MockKVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiration && Date.now() / 1000 > entry.expiration) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number },
  ): Promise<void> {
    const expiration = options?.expiration
      ? options.expiration
      : options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : undefined;
    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    const keys: { name: string }[] = [];
    for (const key of this.store.keys()) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        keys.push({ name: key });
      }
    }
    return { keys, list_complete: true };
  }

  /** Test helper: clear all entries */
  clear(): void {
    this.store.clear();
  }

  /** Test helper: get raw store size */
  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Mock R2 Bucket
// ---------------------------------------------------------------------------

export class MockR2Bucket {
  private store = new Map<string, { body: ArrayBuffer; metadata?: Record<string, string> }>();

  async put(
    key: string,
    body: ArrayBuffer | ReadableStream | string,
    _options?: Record<string, unknown>,
  ): Promise<{ key: string }> {
    let data: ArrayBuffer;
    if (typeof body === 'string') {
      data = new TextEncoder().encode(body).buffer;
    } else if (body instanceof ArrayBuffer) {
      data = body;
    } else {
      // ReadableStream: read all chunks
      const reader = (body as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) chunks.push(result.value);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      data = merged.buffer;
    }
    this.store.set(key, { body: data });
    return { key };
  }

  async get(key: string): Promise<{ body: ReadableStream; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    const body = entry.body;
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(body));
          controller.close();
        },
      }),
      arrayBuffer: async () => body,
    };
  }

  async delete(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      this.store.delete(k);
    }
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }> {
    const objects: { key: string }[] = [];
    for (const key of this.store.keys()) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        objects.push({ key });
      }
    }
    return { objects, truncated: false };
  }

  /** Test helper */
  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Mock SQL Storage (simplified in-memory SQLite-like store)
// ---------------------------------------------------------------------------

/**
 * MockSqlStorage provides a minimal mock for SqlStorage.
 * It stores raw SQL executions and allows tests to check schema creation.
 *
 * For actual SQL execution testing, we track calls and provide
 * a simple key-value based result system.
 */
export class MockSqlStorage {
  public execCalls: string[] = [];
  private tables = new Map<string, unknown[]>();

  exec(query: string, ..._params: unknown[]): { toArray: () => unknown[]; one: () => unknown | undefined } {
    this.execCalls.push(query);

    // Return empty results by default
    return {
      toArray: () => [],
      one: () => undefined,
    };
  }

  /** Test helper: check if a table creation query was called */
  hasTableCreation(tableName: string): boolean {
    return this.execCalls.some(q =>
      q.toLowerCase().includes(`create table if not exists ${tableName.toLowerCase()}`),
    );
  }
}

// ---------------------------------------------------------------------------
// Mock Durable Object State
// ---------------------------------------------------------------------------

export class MockDurableObjectState {
  public storage: {
    sql: MockSqlStorage;
    get: (key: string) => Promise<unknown>;
    put: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<boolean>;
    setAlarm: (scheduledTime: number) => Promise<void>;
  };

  private kvStore = new Map<string, unknown>();
  public alarmTime: number | null = null;

  constructor() {
    const sqlStorage = new MockSqlStorage();
    const self = this;

    this.storage = {
      sql: sqlStorage,
      get: async (key: string) => self.kvStore.get(key),
      put: async (key: string, value: unknown) => { self.kvStore.set(key, value); },
      delete: async (key: string) => self.kvStore.delete(key),
      setAlarm: async (scheduledTime: number) => { self.alarmTime = scheduledTime; },
    };
  }
}

// ---------------------------------------------------------------------------
// Mock Durable Object Namespace
// ---------------------------------------------------------------------------

export class MockDurableObjectNamespace {
  private stubs = new Map<string, MockDurableObjectStub>();

  idFromName(name: string): { toString: () => string; name: string } {
    return { toString: () => name, name };
  }

  get(_id: { toString: () => string }): MockDurableObjectStub {
    const key = _id.toString();
    if (!this.stubs.has(key)) {
      this.stubs.set(key, new MockDurableObjectStub());
    }
    return this.stubs.get(key)!;
  }
}

export class MockDurableObjectStub {
  public lastRequest: Request | null = null;
  public mockResponse: Response = new Response('{}', {
    headers: { 'Content-Type': 'application/json' },
  });

  async fetch(request: Request): Promise<Response> {
    this.lastRequest = request;
    return this.mockResponse;
  }

  /** Test helper: set the response the stub will return */
  setResponse(status: number, body: unknown): void {
    this.mockResponse = new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ---------------------------------------------------------------------------
// Create Mock Environment
// ---------------------------------------------------------------------------

export function createMockEnv(overrides?: Partial<Env>): Env {
  return {
    USER_SYNC: new MockDurableObjectNamespace() as unknown as DurableObjectNamespace,
    SYNC_BUCKET: new MockR2Bucket() as unknown as R2Bucket,
    AUTH_KV: new MockKVNamespace() as unknown as KVNamespace,
    REGISTRY_KV: new MockKVNamespace() as unknown as KVNamespace,
    JWT_SECRET: 'test-secret-key-for-testing-only-minimum-length',
    JWT_ISSUER: 'saqr',
    JWT_AUDIENCE: 'saqr-sync',
    ALLOWED_ORIGINS: '',
    FREE_TIER_STORAGE_BYTES: '5242880',
    PRO_TIER_STORAGE_BYTES: '524288000',
    TEAM_TIER_STORAGE_BYTES: '5368709120',
    FREE_TIER_MACHINES: '2',
    PRO_TIER_MACHINES: '5',
    TEAM_TIER_MACHINES: '0',
    FREE_TIER_RATE_PER_MIN: '60',
    PRO_TIER_RATE_PER_MIN: '600',
    TEAM_TIER_RATE_PER_MIN: '6000',
    FREE_TIER_RETENTION_DAYS: '30',
    PRO_TIER_RETENTION_DAYS: '365',
    TEAM_TIER_RETENTION_DAYS: '0',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Request Helpers
// ---------------------------------------------------------------------------

export function createRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const url = `https://sync.test.dev${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

export function createAuthRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return createRequest(method, path, body, {
    Authorization: `Bearer ${token}`,
    ...headers,
  });
}

/** Create a mock AuthContext */
export function createMockAuthCtx(overrides?: Partial<AuthContext>): AuthContext {
  return {
    userId: 'usr_test123456',
    email: 'test@example.com',
    tier: 'free',
    ...overrides,
  };
}
