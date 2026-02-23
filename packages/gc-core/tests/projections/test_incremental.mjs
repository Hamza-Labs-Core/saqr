// tests/projections/test_incremental.mjs -- Tests for incremental rebuild logic
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { buildProjection } from '../../src/projections/lib/incremental.mjs';
import { CURRENT_PROJECTION_VERSION } from '../../src/projections/lib/registry.mjs';

let passed = 0;
let failed = 0;
const stderrMessages = [];
const origStderrWrite = process.stderr.write.bind(process.stderr);

function captureStderr() {
  stderrMessages.length = 0;
  process.stderr.write = (msg) => { stderrMessages.push(msg); return true; };
}
function restoreStderr() {
  process.stderr.write = origStderrWrite;
}

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

// Simple timeline-like handler for testing
function makeTestHandler() {
  return {
    handler: {
      init(existing) {
        if (existing) {
          return { entries: existing.entries || [], count: (existing.entries || []).length };
        }
        return { entries: [], count: 0 };
      },
      handle(state, event) {
        state.entries.push({ seq: event.sequence, type: event.event_type });
        state.count++;
        return state;
      },
      finalize(state) {
        return {
          _projection_type: 'test',
          _projection_version: CURRENT_PROJECTION_VERSION,
          _rebuilt_at: new Date().toISOString(),
          _last_sequence: state.entries.length > 0 ? state.entries[state.entries.length - 1].seq : 0,
          entries: state.entries,
          entry_count: state.entries.length,
        };
      },
    },
    version: CURRENT_PROJECTION_VERSION,
    outputFile: 'test.json',
    formatters: { json: (p) => JSON.stringify(p, null, 2) },
  };
}

async function createEventFiles(tmpDir, projectId, sessionId, events) {
  const eventsDir = path.join(tmpDir, 'events', projectId, sessionId);
  await mkdir(eventsDir, { recursive: true });
  for (const event of events) {
    const seq = String(event.sequence).padStart(6, '0');
    await writeFile(path.join(eventsDir, `${seq}.json`), JSON.stringify(event));
  }
  return eventsDir;
}

async function writeExistingProjection(tmpDir, projectId, sessionId, outputFile, projection) {
  const projDir = path.join(tmpDir, 'projections', projectId, sessionId);
  await mkdir(projDir, { recursive: true });
  await writeFile(path.join(projDir, outputFile), JSON.stringify(projection));
}

console.log('Test: incremental.mjs');

