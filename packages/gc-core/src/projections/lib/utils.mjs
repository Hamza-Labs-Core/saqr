// utils.mjs -- Shared utilities for the projection engine.
// String truncation, safe JSON parse, atomic file write, duration formatting.
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Truncate a string to maxLen characters, appending suffix if truncated.
 */
export function truncate(str, maxLen, suffix = '...') {
  if (typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + suffix;
}

/**
 * Safely parse JSON, returning a result object.
 * @returns {{ ok: boolean, data: any, error: string|null }}
 */
export function safeJsonParse(content, filePath) {
  try {
    const data = JSON.parse(content);
    return { ok: true, data, error: null };
  } catch (e) {
    return { ok: false, data: null, error: `${e.message} in ${filePath || 'unknown'}` };
  }
}

/**
 * Atomic write: write to a temp file then rename.
 * Ensures the original file remains intact if interrupted mid-write.
 */
export async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpName = `.tmp-${crypto.randomBytes(8).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  await writeFile(tmpPath, data, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Format a duration in seconds to a human-readable string.
 * Examples: "0m", "5m", "1h 30m", "2h 0m"
 */
export function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '0m';
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Recursively create directories (like mkdir -p).
 */
export async function mkdirp(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * Log a warning to stderr.
 */
export function warn(message) {
  process.stderr.write(`[project] WARNING: ${message}\n`);
}
