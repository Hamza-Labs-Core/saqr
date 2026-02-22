# Implementation Plan: Story 06 -- Local Dashboard

**Date**: 2026-02-22
**Story**: 12-local-dashboard
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (96-128 hours)
**Prerequisites**: Existing `gc-dashboard` (~3010 lines) serves as the base. Stories 01-05 (event store, hooks, projections) must be functional. Story 00 (installation) provides deploy.sh integration.
**Design Amendments**: None specific. Story 06 is new scope defined in `docs/PRODUCT-SPEC.md` (F4.1-F4.10).

### Relationship to Other Stories

This is the **primary human interface** story. It enhances the existing `gc-dashboard` single-file Node.js HTTP server with the full feature set defined in F4.1-F4.10 of the product spec.

- **Story 01** (Event Capture): Dashboard reads events from `~/.claude-context/events/{project-id}/{session-id}/`
- **Story 02** (Hook Integration): `gc-hook` triggers auto-start of the dashboard when `.dashboard-enabled` marker exists
- **Story 03** (Storage Layer): Dashboard reads `config.json`, event files, and session metadata
- **Story 04** (Projection Engine): Dashboard may read projections for enriched views
- **Story 05** (Context Recovery): Dashboard shares the same event store read path as `gc-query`
- **Story 00** (Installation): `gc-install` deploys `gc-dashboard` to `bin/`; `deploy.sh` restarts dashboard on upgrade
- **F3 (Agent Orchestration)**: Dashboard communicates with the daemon's agent manager for F4.8/F4.9 (future integration point)

### What Already Exists (Baseline)

The current `src/bin/gc-dashboard` (~3010 lines) already implements:
- Single-file Node.js HTTP server with inline HTML/CSS/JS
- `GET /` serving the dashboard UI
- `GET /api/projects` listing projects from the event store
- `GET /api/sessions?project={id}` listing sessions
- `GET /api/events?project={id}&session={id}&from={seq}&limit={n}` returning events
- `GET /api/usage` and `GET /api/usage?project={id}` with JSONL transcript parsing
- Per-event-type rendering (`generateInputSummary`, `generateOutputSummary`, `generateEventSummary`)
- Usage analytics with per-project, per-model, per-day, per-month aggregation
- Daily timeline bar chart (pure CSS/HTML)
- Monthly filter buttons with month-over-month comparison
- Per-project percentage badges in the usage table
- File-size-based JSONL cache (`usageCache`)
- Cost estimation (`calcCost` with `MODEL_PRICING`)
- Project sidebar, session list, event feed table with filters
- Basic event type filter checkboxes

### What This Plan Adds

| Feature | Status | Plan Task |
|---------|--------|-----------|
| F4.1 Event feed enhancements (virtual scrolling, pagination) | Partial -- needs virtual scroll, DOM limit | Task 1 |
| F4.2 Usage analytics enhancements (cache warm, concurrency limit) | Partial -- needs warm + limit | Task 2 |
| F4.3 Daily timeline (click-to-filter) | Partial -- needs click interaction | Task 3 |
| F4.4 Monthly views (comparison deltas) | Partial -- needs delta indicators | Task 3 |
| F4.5 Per-project percentage | Done in baseline | -- |
| F4.6 SSE live streaming | New | Task 4 |
| F4.7 System prompt filtering | New | Task 5 |
| F4.8 Agent status panel | New | Task 6 |
| F4.9 Agent interaction | New | Task 7 |
| F4.10 Auto-start/restart lifecycle | New | Task 8 |
| Integration into gc-hook and deploy.sh | New | Task 9 |
| Tests (unit + integration + manual) | New | Task 10 |

---

## Task Dependency Graph

```
Task 1: Event Feed Enhancements (virtual scroll, pagination)
  |
  +---> Task 4: SSE Live Streaming (needs event feed to append to)
  |       |
  |       +---> Task 5: System Prompt Filtering (needs SSE + event feed)
  |
Task 2: Usage Analytics Enhancements (cache warm, concurrency)
  |
  +---> Task 3: Timeline & Monthly Enhancements (click-to-filter, deltas)
  |
Task 6: Agent Status Panel (independent of events, needs new tab)
  |
  +---> Task 7: Agent Interaction (needs agent panel)
  |
Task 8: Lifecycle Management (gc-dashboard start/stop/restart/status)
  |
  +---> Task 9: Hook & Deploy Integration (needs lifecycle commands)
  |
Task 10: Tests (needs all above)
```

Parallelism opportunities:
- Tasks 1 and 2 can be done in parallel (event feed vs usage analytics)
- Task 6 can be done in parallel with Tasks 1-5 (separate tab, separate API)
- Task 8 can be done in parallel with Tasks 1-7 (lifecycle is server-level, not UI)

---

## Tasks

### Task 1: Event Feed Enhancements

**Description**

Enhance the existing event feed with virtual scrolling (DOM limit of 500 rows), pagination (load 100 events per page), and upward scroll loading. The baseline already renders events in a table; this task adds DOM management to keep performance acceptable for sessions with thousands of events.

**Prerequisites/Inputs**
- Existing `gc-dashboard` event feed table (`#event-rows`)
- Existing `GET /api/events` endpoint
- Existing `renderEvents()` and `appendEvent()` client-side functions

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing)

1. **Client-side state additions** -- add to the existing `state` object:

```javascript
// Add to existing state object
state.oldestSeq = Infinity;   // lowest sequence number currently in DOM
state.newestSeq = 0;          // highest sequence number currently in DOM
state.loadingMore = false;    // prevents concurrent upward-load requests
state.domRowCount = 0;        // tracks rows currently in DOM
const MAX_DOM_ROWS = 500;     // hard limit on rows in DOM
const PAGE_SIZE = 100;        // events per API request
```

2. **Virtual scroll handler** -- attach to the event feed container:

```javascript
function initVirtualScroll() {
  const feedEl = document.getElementById('event-feed-container');
  if (!feedEl) return;
  feedEl.addEventListener('scroll', () => {
    if (feedEl.scrollTop < 200 && !state.loadingMore && state.oldestSeq > 1) {
      state.loadingMore = true;
      const toSeq = state.oldestSeq;
      const fromSeq = Math.max(0, toSeq - PAGE_SIZE);
      loadEvents(state.selectedProject, state.selectedSession, fromSeq, PAGE_SIZE)
        .then(events => {
          prependEvents(events);
          trimBottomRows();
          state.loadingMore = false;
        })
        .catch(() => { state.loadingMore = false; });
    }
  });
}
```

3. **DOM trimming functions**:

```javascript
function trimBottomRows() {
  const tbody = document.getElementById('event-rows');
  while (tbody.children.length > MAX_DOM_ROWS) {
    tbody.removeChild(tbody.lastChild);
    state.domRowCount--;
  }
  // Update newestSeq from last remaining row
  if (tbody.lastChild) {
    state.newestSeq = parseInt(tbody.lastChild.dataset.seq, 10) || state.newestSeq;
  }
}

function trimTopRows() {
  const tbody = document.getElementById('event-rows');
  while (tbody.children.length > MAX_DOM_ROWS) {
    tbody.removeChild(tbody.firstChild);
    state.domRowCount--;
  }
  // Update oldestSeq from first remaining row
  if (tbody.firstChild) {
    state.oldestSeq = parseInt(tbody.firstChild.dataset.seq, 10) || state.oldestSeq;
  }
}
```

4. **Modify existing `prependEvents()` and `appendEvent()`** to:
   - Add `data-seq` attribute to each `<tr>`
   - Update `state.oldestSeq` / `state.newestSeq`
   - Increment `state.domRowCount`
   - Call `trimTopRows()` when appending, `trimBottomRows()` when prepending

5. **Auto-scroll behavior**: When user is scrolled to bottom (within 100px), auto-scroll on new events. When user has scrolled up, do not auto-scroll.

```javascript
function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
}
```

**Acceptance Criteria**

- [ ] Event feed loads events in pages of 100
- [ ] Scrolling to top triggers loading of older events (from `state.oldestSeq - 100`)
- [ ] DOM never exceeds 500 `<tr>` elements in the event table
- [ ] `trimTopRows()` removes oldest rows when appending beyond limit
- [ ] `trimBottomRows()` removes newest rows when prepending beyond limit
- [ ] Auto-scroll to bottom on new events only when user is already at bottom
- [ ] Each `<tr>` has a `data-seq` attribute for tracking
- [ ] Loading indicator shown while fetching older events

**Edge Cases**

- Session has fewer than 100 events: single page loads, no virtual scroll needed
- Session has exactly 500 events: DOM is at limit, next append triggers trim
- Rapid scroll to top: `state.loadingMore` flag prevents concurrent fetches
- Events arrive via SSE while loading older events: both operations are safe (append vs prepend)

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 2: Usage Analytics Enhancements

**Description**

Enhance the existing usage analytics with: (a) cache pre-warming on server start so the first `/api/usage` response is fast, and (b) a concurrency limiter for JSONL file parsing to avoid file descriptor exhaustion.

**Prerequisites/Inputs**
- Existing `parseTranscriptFile()` function
- Existing `usageCache` Map
- Existing `GET /api/usage` endpoint handler
- Claude JSONL transcript files in `~/.claude/projects/`

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing)

1. **Concurrency limiter** -- add a semaphore utility:

```javascript
function createSemaphore(maxConcurrency) {
  let running = 0;
  const queue = [];
  return function acquire() {
    return new Promise(resolve => {
      const tryRun = () => {
        if (running < maxConcurrency) {
          running++;
          resolve(() => { running--; if (queue.length) queue.shift()(); });
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });
  };
}

const parseSemaphore = createSemaphore(8);
```

