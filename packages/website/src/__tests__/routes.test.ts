/**
 * Route structure tests — verify all expected routes exist.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTES_DIR = resolve(__dirname, '../routes');

const EXPECTED_ROUTES = [
  '_index.tsx',
  'auth.login.tsx',
  'auth.register.tsx',
  'auth.device.tsx',
  'downloads.tsx',
  'dashboard.tsx',
  'remote.tsx',
  'remote.$serverId.tsx',
  'admin._index.tsx',
  'admin.users.tsx',
  'admin.rules.tsx',
  'admin.rules.$id.tsx',
];

describe('Website Routes', () => {
  it.each(EXPECTED_ROUTES)('has route file: %s', (route) => {
    expect(existsSync(resolve(ROUTES_DIR, route))).toBe(true);
  });

  it('has root layout', () => {
    expect(existsSync(resolve(ROUTES_DIR, '../root.tsx'))).toBe(true);
  });

  it('has global CSS', () => {
    expect(existsSync(resolve(ROUTES_DIR, '../app.css'))).toBe(true);
  });
});
