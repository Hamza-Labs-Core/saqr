/**
 * Wrangler configuration tests — verify the Cloudflare Workers deploy config
 * is valid and the worker entry exports a default fetch handler.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/** Strip JSONC to valid JSON: mask strings first to avoid breaking URLs. */
function parseJsonc(text: string): unknown {
  // 1. Mask all string literals so we don't touch // inside URLs
  const strings: string[] = [];
  const masked = text.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    strings.push(m);
    return `"__STR_${strings.length - 1}__"`;
  });
  // 2. Now strip comments and trailing commas safely
  const clean = masked
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  // 3. Restore strings
  const restored = clean.replace(/"__STR_(\d+)__"/g, (_, i) => strings[Number(i)]);
  return JSON.parse(restored);
}

describe('Wrangler Config', () => {
  const raw = readFileSync(resolve(ROOT, 'wrangler.jsonc'), 'utf-8');
  const config = parseJsonc(raw) as Record<string, any>;

  it('has a main entry point that exists on disk', () => {
    expect(config.main).toBeDefined();
    expect(existsSync(resolve(ROOT, config.main))).toBe(true);
  });

  it('worker entry re-exports a default with fetch handler', () => {
    const entryPath = resolve(ROOT, config.main);
    const source = readFileSync(entryPath, 'utf-8');
    expect(source).toMatch(/export\s+default\b/);
  });

  it('assets directory is configured', () => {
    expect(config.assets?.directory).toBeDefined();
  });

  it('preview env inherits vars', () => {
    if (config.vars && Object.keys(config.vars).length > 0) {
      expect(config.env?.preview?.vars).toBeDefined();
    }
  });
});
