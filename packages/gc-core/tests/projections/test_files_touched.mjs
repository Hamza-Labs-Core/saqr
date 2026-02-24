// tests/projections/test_files_touched.mjs -- Tests for files-touched projection handler
import assert from 'node:assert';
import { handler, formatJson, formatText, formatMarkdown, extractFromRequest, extractFromResponse } from '../../src/projections/handlers/files-touched.mjs';

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
    data: data || {},
  };
}

console.log('Test: files-touched.mjs');

await test('Read event records read operation', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].path, '/foo/bar.js');
  assert.strictEqual(result.files[0].operations[0].type, 'read');
});

await test('Write event records write operation', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Write', tool_input: { file_path: '/foo/bar.js' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files[0].operations[0].type, 'write');
});

await test('Edit event records edit operation', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Edit', tool_input: { file_path: '/foo/bar.js' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files[0].operations[0].type, 'edit');
});

await test('Glob ToolCallRequested records pattern', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Glob', tool_input: { path: '/src', pattern: '**/*.js' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files[0].path, '/src/**/*.js');
  assert.strictEqual(result.files[0].operations[0].type, 'glob');
});

await test('Glob ToolCallCompleted records matched files (G-2)', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallCompleted', 2, {
    tool_name: 'Glob', tool_response: '/src/a.js\n/src/b.js\n/src/c.js',
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 3);
  assert.ok(result.files.some(f => f.path === '/src/a.js'));
  assert.ok(result.files.some(f => f.path === '/src/b.js'));
  assert.ok(result.files.some(f => f.path === '/src/c.js'));
  for (const f of result.files) {
    assert.strictEqual(f.operations[0].type, 'glob');
  }
});

await test('Grep ToolCallCompleted records matched files (G-2)', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallCompleted', 2, {
    tool_name: 'Grep', tool_response: '/src/auth.js\n/src/login.js',
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 2);
  assert.ok(result.files.some(f => f.path === '/src/auth.js'));
  assert.ok(result.files.some(f => f.path === '/src/login.js'));
  for (const f of result.files) {
    assert.strictEqual(f.operations[0].type, 'grep');
  }
});

await test('Grep content mode extracts filenames', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallCompleted', 2, {
    tool_name: 'Grep', tool_response: '/src/auth.js:10:  const token = ...\n/src/auth.js:20:  return token;\n/src/login.js:5:  expiry check',
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 2);
  assert.ok(result.files.some(f => f.path === '/src/auth.js'));
  assert.ok(result.files.some(f => f.path === '/src/login.js'));
});

await test('Reading same file twice produces one entry with two operations', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' },
  }, '2026-01-01T00:00:01.000Z'));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, {
    tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' },
  }, '2026-01-01T00:00:02.000Z'));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].touch_count, 2);
  assert.strictEqual(result.files[0].operations.length, 2);
  assert.strictEqual(result.files[0].first_touched, '2026-01-01T00:00:01.000Z');
  assert.strictEqual(result.files[0].last_touched, '2026-01-01T00:00:02.000Z');
});

await test('Stats accurately count unique files per operation type', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read', tool_input: { file_path: '/a.js' },
  }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 2, {
    tool_name: 'Read', tool_input: { file_path: '/b.js' },
  }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 3, {
    tool_name: 'Write', tool_input: { file_path: '/c.js' },
  }));
  state = handler.handle(state, makeEvent('ToolCallRequested', 4, {
    tool_name: 'Edit', tool_input: { file_path: '/a.js' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.stats.total_files, 3);
  assert.strictEqual(result.stats.files_read, 2);
  assert.strictEqual(result.stats.files_written, 1);
  assert.strictEqual(result.stats.files_edited, 1);
});

await test('Missing tool_input does not crash', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read',
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 0);
});

await test('Bash cat /etc/hosts extracts read', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Bash', tool_input: { command: 'cat /etc/hosts' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].path, '/etc/hosts');
  assert.strictEqual(result.files[0].operations[0].type, 'read');
});

await test('Unknown tool does not record any file', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'SomeUnknownTool', tool_input: { path: '/foo' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 0);
});

await test('JSON format produces valid JSON', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' },
  }));
  const result = handler.finalize(state);
  const json = formatJson(result);
  const parsed = JSON.parse(json);
  assert.ok(parsed._projection_type);
  assert.ok(Array.isArray(parsed.files));
});

await test('Text format produces clean text', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' },
  }));
  const result = handler.finalize(state);
  const text = formatText(result);
  assert.ok(text.includes('Files Touched:'));
  assert.ok(text.includes('/foo/bar.js'));
  assert.ok(!text.includes('{'));
});

await test('Markdown format produces valid markdown', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' },
  }));
  const result = handler.finalize(state);
  const md = formatMarkdown(result);
  assert.ok(md.includes('# Files Touched'));
  assert.ok(md.includes('|'));
  assert.ok(md.includes('`/foo/bar.js`'));
});

await test('NotebookEdit records edit', async () => {
  let state = handler.init();
  state = handler.handle(state, makeEvent('ToolCallRequested', 1, {
    tool_name: 'NotebookEdit', tool_input: { notebook_path: '/foo/notebook.ipynb' },
  }));
  const result = handler.finalize(state);
  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].path, '/foo/notebook.ipynb');
  assert.strictEqual(result.files[0].operations[0].type, 'edit');
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
