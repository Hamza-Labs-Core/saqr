// timeline.mjs -- Timeline projection handler.
// One entry per event, in sequence order, with a generated summary string.
import { CURRENT_PROJECTION_VERSION, register } from '../lib/registry.mjs';
import { generateEventSummary } from '../lib/summary-generators.mjs';

const handler = {
  init(existing) {
    if (existing) {
      return {
        entries: existing.entries || [],
        sessionId: existing._session_id || null,
      };
    }
    return { entries: [], sessionId: null };
  },

  handle(state, event) {
    if (event.session_id && !state.sessionId) {
      state.sessionId = event.session_id;
    }

    state.entries.push({
      sequence: event.sequence,
      timestamp: event.timestamp,
      event_type: event.event_type,
      summary: generateEventSummary(event),
    });

    return state;
  },

  finalize(state) {
    return {
      _projection_type: 'timeline',
      _projection_version: CURRENT_PROJECTION_VERSION,
      _rebuilt_at: new Date().toISOString(),
      _session_id: state.sessionId,
      _last_sequence: state.entries.length > 0 ? state.entries[state.entries.length - 1].sequence : 0,
      entry_count: state.entries.length,
      entries: state.entries,
    };
  },
};

function formatJson(projection) {
  return JSON.stringify(projection, null, 2);
}

function formatText(projection) {
  return projection.entries.map(e =>
    `[${e.sequence}] ${e.timestamp} ${e.event_type}: ${e.summary}`
  ).join('\n');
}

function formatMarkdown(projection) {
  const lines = [];
  lines.push('# Timeline');
  lines.push('');
  lines.push('| # | Timestamp | Type | Summary |');
  lines.push('|---|-----------|------|---------|');
  for (const e of projection.entries) {
    // Escape pipes in summary
    const safeSummary = (e.summary || '').replace(/\|/g, '\\|');
    lines.push(`| ${e.sequence} | ${e.timestamp} | ${e.event_type} | ${safeSummary} |`);
  }
  return lines.join('\n');
}

register('timeline', {
  name: 'Timeline',
  description: 'Ordered summary of all events in sequence order',
  version: CURRENT_PROJECTION_VERSION,
  outputFile: 'timeline.json',
  handler,
  formatters: { json: formatJson, text: formatText, markdown: formatMarkdown },
});

export { handler, formatJson, formatText, formatMarkdown };
