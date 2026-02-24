// files-touched.mjs -- Files touched projection handler.
// Tracks every file read, written, edited, globbed, or grepped during a session.
// Extracts paths from both tool_input (request) and tool_response (result) per G-2.

import { register, CURRENT_PROJECTION_VERSION } from '../lib/registry.mjs';

/**
 * Extract file paths from a ToolCallRequested event.
 * Returns array of { path, operation }.
 */
function extractFromRequest(event) {
  const data = event.data || {};
  const toolName = (data.tool_name || '').toLowerCase();
  const input = data.tool_input || {};
  const results = [];

  switch (toolName) {
    case 'read':
      if (input.file_path) results.push({ path: input.file_path, operation: 'read' });
      break;
    case 'write':
      if (input.file_path) results.push({ path: input.file_path, operation: 'write' });
      break;
    case 'edit':
      if (input.file_path) results.push({ path: input.file_path, operation: 'edit' });
      break;
    case 'notebookedit':
      if (input.notebook_path) results.push({ path: input.notebook_path, operation: 'edit' });
      break;
    case 'glob':
      // Record the glob pattern itself as an entry
      if (input.pattern) {
        const globPath = input.path ? `${input.path}/${input.pattern}` : input.pattern;
        results.push({ path: globPath, operation: 'glob' });
      }
      break;
    case 'grep':
      // If path looks like a specific file (has extension), record it
      if (input.path && /\.\w+$/.test(input.path)) {
        results.push({ path: input.path, operation: 'grep' });
      }
      break;
    case 'bash': {
      // Best-effort regex extraction from bash commands
      const cmd = input.command || '';
      const bashFiles = extractFromBashCommand(cmd);
      results.push(...bashFiles);
      break;
    }
    default:
      // Unknown tool - no file extraction
      break;
  }

  return results;
}

/**
 * Best-effort extraction of file paths from bash commands.
 */
