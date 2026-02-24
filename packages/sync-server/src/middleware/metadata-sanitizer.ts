/**
 * Metadata Sanitizer — Server-side PII prevention middleware.
 *
 * Validates cleartext metadata against an allowlist of fields, strips
 * disallowed fields, and rejects events containing PII patterns in
 * metadata values (e.g., email addresses, filesystem paths with usernames).
 *
 * Art. 25 GDPR — Data protection by design and by default.
 */

// ---------------------------------------------------------------------------
// Allowlisted metadata fields (cleartext safe)
// ---------------------------------------------------------------------------

export const ALLOWED_METADATA_FIELDS = new Set([
  'event_id',
  'event_type',
  'project_id',
  'session_id',
  'sequence',
  'timestamp',
  'agent_provider',
  'machine_id',
  'token_count_input',
  'token_count_output',
  'model',
  'tool_name',
  'encrypted_blob_sha256',
  'encrypted_size_bytes',
]);

// ---------------------------------------------------------------------------
// PII Detection Patterns
// ---------------------------------------------------------------------------

/** Email addresses: simplified RFC 5322 */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

/** Home directory paths that expose usernames */
const HOME_PATH_PATTERN = /(?:\/home\/|\/Users\/|C:\\Users\\)[a-zA-Z0-9._\-]+/i;

/** Windows user profile path */
const WINDOWS_USER_PATH = /C:\\Users\\[a-zA-Z0-9._\-]+/i;

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

export class MetadataSanitizationError extends Error {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Metadata sanitization error on field "${field}": ${reason}`);
    this.name = 'MetadataSanitizationError';
    this.field = field;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// PII Detection
// ---------------------------------------------------------------------------

/**
 * Check if a string value looks like it contains PII.
 * Returns the type of PII detected, or null if clean.
 */
export function detectPII(value: string): string | null {
  if (typeof value !== 'string') return null;

  if (EMAIL_PATTERN.test(value)) {
    return 'email_address';
  }

  if (HOME_PATH_PATTERN.test(value) || WINDOWS_USER_PATH.test(value)) {
    return 'user_path';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Path Hashing
// ---------------------------------------------------------------------------

/**
 * Hash a project_id that contains path segments to remove PII.
 * Uses a simple SHA-256 based hash to anonymize the path.
 */
export async function hashProjectId(projectId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(projectId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, '0');
  }
  return `proj_${hex.slice(0, 16)}`;
}

/**
 * Check if a project_id contains path segments (e.g., /home/user/project).
 */
function containsPathSegments(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate metadata fields, checking for PII in critical fields.
 * Returns an array of validation errors (empty if all valid).
 */
export function validateMetadata(
  metadata: Record<string, unknown>,
): MetadataSanitizationError[] {
  const errors: MetadataSanitizationError[] = [];

  // Check project_id for PII
  if (metadata.project_id && typeof metadata.project_id === 'string') {
    const piiType = detectPII(metadata.project_id);
    if (piiType) {
      errors.push(
        new MetadataSanitizationError('project_id', `Contains ${piiType}`),
      );
    }
  }

  // Check session_id for PII
  if (metadata.session_id && typeof metadata.session_id === 'string') {
    const piiType = detectPII(metadata.session_id);
    if (piiType) {
      errors.push(
        new MetadataSanitizationError('session_id', `Contains ${piiType}`),
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

export interface SanitizationResult {
  /** The sanitized metadata with only allowed fields */
  sanitized: Record<string, unknown>;
  /** Fields that were stripped */
  stripped: string[];
  /** Whether project_id was hashed due to path content */
  projectIdHashed: boolean;
}

/**
 * Sanitize metadata by stripping non-allowlisted fields, hashing
 * path-based project IDs, and validating against PII patterns.
 *
 * @throws MetadataSanitizationError if critical fields contain PII
 */
export async function sanitizeMetadata(
  metadata: Record<string, unknown>,
): Promise<SanitizationResult> {
  // 1. Validate critical fields for PII
  const errors = validateMetadata(metadata);
  if (errors.length > 0) {
    throw errors[0]; // Throw the first validation error
  }

  // 2. Strip non-allowlisted fields
  const sanitized: Record<string, unknown> = {};
  const stripped: string[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (ALLOWED_METADATA_FIELDS.has(key)) {
      sanitized[key] = value;
    } else {
      stripped.push(key);
    }
  }

  // 3. Hash project_id if it contains path segments
  let projectIdHashed = false;
  if (sanitized.project_id && typeof sanitized.project_id === 'string') {
    if (containsPathSegments(sanitized.project_id)) {
      sanitized.project_id = await hashProjectId(sanitized.project_id as string);
      projectIdHashed = true;
    }
  }

  return { sanitized, stripped, projectIdHashed };
}
