// tests/projections/test_summary.mjs -- Tests for summary projection handler
import assert from 'node:assert';
import { handler, formatJson, formatText, formatMarkdown } from '../../src/projections/handlers/summary.mjs';

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
    timestamp: `2026-01-01T00:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`,
    session_id: 'test-session',
    data: data || {},
  };
}

function buildStandardSession() {
  let state = handler.init();
  // 14 event standard session
  state = handler.handle(state, { event_type: 'SessionStarted', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', session_id: 'test', data: { model: 'claude-opus-4-6', cwd: '/home/user/project' } });
  state = handler.handle(state, { event_type: 'UserPromptReceived', sequence: 2, timestamp: '2026-01-01T00:00:01.000Z', session_id: 'test', data: { prompt: 'Fix the failing test' } });
  state = handler.handle(state, { event_type: 'ToolCallRequested', sequence: 3, timestamp: '2026-01-01T00:00:02.000Z', session_id: 'test', data: { tool_name: 'Read', tool_input: { file_path: '/a.js' } } });
  state = handler.handle(state, { event_type: 'ToolCallCompleted', sequence: 4, timestamp: '2026-01-01T00:00:03.000Z', session_id: 'test', data: { tool_name: 'Read' } });
  state = handler.handle(state, { event_type: 'ToolCallRequested', sequence: 5, timestamp: '2026-01-01T00:00:04.000Z', session_id: 'test', data: { tool_name: 'Edit', tool_input: { file_path: '/a.js' } } });
  state = handler.handle(state, { event_type: 'ToolCallCompleted', sequence: 6, timestamp: '2026-01-01T00:00:05.000Z', session_id: 'test', data: { tool_name: 'Edit' } });
  state = handler.handle(state, { event_type: 'ToolCallRequested', sequence: 7, timestamp: '2026-01-01T00:00:06.000Z', session_id: 'test', data: { tool_name: 'Bash', tool_input: { command: 'npm test' } } });
  state = handler.handle(state, { event_type: 'ToolCallCompleted', sequence: 8, timestamp: '2026-01-01T00:00:07.000Z', session_id: 'test', data: { tool_name: 'Bash' } });
  state = handler.handle(state, { event_type: 'TurnCompleted', sequence: 9, timestamp: '2026-01-01T00:00:08.000Z', session_id: 'test', data: {} });
  state = handler.handle(state, { event_type: 'UserPromptReceived', sequence: 10, timestamp: '2026-01-01T00:00:09.000Z', session_id: 'test', data: { prompt: 'Search for expiry tests' } });
  state = handler.handle(state, { event_type: 'ToolCallRequested', sequence: 11, timestamp: '2026-01-01T00:00:10.000Z', session_id: 'test', data: { tool_name: 'Grep', tool_input: { pattern: 'expiry' } } });
  state = handler.handle(state, { event_type: 'ToolCallCompleted', sequence: 12, timestamp: '2026-01-01T00:00:11.000Z', session_id: 'test', data: { tool_name: 'Grep' } });
  state = handler.handle(state, { event_type: 'TurnCompleted', sequence: 13, timestamp: '2026-01-01T00:00:12.000Z', session_id: 'test', data: {} });
  state = handler.handle(state, { event_type: 'SessionEnded', sequence: 14, timestamp: '2026-01-01T00:01:30.000Z', session_id: 'test', data: {} });
  return state;
}

console.log('Test: summary.mjs');

await test('14 events produce event_count: 14', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.strictEqual(result.event_count, 14);
});

await test('event_breakdown has correct counts', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.strictEqual(result.event_breakdown['SessionStarted'], 1);
  assert.strictEqual(result.event_breakdown['UserPromptReceived'], 2);
  assert.strictEqual(result.event_breakdown['ToolCallRequested'], 4);
  assert.strictEqual(result.event_breakdown['ToolCallCompleted'], 4);
  assert.strictEqual(result.event_breakdown['TurnCompleted'], 2);
  assert.strictEqual(result.event_breakdown['SessionEnded'], 1);
});