function extractFromBashCommand(cmd) {
  const results = [];

  // cat, less, head, tail - read operations
  const readPatterns = [
    /\b(?:cat|less|head|tail|more)\s+(?:-[^\s]+\s+)*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|>&]+)/g,
  ];
  for (const pat of readPatterns) {
    let m;
    while ((m = pat.exec(cmd)) !== null) {
      const p = m[1].replace(/^["']|["']$/g, '');
      if (p.startsWith('/') || p.startsWith('./') || p.startsWith('../')) {
        results.push({ path: p, operation: 'read' });
      }
    }
  }

  // echo > / echo >> - write operations
  const writeRedirect = /(?:echo|printf)\s+.*?>\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|>&]+)/g;
  let m;
  while ((m = writeRedirect.exec(cmd)) !== null) {
    const p = m[1].replace(/^["']|["']$/g, '');
    if (p.startsWith('/') || p.startsWith('./') || p.startsWith('../')) {
      results.push({ path: p, operation: 'write' });
    }
  }

  // cp - first non-flag arg is read, last is write
  const cpMatch = cmd.match(/\bcp\s+(?:-[^\s]+\s+)*(.+)/);
  if (cpMatch) {
    const args = cpMatch[1].trim().split(/\s+/).filter(a => !a.startsWith('-'));
    if (args.length >= 2) {
      const src = args[0].replace(/^["']|["']$/g, '');
      const dst = args[args.length - 1].replace(/^["']|["']$/g, '');
      if (src.startsWith('/') || src.startsWith('./')) results.push({ path: src, operation: 'read' });
      if (dst.startsWith('/') || dst.startsWith('./')) results.push({ path: dst, operation: 'write' });
    }
  }

  // mv - similar to cp
  const mvMatch = cmd.match(/\bmv\s+(?:-[^\s]+\s+)*(.+)/);
  if (mvMatch) {
    const args = mvMatch[1].trim().split(/\s+/).filter(a => !a.startsWith('-'));
    if (args.length >= 2) {
      const src = args[0].replace(/^["']|["']$/g, '');
      const dst = args[args.length - 1].replace(/^["']|["']$/g, '');
      if (src.startsWith('/') || src.startsWith('./')) results.push({ path: src, operation: 'write' });
      if (dst.startsWith('/') || dst.startsWith('./')) results.push({ path: dst, operation: 'write' });
    }
  }

  // rm - delete operation
  const rmMatch = cmd.match(/\brm\s+(?:-[^\s]+\s+)*(.+)/);
  if (rmMatch) {
    const args = rmMatch[1].trim().split(/\s+/).filter(a => !a.startsWith('-'));
    for (const arg of args) {
      const p = arg.replace(/^["']|["']$/g, '');
      if (p.startsWith('/') || p.startsWith('./')) results.push({ path: p, operation: 'write' });
    }
  }

  return results;
}

/**
 * Extract file paths from a ToolCallCompleted event (G-2).
 * Particularly important for Glob and Grep results.
 */
function extractFromResponse(event) {
  const data = event.data || {};
  const toolName = (data.tool_name || '').toLowerCase();
  const response = data.tool_response || data.result || '';
  const results = [];

  if (typeof response !== 'string' || !response.trim()) return results;

  switch (toolName) {
    case 'glob': {
      // Each non-empty line is a file path
      const lines = response.split('\n').filter(l => l.trim());
      for (const line of lines) {
        results.push({ path: line.trim(), operation: 'glob' });
      }
      break;
    }
    case 'grep': {
      // In files_with_matches mode, each line is a file path
      // In content mode, lines are "filename:line:content"
      const lines = response.split('\n').filter(l => l.trim());
      const seenPaths = new Set();
      for (const line of lines) {
        let filePath;
        // Try filename:linenum:content format first
        const contentMatch = line.match(/^(.+?):(\d+):/);
        if (contentMatch) {
          filePath = contentMatch[1];
        } else if (line.startsWith('/') || line.startsWith('./')) {
          // Looks like a plain file path
          filePath = line.trim();
        }
        if (filePath && !seenPaths.has(filePath)) {
          seenPaths.add(filePath);
          results.push({ path: filePath, operation: 'grep' });
        }
      }
      break;
    }
    default:
      break;
  }

  return results;
}

/**
 * Record a file touch in the state.
 */
function recordTouch(state, filePath, operation, timestamp) {
  if (!state.filesMap[filePath]) {
    state.filesMap[filePath] = {
      operations: [],
      first_touched: timestamp,
      last_touched: timestamp,
      touch_count: 0,
    };
  }
  const entry = state.filesMap[filePath];
  entry.operations.push({ type: operation, timestamp });
  entry.touch_count = entry.operations.length;
  if (timestamp < entry.first_touched) entry.first_touched = timestamp;
  if (timestamp > entry.last_touched) entry.last_touched = timestamp;

  // Update stats
  const statsKey = `files_${operation}`;
  if (state._touchedByOp[operation] === undefined) {
    state._touchedByOp[operation] = new Set();
  }
  state._touchedByOp[operation].add(filePath);
}

/**
 * Recompute stats from _touchedByOp sets.
 */
function recomputeStats(state) {
  const allFiles = new Set(Object.keys(state.filesMap));
  state.stats.total_files = allFiles.size;
  state.stats.files_read = (state._touchedByOp['read'] || new Set()).size;
  state.stats.files_written = (state._touchedByOp['write'] || new Set()).size;
  state.stats.files_edited = (state._touchedByOp['edit'] || new Set()).size;
  state.stats.files_globbed = (state._touchedByOp['glob'] || new Set()).size;
  state.stats.files_grepped = (state._touchedByOp['grep'] || new Set()).size;
}

// Handler interface
const handler = {
  init(existing) {
    if (existing) {
      // Reconstitute from existing projection
      const state = {
        filesMap: {},
        stats: existing.stats || { total_files: 0, files_read: 0, files_written: 0, files_edited: 0, files_globbed: 0, files_grepped: 0 },
        _touchedByOp: {},
      };
      // Rebuild filesMap and _touchedByOp from existing data
      for (const file of (existing.files || [])) {
        state.filesMap[file.path] = {
          operations: file.operations || [],
          first_touched: file.first_touched,
          last_touched: file.last_touched,
          touch_count: file.touch_count,
        };
        for (const op of (file.operations || [])) {
          if (!state._touchedByOp[op.type]) state._touchedByOp[op.type] = new Set();
          state._touchedByOp[op.type].add(file.path);
        }
      }
      return state;
    }
    return {
      filesMap: {},
      stats: { total_files: 0, files_read: 0, files_written: 0, files_edited: 0, files_globbed: 0, files_grepped: 0 },
      _touchedByOp: {},
    };
  },

  handle(state, event) {
    const timestamp = event.timestamp || new Date().toISOString();

    if (event.event_type === 'ToolCallRequested') {
      if (!event.data || !event.data.tool_input) {
        // Missing tool_input - log warning, don't crash
        if (event.data && event.data.tool_name) {
          // Only warn if there's a tool_name but no input
        }
        return state;
      }
      const touches = extractFromRequest(event);
      for (const touch of touches) {
        recordTouch(state, touch.path, touch.operation, timestamp);
      }
    } else if (event.event_type === 'ToolCallCompleted') {
      const touches = extractFromResponse(event);
      for (const touch of touches) {
        recordTouch(state, touch.path, touch.operation, timestamp);
      }
    }

    return state;
  },

  finalize(state) {
    recomputeStats(state);
    const files = Object.entries(state.filesMap).map(([filePath, entry]) => ({
      path: filePath,
      operations: entry.operations,
      first_touched: entry.first_touched,
      last_touched: entry.last_touched,
      touch_count: entry.touch_count,
    }));
    // Sort by first_touched for stable output
    files.sort((a, b) => a.first_touched.localeCompare(b.first_touched));

    return {
      _projection_type: 'files-touched',
      _projection_version: CURRENT_PROJECTION_VERSION,
      _rebuilt_at: new Date().toISOString(),
      _last_sequence: 0, // will be set by caller
      files,
      stats: state.stats,
    };
  },
};

// Formatters
function formatJson(projection) {
  return JSON.stringify(projection, null, 2);
}

function formatText(projection) {
  const lines = [];
  const s = projection.stats;
  lines.push(`Files Touched: ${s.total_files} files`);
  lines.push(`  Read: ${s.files_read} | Written: ${s.files_written} | Edited: ${s.files_edited} | Globbed: ${s.files_globbed} | Grepped: ${s.files_grepped}`);
  lines.push('');
  for (const file of projection.files) {
    lines.push(`${file.path} (${file.touch_count} operations)`);
    for (const op of file.operations) {
      lines.push(`  - ${op.type} at ${op.timestamp}`);
    }
  }
  return lines.join('\n');
}

function formatMarkdown(projection) {
  const lines = [];
  const s = projection.stats;
  lines.push('# Files Touched');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push(`| Total Files | ${s.total_files} |`);
  lines.push(`| Read | ${s.files_read} |`);
  lines.push(`| Written | ${s.files_written} |`);
  lines.push(`| Edited | ${s.files_edited} |`);
  lines.push(`| Globbed | ${s.files_globbed} |`);
  lines.push(`| Grepped | ${s.files_grepped} |`);
  lines.push('');
  lines.push('## File Details');
  lines.push('');
  for (const file of projection.files) {
    lines.push(`### \`${file.path}\` (${file.touch_count} ops)`);
    lines.push('');
    for (const op of file.operations) {
      lines.push(`- **${op.type}** at ${op.timestamp}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Register
register('files', {
  name: 'Files Touched',
  description: 'Tracks every file read, written, edited, globbed, or grepped during the session',
  version: CURRENT_PROJECTION_VERSION,
  outputFile: 'files-touched.json',
  handler,
  formatters: { json: formatJson, text: formatText, markdown: formatMarkdown },
});

export { handler, formatJson, formatText, formatMarkdown };
export { extractFromRequest, extractFromResponse };
