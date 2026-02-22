# Story 12: Local Dashboard

## Overview

The Local Dashboard is a **single-file HTTP server** (Node.js, no npm dependencies) that provides a real-time web UI for the AgentContext daemon. It builds on the existing `gc-dashboard` implementation (~3000 lines) and enhances it with agent management, live event streaming, usage analytics, system prompt filtering, and agent interaction capabilities.

The dashboard is the primary human interface for the AgentContext system. It runs as a background process on the user's machine, serving an inline HTML/CSS/JS application over localhost. It connects to the event store for historical data and uses Server-Sent Events (SSE) for real-time updates. For agent management, it communicates with the daemon's agent orchestration layer (F3) to display agent status, send prompts, and approve permissions.

**Guiding principle**: The dashboard is a read-mostly interface. It reads from the event store, reads agent state from the daemon, and only writes when the user explicitly interacts (sending prompts, approving permissions). All data rendering happens client-side; the server provides JSON APIs and SSE streams.

---

## Scope

### In Scope

- Enhanced `gc-dashboard` single-file Node.js HTTP server
- Event feed with rich per-event-type rendering (F4.1)
- Usage analytics: token usage per project, per model, per day (F4.2)
- Daily timeline: 30-day bar chart of token consumption (F4.3)
- Monthly views: filter and aggregate usage by month (F4.4)
- Per-project percentage: each project's share of total usage (F4.5)
- SSE live streaming for real-time event updates (F4.6)
- System prompt filtering: categorize system vs real prompts (F4.7)
- Agent status panel: live view of running agents (F4.8)
- Agent interaction: send prompts, approve permissions (F4.9)
- Auto-start/restart lifecycle management (F4.10)

### Out of Scope (Non-Goals)

- Encrypted cloud sync (F5 -- separate story)
- Mobile app or desktop app (F6, F7 -- separate stories)
- Multi-machine agent management (requires sync)
- Authentication or access control (localhost only)
- npm or external package dependencies
- WebSocket protocol (SSE is sufficient for server-to-client push)
- Modifying the event store (dashboard is read-only for events)
- MCP server integration (F3.9 -- separate story)

---

## Requirements

### 1. Event Feed (F4.1)

The event feed is the primary view of the dashboard. It displays captured events in a table with rich formatting per event type.

#### Specification

- **Location**: Main content area of the dashboard, accessible via the "Events" tab
- **Data source**: `GET /api/events?project={id}&session={id}&from={seq}`
- **Rendering**: Client-side HTML generation from JSON event data
- **Default view**: Most recent session of the most recent project, auto-scrolled to bottom

#### Per-Event-Type Rendering

Each event type has a dedicated renderer that extracts the most relevant information from the event payload and presents it in a human-readable format.

| Event Type | Rendering |
|---|---|
| `SessionStarted` | Green play icon, model name badge, working directory path |
| `SessionEnded` | Grey stop icon, session ended label |
| `UserPromptReceived` | Speech bubble icon, truncated prompt text (300 chars max), system prompt detection (see F4.7) |
| `ToolCallRequested` | Tool-specific icon (file for Read, pencil for Write/Edit, terminal for Bash, magnifier for Grep/Glob, globe for WebFetch/WebSearch, robot for Task), tool input summary |
| `ToolCallCompleted` | Tool-specific output summary (line count for Read, "completed" for Write/Edit, exit code + output preview for Bash, match count for Grep/Glob) |
| `ToolCallFailed` | Red X icon, tool name, error message |
| `AgentSpawned` | Robot icon, agent type badge, agent ID, description |
| `AgentCompleted` | Robot icon, agent type, "completed" badge |
| `TurnCompleted` | Grey label, optional response preview |
| `CompactionTriggered` | Warning triangle icon, "Compaction triggered" with trigger type (manual/auto) |

#### Event Feed Table Structure

```html
<table class="event-feed-table">
  <thead>
    <tr>
      <th class="col-seq">#</th>
      <th class="col-time">Time</th>
      <th class="col-type">Type</th>
      <th class="col-summary">Summary</th>
    </tr>
  </thead>
  <tbody id="event-rows">
    <!-- Dynamically generated rows -->
  </tbody>
</table>
```

#### Pagination and Virtual Scrolling

Events are loaded in pages of 100. When the user scrolls to the top, the previous page is fetched. The DOM retains at most 500 event rows; older rows are removed from the DOM but can be re-fetched.

```javascript
// Virtual scrolling: load more events when scrolling near the top
feedEl.addEventListener('scroll', () => {
  if (feedEl.scrollTop < 200 && !state.loadingMore && state.oldestSeq > 1) {
    state.loadingMore = true;
    const toSeq = state.oldestSeq;
    const fromSeq = Math.max(1, toSeq - 100);
    loadEvents(state.selectedProject, state.selectedSession, fromSeq, toSeq)
      .then(events => {
        prependEvents(events);
        state.oldestSeq = fromSeq;
        state.loadingMore = false;
      });
  }
});
```

#### Filter Controls

The event feed supports filtering by:

- **Project**: Dropdown of all projects
- **Session**: Dropdown of sessions within the selected project
- **Event type**: Multi-select checkboxes for each event type
- **Date range**: Start and end date pickers
- **System prompts**: Toggle to show/hide system-injected messages (see F4.7)

```html
<div class="filter-bar">
  <select id="filter-project" onchange="onProjectFilter(this.value)">
    <option value="">All Projects</option>
  </select>
  <select id="filter-session" onchange="onSessionFilter(this.value)">
    <option value="">All Sessions</option>
  </select>
  <div class="filter-types" id="filter-types">
    <!-- Checkbox per event type -->
  </div>
  <input type="date" id="filter-date-start" onchange="applyFilters()">
  <input type="date" id="filter-date-end" onchange="applyFilters()">
  <label class="filter-toggle">
    <input type="checkbox" id="filter-system" checked onchange="applyFilters()">
    Show system prompts
  </label>
</div>
```

#### API Endpoint

```
GET /api/events?project={project_id}&session={session_id}&from={sequence}&limit={count}
```

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `project` | string | yes | -- | Project ID |
| `session` | string | yes | -- | Session ID |
| `from` | integer | no | 0 | Return events with sequence > from |
| `limit` | integer | no | 100 | Maximum events to return |

Response: Array of event envelope objects with `_summary` field added containing `{ text, html }` for rendering.

#### Acceptance Criteria

- [ ] Event feed displays events for a selected project/session
- [ ] Each of the 10 event types has a dedicated renderer with appropriate icons and formatting
- [ ] Tool call events show tool-specific input/output summaries (Bash shows command + exit code, Read shows file path + line count, etc.)
- [ ] Pagination loads events in pages of 100
- [ ] Virtual scrolling keeps at most 500 rows in the DOM
- [ ] Scrolling to the top triggers loading of older events
- [ ] New events arriving via SSE are appended to the bottom with a fade-in animation
- [ ] Filter by project, session, event type, and date range all work correctly
- [ ] Filters can be combined (e.g., only ToolCallCompleted events for a specific project in the last 7 days)

---

### 2. Usage Analytics (F4.2)

