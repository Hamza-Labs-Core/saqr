/**
 * Tests for JWT Auth Module (auth/jwt.ts)
 *
 * Covers:
 * - Sign/verify roundtrip
 * - Expired token rejection
 * - Tampered token rejection
 * - Invalid format rejection
 * - Issuer/audience validation
 */

import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, JWTError } from '../auth/jwt.js';
import type { JWTPayload, Tier } from '../types.js';

const TEST_SECRET = 'test-secret-key-for-jwt-testing-minimum-length-required';

function makePayload(overrides?: Partial<JWTPayload>): Omit<JWTPayload, 'iat' | 'exp'> {
  return {
    sub: 'usr_test123456',
    email: 'test@example.com',
    tier: 'free' as Tier,
    iss: 'saqr',
    aud: 'saqr-sync',
    ...overrides,
  };
}

describe('JWT Module', () => {
  describe('signToken', () => {
    it('should produce a valid JWT string with 3 parts', async () => {
      const token = await signToken(makePayload(), TEST_SECRET);
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
      // Each part should be non-empty
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
      expect(parts[2].length).toBeGreaterThan(0);
    });

    it('should include iat and exp claims by default', async () => {
      const token = await signToken(makePayload(), TEST_SECRET);
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    it('should set exp based on expiresInSeconds parameter', async () => {
      const token = await signToken(makePayload(), TEST_SECRET, 7200); // 2 hours
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.exp - payload.iat).toBe(7200);
    });
  });

  describe('verifyToken', () => {
    it('should successfully verify a valid token (roundtrip)', async () => {
      const originalPayload = makePayload();
      const token = await signToken(originalPayload, TEST_SECRET);
      const decoded = await verifyToken(token, TEST_SECRET);

      expect(decoded.sub).toBe('usr_test123456');
      expect(decoded.email).toBe('test@example.com');
      expect(decoded.tier).toBe('free');
      expect(decoded.iss).toBe('saqr');
      expect(decoded.aud).toBe('saqr-sync');
    });

    it('should reject an expired token', async () => {
      // Create a token that expired 1 hour ago
      const now = Math.floor(Date.now() / 1000);
      const token = await signToken(
        {
          ...makePayload(),
          iat: now - 7200,
          exp: now - 3600,
        },
        TEST_SECRET,
      );

      await expect(verifyToken(token, TEST_SECRET)).rejects.toThrow(JWTError);
      await expect(verifyToken(token, TEST_SECRET)).rejects.toThrow('Token expired');
    });

    it('should reject a tampered token', async () => {
      const token = await signToken(makePayload(), TEST_SECRET);
      // Tamper with the payload (change a character in the middle part)
      const parts = token.split('.');
      const tamperedPayload = parts[1].slice(0, -2) + 'XX';
      const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      await expect(verifyToken(tampered, TEST_SECRET)).rejects.toThrow(JWTError);
    });

    it('should reject a token signed with different secret', async () => {
      const token = await signToken(makePayload(), TEST_SECRET);
      await expect(verifyToken(token, 'wrong-secret-key')).rejects.toThrow(JWTError);
      await expect(verifyToken(token, 'wrong-secret-key')).rejects.toThrow('Invalid signature');
    });

    it('should reject a malformed token (not 3 parts)', async () => {
      await expect(verifyToken('not.a.valid.jwt.token', TEST_SECRET)).rejects.toThrow('Malformed token');
      await expect(verifyToken('only-one-part', TEST_SECRET)).rejects.toThrow('Malformed token');
      await expect(verifyToken('two.parts', TEST_SECRET)).rejects.toThrow('Malformed token');
    });

    it('should reject token with wrong issuer', async () => {
      const token = await signToken(makePayload({ iss: 'wrong-issuer' }), TEST_SECRET);
      await expect(
        verifyToken(token, TEST_SECRET, { issuer: 'saqr' }),
      ).rejects.toThrow('Invalid issuer');
    });

    it('should reject token with wrong audience', async () => {
      const token = await signToken(makePayload({ aud: 'wrong-audience' }), TEST_SECRET);
      await expect(
        verifyToken(token, TEST_SECRET, { audience: 'saqr-sync' }),
      ).rejects.toThrow('Invalid audience');
    });

    it('should accept token when issuer and audience match', async () => {
      const token = await signToken(makePayload(), TEST_SECRET);
      const decoded = await verifyToken(token, TEST_SECRET, {
        issuer: 'saqr',
        audience: 'saqr-sync',
      });
      expect(decoded.sub).toBe('usr_test123456');
    });

    it('should skip issuer check when not specified in options', async () => {
      const token = await signToken(makePayload({ iss: 'any-issuer' }), TEST_SECRET);
      const decoded = await verifyToken(token, TEST_SECRET);
      expect(decoded.iss).toBe('any-issuer');
    });
  });
});
