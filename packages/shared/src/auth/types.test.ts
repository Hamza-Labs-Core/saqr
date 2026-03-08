/**
 * Tests for shared auth types — compile-time type checks.
 */
import { describe, it, expect } from 'vitest';
import type {
  DeviceCodeRequest,
  DeviceCodeResponse,
  DevicePollRequest,
  DevicePollTokenResponse,
  DevicePollPendingError,
  DevicePollErrorResponse,
  DeviceCodeStatus,
  DeviceCodeRecord,
  AuthCallback,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from './types.js';

describe('Auth Types', () => {
  it('DeviceCodeRequest has required fields', () => {
    const req: DeviceCodeRequest = {
      client_id: 'cli',
    };
    expect(req.client_id).toBe('cli');
    expect(req.scope).toBeUndefined();
  });

  it('DeviceCodeRequest accepts optional scope', () => {
    const req: DeviceCodeRequest = {
      client_id: 'desktop',
      scope: ['sync', 'remote'],
    };
    expect(req.scope).toEqual(['sync', 'remote']);
  });

  it('DeviceCodeResponse has all required fields', () => {
    const res: DeviceCodeResponse = {
      user_code: 'ABCD-1234',
      device_code: 'abc123',
      verification_uri: 'https://saqr.dev/auth/device',
      verification_uri_complete: 'https://saqr.dev/auth/device?code=ABCD-1234',
      expires_in: 900,
      interval: 5,
    };
    expect(res.user_code).toBe('ABCD-1234');
    expect(res.expires_in).toBe(900);
  });

  it('DevicePollRequest has required fields', () => {
    const req: DevicePollRequest = {
      device_code: 'abc123',
      client_id: 'cli',
    };
    expect(req.device_code).toBe('abc123');
  });

  it('DevicePollTokenResponse has correct token_type', () => {
    const res: DevicePollTokenResponse = {
      access_token: 'jwt.token.here',
      refresh_token: 'srt_refresh123',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    expect(res.token_type).toBe('Bearer');
  });

  it('DevicePollPendingError covers all RFC 8628 error codes', () => {
    const errors: DevicePollPendingError[] = [
      'authorization_pending',
      'slow_down',
      'expired_token',
      'access_denied',
    ];
    expect(errors).toHaveLength(4);
  });

  it('DevicePollErrorResponse has error and description', () => {
    const res: DevicePollErrorResponse = {
      error: 'authorization_pending',
      error_description: 'The user has not yet approved.',
    };
    expect(res.error).toBe('authorization_pending');
  });

  it('DeviceCodeStatus covers all states', () => {
    const statuses: DeviceCodeStatus[] = ['pending', 'approved', 'denied', 'expired'];
    expect(statuses).toHaveLength(4);
  });

  it('DeviceCodeRecord has all required fields', () => {
    const record: DeviceCodeRecord = {
      userCode: 'ABCD-1234',
      deviceCode: 'abc123',
      clientId: 'cli',
      scope: ['sync'],
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresIn: 900,
    };
    expect(record.status).toBe('pending');
    expect(record.approvedBy).toBeUndefined();
  });

  it('DeviceCodeRecord optional fields for approved state', () => {
    const record: DeviceCodeRecord = {
      userCode: 'ABCD-1234',
      deviceCode: 'abc123',
      clientId: 'cli',
      scope: ['sync'],
      status: 'approved',
      createdAt: new Date().toISOString(),
      expiresIn: 900,
      approvedBy: 'usr_123',
      accessToken: 'jwt.token',
      refreshToken: 'srt_refresh',
    };
    expect(record.approvedBy).toBe('usr_123');
    expect(record.accessToken).toBeDefined();
  });

  it('AuthCallback has all required fields', () => {
    const cb: AuthCallback = {
      token: 'jwt.token.here',
      refresh_token: 'srt_refresh123',
      expires_in: 3600,
    };
    expect(cb.token).toBeDefined();
  });

  it('RefreshTokenRequest has required field', () => {
    const req: RefreshTokenRequest = {
      refresh_token: 'srt_token123',
    };
    expect(req.refresh_token).toBe('srt_token123');
  });

  it('RefreshTokenResponse has correct structure', () => {
    const res: RefreshTokenResponse = {
      access_token: 'new.jwt.token',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    expect(res.token_type).toBe('Bearer');
  });
});