2. **Wrap `parseTranscriptFile()`** calls with the semaphore:

```javascript
async function getFileUsageLimited(filePath) {
  const st = await stat(filePath);
  const cacheKey = filePath + ':' + st.size;
  if (usageCache.has(cacheKey)) return usageCache.get(cacheKey);

  const release = await parseSemaphore();
  try {
    // Re-check cache after acquiring semaphore (another request may have populated it)
    if (usageCache.has(cacheKey)) return usageCache.get(cacheKey);
    const result = await parseTranscriptFile(filePath);
    usageCache.set(cacheKey, result);
    return result;
  } finally {
    release();
  }
}
```

3. **Cache pre-warming on server start**:

```javascript
async function warmUsageCache() {
  const startTime = Date.now();
  try {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    const dirs = await readdir(claudeDir).catch(() => []);
    let fileCount = 0;
    for (const d of dirs) {
      const projDir = path.join(claudeDir, d);
      const files = await readdir(projDir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const filePath = path.join(projDir, f);
        await getFileUsageLimited(filePath).catch(() => {});
        fileCount++;
      }
    }
    const elapsed = Date.now() - startTime;
    console.log(`[gc-dashboard] Cache warmed: ${fileCount} files in ${elapsed}ms`);
  } catch (err) {
    console.log(`[gc-dashboard] Cache warm failed: ${err.message}`);
  }
}
```

4. **Call `warmUsageCache()` after server starts listening** (non-blocking):

```javascript
server.listen(port, () => {
  console.log(`[gc-dashboard] Listening on http://localhost:${port}`);
  warmUsageCache(); // fire-and-forget
});
```

**Acceptance Criteria**

- [ ] Cache is pre-warmed on server start (all JSONL files in `~/.claude/projects/` are parsed)
- [ ] First `GET /api/usage` after start returns cached data (< 50ms if warm completes)
- [ ] Concurrent JSONL parsing is limited to 8 files at a time
- [ ] Semaphore correctly queues excess parse requests
- [ ] Re-check cache after acquiring semaphore to prevent duplicate work
- [ ] Cache warm logs file count and elapsed time to stdout
- [ ] Cache warm failure does not prevent server from starting
- [ ] `warmUsageCache()` is non-blocking (does not delay server listen callback)

**Edge Cases**

- No `~/.claude/projects/` directory: warm completes immediately with 0 files
- Corrupt JSONL file: `parseTranscriptFile()` already has try-catch per line; warm continues
- Very large number of JSONL files (100+): semaphore ensures max 8 open at once
- File changes between warm and first request: cache key includes file size, so changed files get re-parsed

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 3: Timeline & Monthly View Enhancements

**Description**

Enhance the existing daily timeline bar chart with click-to-filter (clicking a bar filters the event feed to that day). Enhance the existing monthly view with month-over-month comparison delta indicators (percentage change for tokens, cost, sessions).

**Prerequisites/Inputs**
- Existing daily timeline bar chart rendering in `renderUsage()`
- Existing monthly filter buttons in `renderUsage()`
- Existing `usageSelectedMonth` state variable
- Existing `buildTimelineData()` function (or equivalent inline code)

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing)

1. **Click-to-filter on timeline bars** -- add to the bar rendering code:

```javascript
// Add to state
state.selectedTimelineDate = null;

// In bar rendering loop, add onclick and selected class:
// Each bar div gets: onclick="filterEventsToDate('YYYY-MM-DD')"
// and class "selected" if state.selectedTimelineDate matches

function filterEventsToDate(dateStr) {
  if (state.selectedTimelineDate === dateStr) {
    state.selectedTimelineDate = null; // toggle off
  } else {
    state.selectedTimelineDate = dateStr;
  }
  renderUsage(); // re-render to highlight selected bar
  // Set date filters in the event feed
  const startInput = document.getElementById('filter-date-start');
  const endInput = document.getElementById('filter-date-end');
  if (state.selectedTimelineDate) {
    if (startInput) startInput.value = dateStr;
    if (endInput) endInput.value = dateStr;
  } else {
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
  }
  applyFilters();
}
```

2. **Bar highlighting CSS**:

```css
.timeline-bar.selected { outline: 2px solid var(--accent); outline-offset: -1px; }
```

3. **Month-over-month comparison panel** -- add after the month filter bar:

```javascript
function renderMonthComparison(usageData, selectedMonth) {
  if (!selectedMonth) return '';

  // Parse selected month
  const [year, month] = selectedMonth.split('-').map(Number);
  const prevMonth = month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;

  // Aggregate current and previous month
  const cur = aggregateMonth(usageData, selectedMonth);
  const prev = aggregateMonth(usageData, prevMonth);

  function delta(curVal, prevVal) {
    if (prevVal === 0) return prev.sessions === 0 ? 'N/A' : '+100%';
    const pct = ((curVal - prevVal) / prevVal * 100);
    const sign = pct >= 0 ? '+' : '';
    const cls = pct > 0 ? 'delta-up' : pct < 0 ? 'delta-down' : 'delta-neutral';
    return `<span class="${cls}">${sign}${pct.toFixed(0)}% vs ${monthLabel(prevMonth)}</span>`;
  }

  return `<div class="month-comparison">
    <div class="month-stat">
      <span class="stat-label">Total Tokens</span>
      <span class="stat-value">${formatTokens(cur.totalTokens)}</span>
      <span class="stat-delta">${delta(cur.totalTokens, prev.totalTokens)}</span>
    </div>
    <div class="month-stat">
      <span class="stat-label">Est. Cost</span>
      <span class="stat-value">${formatCost(cur.cost)}</span>
      <span class="stat-delta">${delta(cur.cost, prev.cost)}</span>
    </div>
    <div class="month-stat">
      <span class="stat-label">Sessions</span>
      <span class="stat-value">${cur.sessions}</span>
      <span class="stat-delta">${delta(cur.sessions, prev.sessions)}</span>
    </div>
  </div>`;
}

function aggregateMonth(usageData, monthStr) {
  let totalTokens = 0, cost = 0, sessions = 0;
  for (const p of usageData) {
    for (const m of (p.monthly || [])) {
      if (m.month === monthStr) {
        const t = (m.input_tokens || 0) + (m.output_tokens || 0) +
                  (m.cache_read_tokens || 0) + (m.cache_create_tokens || 0);
        totalTokens += t;
        // cost estimation per-model is complex; use a default model rate
        cost += calcCost(m.input_tokens || 0, m.output_tokens || 0,
                         m.cache_read_tokens || 0, m.cache_create_tokens || 0,
                         'claude-sonnet-4-20250514');
      }
    }
    for (const s of (p.sessions || [])) {
      if (s.started_at && s.started_at.startsWith(monthStr)) sessions++;
    }
  }
  return { totalTokens, cost, sessions };
}
```

4. **CSS for comparison panel** -- add to inline styles:

```css
.month-comparison { display: flex; gap: 24px; padding: 12px 0; }
.month-stat { display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 11px; color: var(--text2); }
.stat-value { font-size: 18px; font-weight: 600; }
.stat-delta { font-size: 11px; }
.delta-up { color: var(--red); }
.delta-down { color: var(--green); }
.delta-neutral { color: var(--text2); }
```

5. **Integrate `renderMonthComparison()`** into the existing `renderUsage()` function, inserting it after the month filter bar HTML.

**Acceptance Criteria**

- [ ] Clicking a timeline bar sets date filters on the event feed to that day
- [ ] Clicking the same bar again clears the filter (toggle behavior)
- [ ] Selected bar has a visible outline highlight (`var(--accent)`)
- [ ] Month-over-month comparison panel shows delta for tokens, cost, sessions
- [ ] Delta indicators use red for increase, green for decrease
- [ ] "N/A" shown when previous month has no data
- [ ] Delta percentages are integers (e.g., "+15%", not "+15.3%")
- [ ] Comparison panel only appears when a specific month is selected (not "All Time")
- [ ] `monthLabel()` helper converts "2026-01" to "Jan" for display

**Edge Cases**

- First month with data has no previous month: delta shows "N/A"
- Month with zero usage: delta from zero to nonzero shows "+100%"
- Timeline bar for today may have partial data: rendered normally
- No usage data at all: timeline shows empty bars, no comparison panel

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 4: SSE Live Streaming

**Description**

Implement Server-Sent Events (SSE) for real-time event updates. The server polls the event store every 2 seconds for new events and streams them to connected browsers. The client uses the native `EventSource` API. A connection status indicator (live/reconnecting/disconnected) is shown in the dashboard header.

**Prerequisites/Inputs**
- Existing HTTP server request handler
- Existing `readEvents()` server-side function (or equivalent)
- Task 1 (event feed must support `appendEvent()` for incoming SSE events)

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing)

1. **Server-side SSE endpoint** -- add to the request handler:

```javascript
if (pathname === '/api/stream') {
  const projectId = url.searchParams.get('project');
  const sessionId = url.searchParams.get('session');
  if (!projectId || !sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'project and session params required' }));
    return;
  }

  res.socket.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let lastSeq = parseInt(url.searchParams.get('from') || '0', 10);
  let alive = true;
  let keepaliveCount = 0;

  req.on('close', () => { alive = false; });

  res.write(':ok\n\n');
  // Set retry interval for client reconnection
  res.write('retry: 3000\n\n');

  const poll = async () => {
    if (!alive) return;
    try {
      const events = await readEventsFromStore(projectId, sessionId, lastSeq, 100);
      for (const event of events) {
        if (!alive) return;
        const enriched = { ...event, _summary: generateEventSummary(event) };
        res.write(`data: ${JSON.stringify(enriched)}\n\n`);
        if (event.sequence > lastSeq) lastSeq = event.sequence;
      }
    } catch { /* ignore errors, keep polling */ }

    keepaliveCount++;
    // Send keepalive comment every 15 polls (30 seconds at 2s interval)
    if (keepaliveCount >= 15) {
      if (alive) res.write(':keepalive\n\n');
      keepaliveCount = 0;
    }

    if (alive) setTimeout(poll, 2000);
  };

  poll();
  return;
}
```

2. **`readEventsFromStore()` helper** -- reads event files from the event store directory:

```javascript
async function readEventsFromStore(projectId, sessionId, afterSeq, limit) {
  const eventsDir = path.join(getBasePath(), 'events', projectId, sessionId);
  let files;
  try {
    files = await readdir(eventsDir);
  } catch { return []; }

  // Event files are named {sequence}.json (zero-padded)
  const eventFiles = files
    .filter(f => f.endsWith('.json'))
    .sort()
    .filter(f => {
      const seq = parseInt(f.replace('.json', ''), 10);
      return seq > afterSeq;
    })
    .slice(0, limit);

  const events = [];
  for (const f of eventFiles) {
    try {
      const content = await readFile(path.join(eventsDir, f), 'utf-8');
      events.push(JSON.parse(content));
    } catch { /* skip malformed */ }
  }
  return events;
}
```

3. **Client-side SSE connection** -- add to the inline JavaScript:

```javascript
let eventSource = null;