Token usage analytics provide insight into how much each project, model, and time period consumes. Data is derived from Claude's JSONL transcript files stored in `~/.claude/projects/`.

#### Specification

- **Data source**: JSONL transcript files in `~/.claude/projects/{project-dir}/`
- **Parsing**: Stream-parse JSONL files, extract `type: "assistant"` entries with `message.usage`
- **Aggregation levels**: Per-session, per-project, per-model, per-day, per-month
- **Caching**: File-size-based cache (`filepath:filesize` key) to avoid re-parsing unchanged files

#### Token Categories

| Category | JSONL Field | Description |
|---|---|---|
| Input tokens | `message.usage.input_tokens` | Tokens sent to the model |
| Output tokens | `message.usage.output_tokens` | Tokens generated by the model |
| Cache read tokens | `message.usage.cache_read_input_tokens` | Tokens read from prompt cache |
| Cache create tokens | `message.usage.cache_creation_input_tokens` | Tokens written to prompt cache |

#### Usage API Endpoints

```
GET /api/usage
```

Returns usage data for all projects. Response is an array of project usage objects.

```
GET /api/usage?project={project_id}
```

Returns usage data for a single project. Response is a single project usage object.

#### Project Usage Object Schema

```json
{
  "project_id": "my-project-a3f7b2",
  "project_name": "my-project",
  "claude_dir": "-home-meywd-my-project",
  "sessions": [
    {
      "session_id": "abc123",
      "api_calls": 42,
      "input_tokens": 150000,
      "output_tokens": 30000,
      "cache_read_tokens": 100000,
      "cache_create_tokens": 5000,
      "model": "claude-opus-4-6",
      "started_at": "2026-02-21T10:00:00Z",
      "last_api_call_at": "2026-02-21T11:30:00Z"
    }
  ],
  "totals": {
    "api_calls": 200,
    "input_tokens": 500000,
    "output_tokens": 100000,
    "cache_read_tokens": 300000,
    "cache_create_tokens": 20000
  },
  "weekly": {
    "input_tokens": 150000,
    "output_tokens": 30000,
    "cache_read_tokens": 100000,
    "cache_create_tokens": 5000
  },
  "by_model": {
    "claude-opus-4-6": {
      "input_tokens": 400000,
      "output_tokens": 80000,
      "cache_read_tokens": 250000,
      "cache_create_tokens": 15000,
      "api_calls": 150
    }
  },
  "daily": [
    {
      "date": "2026-02-21",
      "input_tokens": 50000,
      "output_tokens": 10000,
      "cache_read_tokens": 30000,
      "cache_create_tokens": 2000,
      "api_calls": 20
    }
  ],
  "monthly": [
    {
      "month": "2026-02",
      "input_tokens": 500000,
      "output_tokens": 100000,
      "cache_read_tokens": 300000,
      "cache_create_tokens": 20000,
      "api_calls": 200
    }
  ]
}
```

#### Cache Strategy

JSONL transcript files are large (hundreds of MB) and appended to frequently. The cache strategy avoids re-parsing entire files when only new lines have been appended.

```javascript
// Cache key: filepath + file size
const usageCache = new Map();

async function getFileUsage(filePath) {
  const st = await stat(filePath);
  const cacheKey = filePath + ':' + st.size;

  if (usageCache.has(cacheKey)) {
    return usageCache.get(cacheKey);
  }

  const result = await parseTranscriptFile(filePath);
  usageCache.set(cacheKey, result);
  return result;
}
```

When the file grows (new lines appended), `st.size` changes, invalidating the cache. The file is re-parsed from scratch. Future optimization could use byte-offset-based incremental parsing.

#### Cost Estimation

The dashboard estimates costs using published Anthropic pricing. Pricing is defined as a client-side constant map:

```javascript
const MODEL_PRICING = {
  'claude-opus-4-6':     { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreate: 18.75 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-haiku-3-5':    { input: 0.8, output: 4.0, cacheRead: 0.08, cacheCreate: 1.0 },
};

function calcCost(input, output, cacheRead, cacheCreate, model) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-20250514'];
  return (input * p.input + output * p.output +
          cacheRead * p.cacheRead + cacheCreate * p.cacheCreate) / 1_000_000;
}
```

#### Acceptance Criteria

- [ ] Usage analytics are derived from Claude JSONL transcript files
- [ ] Token usage is broken down by input, output, cache read, and cache create categories
- [ ] Aggregation works at per-session, per-project, per-model, per-day, and per-month levels
- [ ] File-size-based caching avoids re-parsing unchanged transcript files
- [ ] Cost estimation uses published Anthropic pricing per model
- [ ] Usage API returns data for all projects or a single project
- [ ] Cache is pre-warmed on server start to avoid slow first load
- [ ] Concurrent file parsing is limited to 8 files at a time to avoid file descriptor exhaustion

---

### 3. Daily Timeline (F4.3)

A 30-day bar chart showing daily token consumption. Each bar is stacked to show the breakdown by token type.

#### Specification

- **Chart type**: Vertical stacked bar chart
- **Time range**: Last 30 days by default, adjustable
- **Bar segments**: Input tokens (blue), output tokens (green), cache read tokens (purple), cache create tokens (orange)
- **Interactivity**: Click a bar to filter the event feed to that specific day
- **Rendering**: Pure CSS/HTML (no charting library), using CSS grid for bar positioning

#### Bar Chart HTML Structure

```html
<div class="timeline-chart" id="timeline-chart">
  <div class="timeline-bars">
    <!-- One bar per day -->
    <div class="timeline-bar" data-date="2026-02-21" style="--height: 85%"
         onclick="filterEventsToDate('2026-02-21')">
      <div class="bar-segment bar-input" style="--seg-height: 40%"></div>
      <div class="bar-segment bar-output" style="--seg-height: 20%"></div>
      <div class="bar-segment bar-cache-read" style="--seg-height: 30%"></div>
      <div class="bar-segment bar-cache-create" style="--seg-height: 10%"></div>
      <div class="bar-tooltip">
        <div>Feb 21, 2026</div>
        <div>Input: 50K</div>
        <div>Output: 10K</div>
        <div>Cache: 30K read, 2K create</div>
        <div>Est. cost: $1.23</div>
      </div>
    </div>
  </div>
  <div class="timeline-labels">
    <!-- Date labels for every 5th day -->
  </div>
</div>
```

#### Bar Chart CSS

```css
.timeline-chart {
  height: 200px;
  padding: 8px 0;
  position: relative;
}

.timeline-bars {
  display: flex;
  align-items: flex-end;
  height: 180px;
  gap: 2px;
  padding: 0 4px;
}

.timeline-bar {
  flex: 1;
  display: flex;
  flex-direction: column-reverse;
  height: var(--height);
  cursor: pointer;
  border-radius: 2px 2px 0 0;
  position: relative;
  min-width: 4px;
  transition: opacity 0.15s;
}

.timeline-bar:hover { opacity: 0.8; }
.timeline-bar.selected { outline: 2px solid var(--accent); }

.bar-segment { width: 100%; }
.bar-input { background: var(--accent); height: var(--seg-height); }
.bar-output { background: var(--green); height: var(--seg-height); }
.bar-cache-read { background: var(--purple); height: var(--seg-height); }
.bar-cache-create { background: var(--orange); height: var(--seg-height); }

.bar-tooltip {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg3);
  border: 1px solid var(--border);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
  z-index: 10;
  pointer-events: none;
}

.timeline-bar:hover .bar-tooltip { display: block; }
```

