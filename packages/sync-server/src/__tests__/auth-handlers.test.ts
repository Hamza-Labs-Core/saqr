/**
 * Tests for Auth Handlers (auth/handlers.ts)
 *
 * Covers:
 * - Register new user
 * - Duplicate email rejection
 * - Login success/failure
 * - Password hashing/verification
 * - Input validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleRegister, handleLogin, hashPassword, verifyPassword } from '../auth/handlers.js';
import { createMockEnv, createRequest, MockKVNamespace } from './helpers/mock-env.js';
import type { Env } from '../types.js';

describe('Auth Handlers', () => {
  let env: Env;
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = new MockKVNamespace();
    env = createMockEnv({
      AUTH_KV: kv as unknown as KVNamespace,
    });
  });

  // -----------------------------------------------------------------------
  // Password Hashing
  // -----------------------------------------------------------------------

  describe('Password Hashing', () => {
    it('should hash and verify a password correctly', async () => {
      const password = 'my-secure-password-12345';
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).toContain(':'); // salt:hash format
      expect(hash.length).toBeGreaterThan(64);

      const valid = await verifyPassword(password, hash);
      expect(valid).toBe(true);
    });

    it('should reject wrong password', async () => {
      const hash = await hashPassword('correct-password-123');
      const valid = await verifyPassword('wrong-password-1234', hash);
      expect(valid).toBe(false);
    });

    it('should produce different hashes for same password (random salt)', async () => {
      const hash1 = await hashPassword('same-password-12345');
      const hash2 = await hashPassword('same-password-12345');
      expect(hash1).not.toBe(hash2);

      // But both should verify
      expect(await verifyPassword('same-password-12345', hash1)).toBe(true);
      expect(await verifyPassword('same-password-12345', hash2)).toBe(true);
    });

    it('should reject malformed hash', async () => {
      const valid = await verifyPassword('password12345', 'not-a-valid-hash');
      expect(valid).toBe(false);
    });

    it('should produce hashes in salt_hex:hash_hex format with 64-char salt and 64-char hash', async () => {
      const hash = await hashPassword('test-password-123');
      const [saltHex, hashHex] = hash.split(':');
      // 32-byte salt = 64 hex chars, 32-byte derived key = 64 hex chars
      expect(saltHex).toHaveLength(64);
      expect(hashHex).toHaveLength(64);
      expect(saltHex).toMatch(/^[0-9a-f]+$/);
      expect(hashHex).toMatch(/^[0-9a-f]+$/);
    });

    it('should reject empty salt or hash parts', async () => {
      expect(await verifyPassword('password12345', ':')).toBe(false);
      expect(await verifyPassword('password12345', 'abc:')).toBe(false);
      expect(await verifyPassword('password12345', ':abc')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Register
  // -----------------------------------------------------------------------

  describe('handleRegister', () => {
    it('should register a new user successfully', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: 'newuser@example.com',
        password: 'secure-password-123',
      });

      const response = await handleRegister(request, env);
      expect(response.status).toBe(201);

      const body = await response.json() as Record<string, unknown>;
      expect(body.access_token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(3600);
      expect((body.user as Record<string, unknown>).email).toBe('newuser@example.com');
      expect((body.user as Record<string, unknown>).tier).toBe('free');
      expect(((body.user as Record<string, unknown>).user_id as string).startsWith('usr_')).toBe(true);
    });

    it('should store user in KV', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: 'kvuser@example.com',
        password: 'secure-password-123',
      });

      await handleRegister(request, env);

      const stored = await kv.get('user:kvuser@example.com');
      expect(stored).not.toBeNull();

      const record = JSON.parse(stored!);
      expect(record.email).toBe('kvuser@example.com');
      expect(record.userId).toBeDefined();
      expect(record.passwordHash).toBeDefined();
      expect(record.tier).toBe('free');
    });

    it('should reject duplicate email', async () => {
      // Register first user
      const request1 = createRequest('POST', '/api/auth/register', {
        email: 'dupe@example.com',
        password: 'secure-password-123',
      });
      const response1 = await handleRegister(request1, env);
      expect(response1.status).toBe(201);

      // Try to register same email
      const request2 = createRequest('POST', '/api/auth/register', {
        email: 'dupe@example.com',
        password: 'another-password-456',
      });
      const response2 = await handleRegister(request2, env);
      expect(response2.status).toBe(409);

      const body = await response2.json() as Record<string, unknown>;
      expect(body.error).toBe('email_exists');
    });

    it('should reject invalid email', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: 'not-an-email',
        password: 'secure-password-123',
      });
      const response = await handleRegister(request, env);
      expect(response.status).toBe(400);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_email');
    });

    it('should reject empty email', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: '',
        password: 'secure-password-123',
      });
      const response = await handleRegister(request, env);
      expect(response.status).toBe(400);
    });

    it('should reject short password (< 12 chars)', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: 'user@example.com',
        password: 'short',
      });
      const response = await handleRegister(request, env);
      expect(response.status).toBe(400);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_password');
    });

    it('should reject missing password', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: 'user@example.com',
      });
      const response = await handleRegister(request, env);
      expect(response.status).toBe(400);
    });

    it('should reject invalid JSON body', async () => {
      const request = new Request('https://test.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      const response = await handleRegister(request, env);
      expect(response.status).toBe(400);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_body');
    });

    it('should normalize email to lowercase', async () => {
      const request = createRequest('POST', '/api/auth/register', {
        email: 'User@EXAMPLE.com',
        password: 'secure-password-123',
      });
      const response = await handleRegister(request, env);
      expect(response.status).toBe(201);

      const body = await response.json() as Record<string, unknown>;
      expect((body.user as Record<string, unknown>).email).toBe('user@example.com');
    });
  });

  // -----------------------------------------------------------------------
  // Login
  // -----------------------------------------------------------------------

  describe('handleLogin', () => {
    beforeEach(async () => {
      // Register a user first
      const request = createRequest('POST', '/api/auth/register', {
        email: 'existing@example.com',
        password: 'existing-password-123',
      });
      await handleRegister(request, env);
    });

    it('should login successfully with correct credentials', async () => {
      const request = createRequest('POST', '/api/auth/login', {
        email: 'existing@example.com',
        password: 'existing-password-123',
      });

      const response = await handleLogin(request, env);
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.access_token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(3600);
      expect((body.user as Record<string, unknown>).email).toBe('existing@example.com');
    });

    it('should reject wrong password', async () => {
      const request = createRequest('POST', '/api/auth/login', {
        email: 'existing@example.com',
        password: 'wrong-password-12345',
      });

      const response = await handleLogin(request, env);
      expect(response.status).toBe(401);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_credentials');
      // Should not reveal whether email exists
      expect(body.message).toBe('Invalid email or password');
    });

    it('should reject non-existent email with same error (no enumeration)', async () => {
      const request = createRequest('POST', '/api/auth/login', {
        email: 'nonexistent@example.com',
        password: 'some-password-12345',
      });

      const response = await handleLogin(request, env);
      expect(response.status).toBe(401);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_credentials');
      expect(body.message).toBe('Invalid email or password');
    });

    it('should reject missing fields', async () => {
      const request = createRequest('POST', '/api/auth/login', {
        email: 'existing@example.com',
      });

      const response = await handleLogin(request, env);
      expect(response.status).toBe(400);
    });

    it('should reject invalid JSON body', async () => {
      const request = new Request('https://test.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      const response = await handleLogin(request, env);
      expect(response.status).toBe(400);
    });

    it('should normalize email for login', async () => {
      const request = createRequest('POST', '/api/auth/login', {
        email: 'EXISTING@example.com',
        password: 'existing-password-123',
      });

      const response = await handleLogin(request, env);
      expect(response.status).toBe(200);
    });
  });
});