function connectSSE(projectId, sessionId, fromSeq) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (!projectId || !sessionId) return;

  const sseUrl = '/api/stream?project=' + encodeURIComponent(projectId) +
    '&session=' + encodeURIComponent(sessionId) +
    '&from=' + (fromSeq || state.newestSeq || 0);

  eventSource = new EventSource(sseUrl);

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      appendEvent(event);
      state.newestSeq = Math.max(state.newestSeq, event.sequence || 0);
    } catch { /* skip malformed SSE data */ }
  };

  eventSource.onerror = () => {
    updateConnectionStatus('reconnecting');
  };

  eventSource.onopen = () => {
    updateConnectionStatus('live');
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  updateConnectionStatus('disconnected');
}
```

4. **Connection status indicator** -- add to the dashboard header HTML:

```html
<span class="status-indicator">
  <span class="dot" id="sse-dot"></span>
  <span class="status-label" id="sse-label">Disconnected</span>
</span>
```

```javascript
function updateConnectionStatus(status) {
  const dot = document.getElementById('sse-dot');
  const label = document.getElementById('sse-label');
  if (!dot || !label) return;
  dot.className = 'dot ' + status;
  label.textContent = status === 'live' ? 'Live' :
                      status === 'reconnecting' ? 'Reconnecting...' : 'Disconnected';
}
```

```css
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
.dot.live { background: var(--green); }
.dot.reconnecting { background: var(--yellow); animation: pulse 1.5s infinite; }
.dot.disconnected { background: var(--text2); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
```

5. **Connect SSE on session selection** -- modify the existing `onSessionSelect()`:

```javascript
// At the end of the existing session selection handler:
connectSSE(state.selectedProject, state.selectedSession, state.newestSeq);
```

6. **Disconnect SSE on session/project change** -- call `disconnectSSE()` before changing context.

7. **Fade-in animation for SSE events**:

```css
.event-row-new { animation: fadeIn 0.3s ease-in; }
@keyframes fadeIn { from { opacity: 0; background: rgba(88,166,255,0.08); } to { opacity: 1; background: transparent; } }
```

Add `event-row-new` class to rows appended via SSE.

**Acceptance Criteria**

- [ ] SSE endpoint at `GET /api/stream?project={id}&session={id}&from={seq}` streams events
- [ ] SSE uses `text/event-stream` content type with proper headers (no-cache, keep-alive)
- [ ] Server polls event store every 2 seconds for new events
- [ ] Keepalive comments (`:keepalive`) sent every 30 seconds
- [ ] Client uses native `EventSource` API with auto-reconnect
- [ ] Dashboard header shows connection status: green dot (live), yellow (reconnecting), grey (disconnected)
- [ ] New events appended to event feed with fade-in animation
- [ ] Old SSE connection closed when switching sessions
- [ ] Server cleans up poll timer when client disconnects (`req.on('close')`)
- [ ] `retry: 3000` sent to control client reconnection delay

**Edge Cases**

- E-4: SSE connection drops during network change: EventSource auto-reconnects; `from` param ensures no events lost
- Multiple browser tabs: each gets its own SSE connection; server handles N concurrent connections
- Session with no new events: SSE stream stays open, sends keepalives, no data frames
- Server restart: all SSE connections break; clients reconnect via EventSource retry logic

**Estimated Effort**: L (Large) -- 6-8 hours

---

### Task 5: System Prompt Filtering

**Description**

Detect and visually differentiate system-injected messages (task notifications, system reminders, skill invocations) from real user prompts. Add a "Show system prompts" toggle to the filter bar. System messages get a distinct visual treatment (muted background, gear icon, smaller text).

**Prerequisites/Inputs**
- Existing `generateEventSummary()` function
- Existing event feed rendering pipeline
- Existing filter bar HTML
- Task 1 (event feed must support filtering)
- Task 4 (SSE events must also be categorized)

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing)

1. **`categorizePrompt()` function** -- add server-side (for API enrichment) and inline client-side:

```javascript
function categorizePrompt(promptText) {
  if (typeof promptText !== 'string') return { type: 'user-prompt', text: '' };
  const trimmed = promptText.trimStart();

  if (trimmed.startsWith('<task-notification>')) {
    const tidMatch = trimmed.match(/<task-id>\s*(.*?)\s*<\/task-id>/s);
    const statusMatch = trimmed.match(/<status>\s*(.*?)\s*<\/status>/s);
    const summaryMatch = trimmed.match(/<summary>\s*(.*?)\s*<\/summary>/s);
    return {
      type: 'task-notification',
      taskId: tidMatch ? tidMatch[1].trim() : '?',
      status: statusMatch ? statusMatch[1].trim() : '?',
      summary: summaryMatch ? summaryMatch[1].trim() : '',
    };
  }

  if (trimmed.startsWith('<system-reminder>')) {
    const innerText = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { type: 'system-reminder', text: innerText };
  }

  if (trimmed.startsWith('<task-id>') || trimmed.startsWith('<output-file>') ||
      trimmed.startsWith('<command-name>') || trimmed.startsWith('<command-message>')) {
    const tagMatch = trimmed.match(/^<([a-z-]+)>/);
    const tagName = tagMatch ? tagMatch[1] : 'system';
    const innerText = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { type: 'system-meta', tag: tagName, text: innerText };
  }

  return { type: 'user-prompt', text: promptText };
}
```

2. **Modify `generateEventSummary()` for `UserPromptReceived`** -- when event type is `UserPromptReceived`, run `categorizePrompt()` on the prompt text and return type-specific HTML:

```javascript
// Inside the UserPromptReceived case of generateEventSummary():
case 'UserPromptReceived': {
  const prompt = event.data?.prompt || event.data?.message || '';
  const cat = categorizePrompt(prompt);
  let html = '';
  let isSystem = false;

  switch (cat.type) {
    case 'task-notification':
      isSystem = true;
      html = '<div class="ev-sysmsg ev-sysmsg-task">' +
        '<span class="ev-sysmsg-icon">&#129302;</span>' +
        '<span class="ev-sysmsg-label">Task</span> ' +
        '<span class="ev-code">' + escHtml(cat.taskId) + '</span> ' +
        '<span class="ev-systask-status ev-systask-status-' + escHtml(cat.status) + '">' + escHtml(cat.status) + '</span>' +
        (cat.summary ? ' <span class="ev-output">' + escHtml(truncate(cat.summary, 120)) + '</span>' : '') +
        '</div>';
      break;
    case 'system-reminder':
      isSystem = true;
      html = '<div class="ev-sysmsg ev-sysmsg-reminder">' +
        '<span class="ev-sysmsg-icon">&#9881;</span>' +
        '<span class="ev-sysmsg-label">System Reminder</span> ' +
        '<span class="ev-output">' + escHtml(truncate(cat.text, 150)) + '</span>' +
        '</div>';
      break;
    case 'system-meta':
      isSystem = true;
      html = '<div class="ev-sysmsg ev-sysmsg-meta">' +
        '<span class="ev-sysmsg-icon">&#9881;</span>' +
        '<span class="ev-sysmsg-label">' + escHtml(cat.tag) + '</span> ' +
        '<span class="ev-output">' + escHtml(truncate(cat.text, 150)) + '</span>' +
        '</div>';
      break;
    default:
      html = '<span class="ev-prompt-icon">&#128172;</span> ' +
        '<span class="ev-prompt">' + escHtml(truncate(prompt, 300)) + '</span>';
  }

  return { text: truncate(prompt, 200), html, _isSystem: isSystem };
}
```

3. **Add system prompt toggle to filter bar HTML**:

```html
<label class="filter-toggle">
  <input type="checkbox" id="filter-system" checked onchange="applyFilters()">
  Show system prompts
  <span class="system-count" id="system-count"></span>
</label>
```

4. **Filter logic** -- modify `applyFilters()` to hide/show system rows:

```javascript
function applyFilters() {
  const showSystem = document.getElementById('filter-system')?.checked ?? true;
  const rows = document.querySelectorAll('#event-rows tr');
  let systemCount = 0, userCount = 0;

  rows.forEach(row => {
    if (row.classList.contains('system-prompt')) {
      systemCount++;
      row.style.display = showSystem ? '' : 'none';
    } else if (row.dataset.eventType === 'UserPromptReceived') {
      userCount++;
    }
    // ... existing type/date filters ...
  });

  const countEl = document.getElementById('system-count');
  if (countEl) countEl.textContent = `(${systemCount} system, ${userCount} user)`;
}
```

5. **Mark rows as system** -- when rendering events, add `class="system-prompt"` to `<tr>` elements whose `_isSystem` flag is true.

6. **CSS for system messages** (add to inline styles):

```css
.ev-sysmsg { padding: 4px 8px; border-radius: 4px; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.ev-sysmsg-task { background: rgba(188,140,255,0.08); }
.ev-sysmsg-reminder { background: rgba(139,148,158,0.08); }
.ev-sysmsg-meta { background: rgba(139,148,158,0.06); }
.ev-sysmsg-icon { font-size: 14px; opacity: 0.7; }
.ev-sysmsg-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; color: var(--text2); }
.ev-systask-status-completed { color: var(--green); }
.ev-systask-status-inprogress, .ev-systask-status-in_progress { color: var(--yellow); }
.ev-systask-status-failed { color: var(--red); }
tr.system-prompt { opacity: 0.8; }
```

**Acceptance Criteria**

- [ ] Task notifications (`<task-notification>`) detected and rendered with robot icon, task ID, status badge, summary
- [ ] System reminders (`<system-reminder>`) rendered with gear icon and truncated preview
- [ ] System metadata (`<task-id>`, `<output-file>`, `<command-name>`) rendered with gear icon and tag label
- [ ] Real user prompts rendered with speech bubble icon and full text (up to 300 chars)
- [ ] System messages have distinct visual style (muted background, smaller labels)
- [ ] "Show system prompts" toggle hides/shows system messages
- [ ] Default is system prompts visible (checkbox checked)
- [ ] System/user prompt counts shown in filter bar (e.g., "3 system, 12 user")
- [ ] SSE events are also categorized on arrival

**Edge Cases**

- Prompt starts with `<` but is not a known system tag: treated as user prompt
- Empty prompt text: categorized as user prompt with empty text
- Multi-line task notification: regex uses `/s` flag for dotAll matching
- Mixed content (system XML followed by user text): entire prompt categorized by first tag

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 6: Agent Status Panel

**Description**

Add an "Agents" tab to the dashboard header, alongside the existing "Events" and "Usage" tabs. The Agents tab shows a card-based view of all running agents with lifecycle state, metadata, and activity. Agent data comes from the daemon's agent manager (if running in daemon mode) or a REST API call to the daemon (if standalone).

**Prerequisites/Inputs**
- Existing tab navigation in dashboard HTML
- F3 (Agent Orchestration) API contract -- this task implements the dashboard side; the daemon-side API is a dependency
- If daemon is not available, agent panel shows empty state

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing)

1. **Add "Agents" tab** to the existing header nav:

```html
<button class="tab" data-tab="agents" onclick="switchTab('agents')">
  Agents <span class="agent-tab-count" id="agent-tab-count"></span>
</button>
```

2. **Add agents view container** to the main content area:

```html
<div class="agents-view tab-content" id="agents-view" style="display:none">
  <div class="agents-header">
    <span class="agents-title">Active Agents</span>
    <span class="agents-count" id="agents-count"></span>
  </div>
  <div class="agent-cards" id="agent-cards">
    <!-- Rendered by JavaScript -->
  </div>
</div>
```

3. **Server-side `/api/agents` endpoint**:

```javascript
if (pathname === '/api/agents') {
  const agents = await getAgentList();
  sendJson(res, agents);
  return;
}

async function getAgentList() {
  // If running inside daemon with agent manager in-process
  if (globalThis.agentManager) {
    return globalThis.agentManager.listAgents();
  }
  // Standalone mode: try daemon API
  try {
    const daemonPort = await readDaemonPort();
    if (!daemonPort) return [];
    const resp = await fetch(`http://localhost:${daemonPort}/api/agents`);
    if (!resp.ok) return [];
    return resp.json();
  } catch {
    return [];
  }
}

async function readDaemonPort() {
  const pidFile = path.join(getBasePath(), '.daemon.pid');
  try {
    const content = await readFile(pidFile, 'utf-8');
    const lines = content.trim().split('\n');
    return parseInt(lines[1], 10) || null;
  } catch {
    return null;
  }
}
```

4. **Server-side `/api/agents/stream` SSE endpoint**:

```javascript
if (pathname === '/api/agents/stream') {
  res.socket.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(':ok\n\n');
  res.write('retry: 3000\n\n');

  let alive = true;
  let lastState = JSON.stringify([]);
  req.on('close', () => { alive = false; });

  const poll = async () => {
    if (!alive) return;
    try {
      const agents = await getAgentList();
      const curState = JSON.stringify(agents);
      if (curState !== lastState) {
        res.write(`data: ${JSON.stringify({ type: 'agents_update', agents })}\n\n`);
        lastState = curState;
      }
    } catch { /* ignore */ }
    if (alive) res.write(':keepalive\n\n');
    if (alive) setTimeout(poll, 3000);
  };

  poll();
  return;
}
```

5. **Client-side agent rendering**:

```javascript
let agentSSE = null;
let agentData = [];

async function loadAgents() {
  try {
    agentData = await api('/api/agents');
  } catch { agentData = []; }
  renderAgents();
}

function renderAgents() {
  const container = document.getElementById('agent-cards');
  const countEl = document.getElementById('agents-count');
  const tabCountEl = document.getElementById('agent-tab-count');
  if (!container) return;

  const running = agentData.filter(a => a.status === 'running' || a.status === 'idle');
  if (countEl) countEl.textContent = running.length + ' running';
  if (tabCountEl) tabCountEl.textContent = running.length > 0 ? '(' + running.length + ')' : '';

  if (agentData.length === 0) {
    container.innerHTML = '<div class="empty-state">' +
      '<div class="empty-icon">&#129302;</div>' +
      '<div>No agents running</div>' +
      '<div class="hint">Start a Claude Code session to see agents here.</div>' +
      '</div>';
    return;
  }

  // Sort: running first, then idle, then others
  const order = { running: 0, idle: 1, initializing: 2, error: 3, closed: 4 };
  const sorted = [...agentData].sort((a, b) => (order[a.status] || 5) - (order[b.status] || 5));

  container.innerHTML = sorted.map(a => renderAgentCard(a)).join('');
}

function renderAgentCard(agent) {
  const uptime = agent.uptime_seconds ? formatUptime(agent.uptime_seconds) : '';
  const permBadge = agent.permissions_pending > 0
    ? '<span class="permission-badge">' + agent.permissions_pending + '</span>'
    : '';
  return `<div class="agent-card agent-status-${escHtml(agent.status)}">
    <div class="agent-card-header">
      <span class="agent-status-dot status-${escHtml(agent.status)}"></span>
      <span class="agent-provider">${escHtml(agent.provider || 'claude-code')}</span>
      <span class="agent-model">${escHtml(agent.model || '?')}</span>
      ${permBadge}
      <span class="agent-uptime">${uptime}</span>
    </div>
    <div class="agent-card-body">
      <div class="agent-project">${escHtml(agent.project_name || '')}</div>
      <div class="agent-cwd">${escHtml(agent.cwd || '')}</div>
      ${agent.last_activity ? '<div class="agent-activity">' + escHtml(truncate(agent.last_activity, 80)) + '</div>' : ''}
    </div>
    <div class="agent-card-footer">
      <span class="agent-turns">${agent.turn_count || 0} turns</span>
      <span class="agent-tokens">${formatTokens(agent.token_usage?.input_tokens || 0)} in / ${formatTokens(agent.token_usage?.output_tokens || 0)} out</span>
      <button class="agent-btn" onclick="openAgentInteraction('${escHtml(agent.agent_id)}')">Interact</button>
    </div>
  </div>`;
}

function formatUptime(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + 'h ' + m + 'm';
}
```

6. **Agent card CSS** (add to inline styles):

```css
.agent-cards { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.agent-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; transition: border-color 0.15s; }
.agent-card.agent-status-running { border-left: 3px solid var(--green); }
.agent-card.agent-status-idle { border-left: 3px solid var(--accent); }
.agent-card.agent-status-error { border-left: 3px solid var(--red); }
.agent-card.agent-status-initializing { border-left: 3px solid var(--yellow); }
.agent-card.agent-status-closed { border-left: 3px solid var(--text2); opacity: 0.6; }
.agent-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.agent-card-body { font-size: 12px; color: var(--text2); margin-bottom: 6px; }
.agent-card-footer { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text2); }
.agent-status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.status-initializing { background: var(--yellow); animation: pulse 1.5s infinite; }
.status-idle { background: var(--accent); }
.status-running { background: var(--green); animation: pulse 2s infinite; }
.status-error { background: var(--red); }
.status-closed { background: var(--text2); }
.agent-provider { font-weight: 500; font-size: 13px; }
.agent-model { font-size: 11px; color: var(--text2); background: var(--bg3); padding: 1px 6px; border-radius: 3px; }
.agent-uptime { margin-left: auto; font-size: 11px; color: var(--text2); }
.agent-btn { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 11px; color: var(--text); }
.agent-btn:hover { border-color: var(--accent); }
.agent-project { font-weight: 500; color: var(--text); }
.agent-activity { font-style: italic; margin-top: 2px; }
.permission-badge { background: var(--red); color: #fff; font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 8px; animation: pulse 2s infinite; }
.empty-state { text-align: center; padding: 60px 20px; color: var(--text2); }
.empty-icon { font-size: 48px; margin-bottom: 12px; }
.hint { font-size: 12px; margin-top: 4px; }
```

7. **Connect agent SSE when Agents tab is active**:

```javascript
function connectAgentSSE() {
  if (agentSSE) { agentSSE.close(); agentSSE = null; }
  agentSSE = new EventSource('/api/agents/stream');
  agentSSE.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'agents_update') {
        agentData = msg.agents;
        renderAgents();
      }
    } catch {}
  };
}

