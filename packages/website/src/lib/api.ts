/**
 * API client for communicating with the sync-server.
 */

declare global {
  interface Window {
    __ENV?: {
      SYNC_SERVER_URL?: string;
      ADMIN_SERVER_URL?: string;
    };
  }
}

const DEFAULT_SYNC_URL = 'https://sync.saqr.dev';
const DEFAULT_ADMIN_URL = 'https://admin.saqr.dev';

export function getSyncServerUrl(): string {
  if (typeof window !== 'undefined' && window.__ENV?.SYNC_SERVER_URL) {
    return window.__ENV.SYNC_SERVER_URL;
  }
  return DEFAULT_SYNC_URL;
}

export function getAdminServerUrl(): string {
  if (typeof window !== 'undefined' && window.__ENV?.ADMIN_SERVER_URL) {
    return window.__ENV.ADMIN_SERVER_URL;
  }
  return DEFAULT_ADMIN_URL;
}

export interface ApiError {
  error: string;
  message: string;
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  token?: string,
  baseUrl?: string,
): Promise<{ data?: T; error?: ApiError; status: number }> {
  const url = `${baseUrl ?? getSyncServerUrl()}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (res.ok) {
    return { data: data as T, status: res.status };
  }

  return { error: data as ApiError, status: res.status };
}

export async function apiGet<T>(
  path: string,
  token?: string,
  baseUrl?: string,
): Promise<{ data?: T; error?: ApiError; status: number }> {
  const url = `${baseUrl ?? getSyncServerUrl()}${path}`;
  const headers: Record<string, string> = {};

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  const data = await res.json();

  if (res.ok) {
    return { data: data as T, status: res.status };
  }

  return { error: data as ApiError, status: res.status };
}
