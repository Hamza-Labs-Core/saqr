// tests/projections/run-all.mjs -- Unified test runner for all projection tests.
// Runs all 12 test files sequentially and prints a combined summary.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testFiles = [
  'test_paths.mjs',
  'test_registry.mjs',
  'test_replay.mjs',
  'test_timeline.mjs',
  'test_files_touched.mjs',
  'test_decisions.mjs',
  'test_summary.mjs',
  'test_context_snapshot.mjs',
  'test_formatters.mjs',
  'test_incremental.mjs',
  'test_cli.mjs',
  'test_integration.mjs',
];

let totalPassed = 0;
let totalFailed = 0;
let filesPassed = 0;
let filesFailed = 0;
const failures = [];

console.log('='.repeat(60));
console.log('  GlobalContext Projection Engine — Test Suite');
console.log('='.repeat(60));
console.log();

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  const label = file.replace(/^test_/, '').replace(/\.mjs$/, '');

  try {
    const { stdout, stderr } = await execFileP('node', [filePath], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });

    // Parse pass/fail counts from the "Results: X passed, Y failed" line
    const match = stdout.match(/Results:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    const passed = match ? parseInt(match[1], 10) : 0;
    const failed = match ? parseInt(match[2], 10) : 0;

    totalPassed += passed;
    totalFailed += failed;

    if (failed > 0) {
      filesFailed++;
      console.log(`FAIL  ${label} (${passed} passed, ${failed} failed)`);
      // Print individual failure lines
      const failLines = stdout.split('\n').filter(l => l.includes('FAIL:'));
      for (const line of failLines) {
        console.log(`      ${line.trim()}`);
      }
      failures.push({ file, passed, failed, output: stdout });
    } else {
      filesPassed++;
      console.log(`PASS  ${label} (${passed} passed)`);
    }

    // Print stderr warnings if any (but not for expected ones)
    if (stderr && stderr.trim()) {
      const stderrLines = stderr.trim().split('\n');
      const unexpected = stderrLines.filter(l =>
        !l.includes('WARNING') && !l.includes('Corrupt') && !l.includes('Duplicate') && !l.includes('version mismatch')
      );
      if (unexpected.length > 0) {
        for (const line of unexpected) {
          console.log(`      stderr: ${line}`);
        }
      }
    }
  } catch (e) {
    // Process exited with non-zero code
    const stdout = e.stdout || '';
    const stderr = e.stderr || '';
    const match = stdout.match(/Results:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    const passed = match ? parseInt(match[1], 10) : 0;
    const failed = match ? parseInt(match[2], 10) : 1;

    totalPassed += passed;
    totalFailed += failed;
    filesFailed++;

    console.log(`FAIL  ${label} (${passed} passed, ${failed} failed)`);
    const failLines = stdout.split('\n').filter(l => l.includes('FAIL:'));
    for (const line of failLines) {
      console.log(`      ${line.trim()}`);
    }
    if (!match && e.message) {
      console.log(`      Error: ${e.message.split('\n')[0]}`);
    }
    failures.push({ file, passed, failed, output: stdout, error: e.message });
  }
}

// --- Combined Summary ---
console.log();
console.log('='.repeat(60));
console.log(`  Files:  ${filesPassed} passed, ${filesFailed} failed (${testFiles.length} total)`);
console.log(`  Tests:  ${totalPassed} passed, ${totalFailed} failed (${totalPassed + totalFailed} total)`);
console.log('='.repeat(60));

if (failures.length > 0) {
  console.log();
  console.log('Failed test files:');
  for (const f of failures) {
    console.log(`  - ${f.file}`);
  }
}

process.exit(totalFailed > 0 ? 1 : 0);
