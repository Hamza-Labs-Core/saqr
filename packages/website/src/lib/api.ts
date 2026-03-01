/**
 * API client for communicating with the sync-server.
 */

const DEFAULT_SYNC_URL = 'https://sync.saqr.dev';

export function getSyncServerUrl(): string {
  // In the browser, use a meta tag or default
  if (typeof window !== 'undefined') {
    const meta = document.querySelector('meta[name="sync-server-url"]');
    return meta?.getAttribute('content') ?? DEFAULT_SYNC_URL;
  }
  return DEFAULT_SYNC_URL;
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
