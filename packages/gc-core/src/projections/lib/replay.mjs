// replay.mjs -- Event replay engine with streaming, dedup (G-1), and gap detection.
// Reads event files from a session directory, validates, orders by sequence,
// and streams through a projection handler one at a time.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getEventsDir } from './paths.mjs';
import { safeJsonParse, warn } from './utils.mjs';

/**
 * Discover event files in a directory.
 * Returns array of { sequence, path, filename }.
 */
async function discoverEventFiles(eventsDir) {
  let entries;
  try {
    entries = await readdir(eventsDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const files = [];
  for (const entry of entries) {
    // Match NNNNNN.json pattern (digits only, no orphan- prefix, no session.json)
    if (!/^\d+\.json$/.test(entry)) continue;
    const sequence = parseInt(entry.replace('.json', ''), 10);
    files.push({ sequence, path: path.join(eventsDir, entry), filename: entry });
  }
  return files;
}

/**
 * Detect gaps in the sequence and log warnings.
 */
function detectSequenceGaps(files) {
  for (let i = 0; i < files.length - 1; i++) {
    const gap = files[i + 1].sequence - files[i].sequence;
    if (gap > 1) {
      warn(`Sequence gap detected: ${files[i].sequence} -> ${files[i + 1].sequence} (missing ${gap - 1} events)`);
    }
  }
}

/**
 * Replay events through a projection handler.
 *
 * @param {string} projectId - Project identifier
 * @param {string} sessionId - Session identifier
 * @param {object} handler - { init(existing?), handle(state, event), finalize(state) }
 * @param {object} options - { from, to, existingState }
 * @returns {object} finalized projection
 */
export async function replayThrough(projectId, sessionId, handler, options = {}) {
  const { from = 1, to = Infinity, existingState = null } = options;
  const eventsDir = getEventsDir(projectId, sessionId);

  // 1. Discover event files
  const files = await discoverEventFiles(eventsDir);

  // 2. Sort by numeric sequence
  files.sort((a, b) => a.sequence - b.sequence);

  // 3. Detect gaps and log warnings
  detectSequenceGaps(files);

  // 4. Initialize handler state
  let state = handler.init(existingState);

  // 5. Track seen tool_use_ids for duplicate detection (G-1)
  // NOTE: seenToolUseIds resets per replayThrough() call. For incremental rebuilds,
  // duplicates of events processed in a prior run will not be detected. This is an
  // accepted limitation — full dedup would require persisting the seen set, which
  // adds complexity for a rare edge case. Use --rebuild for a guaranteed-clean pass.
  const seenToolUseIds = new Map(); // "tool_use_id:event_type" -> sequence

  // Track the last sequence actually processed by the handler
  let lastProcessedSequence = 0;

  // 6. Stream through handler
  for (const file of files) {
    if (file.sequence < from || file.sequence > to) continue;

    const raw = await readFile(file.path, 'utf-8');
    const result = safeJsonParse(raw, file.path);
    if (!result.ok) {
      warn(`Corrupt JSON at ${file.path}: ${result.error}`);
      continue;
    }

    const event = result.data;

    // Validate required fields
    if (!event.event_type || event.sequence == null) {
      warn(`Missing required fields in ${file.path}, skipping`);
      continue;
    }

    // Duplicate detection by tool_use_id (G-1)
    const toolUseId = event.data?.tool_use_id;
    if (toolUseId) {
      const key = `${toolUseId}:${event.event_type}`;
      if (seenToolUseIds.has(key)) {
        warn(`Duplicate event detected: tool_use_id=${toolUseId}, ` +
             `event_type=${event.event_type} at sequence ${event.sequence} ` +
             `(first seen at sequence ${seenToolUseIds.get(key)}). Skipping.`);
        continue;
      }
      seenToolUseIds.set(key, event.sequence);
    }

    state = handler.handle(state, event);
    lastProcessedSequence = event.sequence;
  }

  // 7. Finalize
  const finalized = handler.finalize(state);
  finalized._lastProcessedSequence = lastProcessedSequence;
  return finalized;
}

/**
 * Get the highest sequence number in an events directory.
 */
export async function getHighestSequence(projectId, sessionId) {
  const eventsDir = getEventsDir(projectId, sessionId);
  const files = await discoverEventFiles(eventsDir);
  if (files.length === 0) return 0;
  return Math.max(...files.map(f => f.sequence));
}