await test('tools_used has correct counts', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.strictEqual(result.tools_used['Read'], 1);
  assert.strictEqual(result.tools_used['Edit'], 1);
  assert.strictEqual(result.tools_used['Bash'], 1);
  assert.strictEqual(result.tools_used['Grep'], 1);
});

await test('duration_human formats correctly (1m 30s = 1m)', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.strictEqual(result.duration_human, '1m');
  assert.strictEqual(result.duration_seconds, 90);
});

await test('narrative is a complete sentence with no template tokens', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.ok(result.narrative.length > 0);
  assert.ok(!result.narrative.includes('${'));
  assert.ok(!result.narrative.includes('undefined'));
  assert.ok(result.narrative.endsWith('.'));
});

await test('session with only SessionStarted', async () => {
  let state = handler.init();
  state = handler.handle(state, { event_type: 'SessionStarted', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', session_id: 'test', data: {} });
  const result = handler.finalize(state);
  assert.strictEqual(result.event_count, 1);
  assert.strictEqual(result.total_tool_calls, 0);
  assert.ok(result.narrative.includes('started but contained no further activity'));
});

await test('session with failed tool calls has failure in narrative', async () => {
  let state = handler.init();
  state = handler.handle(state, { event_type: 'SessionStarted', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', session_id: 'test', data: {} });
  state = handler.handle(state, { event_type: 'UserPromptReceived', sequence: 2, timestamp: '2026-01-01T00:00:01.000Z', session_id: 'test', data: { prompt: 'do something' } });
  state = handler.handle(state, { event_type: 'ToolCallRequested', sequence: 3, timestamp: '2026-01-01T00:00:02.000Z', session_id: 'test', data: { tool_name: 'Bash', tool_input: {} } });
  state = handler.handle(state, { event_type: 'ToolCallFailed', sequence: 4, timestamp: '2026-01-01T00:00:03.000Z', session_id: 'test', data: { tool_name: 'Bash', error: 'exit 1' } });
  state = handler.handle(state, { event_type: 'SessionEnded', sequence: 5, timestamp: '2026-01-01T00:00:10.000Z', session_id: 'test', data: {} });
  const result = handler.finalize(state);
  assert.ok(result.narrative.includes('failed'));
});

await test('session with agents has agents in narrative', async () => {
  let state = handler.init();
  state = handler.handle(state, { event_type: 'SessionStarted', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', session_id: 'test', data: {} });
  state = handler.handle(state, { event_type: 'UserPromptReceived', sequence: 2, timestamp: '2026-01-01T00:00:01.000Z', session_id: 'test', data: { prompt: 'review' } });
  state = handler.handle(state, { event_type: 'AgentSpawned', sequence: 3, timestamp: '2026-01-01T00:00:02.000Z', session_id: 'test', data: { agent_type: 'code-review' } });
  state = handler.handle(state, { event_type: 'SessionEnded', sequence: 4, timestamp: '2026-01-01T00:00:10.000Z', session_id: 'test', data: {} });
  const result = handler.finalize(state);
  assert.ok(result.narrative.includes('agent'));
  assert.ok(result.narrative.includes('spawned'));
});

await test('first prompt appears in narrative', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.ok(result.narrative.includes('Fix the failing test'));
});

await test('files tracking is correct', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.strictEqual(result.files_touched_count, 1); // /a.js
  assert.strictEqual(result.files_modified_count, 1); // /a.js (Edit)
});

await test('text format has labeled metrics', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  const text = formatText(result);
  assert.ok(text.includes('Session Summary'));
  assert.ok(text.includes('Events:'));
  assert.ok(text.includes('Narrative:'));
});

await test('markdown format has table', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  const md = formatMarkdown(result);
  assert.ok(md.includes('# Session Summary'));
  assert.ok(md.includes('| Metric | Value |'));
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
