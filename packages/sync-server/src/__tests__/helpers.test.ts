/**
 * Tests for utility/helper functions
 *
 * Covers:
 * - ID generation
 * - Email validation
 * - Password validation
 * - Response helpers
 * - Encoding helpers
 * - Tier configuration
 */

import { describe, it, expect } from 'vitest';
import {
  generateId,
  isValidEmail,
  isValidPassword,
  jsonResponse,
  errorResponse,
  base64ToArrayBuffer,
  arrayBufferToBase64,
  formatBytes,
  getTierLimits,
  currentMinuteKey,
  secondsUntilNextMinute,
  withSecurityHeaders,
} from '../helpers.js';
import { createMockEnv } from './helpers/mock-env.js';

describe('Helpers', () => {
  // -----------------------------------------------------------------------
  // ID Generation
  // -----------------------------------------------------------------------

  describe('generateId', () => {
    it('should generate a 12-character string by default', () => {
      const id = generateId();
      expect(id).toHaveLength(12);
    });

    it('should generate string of requested length', () => {
      expect(generateId(6)).toHaveLength(6);
      expect(generateId(24)).toHaveLength(24);
      expect(generateId(1)).toHaveLength(1);
    });

    it('should only contain lowercase alphanumeric characters', () => {
      const id = generateId(100);
      expect(id).toMatch(/^[a-z0-9]+$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }
      // All 100 should be unique
      expect(ids.size).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // Email Validation
  // -----------------------------------------------------------------------

  describe('isValidEmail', () => {
    it('should accept valid emails', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
      expect(isValidEmail('test.user@domain.co')).toBe(true);
      expect(isValidEmail('a@b.c')).toBe(true);
      expect(isValidEmail('user+tag@example.com')).toBe(true);
    });

    it('should reject invalid emails', () => {
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail('not-an-email')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
      expect(isValidEmail('user@')).toBe(false);
      expect(isValidEmail('user@.com')).toBe(false);
      expect(isValidEmail('user @example.com')).toBe(false);
    });

    it('should reject null/undefined', () => {
      expect(isValidEmail(null as unknown as string)).toBe(false);
      expect(isValidEmail(undefined as unknown as string)).toBe(false);
    });

    it('should reject very long emails (> 254 chars)', () => {
      const longEmail = 'a'.repeat(246) + '@test.com'; // 246 + 9 = 255 chars
      expect(isValidEmail(longEmail)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Password Validation
  // -----------------------------------------------------------------------

  describe('isValidPassword', () => {
    it('should accept passwords >= 12 characters', () => {
      expect(isValidPassword('123456789012')).toBe(true);
      expect(isValidPassword('a-very-secure-password')).toBe(true);
    });

    it('should reject passwords < 12 characters', () => {
      expect(isValidPassword('short')).toBe(false);
      expect(isValidPassword('12345678901')).toBe(false);
      expect(isValidPassword('')).toBe(false);
    });

    it('should reject passwords > 1024 characters', () => {
      expect(isValidPassword('a'.repeat(1025))).toBe(false);
    });

    it('should accept passwords exactly 12 characters', () => {
      expect(isValidPassword('exactly12chr')).toBe(true);
    });

    it('should reject null/undefined', () => {
      expect(isValidPassword(null as unknown as string)).toBe(false);
      expect(isValidPassword(undefined as unknown as string)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Response Helpers
  // -----------------------------------------------------------------------

  describe('jsonResponse', () => {
    it('should create a JSON response with correct Content-Type', async () => {
      const response = jsonResponse(200, { test: true });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const body = await response.json() as Record<string, unknown>;
      expect(body.test).toBe(true);
    });

    it('should support custom status codes', () => {
      expect(jsonResponse(201, {}).status).toBe(201);
      expect(jsonResponse(400, {}).status).toBe(400);
      expect(jsonResponse(500, {}).status).toBe(500);
    });

    it('should support extra headers', () => {
      const response = jsonResponse(200, {}, { 'X-Custom': 'value' });
      expect(response.headers.get('X-Custom')).toBe('value');
    });
  });

  describe('errorResponse', () => {
    it('should create error response with error and message', async () => {
      const response = errorResponse(400, 'bad_request', 'Something went wrong');
      expect(response.status).toBe(400);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('bad_request');
      expect(body.message).toBe('Something went wrong');
    });

    it('should include extra fields', async () => {
      const response = errorResponse(413, 'storage_exceeded', 'Quota exceeded', {
        storage_used_bytes: 1000,
        storage_quota_bytes: 500,
      });

      const body = await response.json() as Record<string, unknown>;
      expect(body.storage_used_bytes).toBe(1000);
      expect(body.storage_quota_bytes).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // Security Headers
  // -----------------------------------------------------------------------

  describe('withSecurityHeaders', () => {
    it('should add all required security headers', () => {
      const original = new Response('test');
      const response = withSecurityHeaders(original);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  // -----------------------------------------------------------------------
  // Encoding Helpers
  // -----------------------------------------------------------------------

  describe('base64ToArrayBuffer / arrayBufferToBase64', () => {
    it('should roundtrip encode/decode correctly', () => {
      const original = 'Hello, World!';
      const base64 = btoa(original);
      const buffer = base64ToArrayBuffer(base64);
      const decoded = arrayBufferToBase64(buffer);
      expect(decoded).toBe(base64);
    });

    it('should handle empty input', () => {
      const buffer = base64ToArrayBuffer('');
      expect(buffer.byteLength).toBe(0);
    });

    it('should handle binary data', () => {
      const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
      const base64 = arrayBufferToBase64(bytes.buffer);
      const decoded = base64ToArrayBuffer(base64);
      expect(new Uint8Array(decoded)).toEqual(bytes);
    });
  });

  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1048576)).toBe('1.0 MB');
      expect(formatBytes(5242880)).toBe('5.0 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1.0 GB');
    });
  });

  // -----------------------------------------------------------------------
  // Time Helpers
  // -----------------------------------------------------------------------

  describe('currentMinuteKey', () => {
    it('should return a string in format YYYY-MM-DDThh:mm', () => {
      const key = currentMinuteKey();
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });
  });

  describe('secondsUntilNextMinute', () => {
    it('should return a value between 0 and 60', () => {
      const seconds = secondsUntilNextMinute();
      expect(seconds).toBeGreaterThanOrEqual(0);
      expect(seconds).toBeLessThanOrEqual(60);
    });
  });

  // -----------------------------------------------------------------------
  // Tier Configuration
  // -----------------------------------------------------------------------

  describe('getTierLimits', () => {
    const env = createMockEnv();

    it('should return free tier limits', () => {
      const limits = getTierLimits('free', env);
      expect(limits.machineLimit).toBe(2);
      expect(limits.storageBytes).toBe(5242880);
      expect(limits.retentionDays).toBe(30);
      expect(limits.ratePerMin).toBe(60);
    });

    it('should return pro tier limits', () => {
      const limits = getTierLimits('pro', env);
      expect(limits.machineLimit).toBe(5);
      expect(limits.storageBytes).toBe(524288000);
      expect(limits.retentionDays).toBe(365);
      expect(limits.ratePerMin).toBe(600);
    });

    it('should return team tier limits', () => {
      const limits = getTierLimits('team', env);
      expect(limits.machineLimit).toBe(0); // unlimited
      expect(limits.storageBytes).toBe(5368709120);
      expect(limits.retentionDays).toBe(0); // unlimited
      expect(limits.ratePerMin).toBe(6000);
    });
  });
});