#### Chart Data Computation

```javascript
function buildTimelineData(usageData, days = 30) {
  const now = new Date();
  const dailyMap = new Map();

  // Initialize all days in range
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    dailyMap.set(key, { date: key, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  }

  // Aggregate from all projects
  for (const project of usageData) {
    for (const day of project.daily || []) {
      if (dailyMap.has(day.date)) {
        const d = dailyMap.get(day.date);
        d.input += day.input_tokens;
        d.output += day.output_tokens;
        d.cacheRead += day.cache_read_tokens;
        d.cacheCreate += day.cache_create_tokens;
      }
    }
  }

  // Sort ascending by date
  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}
```

#### Acceptance Criteria

- [ ] 30-day bar chart is rendered using pure CSS/HTML (no external charting library)
- [ ] Bars are stacked with segments for input, output, cache read, and cache create tokens
- [ ] Bar heights are proportional to the maximum day's total tokens
- [ ] Hovering a bar shows a tooltip with the date and token breakdown
- [ ] Clicking a bar filters the event feed to show only events from that day
- [ ] The selected bar is visually highlighted with an outline
- [ ] Days with zero usage show no bar (or a minimal 1px baseline)
- [ ] A legend identifies the color coding for each token type
- [ ] The chart is responsive and adjusts bar widths to the available space

---

### 4. Monthly Views (F4.4)

Monthly views allow the user to filter all usage data by a specific month and compare month-over-month consumption.

#### Specification

- **Filter UI**: Horizontal row of month buttons, one per month with data
- **Default**: "All Time" is selected (no month filter)
- **Effect**: Selecting a month filters the per-project table, per-model table, and daily timeline to that month only
- **Comparison**: Adjacent months show delta indicators (up/down arrows with percentage change)

#### Month Filter Bar

```html
<div class="month-filter" id="month-filter">
  <button class="month-btn active" data-month="" onclick="setMonth(null)">All Time</button>
  <button class="month-btn" data-month="2026-01" onclick="setMonth('2026-01')">Jan 2026</button>
  <button class="month-btn" data-month="2026-02" onclick="setMonth('2026-02')">Feb 2026</button>
</div>
```

#### Month-Over-Month Comparison

When a specific month is selected, the dashboard shows a comparison panel:

```html
<div class="month-comparison">
  <div class="month-stat">
    <span class="stat-label">Total Tokens</span>
    <span class="stat-value">1.2M</span>
    <span class="stat-delta delta-up">+15% vs Jan</span>
  </div>
  <div class="month-stat">
    <span class="stat-label">Est. Cost</span>
    <span class="stat-value">$45.20</span>
    <span class="stat-delta delta-down">-8% vs Jan</span>
  </div>
  <div class="month-stat">
    <span class="stat-label">Sessions</span>
    <span class="stat-value">87</span>
    <span class="stat-delta delta-up">+23% vs Jan</span>
  </div>
</div>
```

```css
.month-comparison {
  display: flex;
  gap: 24px;
  padding: 12px 0;
}

.month-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label { font-size: 11px; color: var(--text2); }
.stat-value { font-size: 18px; font-weight: 600; }
.stat-delta { font-size: 11px; }
.delta-up { color: var(--red); }    /* More spending = red */
.delta-down { color: var(--green); } /* Less spending = green */
.delta-neutral { color: var(--text2); }
```

#### Acceptance Criteria

- [ ] Month buttons are generated dynamically from available data
- [ ] "All Time" button shows unfiltered data
- [ ] Selecting a month filters per-project, per-model, and daily timeline views
- [ ] Month-over-month comparison shows delta percentage for tokens, cost, and sessions
- [ ] Delta indicators use color coding: red for increase, green for decrease
- [ ] If the previous month has no data, the comparison shows "N/A" instead of a percentage
- [ ] The selected month button is visually highlighted

---

### 5. Per-Project Percentage (F4.5)

Each project's share of total usage is displayed as a percentage badge in the project list and the usage table.

#### Specification

- **Calculation**: `project_total_tokens / grand_total_tokens * 100`
- **Display**: Percentage badge next to the project name in the usage table
- **Sidebar badge**: Percentage shown in the project sidebar for quick reference
- **Token total**: Sum of input + output + cache read + cache create tokens

#### Usage Table with Percentages

```html
<table class="usage-table">
  <thead>
    <tr>
      <th></th>
      <th>Project</th>
      <th class="num">%</th>
      <th class="num">Sessions</th>
      <th class="num">Input</th>
      <th class="num">Output</th>
      <th class="num">Cache Read</th>
      <th class="num">Cache Create</th>
      <th class="num">Est. Cost</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><button class="expand-btn" data-pid="my-project-a3f7b2">[+]</button></td>
      <td class="project-name">my-project</td>
      <td class="num"><span class="pct-badge">42.3%</span></td>
      <td class="num">15</td>
      <td class="num">500K</td>
      <td class="num">100K</td>
      <td class="num">300K</td>
      <td class="num">20K</td>
      <td class="num cost-high">$12.50</td>
    </tr>
  </tbody>
</table>
```

#### Percentage Badge CSS

```css
.pct-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(88, 166, 255, 0.15);
  color: var(--accent);
}

.sidebar-pct {
  font-size: 10px;
  color: var(--text2);
  margin-left: 4px;
}
```

#### Acceptance Criteria

- [ ] Each project shows a percentage badge in the usage table
- [ ] Percentages are calculated as `project_tokens / total_tokens * 100`
- [ ] Percentages are displayed with one decimal place (e.g., "42.3%")
- [ ] The grand total row shows "100%"
- [ ] When a month filter is active, percentages are recalculated for that month only
- [ ] Projects with 0% usage (after month filtering) are hidden from the table
- [ ] Percentage badges appear in both the usage table and the project sidebar

---

### 6. SSE Live Streaming (F4.6)

Server-Sent Events (SSE) provide real-time event updates to the browser without polling. When new events are captured by the hook system, they appear in the dashboard within 2 seconds.

#### Specification

- **Protocol**: Server-Sent Events (SSE) over HTTP
- **Endpoint**: `GET /api/stream?project={id}&session={id}&from={seq}`
- **Poll interval**: Server polls the event store every 2 seconds for new events
- **Reconnection**: Browser EventSource auto-reconnects; server sends keepalive comments every 30 seconds

#### Server-Side SSE Implementation

```javascript
// Server-side: SSE endpoint
if (pathname === '/api/stream') {
  const projectId = url.searchParams.get('project');
  const sessionId = url.searchParams.get('session');
  if (!projectId || !sessionId) {
    return sendJson(res, { error: 'project and session params required' }, 400);
  }

  // Disable Node.js response buffering for SSE
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

  req.on('close', () => { alive = false; });

  // Send initial keepalive
  res.write(':ok\n\n');

  const poll = async () => {
    if (!alive) return;
    try {
      const events = await readEvents(projectId, sessionId, lastSeq);
      for (const event of events) {
        if (!alive) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.sequence > lastSeq) lastSeq = event.sequence;
      }
    } catch { /* ignore errors, keep polling */ }

    // Send keepalive comment every 30 seconds
    if (alive) res.write(':keepalive\n\n');
    if (alive) setTimeout(poll, 2000);
  };

  poll();
  return;
}
```

