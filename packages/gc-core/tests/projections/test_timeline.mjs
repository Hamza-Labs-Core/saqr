// tests/projections/test_timeline.mjs -- Tests for timeline projection handler
import assert from 'node:assert';
import { handler, formatJson, formatText, formatMarkdown } from '../../src/projections/handlers/timeline.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(() => {
    console.log(`  PASS: ${name}`);
    passed++;
  }).catch(e => {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  });
}

function makeEvent(type, seq, data) {
  return {
    event_type: type,
    sequence: seq,
    timestamp: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    session_id: 'test-session',
    data: data || {},
  };
}

console.log('Test: timeline.mjs');

await test('14 events produce 14 entries', async () => {
  let state = handler.init();
  for (let i = 1; i <= 14; i++) {
    state = handler.handle(state, makeEvent('TestEvent', i, {}));
  }
  const result = handler.finalize(state);
  assert.strictEqual(result.entry_count, 14);
  assert.strictEqual(result.entries.length, 14);
});

await test('entries are in sequence order', async () => {
  let state = handler.init();
  for (let i = 1; i <= 5; i++) {
    state = handler.handle(state, makeEvent('TestEvent', i, {}));
  }
  const result = handler.finalize(state);
  for (let i = 0; i < result.entries.length - 1; i++) {
    assert.ok(result.entries[i].sequence < result.entries[i + 1].sequence);
  }
});

await test('UserPromptReceived with long prompt is truncated to 200', async () => {
  let state = handler.init();
  const longPrompt = 'x'.repeat(300);
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: longPrompt }));
  const result = handler.finalize(state);
  assert.ok(result.entries[0].summary.length < 300 + 10);
  assert.ok(result.entries[0].summary.includes('...'));
});

await test('ToolCallRequested for Read includes file_path', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' },
  }));
  const result = handler.finalize(state);
  assert.ok(result.entries[0].summary.includes('file_path=/foo/bar.js'));
});

await test('ToolCallRequested for Bash includes command', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Bash', tool_input: { command: 'npm test && echo done' },
  }));
  const result = handler.finalize(state);
  assert.ok(result.entries[0].summary.includes('npm test'));
});

await test('Unknown event type produces fallback summary', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('CustomEventXYZ', 42, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.entries[0].summary, 'CustomEventXYZ at sequence 42');
});

await test('SessionStarted summary includes model and cwd', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, {
    model: 'claude-opus-4-6', cwd: '/home/user/project',
  }));
  const result = handler.finalize(state);
  assert.ok(result.entries[0].summary.includes('claude-opus-4-6'));
  assert.ok(result.entries[0].summary.includes('/home/user/project'));
});

await test('Text format produces exactly one line per entry', async () => {
  let state = handler.init();
  for (let i = 1; i <= 5; i++) {
    state = handler.handle(state, makeEvent('TestEvent', i, {}));
  }
  const result = handler.finalize(state);
  const text = formatText(result);
  const lines = text.split('\n').filter(l => l.trim());
  assert.strictEqual(lines.length, 5);
});

await test('Markdown format produces valid markdown table', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'test', cwd: '/tmp' }));
  state = handler.handle(state, makeEvent('TurnCompleted', 2, {}));
  const result = handler.finalize(state);
  const md = formatMarkdown(result);
  assert.ok(md.includes('# Timeline'));
  assert.ok(md.includes('| # | Timestamp | Type | Summary |'));
  assert.ok(md.includes('|---|'));
  // Should have header + separator + 2 data rows
  const tableLines = md.split('\n').filter(l => l.startsWith('|'));
  assert.strictEqual(tableLines.length, 4); // header, separator, 2 rows
});

await test('JSON output matches documented schema', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'test', cwd: '/tmp' }));
  const result = handler.finalize(state);
  const json = formatJson(result);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed._projection_type, 'timeline');
  assert.strictEqual(parsed._projection_version, 1);
  assert.ok(parsed._rebuilt_at);
  assert.strictEqual(parsed.entry_count, 1);
  assert.ok(Array.isArray(parsed.entries));
  const entry = parsed.entries[0];
  assert.ok(entry.sequence);
  assert.ok(entry.timestamp);
  assert.ok(entry.event_type);
  assert.ok(entry.summary);
});

await test('_last_sequence reflects last event processed', async () => {
  let state = handler.init();
  for (let i = 1; i <= 7; i++) {
    state = handler.handle(state, makeEvent('TestEvent', i, {}));
  }
  const result = handler.finalize(state);
  assert.strictEqual(result._last_sequence, 7);
});

await test('ToolCallCompleted for Bash includes exit code', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallCompleted', 1, {
    tool_name: 'Bash', exit_code: 0, stdout: 'All 12 tests passed',
  }));
  const result = handler.finalize(state);
  assert.ok(result.entries[0].summary.includes('exit=0'));
});

await test('ToolCallFailed includes error info', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallFailed', 1, {
    tool_name: 'Bash', error: 'Command timed out after 120s',
  }));
  const result = handler.finalize(state);
  assert.ok(result.entries[0].summary.includes('FAILED'));
  assert.ok(result.entries[0].summary.includes('timed out'));
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