function disconnectAgentSSE() {
  if (agentSSE) { agentSSE.close(); agentSSE = null; }
}
```

8. **Tab switching** -- modify `switchTab()` to connect/disconnect agent SSE:

```javascript
function switchTab(tab) {
  // ... existing tab switching logic ...
  if (tab === 'agents') {
    loadAgents();
    connectAgentSSE();
  } else {
    disconnectAgentSSE();
  }
}
```

**Acceptance Criteria**

- [ ] "Agents" tab appears in the dashboard header
- [ ] All running agents displayed as cards with provider, model, status, cwd, uptime
- [ ] Status indicators color-coded: green (running), blue (idle), yellow (initializing), red (error), grey (closed)
- [ ] Agent activity updates in real-time via SSE (3-second polling server-side)
- [ ] Each agent card shows turn count and token usage
- [ ] Agents with pending permissions show a notification badge (red circle with count)
- [ ] "Interact" button on each card calls `openAgentInteraction()` (implemented in Task 7)
- [ ] Empty state shown when no agents running
- [ ] Agent cards sorted by status (running first, then idle, then others)
- [ ] Agent tab count badge shows number of running agents

**Edge Cases**

- E-6: No agents running: empty state message displayed
- Daemon not running (standalone dashboard): `getAgentList()` returns empty array gracefully
- Agent status changes rapidly: 3-second poll interval means max 3s lag
- Many agents (10+): cards are scrollable within the agents view

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 7: Agent Interaction Panel

**Description**

Implement the slide-in panel for interacting with a specific agent: send prompts, view streaming output, and approve/deny permissions. The panel opens when clicking "Interact" on an agent card.

**Prerequisites/Inputs**
- Task 6 (Agent Status Panel provides agent data and the "Interact" button)
- F3 daemon API for `POST /api/agents/{id}/prompt` and `POST /api/agents/{id}/permission`
- Daemon must be running for interaction to work

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing)

1. **Interaction panel HTML** -- add to the dashboard body:

```html
<div class="agent-interaction" id="agent-interaction" style="display:none">
  <div class="interaction-header">
    <button class="back-btn" onclick="closeInteraction()">&#8592; Back</button>
    <span class="interaction-title" id="interaction-title"></span>
    <span class="agent-status-dot" id="interaction-status-dot"></span>
  </div>
  <div class="permissions-panel" id="permissions-panel" style="display:none"></div>
  <div class="interaction-output" id="interaction-output"></div>
  <div class="interaction-input">
    <textarea id="agent-prompt" placeholder="Send a prompt to this agent..."
      onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendAgentPrompt();}"></textarea>
    <button class="send-btn" id="send-btn" onclick="sendAgentPrompt()">Send</button>
  </div>
