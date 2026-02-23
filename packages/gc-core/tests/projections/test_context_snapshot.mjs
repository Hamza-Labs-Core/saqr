// tests/projections/test_context_snapshot.mjs -- Tests for context snapshot handler
import assert from 'node:assert';
import { handler, formatJson, formatText, formatMarkdown } from '../../src/projections/handlers/context-snapshot.mjs';

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

function makeEvent(type, seq, data, ts) {
  return {
    event_type: type,
    sequence: seq,
    timestamp: ts || `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    session_id: 'test-session',
    data: data || {},
  };
}

function buildStandardSession() {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'claude-opus-4-6', cwd: '/home/user/project' }, '2026-01-01T00:00:00.000Z'));
  state = handler.handle(state, makeEvent('UserPromptReceived', 2, { prompt: 'Fix the failing test in auth.test.js' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 3, { tool_name: 'Read', tool_input: { file_path: '/home/user/project/auth.test.js' }, tool_use_id: 'tu_001' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 4, { tool_name: 'Read', tool_response: 'small content', tool_use_id: 'tu_001' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 5, { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/auth.test.js' }, tool_use_id: 'tu_002' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 6, { tool_name: 'Edit', tool_response: 'ok', tool_use_id: 'tu_002' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 7, { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu_003' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 8, { tool_name: 'Bash', tool_response: 'All 12 tests passed', exit_code: 0, stdout: 'All 12 tests passed', tool_use_id: 'tu_003' }));
  state = handler.handle(state, makeEvent('TurnCompleted', 9, {}));
  state = handler.handle(state, makeEvent('UserPromptReceived', 10, { prompt: 'Now search for any other expiry-related tests' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 11, { tool_name: 'Grep', tool_input: { pattern: 'expiry', path: '/home/user/project' }, tool_use_id: 'tu_004' }));
  state = handler.handle(state, makeEvent('ToolCallCompleted', 12, { tool_name: 'Grep', tool_response: '/a.js:10: expiry\n/b.js:20: expiry\n/c.js:5: expiry', tool_use_id: 'tu_004' }));
  state = handler.handle(state, makeEvent('TurnCompleted', 13, {}));
  state = handler.handle(state, makeEvent('SessionEnded', 14, {}, '2026-01-01T00:01:30.000Z'));
  return state;
}

console.log('Test: context-snapshot.mjs');

await test('session metadata extracted correctly', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.strictEqual(result.session.model, 'claude-opus-4-6');
  assert.strictEqual(result.session.project_directory, '/home/user/project');
  assert.strictEqual(result.session.started_at, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(result.session.ended_at, '2026-01-01T00:01:30.000Z');
  assert.strictEqual(result.session.duration_seconds, 90);
  assert.strictEqual(result.session.event_count, 14);
});

await test('all user prompts included in order', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.strictEqual(result.prompts.length, 2);
  assert.strictEqual(result.prompts[0].prompt, 'Fix the failing test in auth.test.js');
  assert.strictEqual(result.prompts[1].prompt, 'Now search for any other expiry-related tests');
  assert.ok(result.prompts[0].sequence < result.prompts[1].sequence);
});

await test('tool calls with small outputs included in full', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  // Read small content should not be heavily summarized
  const readCall = result.key_tool_calls.find(tc => tc.tool_use_id === 'tu_001');
  assert.ok(readCall);
  assert.strictEqual(readCall.success, true);
  assert.ok(readCall.output_summary.length > 0);
});

await test('tool calls with large outputs (> 2KB) are summarized', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'test' }));
  state = handler.handle(state, makeEvent('UserPromptReceived', 2, { prompt: 'read big file' }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 3, { tool_name: 'Read', tool_input: { file_path: '/big.js' }, tool_use_id: 'tu_big' }));
  const bigContent = 'line\n'.repeat(1000); // > 2KB
  state = handler.handle(state, makeEvent('ToolCallCompleted', 4, { tool_name: 'Read', tool_response: bigContent, tool_use_id: 'tu_big' }));
  state = handler.handle(state, makeEvent('SessionEnded', 5, {}));
  const result = handler.finalize(state);
  const tc = result.key_tool_calls[0];
  assert.ok(tc.output_summary.includes('Read'));
  assert.ok(tc.output_summary.includes('lines'));
  assert.ok(tc.output_summary.length < bigContent.length);
});

await test('files_modified lists every file with unique operations', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  const authFile = result.files_modified.find(f => f.path === '/home/user/project/auth.test.js');
  assert.ok(authFile);
  assert.ok(authFile.operations.includes('read'));
  assert.ok(authFile.operations.includes('edit'));
  assert.strictEqual(authFile.last_operation, 'edit');
});

await test('last_state reflects tail of event stream', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  assert.ok(result.last_state.last_user_prompt.includes('expiry'));
  assert.ok(result.last_state.last_tool_call.includes('Grep'));
  assert.ok(result.last_state.last_tool_result.includes('expiry'));
  assert.ok(result.last_state.working_on.includes('expiry'));
});

await test('compaction markers recorded', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, {}));
  state = handler.handle(state, makeEvent('CompactionTriggered', 2, { reason: 'context_limit' }));
  state = handler.handle(state, makeEvent('SessionEnded', 3, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.compaction_markers.length, 1);
  assert.strictEqual(result.compaction_markers[0].sequence, 2);
});

await test('_size_bytes reflects serialized size', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  const actualSize = JSON.stringify(result).length;
  // Should be close (may differ slightly due to _size_bytes itself changing)
  assert.ok(Math.abs(result._size_bytes - actualSize) < 50);
});

await test('session with no SessionEnded has ended_at: null', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'test' }));
  state = handler.handle(state, makeEvent('UserPromptReceived', 2, { prompt: 'hello' }));
  const result = handler.finalize(state);
  assert.strictEqual(result.session.ended_at, null);
  assert.strictEqual(result.session.duration_seconds, null);
});

await test('session with 0 tool calls produces valid output', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'test' }));
  state = handler.handle(state, makeEvent('SessionEnded', 2, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.key_tool_calls.length, 0);
  assert.strictEqual(result.files_modified.length, 0);
  assert.ok(result._projection_type);
});

await test('agents tracked correctly', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, {}));
  state = handler.handle(state, makeEvent('AgentSpawned', 2, { agent_type: 'code-review' }));
  state = handler.handle(state, makeEvent('AgentCompleted', 3, { agent_type: 'code-review', status: 'success' }));
  state = handler.handle(state, makeEvent('SessionEnded', 4, {}));
  const result = handler.finalize(state);
  assert.strictEqual(result.agents.length, 1);
  assert.strictEqual(result.agents[0].status, 'success');
});

await test('progressive summarization with > 100KB output', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('SessionStarted', 1, { model: 'test' }));
  // Create many large prompts and tool calls to exceed 100KB
  for (let i = 2; i < 500; i += 3) {
    state = handler.handle(state, makeEvent('UserPromptReceived', i, { prompt: 'A'.repeat(800) }));
    state = handler.handle(state, makeEvent('ToolCallRequested', i + 1, {
      tool_name: 'Read',
      tool_input: { file_path: `/file${i}.js` },
      tool_use_id: `tu_${i}`,
    }));
    state = handler.handle(state, makeEvent('ToolCallCompleted', i + 2, {
      tool_name: 'Read',
      tool_response: 'x'.repeat(800),
      tool_use_id: `tu_${i}`,
    }));
  }
  state = handler.handle(state, makeEvent('SessionEnded', 600, {}));
  const result = handler.finalize(state);
  // With this many entries it should have triggered at least one phase
  assert.ok(result._summarization_applied.length > 0, 'Expected at least one summarization phase to be applied');
  // The result should still be valid
  assert.ok(result._projection_type === 'context');
  assert.ok(result.prompts.length > 0);
});

await test('JSON format is valid', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  const json = formatJson(result);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed._projection_type, 'context');
});

await test('Text format has section separators', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  const text = formatText(result);
  assert.ok(text.includes('Context Snapshot'));
  assert.ok(text.includes('---'));
  assert.ok(text.includes('User Prompts:'));
  assert.ok(text.includes('Key Tool Calls:'));
  assert.ok(text.includes('Files Modified:'));
  assert.ok(text.includes('Last State:'));
});

await test('Markdown format has proper headers', async () => {
  const state = buildStandardSession();
  const result = handler.finalize(state);
  const md = formatMarkdown(result);
  assert.ok(md.includes('# Context Snapshot'));
  assert.ok(md.includes('## Session'));
  assert.ok(md.includes('## User Prompts'));
  assert.ok(md.includes('## Key Tool Calls'));
  assert.ok(md.includes('## Files Modified'));
  assert.ok(md.includes('## Last State'));
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
