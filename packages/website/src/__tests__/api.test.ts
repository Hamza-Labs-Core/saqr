/**
 * Tests for the API client utility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiPost, apiGet, getSyncServerUrl } from '../lib/api';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('getSyncServerUrl', () => {
    it('returns default URL in non-browser environment', () => {
      const url = getSyncServerUrl();
      expect(url).toBe('https://sync.saqr.dev');
    });
  });

  describe('apiPost', () => {
    it('sends POST request with JSON body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'token123' }),
      });

      const result = await apiPost('/api/auth/login', { email: 'test@example.com', password: 'p'.repeat(12) });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://sync.saqr.dev/api/auth/login');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(result.data).toEqual({ access_token: 'token123' });
      expect(result.status).toBe(200);
    });

    it('includes auth token when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'approved' }),
      });

      await apiPost('/api/auth/device-approve', { user_code: 'ABCD-1234' }, 'mytoken');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['Authorization']).toBe('Bearer mytoken');
    });

    it('returns error for non-OK responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_credentials', message: 'Bad password' }),
      });

      const result = await apiPost('/api/auth/login', { email: 'test@example.com', password: 'wrong' });
      expect(result.error).toEqual({ error: 'invalid_credentials', message: 'Bad password' });
      expect(result.status).toBe(401);
    });
  });

  describe('apiGet', () => {
    it('sends GET request with auth token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ machines: [] }),
      });

      const result = await apiGet('/api/machines', 'mytoken');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://sync.saqr.dev/api/machines');
      expect(opts.headers['Authorization']).toBe('Bearer mytoken');
      expect(result.data).toEqual({ machines: [] });
    });

    it('sends GET request without auth', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      });

      await apiGet('/api/health');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['Authorization']).toBeUndefined();
    });
  });
});
