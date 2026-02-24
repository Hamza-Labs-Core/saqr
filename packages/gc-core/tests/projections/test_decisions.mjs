// tests/projections/test_decisions.mjs -- Tests for decisions projection handler
import assert from 'node:assert';
import { handler, formatJson, formatText, formatMarkdown } from '../../src/projections/handlers/decisions.mjs';

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

console.log('Test: decisions.mjs');

await test('2 prompts with tool calls produce 2 decision groups', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Fix the test' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: { file_path: '/a.js' }, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 3, { tool_name: 'Read', tool_response: 'content', tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('TurnCompleted', 4, {}));
  state = handler.handle(state, makeEvent('UserPromptReceived', 5, { prompt: 'Search for expiry' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 6, { tool_name: 'Grep', tool_input: { pattern: 'expiry' }, tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 7, { tool_name: 'Grep', tool_response: '3 matches', tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('SessionEnded', 8, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.group_count, 2);
});

await test('events before first UserPromptReceived do not create a group', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'test' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('UserPromptReceived', 3, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('SessionEnded', 4, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.group_count, 1);
  assert.strictEqual(result.groups[0].action_count, 0);
});

await test('TurnCompleted closes the current group', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 3, { tool_name: 'Read', tool_response: 'ok', tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('TurnCompleted', 4, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.group_count, 1);
  assert.strictEqual(result.groups[0].all_succeeded, true);
});

await test('unmatched ToolCallRequested has success: null', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('SessionEnded', 3, {}));
  const result = handler.finalize(state);
  const action = result.groups[0].actions[0];
  assert.strictEqual(action.success, null);
  assert.strictEqual(action.output_summary, '(no completion recorded)');
});

await test('all_succeeded is true only when every action succeeds', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 3, { tool_name: 'Read', tool_response: 'ok', tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 4, { tool_name: 'Bash', tool_input: { command: 'fail' }, tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('ToolCallFailed', 5, { tool_name: 'Bash', error: 'exit 1', tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('SessionEnded', 6, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.groups[0].all_succeeded, false);
});

await test('action_count matches actions array length', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 3, { tool_name: 'Read', tool_response: 'ok', tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 4, { tool_name: 'Edit', tool_input: {}, tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 5, { tool_name: 'Edit', tool_response: 'ok', tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('TurnCompleted', 6, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.groups[0].action_count, 2);
  assert.strictEqual(result.groups[0].actions.length, 2);
});

await test('stats aggregates are correct', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'G1' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 3, { tool_name: 'Read', tool_response: 'ok', tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('TurnCompleted', 4, {}));
  state = handler.handle(state, makeEvent('UserPromptReceived', 5, { prompt: 'G2' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 6, { tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('ToolCallFailed', 7, { tool_name: 'Bash', error: 'err', tool_use_id: 'tu_2' }));
  state = handler.handle(state, makeEvent('SessionEnded', 8, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.stats.total_groups, 2);
  assert.strictEqual(result.stats.total_actions, 2);
  assert.strictEqual(result.stats.failed_actions, 1);
});

await test('full user prompt is stored, not truncated', async () => {
  const longPrompt = 'x'.repeat(5000);
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: longPrompt }));
  state = handler.handle(state, makeEvent('SessionEnded', 2, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.groups[0].user_prompt.prompt, longPrompt);
  assert.strictEqual(result.groups[0].user_prompt.prompt_length, 5000);
});

await test('agent events within a group are recorded', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('AgentSpawned', 2, { agent_type: 'code-review', description: 'Reviewing PR' }));
  state = handler.handle(state, makeEvent('AgentCompleted', 3, { agent_type: 'code-review', status: 'success' }));
  state = handler.handle(state, makeEvent('SessionEnded', 4, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.groups[0].agents_spawned.length, 2);
});

await test('tool-call pairing uses tool_use_id as primary key', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: { file_path: '/a.js' }, tool_use_id: 'tu_001' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 3, { tool_name: 'Read', tool_input: { file_path: '/b.js' }, tool_use_id: 'tu_002' }));
  // Complete in reverse order
  state = handler.handle(state, makeEvent('ToolCallCompleted', 4, { tool_name: 'Read', tool_response: 'content of b', tool_use_id: 'tu_002' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 5, { tool_name: 'Read', tool_response: 'content of a', tool_use_id: 'tu_001' }));
  state = handler.handle(state, makeEvent('SessionEnded', 6, {}));
  const result = handler.finalize(state);
  // Both actions should be completed
  assert.strictEqual(result.groups[0].actions[0].success, true);
  assert.strictEqual(result.groups[0].actions[1].success, true);
  // Verify correct pairing
  assert.strictEqual(result.groups[0].actions[0].completion_sequence, 5); // tu_001
  assert.strictEqual(result.groups[0].actions[1].completion_sequence, 4); // tu_002
});

await test('JSON format is valid', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Hello' }));
  state = handler.handle(state, makeEvent('SessionEnded', 2, {}));
  const result = handler.finalize(state);
  const json = formatJson(result);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed._projection_type, 'decisions');
  assert.ok(Array.isArray(parsed.groups));
});

await test('Text format has group headers and action list', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Fix test' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, { tool_name: 'Read', tool_input: { file_path: '/a.js' }, tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 3, { tool_name: 'Read', tool_response: 'ok', tool_use_id: 'tu_1' }));
  state = handler.handle(state, makeEvent('SessionEnded', 4, {}));
  const result = handler.finalize(state);
  const text = formatText(result);
  assert.ok(text.includes('Group 1'));
  assert.ok(text.includes('[OK]'));
});

await test('Markdown format has blockquoted prompts', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('UserPromptReceived', 1, { prompt: 'Fix test' }));
  state = handler.handle(state, makeEvent('SessionEnded', 2, {}));
  const result = handler.finalize(state);
  const md = formatMarkdown(result);
  assert.ok(md.includes('### Group 1'));
  assert.ok(md.includes('> Fix test'));
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
