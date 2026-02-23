/**
 * Inline HTML UI generator.
 *
 * Produces a complete self-contained HTML document with inline CSS and JS.
 * No external dependencies — everything is embedded in the HTML string.
 */

export function generateDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saqr Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --bg2: #161b22;
    --bg3: #21262d;
    --border: #30363d;
    --text: #c9d1d9;
    --text2: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #bc8cff;
    --orange: #f0883e;
  }
  [data-theme="light"] {
    --bg: #ffffff;
    --bg2: #f6f8fa;
    --bg3: #eaeef2;
    --border: #d0d7de;
    --text: #1f2328;
    --text2: #656d76;
    --accent: #0969da;
    --green: #1a7f37;
    --red: #cf222e;
    --yellow: #9a6700;
    --purple: #8250df;
    --orange: #bc4c00;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    overflow: hidden;
  }
  .layout {
    display: grid;
    grid-template-columns: 260px 1fr;
    grid-template-rows: 48px 1fr;
    height: 100vh;
  }
  .layout.full-width { grid-template-columns: 1fr; }

  /* Header */
  .header {
    grid-column: 1 / -1;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 16px;
  }
  .header h1 { font-size: 14px; font-weight: 600; color: var(--accent); }
  .header .meta { color: var(--text2); font-size: 12px; }
  .header .status { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text2); }
  .header .dot.live { background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .theme-toggle {
    background: none; border: 1px solid var(--border); color: var(--text2); padding: 4px 8px;
    border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit;
  }
  .theme-toggle:hover { color: var(--text); background: var(--bg3); }

  /* Tabs */
  .header-tabs { display: flex; gap: 2px; margin-left: 16px; }
  .header-tab {
    padding: 6px 14px; font-size: 12px; font-family: inherit; color: var(--text2);
    background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer;
  }
  .header-tab:hover { color: var(--text); background: var(--bg3); }
  .header-tab.active { color: var(--accent); background: var(--bg3); border-color: var(--border); }

  /* Sidebar */
  .sidebar {
    background: var(--bg2); border-right: 1px solid var(--border);
    overflow-y: auto; padding: 8px 0;
  }
  .sidebar-section {
    padding: 8px 12px 4px; font-size: 11px; font-weight: 600; color: var(--text2);
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .sidebar-item {
    padding: 6px 12px; cursor: pointer; display: flex; justify-content: space-between;
    align-items: center; border-left: 2px solid transparent; transition: background 0.1s;
  }
  .sidebar-item:hover { background: var(--bg3); }
  .sidebar-item.active { background: var(--bg3); border-left-color: var(--accent); color: var(--accent); }
  .sidebar-item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sidebar-item .count {
    font-size: 11px; color: var(--text2); background: var(--bg); padding: 1px 6px;
    border-radius: 10px; min-width: 20px; text-align: center;
  }
  .session-item {
    padding: 6px 12px 6px 20px; cursor: pointer; border-left: 2px solid transparent;
    transition: background 0.1s;
  }
  .session-item:hover { background: var(--bg3); }
  .session-item.active { background: var(--bg3); border-left-color: var(--green); }
  .session-item .sid { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-item .smeta { font-size: 11px; color: var(--text2); margin-top: 2px; }

  /* Main */
  .main { display: flex; flex-direction: column; overflow: hidden; }
  .session-header {
    background: var(--bg2); border-bottom: 1px solid var(--border);
    padding: 8px 16px; display: flex; align-items: center; gap: 16px;
    flex-shrink: 0; min-height: 40px;
  }
  .session-header .label { font-size: 11px; color: var(--text2); }
  .session-header .value { font-size: 12px; color: var(--text); }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 500; }
  .badge.active { background: rgba(63,185,80,0.2); color: var(--green); }
  .badge.ended { background: rgba(139,148,158,0.2); color: var(--text2); }

  /* Event feed */
  .event-feed { flex: 1; overflow-y: auto; padding: 0; }
  .event-feed table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .event-feed thead { position: sticky; top: 0; z-index: 1; }
  .event-feed th {
    background: var(--bg3); padding: 6px 10px; text-align: left; font-size: 11px;
    font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.3px;
    border-bottom: 1px solid var(--border);
  }
  .event-feed td { padding: 4px 10px; border-bottom: 1px solid var(--border); font-size: 12px; vertical-align: top; }
  .event-feed tr { transition: background 0.1s; }
  .event-feed tr:hover { background: var(--bg2); }
  .event-feed tr.new { animation: fadeIn 0.3s ease-out; }
  @keyframes fadeIn { from { background: rgba(88,166,255,0.1); } to { background: transparent; } }
  .col-seq { width: 50px; color: var(--text2); text-align: right; }
  .col-time { width: 80px; color: var(--text2); }
  .col-type { width: 170px; }
  .col-summary { overflow: hidden; }
  .etype { font-weight: 500; padding: 1px 6px; border-radius: 3px; font-size: 11px; white-space: nowrap; }
  .etype-SessionStarted { color: var(--green); background: rgba(63,185,80,0.1); }
  .etype-SessionEnded { color: var(--text2); background: rgba(139,148,158,0.1); }
  .etype-UserPromptReceived { color: var(--accent); background: rgba(88,166,255,0.1); }
  .etype-ToolCallRequested { color: var(--yellow); background: rgba(210,153,34,0.1); }
  .etype-ToolCallCompleted { color: var(--green); background: rgba(63,185,80,0.1); }
  .etype-ToolCallFailed { color: var(--red); background: rgba(248,81,73,0.1); }
  .etype-AgentSpawned { color: var(--purple); background: rgba(188,140,255,0.1); }
  .etype-AgentCompleted { color: var(--purple); background: rgba(188,140,255,0.1); }
  .etype-TurnCompleted { color: var(--text2); background: rgba(139,148,158,0.1); }
  .etype-CompactionTriggered { color: var(--orange); background: rgba(240,136,62,0.1); }
  .ev-row-error { background: rgba(248,81,73,0.04); }
  .ev-row-error:hover { background: rgba(248,81,73,0.08); }

  .empty-state {
    display: flex; align-items: center; justify-content: center; height: 100%;
    color: var(--text2); font-size: 14px; flex-direction: column; gap: 8px;
  }
  .empty-state .hint { font-size: 12px; color: var(--text2); opacity: 0.6; }

  /* Usage view */
  .usage-view { flex: 1; overflow-y: auto; padding: 20px; display: none; }
  .usage-view.visible { display: block; }
  .usage-section { margin-bottom: 24px; }
  .usage-section-title {
    font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .usage-section-title .tag {
    font-size: 10px; padding: 2px 6px; border-radius: 3px; font-weight: 500;
    background: rgba(88,166,255,0.15); color: var(--accent);
  }
  .usage-table { width: 100%; border-collapse: collapse; }
  .usage-table th {
    background: var(--bg3); padding: 6px 12px; font-size: 11px; font-weight: 600;
    color: var(--text2); text-transform: uppercase; border-bottom: 1px solid var(--border); text-align: left;
  }
  .usage-table th.num { text-align: right; }
  .usage-table td { padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .usage-table td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }
  .usage-table td.project-name { font-weight: 500; color: var(--accent); }
  .usage-table tr:hover { background: var(--bg2); }
  .usage-cost { color: var(--green); font-weight: 500; }
  .usage-cost.high { color: var(--orange); }
  .usage-cost.very-high { color: var(--red); }

  /* Weekly cards */
  .weekly-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .weekly-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 14px; }
  .weekly-card .wc-label { font-size: 11px; color: var(--text2); text-transform: uppercase; margin-bottom: 6px; }
  .weekly-card .wc-value { font-size: 20px; font-weight: 600; color: var(--text); }

  /* Timeline */
  .timeline-chart { display: flex; flex-direction: column; gap: 1px; }
  .timeline-row { display: grid; grid-template-columns: 90px 1fr 90px; align-items: center; gap: 8px; padding: 2px 0; }
  .timeline-date { font-size: 11px; color: var(--text2); text-align: right; }
  .timeline-bar-bg { height: 14px; background: rgba(139,148,158,0.08); border-radius: 2px; overflow: hidden; }
  .timeline-bar { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s; }
  .timeline-value { font-size: 11px; color: var(--text2); font-variant-numeric: tabular-nums; }

  /* Month selector */
  .month-selector { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 16px; }
  .month-btn {
    padding: 4px 12px; font-size: 11px; font-family: inherit; color: var(--text2);
    background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
  }
  .month-btn:hover { color: var(--text); background: var(--bg3); }
  .month-btn.active { color: var(--accent); background: var(--bg3); border-color: var(--accent); }

  /* Agents view */
  .agents-view { flex: 1; overflow-y: auto; padding: 20px; display: none; }
  .agents-view.visible { display: block; }
  .agent-card {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
    padding: 14px; margin-bottom: 12px;
  }
  .agent-card .agent-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .agent-card .agent-id { font-weight: 600; color: var(--accent); }
  .agent-card .agent-state { font-size: 11px; padding: 2px 6px; border-radius: 3px; }
  .agent-state-running { background: rgba(63,185,80,0.15); color: var(--green); }
  .agent-state-idle { background: rgba(139,148,158,0.15); color: var(--text2); }

  /* Shared styles */
  .ev-code { background: var(--bg3); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: var(--purple); }
  .ev-output { color: var(--text2); font-size: 11px; }
  .ev-success { color: var(--green); }
  .ev-error { background: rgba(248,81,73,0.08); border: 1px solid rgba(248,81,73,0.25); border-radius: 4px; padding: 3px 8px; color: var(--red); }
  .ev-prompt { color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 60px; overflow: hidden; }
  .ev-session-icon { font-size: 11px; margin-right: 3px; }
  .ev-prompt-icon { font-size: 13px; margin-right: 3px; }
  .ev-icon { font-size: 12px; margin-right: 2px; }
  .ev-agent-icon { font-size: 13px; margin-right: 3px; }
  .ev-compact-icon { color: var(--orange); font-size: 13px; margin-right: 3px; }
  .ev-compact { color: var(--orange); font-weight: 600; }
  .ev-error-icon { font-size: 12px; margin-right: 3px; }
  .usage-loading { display: flex; align-items: center; justify-content: center; height: 200px; color: var(--text2); }
</style>
</head>
<body>
<div class="layout" id="layout">
  <div class="header">
    <h1>Saqr</h1>
    <span class="meta" id="headerMeta">Dashboard</span>
    <div class="header-tabs">
      <button class="header-tab active" id="tabEvents" onclick="switchView('events')">Events</button>
      <button class="header-tab" id="tabUsage" onclick="switchView('usage')">Usage</button>
      <button class="header-tab" id="tabAgents" onclick="switchView('agents')">Agents</button>
    </div>
    <button class="theme-toggle" onclick="toggleTheme()">Theme</button>
    <div class="status">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">Idle</span>
    </div>
  </div>

  <div class="sidebar" id="sidebar">
    <div class="sidebar-section">Projects</div>
    <div id="projectList"></div>
    <div class="sidebar-section" id="sessionsLabel" style="display:none">Sessions</div>
    <div id="sessionList"></div>
  </div>

  <div class="main">
    <div class="session-header" id="sessionHeader">
      <span class="label">Select a project and session</span>
    </div>
    <div class="event-feed" id="eventFeed">
      <div class="empty-state">
        <span>No events to display</span>
        <span class="hint">Select a project and session from the sidebar</span>
      </div>
    </div>
    <div class="usage-view" id="usageView">
      <div class="usage-loading">Loading usage data...</div>
    </div>
    <div class="agents-view" id="agentsView">
      <div class="usage-loading">Loading agent data...</div>
    </div>
  </div>
</div>

<script>
const state = {
  projects: [],
  sessions: [],
  events: [],
  selectedProject: null,
  selectedSession: null,
  streaming: false,
  eventSource: null,
  autoScroll: true,
};

const $ = id => document.getElementById(id);

// --- Theme ---
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  try { localStorage.setItem('saqr-theme', next); } catch {}
}
(function() {
  try {
    const saved = localStorage.getItem('saqr-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch {}
})();

// --- API ---
async function api(path) {
  const res = await fetch(path);
  return res.json();
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncStr(s, n) {
  if (!s || s.length <= n) return s || '';
  return s.slice(0, n) + '...';
}

// --- Render ---
function renderProjects() {
  const el = $('projectList');
  el.innerHTML = state.projects.map(p =>
    '<div class="sidebar-item' + (state.selectedProject === p.project_id ? ' active' : '') + '" data-pid="' + p.project_id + '">' +
      '<span class="name">' + esc(p.name) + '</span>' +
      '<span class="count">' + p.session_count + '</span>' +
    '</div>'
  ).join('');
  el.querySelectorAll('.sidebar-item').forEach(item => {
    item.onclick = () => selectProject(item.dataset.pid);
  });
}

function renderSessions() {
  const el = $('sessionList');
  $('sessionsLabel').style.display = state.sessions.length ? '' : 'none';
  el.innerHTML = state.sessions.map(s => {
    const sid = s.session_id || '';
    const shortSid = sid.length > 20 ? sid.slice(0, 8) + '...' + sid.slice(-8) : sid;
    const count = s.event_count || 0;
    const started = s.started_at ? new Date(s.started_at).toLocaleTimeString() : '';
    const ended = s.ended_at ? ' (ended)' : '';
    const active = state.selectedSession === sid;
    return '<div class="session-item' + (active ? ' active' : '') + '" data-sid="' + sid + '">' +
      '<div class="sid">' + esc(shortSid) + '</div>' +
      '<div class="smeta">' + count + ' events &middot; ' + started + ended + '</div>' +
    '</div>';
  }).join('');
  el.querySelectorAll('.session-item').forEach(item => {
    item.onclick = () => selectSession(item.dataset.sid);
  });
}

function renderSessionHeader() {
  const el = $('sessionHeader');
  if (!state.selectedSession) {
    el.innerHTML = '<span class="label">Select a project and session</span>';
    return;
  }
  const s = state.sessions.find(s => s.session_id === state.selectedSession);
  if (!s) return;
  const isActive = !s.ended_at;
  const proj = state.selectedProject ? state.selectedProject.replace(/-[a-f0-9]{6}$/, '') : '';
  el.innerHTML =
    '<span class="badge ' + (isActive ? 'active' : 'ended') + '">' + (isActive ? 'LIVE' : 'ENDED') + '</span>' +
    '<span><span class="label">Project: </span><span class="value">' + esc(proj) + '</span></span>' +
    '<span><span class="label">Events: </span><span class="value">' + (s.event_count || state.events.length) + '</span></span>';
}

function renderEvents() {
  const el = $('eventFeed');
  if (!state.events.length) {
    el.innerHTML = '<div class="empty-state"><span>No events in this session</span></div>';
    return;
  }
  let html = '<table><thead><tr>' +
    '<th class="col-seq">#</th>' +
    '<th class="col-time">Time</th>' +
    '<th class="col-type">Event</th>' +
    '<th class="col-summary">Detail</th>' +
    '</tr></thead><tbody>';
  for (const e of state.events) {
    const ts = e.timestamp ? e.timestamp.slice(11, 19) : '';
    const etypeClass = 'etype-' + (e.event_type || '');
    const summary = e._summary || {};
    const summaryHtml = typeof summary === 'object' ? (summary.html || esc(summary.text || '')) : esc(summary);
    const rowClass = e.event_type === 'ToolCallFailed' ? ' class="ev-row-error"' : '';
    html += '<tr' + rowClass + '>' +
      '<td class="col-seq">' + (e.sequence || '') + '</td>' +
      '<td class="col-time">' + ts + '</td>' +
      '<td class="col-type"><span class="etype ' + etypeClass + '">' + esc(e.event_type || '') + '</span></td>' +
      '<td class="col-summary">' + summaryHtml + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  if (state.autoScroll) el.scrollTop = el.scrollHeight;
}

function appendEvent(event) {
  state.events.push(event);
  const el = $('eventFeed');
  let tbody = el.querySelector('tbody');
  if (!tbody) { renderEvents(); return; }
  const ts = event.timestamp ? event.timestamp.slice(11, 19) : '';
  const etypeClass = 'etype-' + (event.event_type || '');
  const summary = event._summary || {};
  const summaryHtml = typeof summary === 'object' ? (summary.html || esc(summary.text || '')) : esc(summary);
  const tr = document.createElement('tr');
  tr.className = 'new' + (event.event_type === 'ToolCallFailed' ? ' ev-row-error' : '');
  tr.innerHTML =
    '<td class="col-seq">' + (event.sequence || '') + '</td>' +
    '<td class="col-time">' + ts + '</td>' +
    '<td class="col-type"><span class="etype ' + etypeClass + '">' + esc(event.event_type || '') + '</span></td>' +
    '<td class="col-summary">' + summaryHtml + '</td>';
  tbody.appendChild(tr);
  renderSessionHeader();
  if (state.autoScroll) el.scrollTop = el.scrollHeight;
}

// --- Actions ---
async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjects();
}

async function selectProject(projectId) {
  state.selectedProject = projectId;
  state.selectedSession = null;
  state.events = [];
  stopStream();
  renderProjects();
  renderEvents();
  renderSessionHeader();
  state.sessions = await api('/api/sessions?project=' + encodeURIComponent(projectId));
  renderSessions();
  if (state.sessions.length > 0) selectSession(state.sessions[0].session_id);
}

async function selectSession(sessionId) {
  state.selectedSession = sessionId;
  stopStream();
  renderSessions();
  state.events = await api('/api/events?project=' + encodeURIComponent(state.selectedProject) + '&session=' + encodeURIComponent(sessionId));
  renderEvents();
  renderSessionHeader();
  startStream();
}

function startStream() {
  stopStream();
  if (!state.selectedProject || !state.selectedSession) return;
  const lastSeq = state.events.length ? state.events[state.events.length - 1].sequence : 0;
  const url = '/sse?project=' + encodeURIComponent(state.selectedProject) +
    '&session=' + encodeURIComponent(state.selectedSession) +
    '&from=' + lastSeq;
  const es = new EventSource(url);
  state.eventSource = es;
  state.streaming = true;
  $('statusDot').className = 'dot live';
  $('statusText').textContent = 'Streaming';
  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (state.events.some(ev => ev.sequence === event.sequence)) return;
      appendEvent(event);
    } catch {}
  };
  es.onerror = () => {
    $('statusDot').className = 'dot';
    $('statusText').textContent = 'Reconnecting...';
  };
  es.onopen = () => {
    $('statusDot').className = 'dot live';
    $('statusText').textContent = 'Streaming';
  };
}

function stopStream() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  state.streaming = false;
  $('statusDot').className = 'dot';
  $('statusText').textContent = 'Idle';
}

$('eventFeed').addEventListener('scroll', () => {
  const el = $('eventFeed');
  state.autoScroll = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
});

// --- View switching ---
let currentView = 'events';
function switchView(view) {
  currentView = view;
  const eventsEls = [$('eventFeed'), $('sessionHeader')];
  const usageEl = $('usageView');
  const agentsEl = $('agentsView');
  const sidebarEl = $('sidebar');
  const layout = $('layout');

  $('tabEvents').className = 'header-tab' + (view === 'events' ? ' active' : '');
  $('tabUsage').className = 'header-tab' + (view === 'usage' ? ' active' : '');
  $('tabAgents').className = 'header-tab' + (view === 'agents' ? ' active' : '');

  eventsEls.forEach(el => el.style.display = view === 'events' ? '' : 'none');
  usageEl.classList.toggle('visible', view === 'usage');
  agentsEl.classList.toggle('visible', view === 'agents');
  sidebarEl.style.display = view === 'events' ? '' : 'none';
  layout.classList.toggle('full-width', view !== 'events');

  if (view === 'usage') loadUsageData();
  if (view === 'agents') loadAgentsData();
}

// --- Usage ---
const MODEL_PRICING = {
  opus: { input: 15, output: 75, cache_read: 1.5, cache_create: 18.75 },
  sonnet: { input: 3, output: 15, cache_read: 0.3, cache_create: 3.75 },
  haiku: { input: 0.8, output: 4, cache_read: 0.08, cache_create: 1 },
};

function getModelTier(model) {
  if (!model) return 'opus';
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return 'opus';
}

function calcCost(inp, out, cr, cc, model) {
  const p = MODEL_PRICING[getModelTier(model)];
  return (inp/1e6)*p.input + (out/1e6)*p.output + (cr/1e6)*p.cache_read + (cc/1e6)*p.cache_create;
}

function formatTokens(n) {
  if (n === 0) return '0';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return n.toString();
}

function formatCost(c) {
  if (c >= 100) return '$' + c.toFixed(0);
  if (c >= 10) return '$' + c.toFixed(1);
  return '$' + c.toFixed(2);
}

async function loadUsageData() {
  const el = $('usageView');
  el.innerHTML = '<div class="usage-loading">Loading usage data...</div>';
  try {
    const usage = await api('/api/usage');
    if (!usage || !usage.length) {
      el.innerHTML = '<div class="empty-state"><span>No usage data available</span></div>';
      return;
    }
    renderUsageView(el, usage);
  } catch {
    el.innerHTML = '<div class="usage-loading">Failed to load usage data</div>';
  }
}

function renderUsageView(el, data) {
  let html = '<div class="usage-section"><div class="usage-section-title">Project Usage</div>';
  html += '<table class="usage-table"><thead><tr><th>Project</th><th class="num">API Calls</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache Read</th><th class="num">Est. Cost</th></tr></thead><tbody>';
  let totalCost = 0;
  for (const p of data) {
    let cost = 0;
    for (const s of p.sessions) {
      cost += calcCost(s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_create_tokens, s.model);
    }
    totalCost += cost;
    const costCls = cost >= 50 ? 'usage-cost very-high' : cost >= 10 ? 'usage-cost high' : 'usage-cost';
    html += '<tr><td class="project-name">' + esc(p.project_name) + '</td>' +
      '<td class="num">' + p.totals.api_calls + '</td>' +
      '<td class="num">' + formatTokens(p.totals.input_tokens) + '</td>' +
      '<td class="num">' + formatTokens(p.totals.output_tokens) + '</td>' +
      '<td class="num">' + formatTokens(p.totals.cache_read_tokens) + '</td>' +
      '<td class="num"><span class="' + costCls + '">' + formatCost(cost) + '</span></td></tr>';
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

// --- Agents ---
async function loadAgentsData() {
  const el = $('agentsView');
  el.innerHTML = '<div class="usage-loading">Loading agent data...</div>';
  try {
    const agents = await api('/api/agents');
    if (!agents || !agents.length) {
      el.innerHTML = '<div class="empty-state"><span>No agents running</span><span class="hint">Start an agent to see its status here</span></div>';
      return;
    }
    let html = '';
    for (const a of agents) {
      const stateCls = a.state === 'running' ? 'agent-state-running' : 'agent-state-idle';
      html += '<div class="agent-card"><div class="agent-header">' +
        '<span class="agent-id">' + esc(a.agent_id) + '</span>' +
        '<span class="agent-state ' + stateCls + '">' + esc(a.state) + '</span>' +
        '<span class="ev-code">' + esc(a.provider) + '</span>' +
        '</div><div class="ev-output">Project: ' + esc(a.project_id) + ' | Session: ' + esc(a.session_id) + '</div></div>';
    }
    el.innerHTML = html;
  } catch {
    el.innerHTML = '<div class="usage-loading">Failed to load agent data</div>';
  }
}

// --- Init ---
loadProjects();
setInterval(loadProjects, 30000);
</script>
</body>
</html>`;
}