await test('full build processes all events', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-incr-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';
  const events = [];
  for (let i = 1; i <= 10; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: '2026-01-01T00:00:00.000Z', data: {} });
  }
  await createEventFiles(tmpDir, projectId, sessionId, events);
  try {
    const result = await buildProjection(projectId, sessionId, makeTestHandler());
    assert.strictEqual(result.entry_count, 10);
    assert.strictEqual(result._last_sequence, 10);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('no new events returns existing projection unchanged', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-incr-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';

  // 10 events
  const events = [];
  for (let i = 1; i <= 10; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: '2026-01-01T00:00:00.000Z', data: {} });
  }
  await createEventFiles(tmpDir, projectId, sessionId, events);

  // Existing projection covering all 10
  const existing = {
    _projection_type: 'test',
    _projection_version: CURRENT_PROJECTION_VERSION,
    _rebuilt_at: '2026-01-01T00:00:00.000Z',
    _last_sequence: 10,
    entries: events.map(e => ({ seq: e.sequence, type: e.event_type })),
    entry_count: 10,
  };
  await writeExistingProjection(tmpDir, projectId, sessionId, 'test.json', existing);

  try {
    const result = await buildProjection(projectId, sessionId, makeTestHandler());
    // Should return existing as-is
    assert.strictEqual(result.entry_count, 10);
    assert.strictEqual(result._rebuilt_at, '2026-01-01T00:00:00.000Z'); // not updated
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('incremental: adding new events only processes those events', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-incr-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';

  // 20 events total
  const events = [];
  for (let i = 1; i <= 20; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: '2026-01-01T00:00:00.000Z', data: {} });
  }
  await createEventFiles(tmpDir, projectId, sessionId, events);

  // Existing projection covering first 10
  const existing = {
    _projection_type: 'test',
    _projection_version: CURRENT_PROJECTION_VERSION,
    _rebuilt_at: '2026-01-01T00:00:00.000Z',
    _last_sequence: 10,
    entries: events.slice(0, 10).map(e => ({ seq: e.sequence, type: e.event_type })),
    entry_count: 10,
  };
  await writeExistingProjection(tmpDir, projectId, sessionId, 'test.json', existing);

  try {
    const result = await buildProjection(projectId, sessionId, makeTestHandler());
    assert.strictEqual(result.entry_count, 20); // existing 10 + new 10
    assert.strictEqual(result._last_sequence, 20);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('--rebuild forces full reprocessing', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-incr-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';

  const events = [];
  for (let i = 1; i <= 10; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: '2026-01-01T00:00:00.000Z', data: {} });
  }
  await createEventFiles(tmpDir, projectId, sessionId, events);

  // Existing projection
  const existing = {
    _projection_type: 'test',
    _projection_version: CURRENT_PROJECTION_VERSION,
    _rebuilt_at: '2026-01-01T00:00:00.000Z',
    _last_sequence: 10,
    entries: events.map(e => ({ seq: e.sequence, type: e.event_type })),
    entry_count: 10,
  };
  await writeExistingProjection(tmpDir, projectId, sessionId, 'test.json', existing);

  try {
    const result = await buildProjection(projectId, sessionId, makeTestHandler(), { rebuild: true });
    // Should be freshly built (new _rebuilt_at)
    assert.notStrictEqual(result._rebuilt_at, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(result.entry_count, 10);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('version mismatch triggers automatic full rebuild with warning', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-incr-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';

  const events = [];
  for (let i = 1; i <= 5; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: '2026-01-01T00:00:00.000Z', data: {} });
  }
  await createEventFiles(tmpDir, projectId, sessionId, events);

  // Existing projection with version 999 (mismatch)
  const existing = {
    _projection_type: 'test',
    _projection_version: 999,
    _rebuilt_at: '2026-01-01T00:00:00.000Z',
    _last_sequence: 5,
    entries: events.map(e => ({ seq: e.sequence, type: e.event_type })),
    entry_count: 5,
  };
  await writeExistingProjection(tmpDir, projectId, sessionId, 'test.json', existing);

  captureStderr();
  try {
    const result = await buildProjection(projectId, sessionId, makeTestHandler());
    assert.strictEqual(result.entry_count, 5);
    assert.ok(stderrMessages.some(m => m.includes('version mismatch')));
  } finally {
    restoreStderr();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('incremental produces same results as full rebuild', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-incr-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';

  const events = [];
  for (let i = 1; i <= 20; i++) {
    events.push({ event_type: `Event${i}`, sequence: i, timestamp: '2026-01-01T00:00:00.000Z', data: {} });
  }
  await createEventFiles(tmpDir, projectId, sessionId, events);

  // Full rebuild
  const fullResult = await buildProjection(projectId, sessionId, makeTestHandler(), { rebuild: true });

  // Now create existing with first 10 and do incremental
  const existing = {
    _projection_type: 'test',
    _projection_version: CURRENT_PROJECTION_VERSION,
    _rebuilt_at: '2026-01-01T00:00:00.000Z',
    _last_sequence: 10,
    entries: events.slice(0, 10).map(e => ({ seq: e.sequence, type: e.event_type })),
    entry_count: 10,
  };
  await writeExistingProjection(tmpDir, projectId, sessionId, 'test.json', existing);

  try {
    const incrResult = await buildProjection(projectId, sessionId, makeTestHandler());
    assert.strictEqual(incrResult.entry_count, fullResult.entry_count);
    assert.strictEqual(incrResult._last_sequence, fullResult._last_sequence);
    // Check entries match
    for (let i = 0; i < fullResult.entries.length; i++) {
      assert.strictEqual(incrResult.entries[i].seq, fullResult.entries[i].seq);
      assert.strictEqual(incrResult.entries[i].type, fullResult.entries[i].type);
    }
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
