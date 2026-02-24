// tests/projections/test_cli.mjs -- Tests for CLI entry point (project script)
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

let passed = 0;
let failed = 0;

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/bin/project');

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

async function runCli(args, env = {}) {
  const fullEnv = { ...process.env, ...env };
  try {
    const { stdout, stderr } = await execFileP('node', [CLI, ...args], {
      env: fullEnv,
      timeout: 10000,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', code: e.code || 1 };
  }
}

async function createTestSession(tmpDir, projectId, sessionId, events) {
  const eventsDir = path.join(tmpDir, 'events', projectId, sessionId);
  await mkdir(eventsDir, { recursive: true });
  for (const event of events) {
    const seq = String(event.sequence).padStart(6, '0');
    await writeFile(path.join(eventsDir, `${seq}.json`), JSON.stringify(event));
  }
}

function standardEvents() {
  return [
    { event_id: 'e1', event_type: 'SessionStarted', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', data: { model: 'claude-opus-4-6', cwd: '/home/user/project' } },
    { event_id: 'e2', event_type: 'UserPromptReceived', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 2, timestamp: '2026-01-01T00:00:01.000Z', data: { prompt: 'Fix the failing test' } },
    { event_id: 'e3', event_type: 'ToolCallRequested', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 3, timestamp: '2026-01-01T00:00:02.000Z', data: { tool_name: 'Read', tool_input: { file_path: '/home/user/project/auth.test.js' }, tool_use_id: 'tu_001' } },
    { event_id: 'e4', event_type: 'ToolCallCompleted', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 4, timestamp: '2026-01-01T00:00:03.000Z', data: { tool_name: 'Read', tool_response: 'file content here', tool_use_id: 'tu_001' } },
    { event_id: 'e5', event_type: 'ToolCallRequested', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 5, timestamp: '2026-01-01T00:00:04.000Z', data: { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/auth.test.js' }, tool_use_id: 'tu_002' } },
    { event_id: 'e6', event_type: 'ToolCallCompleted', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 6, timestamp: '2026-01-01T00:00:05.000Z', data: { tool_name: 'Edit', tool_response: 'ok', tool_use_id: 'tu_002' } },
    { event_id: 'e7', event_type: 'TurnCompleted', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 7, timestamp: '2026-01-01T00:00:06.000Z', data: {} },
    { event_id: 'e8', event_type: 'UserPromptReceived', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 8, timestamp: '2026-01-01T00:00:07.000Z', data: { prompt: 'Search for expiry tests' } },
    { event_id: 'e9', event_type: 'ToolCallRequested', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 9, timestamp: '2026-01-01T00:00:08.000Z', data: { tool_name: 'Grep', tool_input: { pattern: 'expiry', path: '/home/user/project' }, tool_use_id: 'tu_003' } },
    { event_id: 'e10', event_type: 'ToolCallCompleted', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 10, timestamp: '2026-01-01T00:00:09.000Z', data: { tool_name: 'Grep', tool_response: '/a.js\n/b.js', tool_use_id: 'tu_003' } },
    { event_id: 'e11', event_type: 'TurnCompleted', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 11, timestamp: '2026-01-01T00:00:10.000Z', data: {} },
    { event_id: 'e12', event_type: 'SessionEnded', project_id: 'proj-abc123', session_id: 'sess-1', sequence: 12, timestamp: '2026-01-01T00:01:30.000Z', data: {} },
  ];
}

console.log('Test: project CLI');

await test('no arguments prints usage and exits 1', async () => {
  const r = await runCli([]);
  assert.notStrictEqual(r.code, 0);
  assert.ok(r.stderr.includes('Usage'));
});

await test('unknown projection type prints error and exits 1', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  try {
    const r = await runCli(['bogus', 'some-session', '--project', 'proj-abc123'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.notStrictEqual(r.code, 0);
    assert.ok(r.stderr.includes('Unknown projection type'));
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('nonexistent session exits 1', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  try {
    const r = await runCli(['timeline', 'nonexistent-session', '--project', 'proj-abc123'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.notStrictEqual(r.code, 0);
    assert.ok(r.stderr.includes('not found'));
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('project timeline produces valid JSON output', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['timeline', 'sess-1', '--project', 'proj-abc123', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed._projection_type, 'timeline');
    assert.strictEqual(parsed.entry_count, 12);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('project files produces valid output', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['files', 'sess-1', '--project', 'proj-abc123', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed._projection_type, 'files-touched');
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('project decisions produces valid output', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['decisions', 'sess-1', '--project', 'proj-abc123', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed._projection_type, 'decisions');
    assert.strictEqual(parsed.group_count, 2);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('project summary produces valid output', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['summary', 'sess-1', '--project', 'proj-abc123', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed._projection_type, 'summary');
    assert.strictEqual(parsed.event_count, 12);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('project context produces valid output', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['context', 'sess-1', '--project', 'proj-abc123', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed._projection_type, 'context');
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('--format text outputs plain text', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['timeline', 'sess-1', '--project', 'proj-abc123', '--format', 'text', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    // Should not be JSON
    assert.throws(() => JSON.parse(r.stdout));
    assert.ok(r.stdout.includes('SessionStarted'));
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('--format markdown outputs markdown', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['timeline', 'sess-1', '--project', 'proj-abc123', '--format', 'markdown', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('# Timeline'));
    assert.ok(r.stdout.includes('|'));
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('--from and --to limit event range', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['timeline', 'sess-1', '--project', 'proj-abc123', '--from', '3', '--to', '6', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.entry_count, 4); // sequences 3,4,5,6
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('--rebuild forces full rebuild', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['timeline', 'sess-1', '--project', 'proj-abc123', '--rebuild', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.entry_count, 12);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('default output writes JSON file', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  try {
    const r = await runCli(['timeline', 'sess-1', '--project', 'proj-abc123', '--quiet'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    // Check file exists
    const filePath = path.join(tmpDir, 'projections', 'proj-abc123', 'sess-1', 'timeline.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed._projection_type, 'timeline');
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('latest symlink resolution', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-cli-'));
  await createTestSession(tmpDir, 'proj-abc123', 'sess-1', standardEvents());
  // Create latest symlink
  const projDir = path.join(tmpDir, 'projections', 'proj-abc123');
  await mkdir(projDir, { recursive: true });
  await symlink('sess-1', path.join(projDir, 'latest'));
  try {
    const r = await runCli(['timeline', 'latest', '--project', 'proj-abc123', '--output', '-'], { CLAUDE_CONTEXT_PATH: tmpDir });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.entry_count, 12);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
