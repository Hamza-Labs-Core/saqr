// tests/projections/test_replay.mjs -- Tests for event replay engine
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { replayThrough, getHighestSequence } from '../../src/projections/lib/replay.mjs';

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

// Helper: create event files in a temp dir
async function setupEvents(events, opts = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-replay-'));
  const projectId = opts.projectId || 'test-proj-abc123';
  const sessionId = opts.sessionId || 'test-session';
  const eventsDir = path.join(tmpDir, 'events', projectId, sessionId);
  await mkdir(eventsDir, { recursive: true });

  for (const event of events) {
    const seq = String(event.sequence).padStart(6, '0');
    await writeFile(path.join(eventsDir, `${seq}.json`), JSON.stringify(event));
  }

  return { tmpDir, projectId, sessionId };
}

// Simple counting handler
function countingHandler() {
  return {
    init: (existing) => existing || { count: 0, events: [] },
    handle: (state, event) => ({
      count: state.count + 1,
      events: [...state.events, event.sequence],
    }),
    finalize: (state) => state,
  };
}

console.log('Test: replay.mjs');

await test('14 events processed in order', async () => {
  const events = [];
  for (let i = 1; i <= 14; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, data: {} });
  }
  const { tmpDir, projectId, sessionId } = await setupEvents(events);
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  try {
    const result = await replayThrough(projectId, sessionId, countingHandler());
    assert.strictEqual(result.count, 14);
    assert.deepStrictEqual(result.events, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('from/to range filtering (5 to 10 = 6 events)', async () => {
  const events = [];
  for (let i = 1; i <= 14; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: `2026-01-01T00:00:00.000Z`, data: {} });
  }
  const { tmpDir, projectId, sessionId } = await setupEvents(events);
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  try {
    const result = await replayThrough(projectId, sessionId, countingHandler(), { from: 5, to: 10 });
    assert.strictEqual(result.count, 6);
    assert.deepStrictEqual(result.events, [5, 6, 7, 8, 9, 10]);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('corrupt JSON logs warning and continues', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-replay-'));
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';
  const eventsDir = path.join(tmpDir, 'events', projectId, sessionId);
  await mkdir(eventsDir, { recursive: true });

  await writeFile(path.join(eventsDir, '000001.json'), JSON.stringify({ event_type: 'A', sequence: 1, data: {} }));
  await writeFile(path.join(eventsDir, '000002.json'), '{invalid');
  await writeFile(path.join(eventsDir, '000003.json'), JSON.stringify({ event_type: 'B', sequence: 3, data: {} }));

  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStderr();
  try {
    const result = await replayThrough(projectId, sessionId, countingHandler());
    assert.strictEqual(result.count, 2); // 1 and 3, not 2
    assert.ok(stderrMessages.some(m => m.includes('Corrupt JSON')));
  } finally {
    restoreStderr();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('sequence gap logs warning and continues', async () => {
  const events = [
    { event_type: 'A', sequence: 1, data: {} },
    { event_type: 'B', sequence: 2, data: {} },
    { event_type: 'D', sequence: 4, data: {} }, // missing 3
  ];
  const { tmpDir, projectId, sessionId } = await setupEvents(events);
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStderr();
  try {
    const result = await replayThrough(projectId, sessionId, countingHandler());
    assert.strictEqual(result.count, 3);
    assert.ok(stderrMessages.some(m => m.includes('Sequence gap')));
  } finally {
    restoreStderr();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('event missing event_type is skipped with warning', async () => {
  const events = [
    { event_type: 'A', sequence: 1, data: {} },
    { sequence: 2, data: {} }, // missing event_type
    { event_type: 'C', sequence: 3, data: {} },
  ];
  const { tmpDir, projectId, sessionId } = await setupEvents(events);
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStderr();
  try {
    const result = await replayThrough(projectId, sessionId, countingHandler());
    assert.strictEqual(result.count, 2);
    assert.ok(stderrMessages.some(m => m.includes('Missing required fields')));
  } finally {
    restoreStderr();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('duplicate tool_use_id: only first is processed (G-1)', async () => {
  const events = [
    { event_type: 'ToolCallRequested', sequence: 1, data: { tool_use_id: 'tu_001', tool_name: 'Read' } },
    { event_type: 'ToolCallRequested', sequence: 2, data: { tool_use_id: 'tu_001', tool_name: 'Read' } }, // duplicate
    { event_type: 'ToolCallCompleted', sequence: 3, data: { tool_use_id: 'tu_001', tool_name: 'Read' } },
  ];
  const { tmpDir, projectId, sessionId } = await setupEvents(events);
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStderr();
  try {
    const result = await replayThrough(projectId, sessionId, countingHandler());
    assert.strictEqual(result.count, 2); // only first ToolCallRequested + ToolCallCompleted
    assert.ok(stderrMessages.some(m => m.includes('Duplicate event detected')));
  } finally {
    restoreStderr();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('empty directory produces zero handle calls', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-replay-'));
  const projectId = 'test-proj-abc123';
  const sessionId = 'test-session';
  const eventsDir = path.join(tmpDir, 'events', projectId, sessionId);
  await mkdir(eventsDir, { recursive: true });

  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  try {
    const result = await replayThrough(projectId, sessionId, countingHandler());
    assert.strictEqual(result.count, 0);
    assert.deepStrictEqual(result.events, []);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('non-existent directory produces zero handle calls', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-replay-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  try {
    const result = await replayThrough('no-proj-abc123', 'no-session', countingHandler());
    assert.strictEqual(result.count, 0);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('getHighestSequence returns correct value', async () => {
  const events = [];
  for (let i = 1; i <= 10; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, data: {} });
  }
  const { tmpDir, projectId, sessionId } = await setupEvents(events);
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  try {
    const highest = await getHighestSequence(projectId, sessionId);
    assert.strictEqual(highest, 10);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('1000 events processed in under 2 seconds', async () => {
  const events = [];
  for (let i = 1; i <= 1000; i++) {
    events.push({ event_type: 'TestEvent', sequence: i, timestamp: `2026-01-01T00:00:00.000Z`, data: { value: i } });
  }
  const { tmpDir, projectId, sessionId } = await setupEvents(events);
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  try {
    const start = Date.now();
    const result = await replayThrough(projectId, sessionId, countingHandler());
    const elapsed = Date.now() - start;
    assert.strictEqual(result.count, 1000);
    assert.ok(elapsed < 2000, `Took ${elapsed}ms, expected < 2000ms`);
  } finally {
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
