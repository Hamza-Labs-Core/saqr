// tests/projections/test_integration.mjs -- Integration tests for the projection engine.
// Creates fixture data, runs all projections, and validates outputs end-to-end.
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/bin/project');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(() => {
    console.log(`  PASS: ${name}`);
    passed++;
  }).catch(e => {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    if (e.stack) console.log(`        ${e.stack.split('\n').slice(1, 3).join('\n        ')}`);
    failed++;
  });
}

async function runCli(args, env = {}) {
  const fullEnv = { ...process.env, ...env };
  try {
    const { stdout, stderr } = await execFileP('node', [CLI, ...args], { env: fullEnv, timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', code: e.code || 1 };
  }
}

// ============= FIXTURE DATA =============

function fixtureStandardSession() {
  // 14-event test session covering all event types
  return [
    { event_id: 'e1', event_type: 'SessionStarted', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', data: { model: 'claude-opus-4-6', cwd: '/home/user/project' } },
    { event_id: 'e2', event_type: 'UserPromptReceived', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 2, timestamp: '2026-01-01T00:00:05.000Z', data: { prompt: 'Fix the failing test in auth.test.js' } },
    { event_id: 'e3', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 3, timestamp: '2026-01-01T00:00:10.000Z', data: { tool_name: 'Read', tool_input: { file_path: '/home/user/project/auth.test.js' }, tool_use_id: 'tu_001' } },
    { event_id: 'e4', event_type: 'ToolCallCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 4, timestamp: '2026-01-01T00:00:11.000Z', data: { tool_name: 'Read', tool_response: 'const test = require("test");\ndescribe("auth", () => {\n  it("should validate token", () => {\n    // 45 lines of test code\n  });\n});\n// ... 40 more lines', tool_use_id: 'tu_001' } },
    { event_id: 'e5', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 5, timestamp: '2026-01-01T00:00:15.000Z', data: { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/auth.test.js', old_string: 'validate token', new_string: 'validate token correctly' }, tool_use_id: 'tu_002' } },
    { event_id: 'e6', event_type: 'ToolCallCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 6, timestamp: '2026-01-01T00:00:16.000Z', data: { tool_name: 'Edit', tool_response: 'File edited successfully', tool_use_id: 'tu_002' } },
    { event_id: 'e7', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 7, timestamp: '2026-01-01T00:00:20.000Z', data: { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu_003' } },
    { event_id: 'e8', event_type: 'ToolCallCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 8, timestamp: '2026-01-01T00:00:25.000Z', data: { tool_name: 'Bash', tool_response: 'All 12 tests passed', exit_code: 0, stdout: 'All 12 tests passed', tool_use_id: 'tu_003' } },
    { event_id: 'e9', event_type: 'TurnCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 9, timestamp: '2026-01-01T00:00:26.000Z', data: {} },
    { event_id: 'e10', event_type: 'UserPromptReceived', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 10, timestamp: '2026-01-01T00:00:30.000Z', data: { prompt: 'Now search for any other expiry-related tests' } },
    { event_id: 'e11', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 11, timestamp: '2026-01-01T00:00:35.000Z', data: { tool_name: 'Grep', tool_input: { pattern: 'expiry', path: '/home/user/project' }, tool_use_id: 'tu_004' } },
    { event_id: 'e12', event_type: 'ToolCallCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 12, timestamp: '2026-01-01T00:00:36.000Z', data: { tool_name: 'Grep', tool_response: '/home/user/project/token.test.js\n/home/user/project/session.test.js', tool_use_id: 'tu_004' } },
    { event_id: 'e13', event_type: 'TurnCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 13, timestamp: '2026-01-01T00:00:37.000Z', data: {} },
    { event_id: 'e14', event_type: 'SessionEnded', project_id: 'test-proj-abc123', session_id: 'test-session-001', sequence: 14, timestamp: '2026-01-01T00:01:30.000Z', data: {} },
  ];
}

function fixtureCorruptSession() {
  return [
    { event_id: 'c1', event_type: 'SessionStarted', project_id: 'test-proj-abc123', session_id: 'test-session-corrupt', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', data: {} },
    '{invalid json here',  // Will be written as raw string
    { event_id: 'c3', event_type: 'UserPromptReceived', project_id: 'test-proj-abc123', session_id: 'test-session-corrupt', sequence: 3, timestamp: '2026-01-01T00:00:02.000Z', data: { prompt: 'After the corrupt event' } },
  ];
}

function fixtureDuplicateSession() {
  return [
    { event_id: 'd1', event_type: 'SessionStarted', project_id: 'test-proj-abc123', session_id: 'test-session-duplicate', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', data: {} },
    { event_id: 'd2', event_type: 'UserPromptReceived', project_id: 'test-proj-abc123', session_id: 'test-session-duplicate', sequence: 2, timestamp: '2026-01-01T00:00:01.000Z', data: { prompt: 'Test dedup' } },
    { event_id: 'd3', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-duplicate', sequence: 3, timestamp: '2026-01-01T00:00:02.000Z', data: { tool_name: 'Read', tool_input: { file_path: '/test.js' }, tool_use_id: 'tu_dup' } },
    { event_id: 'd4', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-duplicate', sequence: 4, timestamp: '2026-01-01T00:00:03.000Z', data: { tool_name: 'Read', tool_input: { file_path: '/test.js' }, tool_use_id: 'tu_dup' } }, // DUPLICATE
    { event_id: 'd5', event_type: 'ToolCallCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-duplicate', sequence: 5, timestamp: '2026-01-01T00:00:04.000Z', data: { tool_name: 'Read', tool_response: 'content', tool_use_id: 'tu_dup' } },
    { event_id: 'd6', event_type: 'SessionEnded', project_id: 'test-proj-abc123', session_id: 'test-session-duplicate', sequence: 6, timestamp: '2026-01-01T00:00:05.000Z', data: {} },
  ];
}

function fixtureGlobGrepSession() {
  return [
    { event_id: 'g1', event_type: 'SessionStarted', project_id: 'test-proj-abc123', session_id: 'test-session-globgrep', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', data: {} },
    { event_id: 'g2', event_type: 'UserPromptReceived', project_id: 'test-proj-abc123', session_id: 'test-session-globgrep', sequence: 2, timestamp: '2026-01-01T00:00:01.000Z', data: { prompt: 'Find JS files and search for auth' } },
    { event_id: 'g3', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-globgrep', sequence: 3, timestamp: '2026-01-01T00:00:02.000Z', data: { tool_name: 'Glob', tool_input: { pattern: '**/*.js', path: '/src' }, tool_use_id: 'tu_g1' } },
    { event_id: 'g4', event_type: 'ToolCallCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-globgrep', sequence: 4, timestamp: '2026-01-01T00:00:03.000Z', data: { tool_name: 'Glob', tool_response: '/src/auth.js\n/src/login.js\n/src/utils.js', tool_use_id: 'tu_g1' } },
    { event_id: 'g5', event_type: 'ToolCallRequested', project_id: 'test-proj-abc123', session_id: 'test-session-globgrep', sequence: 5, timestamp: '2026-01-01T00:00:04.000Z', data: { tool_name: 'Grep', tool_input: { pattern: 'auth', path: '/src' }, tool_use_id: 'tu_g2' } },
    { event_id: 'g6', event_type: 'ToolCallCompleted', project_id: 'test-proj-abc123', session_id: 'test-session-globgrep', sequence: 6, timestamp: '2026-01-01T00:00:05.000Z', data: { tool_name: 'Grep', tool_response: '/src/auth.js\n/src/login.js', tool_use_id: 'tu_g2' } },
    { event_id: 'g7', event_type: 'SessionEnded', project_id: 'test-proj-abc123', session_id: 'test-session-globgrep', sequence: 7, timestamp: '2026-01-01T00:00:10.000Z', data: {} },
  ];
}

async function setupFixtures(tmpDir) {
  const projectId = 'test-proj-abc123';

  // Standard session
  const stdEvents = fixtureStandardSession();
  const stdDir = path.join(tmpDir, 'events', projectId, 'test-session-001');
  await mkdir(stdDir, { recursive: true });
  for (const evt of stdEvents) {
    const seq = String(evt.sequence).padStart(6, '0');
    await writeFile(path.join(stdDir, `${seq}.json`), JSON.stringify(evt));
  }

  // Empty session
  const emptyDir = path.join(tmpDir, 'events', projectId, 'test-session-empty');
  await mkdir(emptyDir, { recursive: true });

  // Corrupt session
  const corruptEvents = fixtureCorruptSession();
  const corruptDir = path.join(tmpDir, 'events', projectId, 'test-session-corrupt');
  await mkdir(corruptDir, { recursive: true });
  await writeFile(path.join(corruptDir, '000001.json'), JSON.stringify(corruptEvents[0]));
  await writeFile(path.join(corruptDir, '000002.json'), corruptEvents[1]); // raw invalid string
  await writeFile(path.join(corruptDir, '000003.json'), JSON.stringify(corruptEvents[2]));

  // Duplicate session
  const dupEvents = fixtureDuplicateSession();
  const dupDir = path.join(tmpDir, 'events', projectId, 'test-session-duplicate');
  await mkdir(dupDir, { recursive: true });
  for (const evt of dupEvents) {
    const seq = String(evt.sequence).padStart(6, '0');
    await writeFile(path.join(dupDir, `${seq}.json`), JSON.stringify(evt));
  }

  // Glob/Grep session
  const ggEvents = fixtureGlobGrepSession();
  const ggDir = path.join(tmpDir, 'events', projectId, 'test-session-globgrep');
  await mkdir(ggDir, { recursive: true });
  for (const evt of ggEvents) {
    const seq = String(evt.sequence).padStart(6, '0');
    await writeFile(path.join(ggDir, `${seq}.json`), JSON.stringify(evt));
  }

  return projectId;
}

// ============= TESTS =============

let tmpDir;
let projectId;

// Setup
tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-integ-'));
projectId = await setupFixtures(tmpDir);

console.log('Test: Integration Tests');
console.log(`  Fixtures at: ${tmpDir}`);

// 1. Schema validation - all projections have required fields
await test('1. Schema: timeline has required fields', async () => {
  const r = await runCli(['timeline', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p._projection_type, 'timeline');
  assert.strictEqual(p._projection_version, 1);
  assert.ok(p._rebuilt_at);
  assert.ok(p._last_sequence >= 14);
  assert.ok(typeof p.entry_count === 'number');
  assert.ok(Array.isArray(p.entries));
});

await test('1. Schema: files-touched has required fields', async () => {
  const r = await runCli(['files', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p._projection_type, 'files-touched');
  assert.strictEqual(p._projection_version, 1);
  assert.ok(Array.isArray(p.files));
  assert.ok(p.stats);
});

await test('1. Schema: decisions has required fields', async () => {
  const r = await runCli(['decisions', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p._projection_type, 'decisions');
  assert.strictEqual(p._projection_version, 1);
  assert.ok(Array.isArray(p.groups));
  assert.ok(p.stats);
});

await test('1. Schema: summary has required fields', async () => {
  const r = await runCli(['summary', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p._projection_type, 'summary');
  assert.strictEqual(p._projection_version, 1);
  assert.ok(typeof p.event_count === 'number');
  assert.ok(p.narrative);
});

await test('1. Schema: context has required fields', async () => {
  const r = await runCli(['context', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p._projection_type, 'context');
  assert.strictEqual(p._projection_version, 1);
  assert.ok(p.session);
  assert.ok(Array.isArray(p.prompts));
  assert.ok(Array.isArray(p.key_tool_calls));
  assert.ok(p.last_state);
});

// 2. Timeline accuracy
await test('2. Timeline: 14 entries, correct order', async () => {
  const r = await runCli(['timeline', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.entry_count, 14);
  for (let i = 0; i < p.entries.length - 1; i++) {
    assert.ok(p.entries[i].sequence < p.entries[i + 1].sequence);
  }
});

// 3. Files Touched accuracy
await test('3. Files: auth.test.js has read + edit operations', async () => {
  const r = await runCli(['files', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  const p = JSON.parse(r.stdout);
  const authFile = p.files.find(f => f.path.includes('auth.test.js'));
  assert.ok(authFile, 'auth.test.js should be in files');
  const opTypes = authFile.operations.map(o => o.type);
  assert.ok(opTypes.includes('read'), 'should have read operation');
  assert.ok(opTypes.includes('edit'), 'should have edit operation');
});

await test('3. Files: grep results include matched files (G-2)', async () => {
  const r = await runCli(['files', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  const p = JSON.parse(r.stdout);
  const grepFiles = p.files.filter(f => f.operations.some(o => o.type === 'grep'));
  assert.ok(grepFiles.length >= 2, `Expected at least 2 grepped files, got ${grepFiles.length}`);
});

// 4. Decisions accuracy
await test('4. Decisions: 2 groups with correct action counts', async () => {
  const r = await runCli(['decisions', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.group_count, 2);
  assert.strictEqual(p.groups[0].action_count, 3); // Read, Edit, Bash
  assert.strictEqual(p.groups[1].action_count, 1); // Grep
});

// 5. Summary accuracy
await test('5. Summary: event_count=14, tools include Read,Edit,Bash,Grep', async () => {
  const r = await runCli(['summary', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.event_count, 14);
  assert.ok(p.tools_used['Read']);
  assert.ok(p.tools_used['Edit']);
  assert.ok(p.tools_used['Bash']);
  assert.ok(p.tools_used['Grep']);
});

// 6. Context accuracy
await test('6. Context: 2 prompts, paired tool calls, correct last_state', async () => {
  const r = await runCli(['context', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.prompts.length, 2);
  // Check tool call pairing
  const readCall = p.key_tool_calls.find(tc => tc.tool_use_id === 'tu_001');
  assert.ok(readCall);
  assert.strictEqual(readCall.success, true);
  // last_state should reflect the Grep result
  assert.ok(p.last_state.last_tool_call.includes('Grep'));
});

// 7. Empty session
await test('7. Empty session: all projections produce valid output', async () => {
  for (const type of ['timeline', 'files', 'decisions', 'summary', 'context']) {
    const r = await runCli([type, 'test-session-empty', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0, `${type} should exit 0 for empty session`);
    const p = JSON.parse(r.stdout);
    assert.ok(p._projection_type, `${type} should have _projection_type`);
  }
});

// 8. Corrupt session
await test('8. Corrupt: corrupt event skipped, valid events processed', async () => {
  const r = await runCli(['timeline', 'test-session-corrupt', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.entry_count, 2); // 1 and 3, not 2 (corrupt)
  assert.ok(r.stderr.includes('Corrupt') || r.stderr.includes('WARNING'));
});

// 9. Duplicate events (G-1)
await test('9. Duplicate: only first tool_use_id event is processed (G-1)', async () => {
  const r = await runCli(['timeline', 'test-session-duplicate', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  // 6 events total, but sequence 4 is a duplicate of 3 (same tool_use_id + event_type)
  assert.strictEqual(p.entry_count, 5);
  assert.ok(r.stderr.includes('Duplicate'));
});

// 10. Glob/Grep response extraction (G-2)
await test('10. Glob/Grep: files from tool_response recorded (G-2)', async () => {
  const r = await runCli(['files', 'test-session-globgrep', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  // Glob response has 3 files, Grep response has 2 files
  const globFiles = p.files.filter(f => f.operations.some(o => o.type === 'glob'));
  const grepFiles = p.files.filter(f => f.operations.some(o => o.type === 'grep'));
  // At least the glob pattern + 3 matched files
  assert.ok(globFiles.length >= 3, `Expected at least 3 glob files, got ${globFiles.length}`);
  assert.ok(grepFiles.length >= 2, `Expected at least 2 grep files, got ${grepFiles.length}`);
});

// 11. Format outputs
await test('11. Formats: JSON/text/markdown validated for timeline', async () => {
  // JSON
  const rj = await runCli(['timeline', 'test-session-001', '--project', projectId, '--format', 'json', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  JSON.parse(rj.stdout); // should not throw

  // Text
  const rt = await runCli(['timeline', 'test-session-001', '--project', projectId, '--format', 'text', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.ok(rt.stdout.includes('SessionStarted'));
  assert.throws(() => JSON.parse(rt.stdout)); // should not be JSON

  // Markdown
  const rm = await runCli(['timeline', 'test-session-001', '--project', projectId, '--format', 'markdown', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.ok(rm.stdout.includes('# Timeline'));
  assert.ok(rm.stdout.includes('|'));
});

await test('11. Formats: all projections produce valid text output', async () => {
  for (const type of ['timeline', 'files', 'decisions', 'summary', 'context']) {
    const r = await runCli([type, 'test-session-001', '--project', projectId, '--format', 'text', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0, `${type} text format should succeed`);
    assert.ok(r.stdout.length > 0, `${type} text should produce output`);
  }
});

await test('11. Formats: all projections produce valid markdown output', async () => {
  for (const type of ['timeline', 'files', 'decisions', 'summary', 'context']) {
    const r = await runCli([type, 'test-session-001', '--project', projectId, '--format', 'markdown', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0, `${type} markdown format should succeed`);
    assert.ok(r.stdout.includes('#'), `${type} markdown should have headers`);
  }
});

// 12. Incremental rebuild
await test('12. Incremental: build, add events, rebuild, compare with full', async () => {
  // First build
  const r1 = await runCli(['timeline', 'test-session-001', '--project', projectId, '--quiet'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r1.code, 0);

  // Add 2 more events
  const eventsDir = path.join(tmpDir, 'events', projectId, 'test-session-001');
  await writeFile(path.join(eventsDir, '000015.json'), JSON.stringify({
    event_id: 'e15', event_type: 'UserPromptReceived', project_id: projectId,
    session_id: 'test-session-001', sequence: 15, timestamp: '2026-01-01T00:02:00.000Z',
    data: { prompt: 'Added event 15' },
  }));
  await writeFile(path.join(eventsDir, '000016.json'), JSON.stringify({
    event_id: 'e16', event_type: 'SessionEnded', project_id: projectId,
    session_id: 'test-session-001', sequence: 16, timestamp: '2026-01-01T00:02:30.000Z',
    data: {},
  }));

  // Incremental rebuild
  const r2 = await runCli(['timeline', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r2.code, 0);
  const incr = JSON.parse(r2.stdout);
  assert.strictEqual(incr.entry_count, 16);

  // Full rebuild
  const r3 = await runCli(['timeline', 'test-session-001', '--project', projectId, '--rebuild', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r3.code, 0);
  const full = JSON.parse(r3.stdout);
  assert.strictEqual(full.entry_count, 16);

  // Compare (ignoring _rebuilt_at)
  assert.strictEqual(incr.entry_count, full.entry_count);
  for (let i = 0; i < full.entries.length; i++) {
    assert.strictEqual(incr.entries[i].sequence, full.entries[i].sequence);
    assert.strictEqual(incr.entries[i].event_type, full.entries[i].event_type);
  }
});

// 13. Range filtering
await test('13. Range: --from 5 --to 10 produces 6 events', async () => {
  const r = await runCli(['timeline', 'test-session-001', '--project', projectId, '--from', '5', '--to', '10', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.entry_count, 6);
  assert.strictEqual(p.entries[0].sequence, 5);
  assert.strictEqual(p.entries[5].sequence, 10);
});

// 14. CLAUDE_CONTEXT_PATH
await test('14. CLAUDE_CONTEXT_PATH changes base path', async () => {
  // Create a separate store
  const altDir = await mkdtemp(path.join(os.tmpdir(), 'gc-alt-'));
  const altEventsDir = path.join(altDir, 'events', 'alt-proj-xyz999', 'alt-sess');
  await mkdir(altEventsDir, { recursive: true });
  await writeFile(path.join(altEventsDir, '000001.json'), JSON.stringify({
    event_id: 'a1', event_type: 'SessionStarted', project_id: 'alt-proj-xyz999',
    session_id: 'alt-sess', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z',
    data: { model: 'test' },
  }));
  try {
    const r = await runCli(['timeline', 'alt-sess', '--project', 'alt-proj-xyz999', '--output', '-'], { CLAUDE_CONTEXT_PATH: altDir });
    assert.strictEqual(r.code, 0);
    const p = JSON.parse(r.stdout);
    assert.strictEqual(p.entry_count, 1);
  } finally {
    await rm(altDir, { recursive: true });
  }
});

// 15. Version mismatch
await test('15. Version mismatch triggers auto-rebuild', async () => {
  // Write a projection with wrong version
  const projDir = path.join(tmpDir, 'projections', projectId, 'test-session-001');
  await mkdir(projDir, { recursive: true });
  await writeFile(path.join(projDir, 'timeline.json'), JSON.stringify({
    _projection_type: 'timeline',
    _projection_version: 999,
    _rebuilt_at: '2026-01-01T00:00:00.000Z',
    _last_sequence: 16,
    entry_count: 0,
    entries: [],
  }));

  const r = await runCli(['timeline', 'test-session-001', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p._projection_version, 1);
  assert.ok(p.entry_count > 0); // full rebuild happened
  assert.ok(r.stderr.includes('version mismatch'));
});

// 16. Performance
await test('16. Performance: 1000 events processed in under 2 seconds', async () => {
  const perfDir = path.join(tmpDir, 'events', projectId, 'test-session-perf');
  await mkdir(perfDir, { recursive: true });
  for (let i = 1; i <= 1000; i++) {
    const seq = String(i).padStart(6, '0');
    await writeFile(path.join(perfDir, `${seq}.json`), JSON.stringify({
      event_id: `p${i}`, event_type: 'ToolCallRequested', project_id: projectId,
      session_id: 'test-session-perf', sequence: i,
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { tool_name: 'Read', tool_input: { file_path: `/file${i}.js` }, tool_use_id: `tu_p${i}` },
    }));
  }

  const start = Date.now();
  const r = await runCli(['summary', 'test-session-perf', '--project', projectId, '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
  const elapsed = Date.now() - start;
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.event_count, 1000);
  assert.ok(elapsed < 5000, `Took ${elapsed}ms, expected < 5000ms`);
  console.log(`    (took ${elapsed}ms)`);
});

// Cleanup
await rm(tmpDir, { recursive: true });

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