</div>
```

2. **Server-side prompt endpoint** -- proxy to daemon:

```javascript
if (pathname.match(/^\/api\/agents\/[^/]+\/prompt$/)) {
  const agentId = pathname.split('/')[3];
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const { prompt } = JSON.parse(body);

  // Forward to daemon
  const daemonPort = await readDaemonPort();
  if (!daemonPort) {
    sendJson(res, { error: 'Daemon not running' }, 503);
    return;
  }

  try {
    // Proxy SSE stream from daemon to client
    const daemonReq = http.request({
      hostname: 'localhost', port: daemonPort,
      path: `/api/agents/${agentId}/prompt`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (daemonRes) => {
      res.writeHead(daemonRes.statusCode, daemonRes.headers);
      daemonRes.pipe(res);
    });
    daemonReq.write(JSON.stringify({ prompt }));
    daemonReq.end();
  } catch (err) {
    sendJson(res, { error: err.message }, 502);
  }
  return;
}
```

3. **Server-side permission endpoint** -- proxy to daemon:

```javascript
if (pathname.match(/^\/api\/agents\/[^/]+\/permission$/)) {
  const agentId = pathname.split('/')[3];
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;

  const daemonPort = await readDaemonPort();
  if (!daemonPort) {
    sendJson(res, { error: 'Daemon not running' }, 503);
    return;
  }

  try {
    const daemonReq = http.request({
      hostname: 'localhost', port: daemonPort,
      path: `/api/agents/${agentId}/permission`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (daemonRes) => {
      let data = '';
      daemonRes.on('data', c => data += c);
      daemonRes.on('end', () => {
        res.writeHead(daemonRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    daemonReq.write(body);
    daemonReq.end();
  } catch (err) {
    sendJson(res, { error: err.message }, 502);
  }
  return;
}
```

4. **Client-side interaction functions**:

```javascript
let interactionAgentId = null;
let interactionSSE = null;
let turnInProgress = false;

function openAgentInteraction(agentId) {
  const agent = agentData.find(a => a.agent_id === agentId);
  if (!agent) return;

  interactionAgentId = agentId;
  const panel = document.getElementById('agent-interaction');
  const title = document.getElementById('interaction-title');
  const dot = document.getElementById('interaction-status-dot');
  const output = document.getElementById('interaction-output');

  panel.style.display = 'flex';
  title.textContent = `Agent: ${agent.provider} (${agent.project_name || '?'})`;
  dot.className = 'agent-status-dot status-' + (agent.status || 'closed');
  output.innerHTML = '';

  if (agent.status === 'closed' || agent.status === 'error') {
    output.innerHTML = '<div class="interaction-notice">This agent is no longer running.</div>';
    document.getElementById('agent-prompt').disabled = true;
    document.getElementById('send-btn').disabled = true;
  } else {
    document.getElementById('agent-prompt').disabled = false;
    document.getElementById('send-btn').disabled = false;
  }

  // Connect to agent output stream
  connectInteractionSSE(agentId);
}

function closeInteraction() {
  document.getElementById('agent-interaction').style.display = 'none';
  interactionAgentId = null;
  if (interactionSSE) { interactionSSE.close(); interactionSSE = null; }
}

function connectInteractionSSE(agentId) {
  if (interactionSSE) { interactionSSE.close(); }
  interactionSSE = new EventSource('/api/agents/' + encodeURIComponent(agentId) + '/stream');
  const outputEl = document.getElementById('interaction-output');

  interactionSSE.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'text':
          appendInteractionText(outputEl, msg.content);
          break;
        case 'tool_use':
          appendInteractionToolCall(outputEl, msg.tool, msg.input);
          break;
        case 'tool_result':
          appendInteractionToolResult(outputEl, msg.tool, msg.output);
          break;
        case 'permission_request':
          showPermissionRequest(msg);
          break;
        case 'done':
          turnInProgress = false;
          document.getElementById('send-btn').disabled = false;
          break;
        case 'error':
          appendInteractionError(outputEl, msg.message);
          turnInProgress = false;
          document.getElementById('send-btn').disabled = false;
          break;
      }
      outputEl.scrollTop = outputEl.scrollHeight;
    } catch {}
  };
}

async function sendAgentPrompt() {
  if (turnInProgress || !interactionAgentId) return;
  const textarea = document.getElementById('agent-prompt');
  const prompt = textarea.value.trim();
  if (!prompt) return;

  turnInProgress = true;
  document.getElementById('send-btn').disabled = true;
  textarea.value = '';

  // Show sent prompt in output
  const outputEl = document.getElementById('interaction-output');
  outputEl.innerHTML += '<div class="interaction-user-msg">' + escHtml(prompt) + '</div>';
  outputEl.scrollTop = outputEl.scrollHeight;

  try {
    await fetch('/api/agents/' + encodeURIComponent(interactionAgentId) + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    // Response will come through the SSE stream
  } catch (err) {
    appendInteractionError(outputEl, 'Failed to send prompt: ' + err.message);
    turnInProgress = false;
    document.getElementById('send-btn').disabled = false;
  }
}

function showPermissionRequest(msg) {
  const panel = document.getElementById('permissions-panel');
  panel.style.display = 'block';
  panel.innerHTML += `<div class="permission-card" id="perm-${escHtml(msg.permission_id)}">
    <div class="permission-type">${escHtml(msg.tool || 'Permission')}</div>
    <div class="permission-detail">${escHtml(msg.detail || '')}</div>
    <div class="permission-actions">
      <button class="perm-approve" onclick="handlePermission('${escHtml(msg.permission_id)}','approve')">Approve</button>
      <button class="perm-deny" onclick="handlePermission('${escHtml(msg.permission_id)}','deny')">Deny</button>
    </div>
  </div>`;
}

async function handlePermission(permissionId, action) {
  try {
    await fetch('/api/agents/' + encodeURIComponent(interactionAgentId) + '/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission_id: permissionId, action }),
    });
    const card = document.getElementById('perm-' + permissionId);
    if (card) card.remove();
    // Hide panel if no more permissions
    const panel = document.getElementById('permissions-panel');
    if (panel && panel.children.length === 0) panel.style.display = 'none';
  } catch (err) {
    alert('Permission action failed: ' + err.message);
  }
}

function appendInteractionText(el, text) {
  let lastChild = el.lastElementChild;
  if (lastChild && lastChild.classList.contains('interaction-assistant-msg')) {
    lastChild.textContent += text;
  } else {
    el.innerHTML += '<div class="interaction-assistant-msg">' + escHtml(text) + '</div>';
  }
}

function appendInteractionToolCall(el, tool, input) {
  const summary = generateInputSummary(tool, input);
  el.innerHTML += '<div class="interaction-tool-call">' + summary.html + '</div>';
}

function appendInteractionToolResult(el, tool, output) {
  el.innerHTML += '<div class="interaction-tool-result">' + escHtml(truncate(String(output), 200)) + '</div>';
}

function appendInteractionError(el, message) {
  el.innerHTML += '<div class="interaction-error">' + escHtml(message) + '</div>';
}
```

5. **Interaction panel CSS** (add to inline styles):

```css
.agent-interaction { position: fixed; right: 0; top: 48px; bottom: 0; width: 50%; min-width: 400px; background: var(--bg); border-left: 1px solid var(--border); display: flex; flex-direction: column; z-index: 100; }
.interaction-header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 8px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.back-btn { background: none; border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; cursor: pointer; color: var(--text); font-size: 12px; }
.interaction-title { font-weight: 500; font-size: 13px; }
.interaction-output { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: 13px; line-height: 1.5; }
.interaction-input { border-top: 1px solid var(--border); padding: 8px; display: flex; gap: 8px; flex-shrink: 0; }
.interaction-input textarea { flex: 1; background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: inherit; font-size: 13px; padding: 8px; resize: none; min-height: 40px; max-height: 120px; }
.send-btn { background: var(--accent); color: #fff; border: none; border-radius: 4px; padding: 8px 16px; cursor: pointer; font-weight: 500; }
.send-btn:hover { opacity: 0.9; }
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.interaction-user-msg { background: rgba(88,166,255,0.1); border-radius: 6px; padding: 8px 12px; margin: 4px 0; margin-left: 20%; }
.interaction-assistant-msg { padding: 4px 0; white-space: pre-wrap; }
.interaction-tool-call { background: var(--bg2); border-radius: 4px; padding: 6px 10px; margin: 4px 0; font-size: 12px; }
.interaction-tool-result { background: var(--bg2); border-radius: 4px; padding: 6px 10px; margin: 2px 0; font-size: 11px; color: var(--text2); }
.interaction-error { color: var(--red); padding: 4px 0; }
.interaction-notice { color: var(--text2); text-align: center; padding: 40px; }
.permission-card { background: rgba(210,153,34,0.1); border: 1px solid rgba(210,153,34,0.3); border-radius: 6px; padding: 12px; margin: 8px 16px; }
.permission-type { font-weight: 500; }
.permission-detail { font-size: 12px; color: var(--text2); margin: 4px 0; }
.permission-actions { display: flex; gap: 8px; margin-top: 8px; }
.perm-approve { background: var(--green); color: #fff; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; }
.perm-deny { background: var(--red); color: #fff; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; }
```

6. **Server-side agent stream proxy** -- proxy `/api/agents/{id}/stream` to daemon:

```javascript
if (pathname.match(/^\/api\/agents\/[^/]+\/stream$/)) {
  const agentId = pathname.split('/')[3];
  const daemonPort = await readDaemonPort();
  if (!daemonPort) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(':no daemon\n\n');
    res.end();
    return;
  }

  // Proxy SSE from daemon to client
  try {
    const daemonReq = http.request({
      hostname: 'localhost', port: daemonPort,
      path: `/api/agents/${agentId}/stream`,
      method: 'GET',
    }, (daemonRes) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      daemonRes.pipe(res);
    });
    daemonReq.end();
    req.on('close', () => { daemonReq.destroy(); });
  } catch {
    res.writeHead(502); res.end();
  }
  return;
}
```

**Acceptance Criteria**

- [ ] Interaction panel opens when clicking "Interact" on an agent card
- [ ] Users can type prompts and send with Enter or Send button
- [ ] Shift+Enter inserts a newline instead of sending
- [ ] Agent responses are streamed in real-time via SSE
- [ ] Tool calls rendered inline with the same formatting as event feed
- [ ] Permission requests appear as cards with Approve/Deny buttons
- [ ] Approve/Deny actions sent to daemon API; permission card removed on success
- [ ] Output panel auto-scrolls to bottom as new content arrives
- [ ] Send button disabled while a turn is in progress
- [ ] Panel closes with the Back button
- [ ] If agent is not running, panel shows disabled state with message
- [ ] E-10: Sending to closed agent shows "This agent is no longer running"

**Edge Cases**

- E-8: Permission request arrives while panel is closed: badge shown on agent card (Task 6)
- E-10: Prompt sent to closed agent: daemon returns 409, panel shows error message
- Daemon not running: all proxy endpoints return 503 or empty state
- Rapid typing while turn in progress: Send button disabled, textarea not cleared

**Estimated Effort**: L (Large) -- 8-10 hours

---

### Task 8: Lifecycle Management (gc-dashboard start/stop/restart/status)

**Description**

Implement the `gc-dashboard` lifecycle commands: `start`, `stop`, `restart`, `status`. The dashboard runs as a background process with a PID file at `~/.claude-context/.dashboard.pid`. Port is configurable via `--port` flag, `.dashboard-config.json`, or `.dashboard-enabled` marker.

**Prerequisites/Inputs**
- Existing `gc-dashboard` server code
- `~/.claude-context/` directory (from Story 03)

**Implementation Details**

File: `src/bin/gc-dashboard` (modify existing, add lifecycle logic before server creation)

1. **PID file management** -- add at the top of the file (after imports):

```javascript
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';

const BASE = getBasePath();
const PID_FILE = path.join(BASE, '.dashboard.pid');
const ENABLED_FILE = path.join(BASE, '.dashboard-enabled');
const CONFIG_FILE = path.join(BASE, '.dashboard-config.json');

function writePid(port) {
  try {
    writeFileSync(PID_FILE, `${process.pid}\n${port}\n`);
  } catch {}
}

function removePid() {
  try { unlinkSync(PID_FILE); } catch {}
}

function readPidFile() {
  try {
    const content = readFileSync(PID_FILE, 'utf-8').trim();
    const [pidStr, portStr] = content.split('\n');
    return { pid: parseInt(pidStr, 10), port: parseInt(portStr, 10) || 4000 };
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
```

2. **Port selection logic**:

```javascript
async function selectPort() {
  // 1. Check --port CLI flag
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1 && process.argv[portIdx + 1]) {
    const p = parseInt(process.argv[portIdx + 1], 10);
    if (p > 0 && p < 65536) return p;
  }

  // 2. Check .dashboard-config.json
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    if (config.port > 0 && config.port < 65536) return config.port;
  } catch {}

  // 3. Check .dashboard-enabled marker
  try {
    const marker = readFileSync(ENABLED_FILE, 'utf-8').trim();
    const markerPort = parseInt(marker, 10);
    if (markerPort > 0 && markerPort < 65536) return markerPort;
  } catch {}

  // 4. Default
  return 4000;
}
```

3. **Lifecycle command handling** -- add before the server creation code:

```javascript
const command = process.argv[2];

if (command === 'stop') {
  const info = readPidFile();
  if (!info || !isRunning(info.pid)) {
    console.log('[gc-dashboard] Not running.');
    removePid();
    process.exit(0);
  }
  console.log(`[gc-dashboard] Stopping PID ${info.pid}...`);
  process.kill(info.pid, 'SIGTERM');
  // Wait up to 2 seconds
  let waited = 0;
  while (waited < 2000 && isRunning(info.pid)) {
    await new Promise(r => setTimeout(r, 200));
    waited += 200;
  }
  if (isRunning(info.pid)) {
    console.log('[gc-dashboard] Force killing...');
    try { process.kill(info.pid, 'SIGKILL'); } catch {}
  }
  removePid();
  console.log('[gc-dashboard] Stopped.');
  process.exit(0);
}

if (command === 'restart') {
  // Stop first
  const info = readPidFile();
  if (info && isRunning(info.pid)) {
    process.kill(info.pid, 'SIGTERM');
    let waited = 0;
    while (waited < 2000 && isRunning(info.pid)) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    if (isRunning(info.pid)) {
      try { process.kill(info.pid, 'SIGKILL'); } catch {}
    }
    removePid();
  }
  // Fall through to start
}

if (command === 'status') {
  const info = readPidFile();
  if (info && isRunning(info.pid)) {
    console.log(`[gc-dashboard] Running (PID ${info.pid}, port ${info.port})`);
    console.log(`  URL: http://localhost:${info.port}`);
  } else {
    if (info) removePid(); // Stale PID file
    console.log('[gc-dashboard] Not running.');
  }
  process.exit(0);
}

if (command === 'start' || command === 'restart' || !command || command === '--port') {
  // Check if already running
  const info = readPidFile();
  if (info && isRunning(info.pid) && command !== 'restart') {
    console.log(`[gc-dashboard] Already running (PID ${info.pid}, port ${info.port})`);
    console.log(`  URL: http://localhost:${info.port}`);
    process.exit(0);
  }
  if (info && !isRunning(info.pid)) {
    removePid(); // Stale PID
  }
  // Proceed to start server...
}
```

4. **Signal handling** -- add after server starts:

```javascript
process.on('SIGINT', () => { removePid(); process.exit(0); });
process.on('SIGTERM', () => { removePid(); process.exit(0); });
process.on('exit', () => { removePid(); });
```

5. **EADDRINUSE handling** -- wrap `server.listen()`:

```javascript
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[gc-dashboard] ERROR: Port ${port} is already in use.`);
    console.error(`[gc-dashboard]   Another process is listening on this port.`);
    console.error(`[gc-dashboard]   Use --port to specify a different port:`);
    console.error(`[gc-dashboard]     gc-dashboard start --port ${port + 1}`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  writePid(port);
  console.log(`[gc-dashboard] Listening on http://localhost:${port}`);
  warmUsageCache();
});
```

6. **Logging** -- redirect stdout/stderr to log file when running as daemon (handled by the caller using `nohup ... >> .dashboard.log 2>&1`). The server itself just writes to stdout.

**Acceptance Criteria**

- [ ] `gc-dashboard start` starts the HTTP server and writes PID file
- [ ] `gc-dashboard stop` sends SIGTERM, waits up to 2s, then SIGKILL if needed, removes PID file
- [ ] `gc-dashboard restart` stops (if running) then starts
- [ ] `gc-dashboard status` reports running state and URL
- [ ] PID file at `~/.claude-context/.dashboard.pid` contains `{pid}\n{port}\n`
- [ ] Port configurable via `--port` flag, `.dashboard-config.json`, or `.dashboard-enabled`
- [ ] Stale PID files (process no longer alive) cleaned up on next start/status
- [ ] SIGINT and SIGTERM handled gracefully (PID file removed)
- [ ] E-1: Port already in use produces clear error with suggestion
- [ ] E-2: Stale PID detected and cleaned up
- [ ] E-5: Concurrent start attempts handled via PID check + EADDRINUSE safety net
- [ ] `gc-dashboard` with no command defaults to `start` behavior

**Edge Cases**

- E-1: Port in use: clear error message, exit 1
- E-2: Orphaned PID file: detected by `isRunning()`, cleaned up
- E-5: Concurrent starts: second instance gets EADDRINUSE from `server.listen()`
- Process killed with `kill -9`: PID file remains; next start detects stale PID via `kill(pid, 0)`

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 9: Hook & Deploy Integration

**Description**

Integrate the dashboard lifecycle into `gc-hook` (auto-start on session) and `deploy.sh` (restart on upgrade). Create the `.dashboard-enabled` marker during `gc-install` or `gc-dashboard start`. Update `gc-install` to deploy `gc-dashboard` to `bin/`.

**Prerequisites/Inputs**
- Task 8 (lifecycle commands must exist)
- Existing `src/gc-hook` script
- Existing `src/lib/deploy.sh`
- Existing `src/bin/gc-install`

**Implementation Details**

1. **Modify `src/gc-hook`** -- add auto-start check after event capture (at the end of the background subshell):

File: `src/gc-hook` (modify existing)

```bash
# Auto-start dashboard if enabled
_auto_start_dashboard() {
  local base_dir="$1"
  local dashboard_enabled="$base_dir/.dashboard-enabled"
  local dashboard_pid="$base_dir/.dashboard.pid"
  local dashboard_bin="$base_dir/bin/gc-dashboard"

  [ -f "$dashboard_enabled" ] || return 0
  [ -f "$dashboard_bin" ] || return 0
  command -v node >/dev/null 2>&1 || return 0

  local port
  port=$(head -1 "$dashboard_enabled" 2>/dev/null)
  port="${port:-4000}"

  # Check if already running
  if [ -f "$dashboard_pid" ]; then
    local pid
    pid=$(head -1 "$dashboard_pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0  # Already running
    fi
    # Stale PID, clean up
    rm -f "$dashboard_pid"
  fi

  # Start dashboard in background
  nohup node "$dashboard_bin" start --port "$port" >> "$base_dir/.dashboard.log" 2>&1 &
}

# Call at end of hook processing (inside background subshell)
_auto_start_dashboard "$GC_BASE"
```

2. **Modify `src/lib/deploy.sh`** -- add dashboard restart after file deployment:

File: `src/lib/deploy.sh` (modify existing)

```bash
# Add to gc_deploy_files() after all files are copied:
gc_restart_dashboard_if_enabled() {
  local target_dir="$1"
  local dashboard_enabled="$target_dir/.dashboard-enabled"
  local dashboard_bin="$target_dir/bin/gc-dashboard"

  if [ -f "$dashboard_enabled" ] && [ -f "$dashboard_bin" ] && command -v node >/dev/null 2>&1; then
    echo "[deploy] Restarting dashboard..."
    node "$dashboard_bin" stop 2>/dev/null || true
    local port
    port=$(head -1 "$dashboard_enabled" 2>/dev/null)
    port="${port:-4000}"
    nohup node "$dashboard_bin" start --port "$port" >> "$target_dir/.dashboard.log" 2>&1 &
    echo "[deploy] Dashboard restarted."
  fi
}
```

3. **Create `.dashboard-enabled` marker** -- modify `gc-dashboard start` to create the marker:

File: `src/bin/gc-dashboard` (modify in Task 8 code)

```javascript
// In the server.listen() callback:
server.listen(port, () => {
  writePid(port);
  // Create enabled marker for auto-start
  try {
    writeFileSync(ENABLED_FILE, String(port) + '\n');
  } catch {}
  console.log(`[gc-dashboard] Listening on http://localhost:${port}`);
  warmUsageCache();
});
```

And in `gc-dashboard stop`, remove the enabled marker:

```javascript
// In stop command: do NOT remove .dashboard-enabled
// The marker persists so the dashboard auto-starts on next session.
// User must explicitly disable: rm ~/.claude-context/.dashboard-enabled
```

4. **Ensure `gc-dashboard` is deployed by `gc-install`** -- verify that `deploy.sh` copies `gc-dashboard` from `src/bin/` to `$GC_BASE/bin/` with mode 755. The existing deployment loop already handles all files in `src/bin/`, so `gc-dashboard` is included automatically.

5. **Add `gc_restart_dashboard_if_enabled` call** in `deploy.sh`'s `gc_deploy_files()` at the end.

**Acceptance Criteria**

- [ ] `gc-hook` auto-starts dashboard when `.dashboard-enabled` exists and dashboard is not running
- [ ] `gc-hook` detects stale PID files and cleans up before starting
- [ ] `gc-hook` does nothing if dashboard is already running
- [ ] `deploy.sh` restarts dashboard after upgrading files
- [ ] `.dashboard-enabled` marker created on `gc-dashboard start` with port number
- [ ] `.dashboard-enabled` marker NOT removed on `gc-dashboard stop` (preserves auto-start preference)
- [ ] `gc-dashboard` deployed by `gc-install` to `$GC_BASE/bin/` with mode 755
- [ ] Auto-start only happens if `node` is available on PATH
- [ ] Startup logged to `~/.claude-context/.dashboard.log`

**Edge Cases**

- Node not installed: auto-start silently skipped (`command -v node` check)
- Dashboard binary not deployed yet (first partial install): auto-start skipped
- Multiple hook invocations in rapid succession: first starts dashboard, subsequent detect running PID
- Deploy during active dashboard serving: stop + start ensures clean restart

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 10: Tests

**Description**

Create unit tests for pure functions, integration tests for API endpoints, and document manual verification tests. Tests are organized into separate files following the project's test structure.

**Prerequisites/Inputs**
- All tasks 1-9 must be implemented
- Existing test patterns from `tests/` directory

**Implementation Details**

1. **Unit test file**: `tests/12-dashboard-unit.sh`

Tests for pure functions extracted from the dashboard. Since the dashboard is a Node.js file, we test by running Node with a test harness that imports functions.

Create a test runner that sources the functions:

```bash
#!/usr/bin/env bash
# tests/12-dashboard-unit.sh -- Unit tests for dashboard functions
set -euo pipefail

DASHBOARD="$(cd "$(dirname "$0")/.." && pwd)/src/bin/gc-dashboard"
PASS=0; FAIL=0

run_node_test() {
  local name="$1" code="$2"
  local result
  result=$(node -e "$code" 2>&1) || true
  if echo "$result" | grep -q "^PASS"; then
    echo "  PASS: $name"
    ((PASS++))
  else
    echo "  FAIL: $name: $result"
    ((FAIL++))
  fi
}
```

| # | Test | Function | Validates |
|---|---|---|---|
| T-1 | `escHtml` escapes `<`, `>`, `&`, `"` | `escHtml()` | XSS prevention |
| T-2 | `categorizePrompt` detects task-notification | `categorizePrompt()` | F4.7 |
| T-3 | `categorizePrompt` detects system-reminder | `categorizePrompt()` | F4.7 |
| T-4 | `categorizePrompt` detects system-meta tags | `categorizePrompt()` | F4.7 |
| T-5 | `categorizePrompt` returns user-prompt for normal text | `categorizePrompt()` | F4.7 |
| T-6 | `generateInputSummary` correct for Bash | `generateInputSummary()` | F4.1 |
| T-7 | `generateInputSummary` correct for Read | `generateInputSummary()` | F4.1 |
| T-8 | `generateOutputSummary` correct for Bash exit code | `generateOutputSummary()` | F4.1 |
| T-9 | `calcCost` returns correct value for Opus | `calcCost()` | F4.2 |
| T-10 | `truncate` handles strings correctly | `truncate()` | Utility |

2. **Integration test file**: `tests/12-dashboard-integration.sh`

Tests that start the dashboard server and make HTTP requests:

```bash
#!/usr/bin/env bash
# tests/12-dashboard-integration.sh -- Integration tests for dashboard API
set -euo pipefail

TMPDIR=$(mktemp -d)
export CLAUDE_CONTEXT_PATH="$TMPDIR/gc-store"
mkdir -p "$CLAUDE_CONTEXT_PATH/events" "$CLAUDE_CONTEXT_PATH/projections"
echo '{"version":"1.0.0"}' > "$CLAUDE_CONTEXT_PATH/config.json"

DASHBOARD="$(cd "$(dirname "$0")/.." && pwd)/src/bin/gc-dashboard"
PORT=14567
PASS=0; FAIL=0

# Start dashboard
node "$DASHBOARD" start --port $PORT &
DASH_PID=$!
sleep 2

cleanup() { kill $DASH_PID 2>/dev/null; rm -rf "$TMPDIR"; }
trap cleanup EXIT

test_endpoint() {
  local name="$1" url="$2" expected_status="$3" expected_content="$4"
  local status body
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$url")
  body=$(curl -s "http://localhost:$PORT$url")
  if [ "$status" = "$expected_status" ]; then
    if [ -z "$expected_content" ] || echo "$body" | grep -q "$expected_content"; then
      echo "  PASS: $name"
      ((PASS++))
    else
      echo "  FAIL: $name (content mismatch)"
      ((FAIL++))
    fi
  else
    echo "  FAIL: $name (expected $expected_status, got $status)"
    ((FAIL++))
  fi
}
```

| # | Test | Endpoint | Validates |
|---|---|---|---|
| T-11 | GET / returns HTML 200 | `GET /` | Dashboard serves |
| T-12 | GET /api/projects returns JSON array | `GET /api/projects` | Project listing |
| T-13 | GET /api/sessions returns array | `GET /api/sessions?project=test` | Session listing |
| T-14 | GET /api/events returns events | `GET /api/events?project=test&session=test` | Event retrieval |
| T-15 | GET /api/events with from param filters | `GET /api/events?...&from=10` | Sequence filtering |
| T-16 | GET /api/usage returns usage data | `GET /api/usage` | Usage analytics |
| T-17 | GET /api/usage with project filter | `GET /api/usage?project=test` | Single project usage |
| T-18 | GET /api/stream returns text/event-stream | `GET /api/stream?...` | SSE content type |
| T-19 | SSE connection receives keepalive | SSE stream | Keepalive delivery |
| T-20 | GET /api/agents returns array | `GET /api/agents` | Agent listing (empty) |
| T-21 | PID file created on start | File check | Lifecycle |
| T-22 | gc-dashboard stop removes PID | `stop` command | Lifecycle |
| T-23 | gc-dashboard status reports correctly | `status` command | Lifecycle |
| T-24 | gc-dashboard restart works | `restart` command | Lifecycle |
| T-25 | EADDRINUSE produces clear error | Start on used port | E-1 |
| T-26 | Stale PID cleaned up on start | Stale PID file | E-2 |

3. **Manual verification tests** -- document in the plan (not automated):

| # | Test | Description |
|---|---|---|
| M-1 | Open dashboard, verify sidebar shows projects/sessions | Visual check |
| M-2 | Select session, verify event feed loads with per-type rendering | Visual check |
| M-3 | Start Claude Code session, verify new events appear via SSE | Live test |
| M-4 | Switch to Usage tab, verify token counts and costs | Visual check |
| M-5 | Verify daily timeline bar chart (30 days, stacked bars) | Visual check |
| M-6 | Click timeline bar, verify events filtered to that day | Interaction test |
| M-7 | Select a month, verify tables update + comparison deltas | Interaction test |
| M-8 | Verify per-project percentage badges sum to 100% | Math check |
| M-9 | Toggle "Show system prompts", verify hide/show | Interaction test |
| M-10 | Switch to Agents tab, verify agent cards (or empty state) | Visual check |
| M-11 | Click "Interact" on agent card, verify panel opens | Interaction test |
| M-12 | Send prompt from interaction panel, verify streaming response | Live test |
| M-13 | Approve permission from dashboard | Live test |
| M-14 | `gc-dashboard stop`, verify PID file removed | CLI test |
| M-15 | Verify auto-start on `gc-hook` when `.dashboard-enabled` exists | Integration test |

**Files to Create**

| File | Purpose |
|---|---|
| `tests/12-dashboard-unit.sh` | Unit tests for pure functions |
| `tests/12-dashboard-integration.sh` | Integration tests for API endpoints and lifecycle |

**Acceptance Criteria**

- [ ] All 10 unit tests pass
- [ ] All 16 integration tests pass
- [ ] All 15 manual verification tests are documented with pass/fail criteria
- [ ] Tests use isolated temp directories (no real `~/.claude-context/` touched)
- [ ] Test cleanup on exit (trap removes temp dir and kills dashboard)
- [ ] Tests can run via `bash tests/12-dashboard-unit.sh` and `bash tests/12-dashboard-integration.sh`

**Edge Cases**

- Test port conflict: use a high port (14567+) unlikely to conflict
- Dashboard fails to start in test: cleanup trap still runs
- CI environment without Node.js: integration tests skip with clear message

**Estimated Effort**: L (Large) -- 8-10 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/`.

| File | Action | Task(s) |
|---|---|---|
| `src/bin/gc-dashboard` | Modify (major) | 1, 2, 3, 4, 5, 6, 7, 8 |
| `src/gc-hook` | Modify | 9 |
| `src/lib/deploy.sh` | Modify | 9 |
| `tests/12-dashboard-unit.sh` | Create | 10 |
| `tests/12-dashboard-integration.sh` | Create | 10 |

Note: All changes are concentrated in the single `src/bin/gc-dashboard` file (the single-file architecture) plus minor integration points in `gc-hook` and `deploy.sh`.

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone |
|-------|-------|-----------|
| **Phase 1: Core Enhancements** | Task 1 (Virtual Scroll), Task 2 (Cache/Concurrency) | Event feed and usage performant |
| **Phase 2: Timeline & Filters** | Task 3 (Click-to-filter, Deltas), Task 5 (System Prompts) | Full analytics interaction |
| **Phase 3: Real-Time** | Task 4 (SSE Streaming) | Live event updates working |
| **Phase 4: Agent Management** | Task 6 (Agent Panel), Task 7 (Agent Interaction) | Agent UI complete |
| **Phase 5: Lifecycle** | Task 8 (start/stop/restart), Task 9 (Hook/Deploy Integration) | Auto-start, upgrades |
| **Phase 6: Validation** | Task 10 (Tests) | All scenarios tested |

Tasks 1 and 2 can run in parallel (Phase 1). Tasks 6-7 can run in parallel with Tasks 3-5. Task 8 can start any time after Phase 1.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Single-file becomes unwieldy (3000+ lines growing to ~5000+) | High | Medium (harder to navigate/debug) | Use clear section headers, function grouping. Future story could split into modules with a build step. |
| Agent API (F3) not ready when dashboard needs it | High | Medium (Tasks 6-7 blocked) | Agent panel shows empty state gracefully. Mock daemon responses for testing. |
| SSE connections accumulate if clients don't disconnect | Medium | Medium (fd/memory leak) | `req.on('close')` cleanup. Poll timer checks `alive` flag. |
| JSONL transcript files > 500MB cause slow cache warm | Medium | Low (first load slow) | Semaphore limits concurrency. Background warm does not block server. Consider byte-offset parsing in future. |
| Port 4000 conflicts with other dev tools | Medium | Low (user must reconfigure) | Clear error message with `--port` suggestion. No auto-increment (predictable port needed for auto-start). |
| Daemon proxy (Tasks 6-7) adds latency | Low | Low | Proxy is localhost-to-localhost, sub-ms latency. |
| Browser EventSource reconnection storms | Low | Low | `retry: 3000` controls backoff. Server keepalive prevents premature disconnects. |

---

## Notes for Implementation

1. **All changes go into the single `src/bin/gc-dashboard` file** -- this is the architectural constraint. The file will grow from ~3010 lines to ~5000+ lines. Each task adds a well-delimited section.

2. **The baseline already implements many features** -- Tasks 1-3 are enhancements to existing code, not greenfield. Read the existing implementation carefully before modifying.

3. **Agent features (Tasks 6-7) depend on a daemon API that does not yet exist** -- implement the dashboard side with clear proxy endpoints. The agent panel gracefully degrades to an empty state when the daemon is unavailable.

4. **SSE (Task 4) is the most architecturally significant addition** -- it introduces long-lived connections and server-side polling. Ensure cleanup is airtight (`req.on('close')`, `alive` flag).

5. **System prompt detection (Task 5) should be conservative** -- only detect known XML tags. Unrecognized `<` prefixes are treated as user prompts to avoid false positives.

6. **Lifecycle commands (Task 8) must be synchronous-feeling** -- `gc-dashboard start` should print the URL and exit only after the server is listening. `gc-dashboard stop` should wait for the process to die.

7. **The `.dashboard-enabled` marker is the auto-start contract** -- it persists across stop/start cycles. The only way to disable auto-start is to delete the file manually.

8. **Performance targets from the story spec**: < 2s cold start, < 3s SSE latency, < 50ms cached API responses, < 100ms page load. The cache warm and semaphore in Task 2 are critical for the cold start target.

---

## Effort Estimates

| Task | Complexity | Estimate |
|---|---|---|
| Task 1: Event Feed Enhancements (virtual scroll) | M | 4-6 hours |
| Task 2: Usage Analytics Enhancements (cache, semaphore) | S | 2-3 hours |
| Task 3: Timeline & Monthly Enhancements | M | 4-6 hours |
| Task 4: SSE Live Streaming | L | 6-8 hours |
| Task 5: System Prompt Filtering | M | 4-6 hours |
| Task 6: Agent Status Panel | L | 8-10 hours |
| Task 7: Agent Interaction Panel | L | 8-10 hours |
| Task 8: Lifecycle Management | M | 4-6 hours |
| Task 9: Hook & Deploy Integration | M | 3-4 hours |
| Task 10: Tests | L | 8-10 hours |
| **Total** | | **~51-69 hours (~7-9 working days)** |
