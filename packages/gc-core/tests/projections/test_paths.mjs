// tests/projections/test_paths.mjs -- Tests for base path resolution and shared utilities
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { getBasePath, getEventsDir, getProjectionsDir, getLatestSymlink } from '../../src/projections/lib/paths.mjs';
import { truncate, safeJsonParse, atomicWrite, formatDuration, warn } from '../../src/projections/lib/utils.mjs';

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

console.log('Test: paths.mjs');

// --- getBasePath ---
await test('getBasePath returns CLAUDE_CONTEXT_PATH when set', async () => {
  const orig = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = '/tmp/test-gc';
  try {
    assert.strictEqual(getBasePath(), '/tmp/test-gc');
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_CONTEXT_PATH;
    else process.env.CLAUDE_CONTEXT_PATH = orig;
  }
});

await test('getBasePath returns ~/.claude-context by default', async () => {
  const orig = process.env.CLAUDE_CONTEXT_PATH;
  delete process.env.CLAUDE_CONTEXT_PATH;
  try {
    assert.strictEqual(getBasePath(), path.join(os.homedir(), '.claude-context'));
  } finally {
    if (orig !== undefined) process.env.CLAUDE_CONTEXT_PATH = orig;
  }
});

// --- getEventsDir ---
await test('getEventsDir returns correct path with project and session', async () => {
  const orig = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = '/tmp/test-gc';
  try {
    assert.strictEqual(getEventsDir('proj-abc123', 'sess-1'), '/tmp/test-gc/events/proj-abc123/sess-1');
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_CONTEXT_PATH;
    else process.env.CLAUDE_CONTEXT_PATH = orig;
  }
});

await test('getEventsDir throws without projectId or sessionId', async () => {
  assert.throws(() => getEventsDir(null, 'sess-1'));
  assert.throws(() => getEventsDir('proj-abc123', null));
});

// --- getProjectionsDir ---
await test('getProjectionsDir returns correct path', async () => {
  const orig = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = '/tmp/test-gc';
  try {
    assert.strictEqual(getProjectionsDir('proj-abc123', 'sess-1'), '/tmp/test-gc/projections/proj-abc123/sess-1');
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_CONTEXT_PATH;
    else process.env.CLAUDE_CONTEXT_PATH = orig;
  }
});

// --- getLatestSymlink ---
await test('getLatestSymlink returns correct per-project path', async () => {
  const orig = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = '/tmp/test-gc';
  try {
    assert.strictEqual(getLatestSymlink('proj-abc123'), '/tmp/test-gc/projections/proj-abc123/latest');
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_CONTEXT_PATH;
    else process.env.CLAUDE_CONTEXT_PATH = orig;
  }
});

console.log('\nTest: utils.mjs');

// --- truncate ---
await test('truncate short string returns unchanged', async () => {
  assert.strictEqual(truncate('hi', 5), 'hi');
});

await test('truncate at boundary returns unchanged', async () => {
  assert.strictEqual(truncate('hello', 5), 'hello');
});

await test('truncate long string adds suffix', async () => {
  assert.strictEqual(truncate('hello world', 5), 'hello...');
});

await test('truncate with custom suffix', async () => {
  assert.strictEqual(truncate('hello world', 5, '~'), 'hello~');
});

await test('truncate non-string returns empty', async () => {
  assert.strictEqual(truncate(null, 5), '');
  assert.strictEqual(truncate(undefined, 5), '');
  assert.strictEqual(truncate(42, 5), '');
});

// --- safeJsonParse ---
await test('safeJsonParse valid JSON', async () => {
  const r = safeJsonParse('{"a":1}', 'test.json');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, { a: 1 });
  assert.strictEqual(r.error, null);
});

await test('safeJsonParse invalid JSON', async () => {
  const r = safeJsonParse('{invalid', 'bad.json');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.data, null);
  assert.ok(r.error.includes('bad.json'));
});

// --- formatDuration ---
await test('formatDuration 0 seconds', async () => {
  assert.strictEqual(formatDuration(0), '0m');
});

await test('formatDuration 300 seconds = 5m', async () => {
  assert.strictEqual(formatDuration(300), '5m');
});

await test('formatDuration 5400 seconds = 1h 30m', async () => {
  assert.strictEqual(formatDuration(5400), '1h 30m');
});

await test('formatDuration 7200 seconds = 2h 0m', async () => {
  assert.strictEqual(formatDuration(7200), '2h 0m');
});

await test('formatDuration null/NaN', async () => {
  assert.strictEqual(formatDuration(null), '0m');
  assert.strictEqual(formatDuration(NaN), '0m');
  assert.strictEqual(formatDuration(-5), '0m');
});

// --- atomicWrite ---
await test('atomicWrite creates file with correct content', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-test-'));
  try {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWrite(filePath, '{"hello":"world"}');
    const content = await readFile(filePath, 'utf-8');
    assert.strictEqual(content, '{"hello":"world"}');
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

await test('atomicWrite overwrites existing file', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-test-'));
  try {
    const filePath = path.join(tmpDir, 'test.json');
    await writeFile(filePath, 'old content');
    await atomicWrite(filePath, 'new content');
    const content = await readFile(filePath, 'utf-8');
    assert.strictEqual(content, 'new content');
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
