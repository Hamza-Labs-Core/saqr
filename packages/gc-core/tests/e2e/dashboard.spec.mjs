// dashboard.spec.mjs -- Playwright e2e tests for GlobalContext dashboard
// Requires dashboard running at http://localhost:4000
// Run: npx playwright test
import { test, expect } from '@playwright/test';

test.describe('Dashboard loads', () => {
  test('serves HTML at root', async ({ page }) => {
    const response = await page.goto('/');
    expect(response.status()).toBe(200);
    expect(await page.title()).toBe('GlobalContext Dashboard');
  });

  test('has header with title', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('.header h1');
    await expect(header).toHaveText('GlobalContext');
  });

  test('has sidebar with projects section', async ({ page }) => {
    await page.goto('/');
    const section = page.locator('.sidebar-section').first();
    await expect(section).toHaveText('Projects');
  });
});

test.describe('Projects API', () => {
  test('returns JSON array', async ({ request }) => {
    const res = await request.get('/api/projects');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('each project has required fields', async ({ request }) => {
    const res = await request.get('/api/projects');
    const data = await res.json();
    if (data.length > 0) {
      const p = data[0];
      expect(p).toHaveProperty('project_id');
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('session_count');
      expect(typeof p.session_count).toBe('number');
    }
  });
});

test.describe('Sessions API', () => {
  test('requires project param', async ({ request }) => {
    const res = await request.get('/api/sessions');
    expect(res.status()).toBe(400);
  });

  test('returns sessions for a valid project', async ({ request }) => {
    // First get a project
    const projRes = await request.get('/api/projects');
    const projects = await projRes.json();
    if (projects.length === 0) return;

    const res = await request.get(`/api/sessions?project=${projects[0].project_id}`);
    expect(res.status()).toBe(200);
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
    if (sessions.length > 0) {
      expect(sessions[0]).toHaveProperty('session_id');
    }
  });
});

test.describe('Events API', () => {
  test('requires project and session params', async ({ request }) => {
    const res = await request.get('/api/events');
    expect(res.status()).toBe(400);
  });

  test('returns events for a valid session', async ({ request }) => {
    const projRes = await request.get('/api/projects');
    const projects = await projRes.json();
    if (projects.length === 0) return;

    const sessRes = await request.get(`/api/sessions?project=${projects[0].project_id}`);
    const sessions = await sessRes.json();
    if (sessions.length === 0) return;

    const res = await request.get(
      `/api/events?project=${projects[0].project_id}&session=${sessions[0].session_id}`
    );
    expect(res.status()).toBe(200);
    const events = await res.json();
    expect(Array.isArray(events)).toBe(true);
    if (events.length > 0) {
      expect(events[0]).toHaveProperty('event_type');
      expect(events[0]).toHaveProperty('sequence');
      expect(events[0]).toHaveProperty('_summary');
    }
  });

  test('supports from param for pagination', async ({ request }) => {
    const projRes = await request.get('/api/projects');
    const projects = await projRes.json();
    if (projects.length === 0) return;

    const sessRes = await request.get(`/api/sessions?project=${projects[0].project_id}`);
    const sessions = await sessRes.json();
    if (sessions.length === 0) return;

    const pid = projects[0].project_id;
    const sid = sessions[0].session_id;

    const all = await (await request.get(`/api/events?project=${pid}&session=${sid}`)).json();
    if (all.length < 2) return;

    const midSeq = all[Math.floor(all.length / 2)].sequence;
    const partial = await (await request.get(`/api/events?project=${pid}&session=${sid}&from=${midSeq}`)).json();
    expect(partial.length).toBeLessThan(all.length);
    for (const e of partial) {
      expect(e.sequence).toBeGreaterThan(midSeq);
    }
  });
});

test.describe('Usage API', () => {
  test('returns usage for all projects', async ({ request }) => {
    const res = await request.get('/api/usage');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      const u = data[0];
      expect(u).toHaveProperty('project_id');
      expect(u).toHaveProperty('project_name');
      expect(u).toHaveProperty('totals');
      expect(u.totals).toHaveProperty('input_tokens');
      expect(u.totals).toHaveProperty('output_tokens');
      expect(u.totals).toHaveProperty('cache_read_tokens');
      expect(u.totals).toHaveProperty('cache_create_tokens');
    }
  });

  test('returns usage for specific project', async ({ request }) => {
    const projRes = await request.get('/api/projects');
    const projects = await projRes.json();
    if (projects.length === 0) return;

    const res = await request.get(`/api/usage?project=${projects[0].project_id}`);
    // May be 404 if no transcript data
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const u = await res.json();
      expect(u).toHaveProperty('totals');
      expect(u).toHaveProperty('sessions');
      expect(Array.isArray(u.sessions)).toBe(true);
    }
  });
});