#### Client-Side SSE Connection

```javascript
let eventSource = null;

function connectSSE(projectId, sessionId, fromSeq) {
  if (eventSource) {
    eventSource.close();
  }

  const url = '/api/stream?project=' + encodeURIComponent(projectId) +
    '&session=' + encodeURIComponent(sessionId) +
    '&from=' + fromSeq;

  eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      appendEvent(event);
      updateHeaderStatus('live');
    } catch { /* skip malformed SSE data */ }
  };

  eventSource.onerror = () => {
    updateHeaderStatus('reconnecting');
    // EventSource auto-reconnects with exponential backoff
  };

  eventSource.onopen = () => {
    updateHeaderStatus('live');
  };
}

function updateHeaderStatus(status) {
  const dot = document.querySelector('.header .dot');
  const label = document.querySelector('.header .status-label');
  if (status === 'live') {
    dot.className = 'dot live';
    label.textContent = 'Live';
  } else if (status === 'reconnecting') {
    dot.className = 'dot reconnecting';
    label.textContent = 'Reconnecting...';
  } else {
    dot.className = 'dot';
    label.textContent = 'Disconnected';
  }
}
```

#### SSE Protocol Details

The SSE stream follows the standard W3C Server-Sent Events protocol:

```
:ok                        <-- Initial comment (keepalive)

data: {"event_id":"...","event_type":"ToolCallRequested",...}

data: {"event_id":"...","event_type":"ToolCallCompleted",...}

:keepalive                 <-- Every 30 seconds

data: {"event_id":"...","event_type":"UserPromptReceived",...}
```

- Lines starting with `:` are comments (used for keepalive, ignored by EventSource)
- `data:` lines contain the JSON payload
- Each message is terminated by a blank line (`\n\n`)
- The browser's `EventSource` API handles reconnection automatically
- `retry:` can be sent to control reconnection delay: `retry: 3000\n\n` (3 seconds)

#### Acceptance Criteria

- [ ] SSE endpoint at `/api/stream` streams new events as they are captured
- [ ] SSE uses the standard `text/event-stream` content type
- [ ] Server polls the event store every 2 seconds for new events
- [ ] Keepalive comments (`:keepalive`) are sent every 30 seconds to prevent connection timeout
- [ ] Client uses the browser's native `EventSource` API
- [ ] Auto-reconnection works when the connection drops (EventSource handles this natively)
- [ ] The dashboard header shows connection status: green dot for live, grey for reconnecting
- [ ] New events arriving via SSE are appended to the event feed with a fade-in animation
- [ ] When switching sessions, the old SSE connection is closed and a new one is opened
- [ ] Server cleans up resources when the client disconnects (`req.on('close')`)

---

### 7. System Prompt Filtering (F4.7)

Claude Code injects system messages into the user prompt stream (task notifications, system reminders, skill invocations). These should be visually distinguished from real user prompts and optionally filtered out.

#### Specification

- **Detection**: Parse the prompt text for known system message patterns
- **Categories**: Task notification (`<task-notification>`), system reminder (`<system-reminder>`), skill invocation (`<command-name>`), metadata (`<task-id>`, `<output-file>`)
- **Visual treatment**: System messages get a distinct visual style (grey background, gear icon, smaller text)
- **Filter toggle**: "Show system prompts" checkbox in the filter bar

#### System Message Detection Logic

```javascript
function categorizePrompt(promptText) {
  const trimmed = promptText.trimStart();

  if (trimmed.startsWith('<task-notification>')) {
    // Extract task-id, status, summary from XML
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

#### System Message Rendering

```html
<!-- Task notification -->
<div class="ev-sysmsg ev-sysmsg-task">
  <span class="ev-sysmsg-icon">&#129302;</span>
  <span class="ev-sysmsg-label">Task</span>
  <span class="ev-code">task-abc123</span>
  <span class="ev-systask-status ev-systask-status-completed">completed</span>
  <span class="ev-output">Implemented the feature as requested</span>
</div>

<!-- System reminder -->
<div class="ev-sysmsg ev-sysmsg-reminder">
  <span class="ev-sysmsg-icon">&#9881;</span>
  <span class="ev-sysmsg-label">System Reminder</span>
  <span class="ev-output">As you answer the user's questions, you can use the following context...</span>
</div>

<!-- Real user prompt -->
<span class="ev-prompt-icon">&#128172;</span>
<span class="ev-prompt">Write a function that sorts the array in descending order</span>
```

```css
.ev-sysmsg {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ev-sysmsg-task { background: rgba(188, 140, 255, 0.08); }
.ev-sysmsg-reminder { background: rgba(139, 148, 158, 0.08); }
.ev-sysmsg-meta { background: rgba(139, 148, 158, 0.06); }

.ev-sysmsg-icon { font-size: 14px; opacity: 0.7; }
.ev-sysmsg-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text2);
}

/* Task notification status badges */
.ev-systask-status-completed { color: var(--green); }
.ev-systask-status-inprogress { color: var(--yellow); }
.ev-systask-status-failed { color: var(--red); }
.ev-systask-status-other { color: var(--text2); }

/* When system prompts are hidden */
.event-feed tr.system-prompt.hidden { display: none; }
```

#### Acceptance Criteria

- [ ] Task notifications (`<task-notification>`) are detected and rendered with robot icon, task ID, status badge, and summary
- [ ] System reminders (`<system-reminder>`) are rendered with gear icon and truncated preview
- [ ] System metadata messages (`<task-id>`, `<output-file>`, `<command-name>`) are rendered with gear icon and tag label
- [ ] Real user prompts are rendered with speech bubble icon and full text
- [ ] System messages have a visually distinct style (muted background, smaller labels)
- [ ] "Show system prompts" toggle in the filter bar hides/shows system messages
- [ ] The default is system prompts visible (checkbox checked)
- [ ] System prompt count is shown in the filter bar (e.g., "3 system, 12 user")

---

### 8. Agent Status Panel (F4.8)

The Agent Status Panel provides a live view of all running agents with their lifecycle state, metadata, and current activity. This requires communication with the daemon's agent orchestration layer.

#### Specification

- **Tab**: "Agents" tab in the main header, alongside "Events" and "Usage"
- **Data source**: `GET /api/agents` (queries the daemon's agent manager)
- **Refresh**: SSE stream for real-time agent state updates, or polling every 3 seconds
- **Lifecycle states**: `initializing`, `idle`, `running`, `error`, `closed`

#### Agent Manager Integration

The dashboard communicates with the agent orchestration layer (F3) to retrieve agent state. Since both the dashboard and the agent manager run within the same daemon process, they share memory. If the dashboard is running standalone (without the full daemon), agent data comes from a REST API.

```javascript
// Agent API endpoint
if (pathname === '/api/agents') {
  const agents = await getAgentList();
  return sendJson(res, agents);
}

