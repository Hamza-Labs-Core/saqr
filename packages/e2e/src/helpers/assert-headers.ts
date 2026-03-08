import { expect } from 'vitest';

export function assertSecurityHeaders(res: Response): void {
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('strict-transport-security')).toBe(
    'max-age=31536000; includeSubDomains',
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
}
