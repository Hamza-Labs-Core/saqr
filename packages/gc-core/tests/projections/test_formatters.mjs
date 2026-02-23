// tests/projections/test_formatters.mjs -- Tests for output format system
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { outputProjection, renderTextHeader, renderMarkdownTable } from '../../src/projections/lib/formatters.mjs';

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

// Capture stdout
const stdoutChunks = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
function captureStdout() {
  stdoutChunks.length = 0;
  process.stdout.write = (chunk) => { stdoutChunks.push(chunk); return true; };
}
function restoreStdout() {
  process.stdout.write = origStdoutWrite;
}
function getStdout() {
  return stdoutChunks.join('');
}

const sampleProjection = {
  _projection_type: 'test',
  _projection_version: 1,
  _session_id: 'sess-1',
  data: 'hello',
};

const sampleDef = {
  outputFile: 'test.json',
  formatters: {
    json: (p) => JSON.stringify(p, null, 2),
    text: (p) => `Type: ${p._projection_type}\nData: ${p.data}`,
    markdown: (p) => `# ${p._projection_type}\n\n${p.data}`,
  },
};

console.log('Test: formatters.mjs');

await test('--format json produces valid pretty-printed JSON', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-fmt-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStdout();
  try {
    await outputProjection(sampleProjection, sampleDef, {
      format: 'json',
      output: '-',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    const out = getStdout();
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed._projection_type, 'test');
  } finally {
    restoreStdout();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('--format text produces clean plain text', async () => {
  captureStdout();
  try {
    await outputProjection(sampleProjection, sampleDef, {
      format: 'text',
      output: '-',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    const out = getStdout();
    assert.ok(out.includes('Type: test'));
    assert.ok(out.includes('Data: hello'));
    assert.ok(!out.includes('"_projection_type"'));
  } finally {
    restoreStdout();
  }
});

await test('--format markdown produces valid markdown', async () => {
  captureStdout();
  try {
    await outputProjection(sampleProjection, sampleDef, {
      format: 'markdown',
      output: '-',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    const out = getStdout();
    assert.ok(out.includes('# test'));
  } finally {
    restoreStdout();
  }
});

await test('--output - does NOT write a file', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-fmt-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStdout();
  try {
    await outputProjection(sampleProjection, sampleDef, {
      format: 'json',
      output: '-',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    // Check no file written in projections dir
    try {
      await stat(path.join(tmpDir, 'projections', 'proj-1', 'sess-1', 'test.json'));
      assert.fail('File should not have been written');
    } catch (e) {
      assert.strictEqual(e.code, 'ENOENT');
    }
  } finally {
    restoreStdout();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('default output writes JSON file AND prints to stdout', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-fmt-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStdout();
  try {
    await outputProjection(sampleProjection, sampleDef, {
      format: 'json',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    // File should exist
    const filePath = path.join(tmpDir, 'projections', 'proj-1', 'sess-1', 'test.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed._projection_type, 'test');
    // Stdout should also have output
    const out = getStdout();
    assert.ok(out.includes('test'));
  } finally {
    restoreStdout();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('projection directory is created if it does not exist', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-fmt-'));
  const origPath = process.env.CLAUDE_CONTEXT_PATH;
  process.env.CLAUDE_CONTEXT_PATH = tmpDir;
  captureStdout();
  try {
    await outputProjection(sampleProjection, sampleDef, {
      format: 'json',
      projectId: 'brand-new-proj',
      sessionId: 'brand-new-sess',
    });
    const filePath = path.join(tmpDir, 'projections', 'brand-new-proj', 'brand-new-sess', 'test.json');
    await stat(filePath); // Should not throw
  } finally {
    restoreStdout();
    process.env.CLAUDE_CONTEXT_PATH = origPath;
    await rm(tmpDir, { recursive: true });
  }
});

await test('unknown format throws error', async () => {
  try {
    await outputProjection(sampleProjection, sampleDef, {
      format: 'xml',
      output: '-',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('Unknown format'));
  }
});

await test('renderTextHeader produces title with underline', async () => {
  const header = renderTextHeader('My Title', 'subtitle');
  assert.ok(header.includes('My Title'));
  assert.ok(header.includes('========'));
  assert.ok(header.includes('subtitle'));
});

await test('renderMarkdownTable produces valid table', async () => {
  const table = renderMarkdownTable(['Name', 'Value'], [['A', '1'], ['B', '2']]);
  assert.ok(table.includes('| Name | Value |'));
  assert.ok(table.includes('|---|---|'));
  assert.ok(table.includes('| A | 1 |'));
  assert.ok(table.includes('| B | 2 |'));
});

await test('renderMarkdownTable escapes pipes in cells', async () => {
  const table = renderMarkdownTable(['Name'], [['A | B']]);
  assert.ok(table.includes('A \\| B'));
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
