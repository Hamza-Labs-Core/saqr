/**
 * Tests for Metadata Sanitizer — Server-side PII prevention.
 *
 * Covers:
 * - Allowlisted field filtering
 * - PII detection in project_id and session_id
 * - Path hashing for project_id
 * - Email pattern detection
 * - Stripping non-allowlisted fields
 * - MetadataSanitizationError
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeMetadata,
  validateMetadata,
  detectPII,
  hashProjectId,
  MetadataSanitizationError,
  ALLOWED_METADATA_FIELDS,
} from '../middleware/metadata-sanitizer.js';

describe('Metadata Sanitizer', () => {
  // -----------------------------------------------------------------------
  // PII Detection
  // -----------------------------------------------------------------------

  describe('detectPII', () => {
    it('should detect email addresses', () => {
      expect(detectPII('user@example.com')).toBe('email_address');
      expect(detectPII('john.doe+tag@company.co.uk')).toBe('email_address');
    });

    it('should detect home directory paths (Unix)', () => {
      expect(detectPII('/home/johndoe/projects')).toBe('user_path');
      expect(detectPII('/home/jane')).toBe('user_path');
    });

    it('should detect home directory paths (macOS)', () => {
      expect(detectPII('/Users/johndoe/Documents')).toBe('user_path');
    });

    it('should detect Windows user paths', () => {
      expect(detectPII('C:\\Users\\JohnDoe\\Projects')).toBe('user_path');
    });

    it('should return null for clean values', () => {
      expect(detectPII('proj-abc123')).toBeNull();
      expect(detectPII('session_001')).toBeNull();
      expect(detectPII('12345')).toBeNull();
    });

    it('should return null for non-string values', () => {
      expect(detectPII(123 as unknown as string)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Path Hashing
  // -----------------------------------------------------------------------

  describe('hashProjectId', () => {
    it('should hash a path-based project ID', async () => {
      const hashed = await hashProjectId('/home/user/my-project');
      expect(hashed).toMatch(/^proj_[0-9a-f]{16}$/);
    });

    it('should produce consistent hashes', async () => {
      const hash1 = await hashProjectId('/home/user/project');
      const hash2 = await hashProjectId('/home/user/project');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different paths', async () => {
      const hash1 = await hashProjectId('/home/user/project-a');
      const hash2 = await hashProjectId('/home/user/project-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('validateMetadata', () => {
    it('should return no errors for clean metadata', () => {
      const errors = validateMetadata({
        project_id: 'proj-abc123',
        session_id: 'sess-001',
      });
      expect(errors).toHaveLength(0);
    });

    it('should detect email in project_id', () => {
      const errors = validateMetadata({
        project_id: 'user@example.com-project',
        session_id: 'sess-001',
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('project_id');
      expect(errors[0].reason).toContain('email_address');
    });

    it('should detect email in session_id', () => {
      const errors = validateMetadata({
        project_id: 'proj-001',
        session_id: 'john@company.com-sess-001',
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('session_id');
      expect(errors[0].reason).toContain('email_address');
    });

    it('should detect user paths in project_id', () => {
      const errors = validateMetadata({
        project_id: '/home/johndoe/project',
        session_id: 'sess-001',
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('project_id');
      expect(errors[0].reason).toContain('user_path');
    });

    it('should return multiple errors when both fields have PII', () => {
      const errors = validateMetadata({
        project_id: 'user@example.com',
        session_id: '/home/jane/sess',
      });
      expect(errors).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Sanitization
  // -----------------------------------------------------------------------

  describe('sanitizeMetadata', () => {
    it('should pass through allowed fields', async () => {
      const result = await sanitizeMetadata({
        event_id: 'evt-001',
        event_type: 'ToolCallCompleted',
        project_id: 'proj-abc123',
        session_id: 'sess-001',
        sequence: 1,
        timestamp: '2026-02-22T10:00:00Z',
      });

      expect(result.sanitized.event_id).toBe('evt-001');
      expect(result.sanitized.event_type).toBe('ToolCallCompleted');
      expect(result.sanitized.project_id).toBe('proj-abc123');
      expect(result.stripped).toHaveLength(0);
    });

    it('should strip non-allowlisted fields', async () => {
      const result = await sanitizeMetadata({
        event_id: 'evt-001',
        project_id: 'proj-abc123',
        custom_field: 'secret data',
        user_email: 'john@example.com',
        internal_notes: 'some notes',
      });

      expect(result.sanitized.event_id).toBe('evt-001');
      expect(result.sanitized).not.toHaveProperty('custom_field');
      expect(result.sanitized).not.toHaveProperty('user_email');
      expect(result.sanitized).not.toHaveProperty('internal_notes');
      expect(result.stripped).toContain('custom_field');
      expect(result.stripped).toContain('user_email');
      expect(result.stripped).toContain('internal_notes');
    });

    it('should hash project_id with path segments', async () => {
      const result = await sanitizeMetadata({
        project_id: 'my-project/sub-dir',
        session_id: 'sess-001',
      });

      expect(result.sanitized.project_id).toMatch(/^proj_[0-9a-f]{16}$/);
      expect(result.projectIdHashed).toBe(true);
    });

    it('should not hash project_id without path segments', async () => {
      const result = await sanitizeMetadata({
        project_id: 'my-project-abc123',
        session_id: 'sess-001',
      });

      expect(result.sanitized.project_id).toBe('my-project-abc123');
      expect(result.projectIdHashed).toBe(false);
    });

    it('should throw MetadataSanitizationError for email in project_id', async () => {
      await expect(
        sanitizeMetadata({
          project_id: 'user@example.com',
          session_id: 'sess-001',
        }),
      ).rejects.toThrow(MetadataSanitizationError);
    });

    it('should throw MetadataSanitizationError for user path in session_id', async () => {
      await expect(
        sanitizeMetadata({
          project_id: 'proj-001',
          session_id: '/home/johndoe/sessions/sess-001',
        }),
      ).rejects.toThrow(MetadataSanitizationError);
    });

    it('should allow all known fields through', async () => {
      const metadata: Record<string, unknown> = {};
      for (const field of ALLOWED_METADATA_FIELDS) {
        metadata[field] = `test_${field}`;
      }
      // Fix project_id and session_id to not have PII
      metadata.project_id = 'proj-clean';
      metadata.session_id = 'sess-clean';

      const result = await sanitizeMetadata(metadata);
      expect(result.stripped).toHaveLength(0);
    });

    it('should handle empty metadata', async () => {
      const result = await sanitizeMetadata({});
      expect(result.sanitized).toEqual({});
      expect(result.stripped).toHaveLength(0);
      expect(result.projectIdHashed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // MetadataSanitizationError
  // -----------------------------------------------------------------------

  describe('MetadataSanitizationError', () => {
    it('should have field and reason properties', () => {
      const error = new MetadataSanitizationError('project_id', 'Contains email_address');
      expect(error.field).toBe('project_id');
      expect(error.reason).toBe('Contains email_address');
      expect(error.name).toBe('MetadataSanitizationError');
      expect(error.message).toContain('project_id');
      expect(error.message).toContain('Contains email_address');
    });
  });
});