async function getAgentList() {
  // If running inside daemon, access AgentManager directly
  if (globalThis.agentManager) {
    return globalThis.agentManager.listAgents();
  }
  // Standalone mode: try to connect to daemon API
  try {
    const daemonPort = await readDaemonPort();
    const resp = await fetch(`http://localhost:${daemonPort}/api/agents`);
    return resp.json();
  } catch {
    return [];
  }
}
```

#### Agent Object Schema

```json
{
  "agent_id": "agent-abc123",
  "provider": "claude-code",
  "model": "claude-opus-4-6",
  "status": "running",
  "cwd": "/home/user/my-project",
  "project_name": "my-project",
  "started_at": "2026-02-21T10:00:00Z",
  "uptime_seconds": 3600,
  "last_activity": "ToolCallCompleted: Write /src/index.ts",
  "current_task": "Implementing the dashboard story specification",
  "permissions_pending": 0,
  "turn_count": 15,
  "token_usage": {
    "input_tokens": 150000,
    "output_tokens": 30000
  }
}
```

#### Agent Status Panel UI

```html
<div class="agents-view" id="agents-view">
  <div class="agents-header">
    <span class="agents-title">Active Agents</span>
    <span class="agents-count">3 running</span>
  </div>

  <div class="agent-cards" id="agent-cards">
    <!-- One card per agent -->
    <div class="agent-card agent-status-running">
      <div class="agent-card-header">
        <span class="agent-status-dot status-running"></span>
        <span class="agent-provider">claude-code</span>
        <span class="agent-model">claude-opus-4-6</span>
        <span class="agent-uptime">1h 23m</span>
      </div>
      <div class="agent-card-body">
        <div class="agent-project">my-project</div>
        <div class="agent-cwd">/home/user/my-project</div>
        <div class="agent-activity">Write /src/index.ts (3s ago)</div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-turns">15 turns</span>
        <span class="agent-tokens">150K in / 30K out</span>
        <button class="agent-btn" onclick="openAgentInteraction('agent-abc123')">Interact</button>
      </div>
    </div>
  </div>
</div>
```

#### Color-Coded Status Indicators

```css
.agent-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.status-initializing { background: var(--yellow); animation: pulse 1.5s infinite; }
.status-idle { background: var(--accent); }
.status-running { background: var(--green); animation: pulse 2s infinite; }
.status-error { background: var(--red); }
.status-closed { background: var(--text2); }

.agent-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
  transition: border-color 0.15s;
}

.agent-card.agent-status-running { border-left: 3px solid var(--green); }
.agent-card.agent-status-idle { border-left: 3px solid var(--accent); }
.agent-card.agent-status-error { border-left: 3px solid var(--red); }
.agent-card.agent-status-initializing { border-left: 3px solid var(--yellow); }
.agent-card.agent-status-closed { border-left: 3px solid var(--text2); opacity: 0.6; }
```

#### Agent SSE Stream

```
GET /api/agents/stream
```

Streams agent state changes in real-time:

```
data: {"type":"agent_state_change","agent_id":"agent-abc123","status":"running","last_activity":"ToolCallCompleted: Write /src/index.ts"}

data: {"type":"agent_state_change","agent_id":"agent-abc123","status":"idle","last_activity":"TurnCompleted"}

data: {"type":"agent_added","agent":{"agent_id":"agent-def456","provider":"claude-code","status":"initializing",...}}

data: {"type":"agent_removed","agent_id":"agent-ghi789"}
```

#### Acceptance Criteria

- [ ] Agent status panel is accessible via the "Agents" tab
- [ ] All running agents are displayed as cards with provider, model, status, cwd, and uptime
- [ ] Status indicators are color-coded: green (running), blue (idle), yellow (initializing), red (error), grey (closed)
- [ ] Agent activity updates in real-time via SSE or 3-second polling
- [ ] Each agent card shows turn count and token usage
- [ ] Agents with pending permissions show a notification badge
- [ ] The "Interact" button on each agent card opens the agent interaction panel (F4.9)
- [ ] When no agents are running, an empty state message is shown: "No agents running. Start a Claude Code session to see agents here."
- [ ] Agent cards are sorted by status (running first, then idle, then others)

---

### 9. Agent Interaction (F4.9)

The Agent Interaction panel allows users to send prompts to agents, approve permissions, and view streaming output -- all from the dashboard.

#### Specification

- **Panel type**: Slide-in panel on the right side, or full-width view
- **Data flow**: Dashboard -> daemon HTTP API -> agent process
- **Prompt sending**: POST to daemon API, response streamed back via SSE
- **Permission approval**: Approve/deny buttons trigger POST to daemon API

#### Agent Interaction Panel UI

```html
<div class="agent-interaction" id="agent-interaction" style="display:none">
  <div class="interaction-header">
    <button class="back-btn" onclick="closeInteraction()">Back</button>
    <span class="interaction-title">Agent: claude-code (my-project)</span>
    <span class="agent-status-dot status-running"></span>
  </div>

  <!-- Permission requests -->
  <div class="permissions-panel" id="permissions-panel" style="display:none">
    <div class="permission-card">
      <div class="permission-type">File Write</div>
      <div class="permission-detail">/src/components/Header.tsx</div>
      <div class="permission-actions">
        <button class="perm-approve" onclick="approvePermission('perm-123')">Approve</button>
        <button class="perm-deny" onclick="denyPermission('perm-123')">Deny</button>
        <button class="perm-approve-all" onclick="approveAllPermissions()">Approve All</button>
      </div>
    </div>
  </div>

  <!-- Streaming output -->
  <div class="interaction-output" id="interaction-output">
    <!-- Real-time agent output rendered here -->
  </div>

  <!-- Prompt input -->
  <div class="interaction-input">
    <textarea id="agent-prompt" placeholder="Send a prompt to this agent..."
              onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendPrompt();}"></textarea>
    <button class="send-btn" onclick="sendPrompt()">Send</button>
  </div>
</div>
```

#### Send Prompt API

```
POST /api/agents/{agent_id}/prompt
Content-Type: application/json

{
  "prompt": "Please add error handling to the main function"
}
```

Response: SSE stream of agent output

```
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"type":"text","content":"I'll add error handling to the main function. Let me "}
data: {"type":"text","content":"first read the current implementation..."}
data: {"type":"tool_use","tool":"Read","input":{"file_path":"/src/main.ts"}}
data: {"type":"tool_result","tool":"Read","output":"(file contents...)"}
data: {"type":"text","content":"Now I'll add try-catch blocks..."}
data: {"type":"done","turn_id":"turn-123"}
```

#### Permission Handling API

```
POST /api/agents/{agent_id}/permission
Content-Type: application/json

{
  "permission_id": "perm-123",
  "action": "approve"
}
```

```
POST /api/agents/{agent_id}/permission
Content-Type: application/json

