/**
 * Tests for Privacy Headers — Cookie-free enforcement and strict privacy.
 *
 * Covers:
 * - All required privacy headers are present
 * - No Set-Cookie headers
 * - Strict CSP
 * - Referrer-Policy
 * - Permissions-Policy
 * - X-Content-Type-Options
 * - Privacy header verification utility
 */

import { describe, it, expect } from 'vitest';
import {
  addPrivacyHeaders,
  verifyPrivacyHeaders,
  PRIVACY_HEADERS,
} from '../middleware/privacy-headers.js';

describe('Privacy Headers', () => {
  // -----------------------------------------------------------------------
  // PRIVACY_HEADERS constant
  // -----------------------------------------------------------------------

  describe('PRIVACY_HEADERS', () => {
    it('should define Content-Security-Policy', () => {
      expect(PRIVACY_HEADERS['Content-Security-Policy']).toBeDefined();
      expect(PRIVACY_HEADERS['Content-Security-Policy']).toContain("default-src 'none'");
    });

    it('should define Referrer-Policy as no-referrer', () => {
      expect(PRIVACY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    });

    it('should define Permissions-Policy', () => {
      expect(PRIVACY_HEADERS['Permissions-Policy']).toBeDefined();
      expect(PRIVACY_HEADERS['Permissions-Policy']).toContain('camera=()');
      expect(PRIVACY_HEADERS['Permissions-Policy']).toContain('microphone=()');
      expect(PRIVACY_HEADERS['Permissions-Policy']).toContain('geolocation=()');
    });

    it('should define X-Content-Type-Options as nosniff', () => {
      expect(PRIVACY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    });

    it('should define X-Frame-Options as DENY', () => {
      expect(PRIVACY_HEADERS['X-Frame-Options']).toBe('DENY');
    });

    it('should define Strict-Transport-Security with long max-age', () => {
      expect(PRIVACY_HEADERS['Strict-Transport-Security']).toContain('max-age=');
      expect(PRIVACY_HEADERS['Strict-Transport-Security']).toContain('includeSubDomains');
    });

    it('should define Cache-Control as no-store', () => {
      expect(PRIVACY_HEADERS['Cache-Control']).toContain('no-store');
    });

    it('should define Cross-Origin-Opener-Policy', () => {
      expect(PRIVACY_HEADERS['Cross-Origin-Opener-Policy']).toBe('same-origin');
    });

    it('should define Cross-Origin-Embedder-Policy', () => {
      expect(PRIVACY_HEADERS['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    });

    it('should define Cross-Origin-Resource-Policy', () => {
      expect(PRIVACY_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
    });
  });

  // -----------------------------------------------------------------------
  // addPrivacyHeaders
  // -----------------------------------------------------------------------

  describe('addPrivacyHeaders', () => {
    it('should add all privacy headers to response', () => {
      const response = new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      const augmented = addPrivacyHeaders(response);

      for (const [key, value] of Object.entries(PRIVACY_HEADERS)) {
        expect(augmented.headers.get(key)).toBe(value);
      }
    });

    it('should remove Set-Cookie headers', () => {
      const response = new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'session=abc123; Path=/',
        },
      });

      const augmented = addPrivacyHeaders(response);
      expect(augmented.headers.get('Set-Cookie')).toBeNull();
    });

    it('should preserve original response status', () => {
      const response = new Response('{}', { status: 201 });
      const augmented = addPrivacyHeaders(response);
      expect(augmented.status).toBe(201);
    });

    it('should preserve original response body', async () => {
      const body = JSON.stringify({ data: 'test' });
      const response = new Response(body, { status: 200 });
      const augmented = addPrivacyHeaders(response);
      const text = await augmented.text();
      expect(text).toBe(body);
    });

    it('should preserve other existing headers', () => {
      const response = new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
        },
      });

      const augmented = addPrivacyHeaders(response);
      expect(augmented.headers.get('Content-Type')).toBe('application/json');
      expect(augmented.headers.get('X-Custom-Header')).toBe('custom-value');
    });

    it('should override existing conflicting headers', () => {
      const response = new Response('{}', {
        status: 200,
        headers: {
          'Referrer-Policy': 'origin',
          'X-Content-Type-Options': 'nosniff',
        },
      });

      const augmented = addPrivacyHeaders(response);
      expect(augmented.headers.get('Referrer-Policy')).toBe('no-referrer');
    });
  });

  // -----------------------------------------------------------------------
  // verifyPrivacyHeaders
  // -----------------------------------------------------------------------

  describe('verifyPrivacyHeaders', () => {
    it('should report compliant response as compliant', () => {
      const response = new Response('{}', { status: 200 });
      const augmented = addPrivacyHeaders(response);
      const result = verifyPrivacyHeaders(augmented);

      expect(result.isCompliant).toBe(true);
      expect(result.missing).toHaveLength(0);
      expect(result.hasCookies).toBe(false);
    });

    it('should report non-compliant response with missing headers', () => {
      const response = new Response('{}', { status: 200 });
      const result = verifyPrivacyHeaders(response);

      expect(result.isCompliant).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
    });

    it('should detect Set-Cookie as non-compliant', () => {
      const response = new Response('{}', {
        status: 200,
        headers: {
          'Set-Cookie': 'tracking=yes',
          ...PRIVACY_HEADERS,
        },
      });

      const result = verifyPrivacyHeaders(response);
      expect(result.hasCookies).toBe(true);
      expect(result.isCompliant).toBe(false);
    });

    it('should list all missing headers', () => {
      const response = new Response('{}', {
        status: 200,
        headers: {
          'X-Content-Type-Options': 'nosniff',
        },
      });

      const result = verifyPrivacyHeaders(response);
      expect(result.missing).not.toContain('X-Content-Type-Options');
      expect(result.missing.length).toBe(Object.keys(PRIVACY_HEADERS).length - 1);
    });
  });

  // -----------------------------------------------------------------------
  // Cookie-Free Enforcement
  // -----------------------------------------------------------------------

  describe('Cookie-Free Enforcement', () => {
    it('should never allow Set-Cookie on any response status', () => {
      for (const status of [200, 201, 204, 301, 400, 401, 403, 404, 500]) {
        const response = new Response(null, {
          status,
          headers: { 'Set-Cookie': 'tracker=abc' },
        });
        const augmented = addPrivacyHeaders(response);
        expect(augmented.headers.get('Set-Cookie')).toBeNull();
      }
    });
  });
});
