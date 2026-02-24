// tests/projections/test_registry.mjs -- Tests for projection registry
import assert from 'node:assert';
import {
  CURRENT_PROJECTION_VERSION,
  register,
  getProjection,
  listProjections,
  clearRegistry,
} from '../../src/projections/lib/registry.mjs';

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

console.log('Test: registry.mjs');

await test('CURRENT_PROJECTION_VERSION is 1', async () => {
  assert.strictEqual(CURRENT_PROJECTION_VERSION, 1);
});

await test('listProjections returns empty array initially', async () => {
  clearRegistry();
  const list = listProjections();
  assert.ok(Array.isArray(list));
  assert.strictEqual(list.length, 0);
});

await test('getProjection returns null for unknown name', async () => {
  clearRegistry();
  assert.strictEqual(getProjection('bogus'), null);
});

await test('register and getProjection works', async () => {
  clearRegistry();
  const def = {
    name: 'Timeline',
    description: 'Ordered event summary',
    version: 1,
    outputFile: 'timeline.json',
    handler: { init: () => ({}), handle: (s) => s, finalize: (s) => s },
    formatters: { json: () => '{}' },
  };
  register('timeline', def);
  const result = getProjection('timeline');
  assert.strictEqual(result.name, 'Timeline');
  assert.strictEqual(result.version, 1);
  assert.strictEqual(result.outputFile, 'timeline.json');
});

await test('register sets default version if missing', async () => {
  clearRegistry();
  const def = {
    name: 'Test',
    description: 'Test projection',
    outputFile: 'test.json',
    handler: { init: () => ({}), handle: (s) => s, finalize: (s) => s },
    formatters: { json: () => '{}' },
  };
  register('test', def);
  const result = getProjection('test');
  assert.strictEqual(result.version, CURRENT_PROJECTION_VERSION);
});

await test('listProjections returns all registered', async () => {
  clearRegistry();
  register('timeline', { name: 'Timeline', description: 'TL', version: 1, outputFile: 'tl.json', handler: {}, formatters: {} });
  register('files', { name: 'Files', description: 'FL', version: 1, outputFile: 'fl.json', handler: {}, formatters: {} });
  const list = listProjections();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].cliName, 'timeline');
  assert.strictEqual(list[1].cliName, 'files');
});

await test('every registered projection has version: 1', async () => {
  clearRegistry();
  register('a', { name: 'A', description: 'A', version: 1, outputFile: 'a.json', handler: {}, formatters: {} });
  register('b', { name: 'B', description: 'B', outputFile: 'b.json', handler: {}, formatters: {} }); // no version - should default
  const list = listProjections();
  for (const entry of list) {
    assert.strictEqual(entry.version, 1, `${entry.cliName} should have version 1`);
  }
});

await test('getProjection returns null before registration, entry after', async () => {
  clearRegistry();
  assert.strictEqual(getProjection('timeline'), null);
  register('timeline', { name: 'Timeline', description: 'TL', version: 1, outputFile: 'tl.json', handler: {}, formatters: {} });
  assert.notStrictEqual(getProjection('timeline'), null);
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