{
  "permission_id": "perm-123",
  "action": "deny"
}
```

#### Streaming Output Rendering

```javascript
function connectAgentStream(agentId) {
  const outputEl = document.getElementById('interaction-output');

  const source = new EventSource('/api/agents/' + agentId + '/stream');

  source.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case 'text':
        appendText(outputEl, msg.content);
        break;
      case 'tool_use':
        appendToolCall(outputEl, msg.tool, msg.input);
        break;
      case 'tool_result':
        appendToolResult(outputEl, msg.tool, msg.output);
        break;
      case 'permission_request':
        showPermissionRequest(msg);
        break;
      case 'done':
        markTurnComplete(outputEl);
        break;
      case 'error':
        appendError(outputEl, msg.message);
        break;
    }

    outputEl.scrollTop = outputEl.scrollHeight;
  };

  return source;
}
```

```css
.agent-interaction {
  position: fixed;
  right: 0;
  top: 48px;
  bottom: 0;
  width: 50%;
  min-width: 400px;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 100;
}

.interaction-header {
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.interaction-output {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.5;
}

.interaction-input {
  border-top: 1px solid var(--border);
  padding: 8px;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.interaction-input textarea {
  flex: 1;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  padding: 8px;
  resize: none;
  min-height: 40px;
  max-height: 120px;
}

.send-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 8px 16px;
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
}

.send-btn:hover { opacity: 0.9; }
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.permission-card {
  background: rgba(210, 153, 34, 0.1);
  border: 1px solid rgba(210, 153, 34, 0.3);
  border-radius: 6px;
  padding: 12px;
  margin: 8px 0;
}

.permission-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.perm-approve {
  background: var(--green);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
}

.perm-deny {
  background: var(--red);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
}

.perm-approve-all {
  background: var(--bg3);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
}
```

#### Acceptance Criteria

- [ ] Agent interaction panel opens when clicking "Interact" on an agent card
- [ ] Users can type prompts in the textarea and send with Enter or the Send button
- [ ] Agent responses are streamed in real-time via SSE
- [ ] Tool calls are rendered inline with the same formatting as the event feed
- [ ] Permission requests appear as cards with Approve, Deny, and Approve All buttons
- [ ] Approve/Deny actions are sent to the daemon API and the permission card is removed on response
- [ ] The output panel auto-scrolls to the bottom as new content arrives
- [ ] The Send button is disabled while a turn is in progress
- [ ] Shift+Enter inserts a newline instead of sending
- [ ] The panel can be closed with the Back button
- [ ] If the agent is not running, the interaction panel shows a disabled state with message

---

### 10. Auto-Start/Restart (F4.10)

The dashboard starts automatically on the first session and restarts on install/upgrade.

#### Specification

- **Trigger**: The `gc-hook` script (or daemon startup) starts the dashboard if it is not running
- **PID file**: `~/.claude-context/.dashboard.pid` contains `{pid}\n{port}\n`
- **Port selection**: Default 4000, configurable via `--port` flag or `~/.claude-context/.dashboard-config.json`
- **Lifecycle commands**: `gc-dashboard start|stop|restart|status`
- **Enabled marker**: `~/.claude-context/.dashboard-enabled` file signals that the dashboard should be auto-started

#### PID File Management

```javascript
const PID_FILE = path.join(BASE, '.dashboard.pid');

function writePid() {
  try {
    writeFileSync(PID_FILE, `${process.pid}\n${port}\n`);
  } catch {}
}

function removePid() {
  try {
    unlinkSync(PID_FILE);
  } catch {}
}

function readPid() {
  try {
    const content = readFileSync(PID_FILE, 'utf-8').trim();
    const [pidStr, portStr] = content.split('\n');
    return { pid: parseInt(pidStr, 10), port: parseInt(portStr, 10) || 4000 };
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

#### Auto-Start on Session Hook

The `gc-hook` script checks for the `.dashboard-enabled` marker and starts the dashboard if it is not running:

```bash
# In gc-hook, after event capture:
DASHBOARD_ENABLED="$BASE_DIR/.dashboard-enabled"
DASHBOARD_PID="$BASE_DIR/.dashboard.pid"

if [ -f "$DASHBOARD_ENABLED" ]; then
  PORT=$(cat "$DASHBOARD_ENABLED" 2>/dev/null | head -1)
  PORT="${PORT:-4000}"

  # Check if already running
  if [ -f "$DASHBOARD_PID" ]; then
    PID=$(head -1 "$DASHBOARD_PID" 2>/dev/null)
    if kill -0 "$PID" 2>/dev/null; then
      : # Already running, do nothing
    else
      # Stale PID, restart
      nohup node "$BIN_DIR/gc-dashboard" --port "$PORT" >> "$BASE_DIR/.dashboard.log" 2>&1 &
    fi
  else
    # Not running, start
    nohup node "$BIN_DIR/gc-dashboard" --port "$PORT" >> "$BASE_DIR/.dashboard.log" 2>&1 &
  fi
fi
```

#### Restart on Install/Upgrade

The `deploy.sh` script (called by `gc-install` during upgrade) restarts the dashboard after updating scripts:

```bash
# In deploy.sh, after copying new scripts:
if [ -f "$BASE_DIR/.dashboard-enabled" ]; then
  echo "[deploy] Restarting dashboard..."
  node "$BIN_DIR/gc-dashboard" restart 2>/dev/null || true
  nohup node "$BIN_DIR/gc-dashboard" --port "$PORT" >> "$BASE_DIR/.dashboard.log" 2>&1 &
  echo "[deploy] Dashboard restarted."
fi
```

#### Port Selection Logic

```javascript
async function selectPort() {
  // 1. Check --port CLI flag
  const cliPort = parseCliPort();
  if (cliPort) return cliPort;

  // 2. Check .dashboard-config.json
  const config = await loadDashboardConfig();
  if (config.port) return config.port;

  // 3. Check .dashboard-enabled marker
  try {
    const marker = readFileSync(path.join(BASE, '.dashboard-enabled'), 'utf-8').trim();
    const markerPort = parseInt(marker, 10);
    if (markerPort > 0 && markerPort < 65536) return markerPort;
  } catch {}

  // 4. Default
  return 4000;
}
```

#### Lifecycle Command Implementations

| Command | Behavior |
|---|---|
| `gc-dashboard start` | Start if not running; print URL. If already running, print current URL. |
| `gc-dashboard stop` | Send SIGTERM to PID from `.dashboard.pid`. Wait up to 2s, then SIGKILL. Remove PID file. |
| `gc-dashboard restart` | Stop (if running) + Start. Used after upgrades. |
| `gc-dashboard status` | Read PID file, check if process is alive, print status and URL. |

#### Acceptance Criteria

- [ ] `gc-dashboard start` starts the HTTP server and writes the PID file
- [ ] `gc-dashboard stop` sends SIGTERM, waits, then SIGKILL if needed, removes PID file
- [ ] `gc-dashboard restart` performs stop+start atomically
- [ ] `gc-dashboard status` reports whether the dashboard is running and on which port
- [ ] PID file at `~/.claude-context/.dashboard.pid` contains `{pid}\n{port}\n`
- [ ] Auto-start is triggered by `gc-hook` when `.dashboard-enabled` exists
- [ ] Stale PID files (process no longer running) are cleaned up and the dashboard is restarted
- [ ] Port is configurable via `--port` flag, `.dashboard-config.json`, or `.dashboard-enabled`
- [ ] The dashboard restarts on install/upgrade via `deploy.sh`
- [ ] SIGINT and SIGTERM are handled gracefully (PID file removed on exit)
- [ ] Startup is logged to `~/.claude-context/.dashboard.log`

---

## Edge Cases

### E-1: Port Already in Use

**Scenario**: The user starts `gc-dashboard` but port 4000 is already occupied by another process.

**Expected behavior**: The `server.listen()` call fails with `EADDRINUSE`. The dashboard catches this error, logs a clear message with the conflicting port, and exits with code 1:

```
[gc-dashboard] ERROR: Port 4000 is already in use.
[gc-dashboard]   Another process is listening on this port.
[gc-dashboard]   Use --port to specify a different port:
[gc-dashboard]     gc-dashboard start --port 4001
```

**Mitigation**: The dashboard does NOT auto-increment the port. Using a predictable port is important because `gc-hook` needs to know where to find the dashboard. If the port changes silently, the `.dashboard-enabled` marker would be stale.

---

### E-2: Dashboard Process Orphaned (PID File Stale)

**Scenario**: The dashboard process was killed with `kill -9` (SIGKILL), which bypasses the signal handlers. The PID file remains but the process is dead.

**Expected behavior**: On next `gc-dashboard start` (or `gc-hook` auto-start), the PID file is read, `kill(pid, 0)` fails, the stale PID file is removed, and the dashboard starts normally.

```javascript
const info = readPid();
if (info && !isRunning(info.pid)) {
  // Stale PID file, clean up
  try { unlinkSync(PID_FILE); } catch {}
  // Proceed to start
}
```

---

### E-3: Large Event Store (Thousands of Sessions)

**Scenario**: A power user has thousands of sessions across dozens of projects. Listing all projects and sessions is slow.

**Expected behavior**: The `/api/projects` endpoint scans the `events/` directory and counts sessions per project. For very large stores, this directory scan could take seconds.

**Mitigation**:
- Project list is cached for 30 seconds (already implemented via periodic refresh)
- Session list is loaded lazily (only when a project is selected)
- Usage data is cached per file size
- The sidebar only renders visible items (no DOM virtualization needed for reasonable project counts)

---

### E-4: SSE Connection Drop During Network Change

**Scenario**: The user's machine changes network (e.g., WiFi reconnect), and the SSE connection drops.

**Expected behavior**: The browser's `EventSource` API handles reconnection automatically with exponential backoff. The dashboard header status indicator changes from green "Live" to grey "Reconnecting..." and back to green when reconnected.

**Risk**: If the reconnection takes a long time, the user may miss events. After reconnection, the SSE endpoint resumes from `lastSeq`, so no events are lost -- they are delivered on reconnect.

---

### E-5: Concurrent Dashboard Instances

**Scenario**: The user runs `gc-dashboard start` twice in rapid succession before the PID file is written by the first instance.

**Expected behavior**: The second instance checks for an existing PID file. If none exists yet, both instances attempt to `listen()` on the same port. The second one fails with `EADDRINUSE` (see E-1).

**Mitigation**: This is a race condition window of a few milliseconds. In practice, the PID file is written within milliseconds of the `listen` callback firing. The `EADDRINUSE` error is the safety net.

---

### E-6: No Agents Running (Standalone Dashboard)

**Scenario**: The dashboard is running but no Claude Code sessions are active. The Agent Status Panel has no agents to display.

**Expected behavior**: The Agents tab shows an empty state:

```html
<div class="empty-state">
  <div class="empty-icon">&#129302;</div>
  <div>No agents running</div>
  <div class="hint">Start a Claude Code session to see agents here.</div>
</div>
```

The dashboard continues to function normally for historical event browsing and usage analytics.

---

### E-7: Malformed JSONL Transcript Lines

**Scenario**: A Claude JSONL transcript file contains corrupted or non-JSON lines (e.g., from a crash mid-write).

**Expected behavior**: The JSONL parser (`parseTranscriptFile`) wraps each `JSON.parse()` in a try-catch and silently skips malformed lines:

```javascript
rl.on('line', (line) => {
  // Fast pre-filter
  if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) return;
  try {
    const entry = JSON.parse(line);
    if (entry.type !== 'assistant') return;
    // ... process
  } catch { /* skip malformed line */ }
});
```

No error is shown to the user. Usage totals may be slightly undercounted if valid lines were skipped, but this is acceptable.

---

### E-8: Permission Request Arrives While Interaction Panel Is Closed

**Scenario**: An agent requests permission (e.g., file write) but the user does not have the Agent Interaction panel open in the dashboard.

**Expected behavior**: The agent card in the Agent Status Panel shows a notification badge with the count of pending permissions:

```html
<span class="permission-badge">1</span>
```

```css
.permission-badge {
  background: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 8px;
  margin-left: 6px;
  animation: pulse 2s infinite;
}
```

The user can click "Interact" on the agent card to open the interaction panel and see the pending permission. The agent waits for approval (or times out per the agent provider's behavior).

---

### E-9: Dashboard Accessed From Non-Localhost

**Scenario**: Someone attempts to access the dashboard from a remote machine (e.g., `http://192.168.1.100:4000`).

**Expected behavior**: The HTTP server binds to `0.0.0.0` (all interfaces) by default for simplicity, so the request is served. However, the dashboard is designed for localhost use only and contains no authentication.

**Future mitigation**: A `--localhost-only` flag (or default behavior change) could bind to `127.0.0.1` instead of `0.0.0.0`. This is out of scope for this story but should be noted as a security consideration.

---

### E-10: Agent Interaction Prompt Sent to Closed Agent

**Scenario**: The user has the interaction panel open for an agent, but the agent's Claude Code session has ended (agent status is now `closed`).

**Expected behavior**: The `POST /api/agents/{agent_id}/prompt` endpoint returns a 409 Conflict:

```json
{
  "error": "Agent is not running",
  "status": "closed"
}
```

The dashboard shows a notification: "This agent is no longer running. Close this panel to return to the agent list."

---

## Technical Specifications

### File Locations

| File | Path | Purpose |
|------|------|---------|
| Dashboard script | `src/bin/gc-dashboard` (source tree) | Single-file Node.js HTTP server |
| Installed script | `~/.claude-context/bin/gc-dashboard` | Running location |
| PID file | `~/.claude-context/.dashboard.pid` | PID + port of running instance |
| Enabled marker | `~/.claude-context/.dashboard-enabled` | Signals auto-start; contains port |
| Config | `~/.claude-context/.dashboard-config.json` | Persisted settings (port, weekly_limit, etc.) |
| Log file | `~/.claude-context/.dashboard.log` | stdout/stderr when running as background process |

### HTTP API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve inline HTML dashboard |
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/sessions?project={id}` | List sessions for a project |
| `GET` | `/api/events?project={id}&session={id}&from={seq}&limit={n}` | Get events for a session |
| `GET` | `/api/usage` | Get usage for all projects |
| `GET` | `/api/usage?project={id}` | Get usage for one project |
| `GET` | `/api/usage/utilization` | Get Anthropic API utilization data |
| `GET` | `/api/config` | Get dashboard config |
| `POST` | `/api/config` | Update dashboard config |
| `GET` | `/api/stream?project={id}&session={id}&from={seq}` | SSE event stream |
| `GET` | `/api/agents` | List all agents with status |
| `GET` | `/api/agents/stream` | SSE agent state stream |
| `POST` | `/api/agents/{id}/prompt` | Send prompt to agent |
| `POST` | `/api/agents/{id}/permission` | Approve/deny permission |
| `GET` | `/api/agents/{id}/stream` | SSE agent output stream |

### Exit Codes

| Command | Exit Code | Meaning |
|---------|-----------|---------|
| `gc-dashboard start` | 0 | Server started successfully |
| `gc-dashboard start` | 1 | Failed to start (port in use, permissions, etc.) |
| `gc-dashboard stop` | 0 | Server stopped (or was not running) |
| `gc-dashboard status` | 0 | Status reported |

### Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `node` | >= 18.0 | HTTP server, ESM modules, `node:fs/promises` |
| `node:http` | built-in | HTTP server |
| `node:https` | built-in | Anthropic API utilization fetch |
| `node:fs` | built-in | Event file reading, PID management |
| `node:readline` | built-in | JSONL stream parsing |
| `node:path` | built-in | Path manipulation |
| `node:os` | built-in | Home directory, hostname |

No npm packages. No external dependencies. The entire dashboard is a single self-contained Node.js file using only built-in modules.

### Performance Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| Dashboard cold start | < 2s | Including cache warm |
| `/api/projects` response | < 100ms | Directory scan |
| `/api/events` response (100 events) | < 200ms | File reads |
| `/api/usage` response (first load) | < 5s | JSONL parsing, cold cache |
| `/api/usage` response (cached) | < 50ms | From memory cache |
| SSE event delivery latency | < 3s | 2s poll interval + processing |
| HTML page load | < 100ms | Inline HTML, no external requests |

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | `generateEventSummary()` produces correct HTML for each of the 10 event types |
| T-2 | `generateInputSummary()` produces correct tool-specific summaries for Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch, Task |
| T-3 | `generateOutputSummary()` produces correct tool-specific output summaries (line counts, exit codes, match counts) |
| T-4 | `categorizePrompt()` correctly identifies task notifications, system reminders, system metadata, and real user prompts |
| T-5 | `parseTranscriptFile()` correctly extracts usage from JSONL assistant entries |
| T-6 | `parseTranscriptFile()` skips malformed JSON lines without throwing |
| T-7 | `calcCost()` computes correct cost estimates for known models |
| T-8 | `buildTimelineData()` produces 30 daily entries with correct aggregation |
| T-9 | `projectName()` strips the 6-char hash suffix correctly |
| T-10 | `escHtml()` escapes `<`, `>`, `&`, `"` correctly |

### Integration Tests

| Test | Description |
|------|-------------|
| T-11 | `GET /` returns HTML with status 200 and `text/html` content type |
| T-12 | `GET /api/projects` returns JSON array of projects from the event store |
| T-13 | `GET /api/sessions?project=X` returns sessions sorted by `started_at` descending |
| T-14 | `GET /api/events?project=X&session=Y` returns events sorted by sequence ascending |
| T-15 | `GET /api/events?project=X&session=Y&from=10` returns only events with sequence > 10 |
| T-16 | `GET /api/usage` returns usage data for all projects |
| T-17 | `GET /api/usage?project=X` returns usage for a single project |
| T-18 | `GET /api/stream?project=X&session=Y` returns `text/event-stream` content type and streams events |
| T-19 | SSE connection receives new events when they are written to the event store |
| T-20 | SSE connection sends keepalive comments |
| T-21 | `gc-dashboard start` writes PID file and starts listening |
| T-22 | `gc-dashboard stop` sends SIGTERM and removes PID file |
| T-23 | `gc-dashboard status` reports correct running state |
| T-24 | `gc-dashboard restart` stops and restarts cleanly |
| T-25 | Starting dashboard when port is in use produces a clear error |
| T-26 | Stale PID file is cleaned up on next start |

### UI Verification (Manual)

| Test | Description |
|------|-------------|
| M-1 | Open dashboard in browser, verify sidebar shows projects and sessions |
| M-2 | Select a session, verify event feed loads with correct per-type rendering |
| M-3 | Start a Claude Code session, verify new events appear in real-time via SSE |
| M-4 | Switch to Usage tab, verify token counts and cost estimates are displayed |
| M-5 | Verify daily timeline bar chart shows last 30 days with stacked bars |
| M-6 | Click a bar in the timeline, verify events are filtered to that day |
| M-7 | Select a month in the month filter, verify all tables update |
| M-8 | Verify per-project percentage badges are shown and sum to 100% |
| M-9 | Toggle "Show system prompts" filter, verify system messages are hidden/shown |
| M-10 | Switch to Agents tab, verify running agents are displayed with correct status colors |
| M-11 | Click "Interact" on an agent, verify interaction panel opens |
| M-12 | Send a prompt from the interaction panel, verify streaming response appears |
| M-13 | Approve a permission from the dashboard, verify the agent continues |
| M-14 | Stop the dashboard with `gc-dashboard stop`, verify PID file is removed |
| M-15 | Verify dashboard auto-starts on next `gc-hook` invocation when `.dashboard-enabled` exists |

---

## Definition of Done

- [ ] `gc-dashboard` serves the full dashboard UI on `http://localhost:{port}` as a single inline HTML page
- [ ] Event feed displays events with per-event-type rendering for all 10 event types
- [ ] Event feed supports filtering by project, session, event type, date range, and system prompt toggle
- [ ] Usage analytics display token usage per project, per model, per day, per month with cost estimation
- [ ] Daily timeline bar chart shows last 30 days with stacked bars (input/output/cache read/cache create)
- [ ] Clicking a timeline bar filters events to that day
- [ ] Monthly view filters all usage tables and shows month-over-month comparison deltas
- [ ] Per-project percentage badges are shown in the usage table and sum to 100%
- [ ] SSE streaming delivers new events to the browser within 3 seconds of capture
- [ ] SSE connection shows live/reconnecting status in the dashboard header
- [ ] System prompt filtering correctly categorizes task notifications, system reminders, and real user prompts
- [ ] Agent Status Panel displays all running agents with color-coded lifecycle state indicators
- [ ] Agent Interaction panel allows sending prompts and streaming responses
- [ ] Permission requests are surfaced in the Agent Interaction panel with Approve/Deny buttons
- [ ] `gc-dashboard start|stop|restart|status` lifecycle commands work correctly
- [ ] PID file management handles stale PIDs, SIGTERM/SIGINT cleanup, and concurrent start attempts
- [ ] Auto-start triggers from `gc-hook` when `.dashboard-enabled` marker exists
- [ ] Dashboard restarts automatically on install/upgrade via `deploy.sh`
- [ ] No npm dependencies -- uses only Node.js built-in modules
- [ ] All 26 automated tests and 15 manual verification tests pass
- [ ] Performance targets are met: < 2s cold start, < 3s SSE latency, < 50ms cached API responses