test.describe('SSE stream', () => {
  test('stream endpoint returns event-stream', async ({ page }) => {
    await page.goto('/');

    const projRes = await page.request.get('/api/projects');
    const projects = await projRes.json();
    if (projects.length === 0) return;

    const sessRes = await page.request.get(`/api/sessions?project=${projects[0].project_id}`);
    const sessions = await sessRes.json();
    if (sessions.length === 0) return;

    const pid = projects[0].project_id;
    const sid = sessions[0].session_id;

    // Use page.evaluate with fetch + AbortController to check SSE headers
    // without waiting for the stream to close
    const result = await page.evaluate(async ({ pid, sid }) => {
      const controller = new AbortController();
      const res = await fetch(`/api/stream?project=${pid}&session=${sid}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      const status = res.status;
      const contentType = res.headers.get('content-type');
      controller.abort();
      return { status, contentType };
    }, { pid, sid });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/event-stream');
  });
});

test.describe('Rich event formatting', () => {
  test('event summaries contain html field', async ({ request }) => {
    const projRes = await request.get('/api/projects');
    const projects = await projRes.json();
    if (projects.length === 0) return;

    const sessRes = await request.get(`/api/sessions?project=${projects[0].project_id}`);
    const sessions = await sessRes.json();
    if (sessions.length === 0) return;

    const events = await (await request.get(
      `/api/events?project=${projects[0].project_id}&session=${sessions[0].session_id}`
    )).json();

    if (events.length === 0) return;

    for (const e of events.slice(0, 10)) {
      expect(e._summary).toHaveProperty('html');
      expect(e._summary).toHaveProperty('text');
      expect(typeof e._summary.html).toBe('string');
      expect(e._summary.html.length).toBeGreaterThan(0);
    }
  });
});

test.describe('UI interactions', () => {
  test('project list loads and is clickable', async ({ page }) => {
    await page.goto('/');
    // Wait for projects to load
    await page.waitForSelector('.sidebar-item', { timeout: 5000 });
    const items = await page.locator('.sidebar-item').count();
    expect(items).toBeGreaterThan(0);

    // Click first project
    await page.locator('.sidebar-item').first().click();
    // Sessions should appear
    await page.waitForSelector('.session-item', { timeout: 5000 });
    const sessions = await page.locator('.session-item').count();
    expect(sessions).toBeGreaterThan(0);
  });

  test('selecting a session loads events', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar-item', { timeout: 5000 });
    await page.locator('.sidebar-item').first().click();
    await page.waitForSelector('.session-item', { timeout: 5000 });
    await page.locator('.session-item').first().click();

    // Wait for event table to appear
    await page.waitForSelector('.event-feed table', { timeout: 5000 });
    const rows = await page.locator('.event-feed tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('event rows show rich formatting', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar-item', { timeout: 5000 });
    await page.locator('.sidebar-item').first().click();
    await page.waitForSelector('.session-item', { timeout: 5000 });
    await page.locator('.session-item').first().click();
    await page.waitForSelector('.event-feed tbody tr', { timeout: 5000 });

    // Check that at least some cells have rich HTML (not plain text)
    const summaryCell = page.locator('.event-feed tbody td.col-summary').first();
    const innerHTML = await summaryCell.innerHTML();
    // Rich formatting should have HTML tags
    expect(innerHTML).toMatch(/<(span|div|code)/);
  });

  test('session header shows metadata', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar-item', { timeout: 5000 });
    await page.locator('.sidebar-item').first().click();
    await page.waitForSelector('.session-item', { timeout: 5000 });
    await page.locator('.session-item').first().click();

    const header = page.locator('.session-header');
    await expect(header).toContainText('Events');
  });
});

test.describe('Usage view', () => {
  test('can switch to usage tab', async ({ page }) => {
    await page.goto('/');
    // Look for usage tab button
    const usageTab = page.locator('#tabUsage');
    if (await usageTab.count() === 0) return; // usage tab may not exist yet

    await usageTab.click();
    // Usage view should be visible
    await page.waitForSelector('#usageView', { timeout: 5000 });
    const visible = await page.locator('#usageView').isVisible();
    expect(visible).toBe(true);
  });
});

test.describe('404 handling', () => {
  test('unknown routes return 404', async ({ request }) => {
    const res = await request.get('/api/nonexistent');
    expect(res.status()).toBe(404);
  });
});
