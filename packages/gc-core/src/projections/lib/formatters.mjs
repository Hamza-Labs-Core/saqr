// formatters.mjs -- Output format dispatch system and shared formatting utilities.
// Handles --format flag, --output flag, and file writing.
import path from 'node:path';
import { getProjectionsDir } from './paths.mjs';
import { atomicWrite, mkdirp } from './utils.mjs';

/**
 * Output a projection: write JSON to file and/or format to stdout.
 *
 * @param {object} projection - The finalized projection data
 * @param {object} projectionDef - Registry definition { outputFile, formatters, ... }
 * @param {object} options - { format, output, quiet, projectId, sessionId }
 */
export async function outputProjection(projection, projectionDef, options = {}) {
  const { format = 'json', output, quiet = false, projectId, sessionId } = options;

  // Always write JSON to the default projection file (unless --output -)
  if (output !== '-') {
    const jsonPath = output || path.join(
      getProjectionsDir(projectId, sessionId),
      projectionDef.outputFile
    );
    await mkdirp(path.dirname(jsonPath));
    await atomicWrite(jsonPath, JSON.stringify(projection, null, 2));
  }

  // Format for stdout
  const formatter = projectionDef.formatters[format];
  if (!formatter) {
    throw new Error(`Unknown format: ${format}. Supported: json, text, markdown`);
  }

  const outputStr = formatter(projection);
  if (!quiet) {
    process.stdout.write(outputStr);
    if (!outputStr.endsWith('\n')) process.stdout.write('\n');
  }
}

/**
 * Render a text header with underline.
 */
export function renderTextHeader(title, subtitle) {
  const lines = [title, '='.repeat(title.length)];
  if (subtitle) lines.push(subtitle);
  return lines.join('\n');
}

/**
 * Render a markdown table.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
export function renderMarkdownTable(headers, rows) {
  const lines = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const row of rows) {
    lines.push('| ' + row.map(cell => String(cell).replace(/\|/g, '\\|')).join(' | ') + ' |');
  }
  return lines.join('\n');
}
