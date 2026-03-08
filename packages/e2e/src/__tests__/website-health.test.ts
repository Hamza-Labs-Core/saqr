import { describe, it, expect, beforeAll } from 'vitest';
import { WEBSITE_URL, waitForWebsite } from '../helpers/client.js';

describe('website health', () => {
  beforeAll(async () => {
    await waitForWebsite();
  });

  it('GET / returns 200 with HTML', async () => {
    const res = await fetch(WEBSITE_URL);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('GET /downloads returns 200', async () => {
    const res = await fetch(`${WEBSITE_URL}/downloads`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toContain('text/html');
  });

  it('GET /auth/login returns 200', async () => {
    const res = await fetch(`${WEBSITE_URL}/auth/login`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toContain('text/html');
  });
});
