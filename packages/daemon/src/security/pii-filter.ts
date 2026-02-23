/**
 * Client-Side PII Filter — Pre-sync protection.
 *
 * Scans event metadata for PII patterns before sync and auto-redacts
 * or rejects events with PII in metadata fields. This is the client-side
 * complement to the server-side metadata sanitizer.
 *
 * Detects: email addresses, IP addresses, paths with usernames, API keys.
 */

// ---------------------------------------------------------------------------
// PII Pattern Types
// ---------------------------------------------------------------------------

export type PIIType =
  | 'email_address'
  | 'ip_address'
  | 'user_path'
  | 'api_key'
  | 'phone_number';

export interface PIIDetection {
  /** The type of PII detected */
  type: PIIType;
  /** The field where PII was found */
  field: string;
  /** The matched pattern (redacted) */
  match: string;
}

export type PIIAction = 'redact' | 'reject';

export interface PIIFilterConfig {
  /** What to do when PII is detected: 'redact' replaces with placeholder, 'reject' throws */
  action: PIIAction;
  /** Fields that are exempt from PII scanning (e.g., encrypted fields) */
  exemptFields: Set<string>;
  /** Custom patterns to detect */
  customPatterns?: Array<{ name: PIIType; pattern: RegExp }>;
}

// ---------------------------------------------------------------------------
// Default Patterns
// ---------------------------------------------------------------------------

const PII_PATTERNS: Array<{ name: PIIType; pattern: RegExp }> = [
  {
    name: 'email_address',
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  },
  {
    name: 'ip_address',
    // IPv4 addresses (not matching version-like numbers e.g., 1.0.0)
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  {
    name: 'user_path',
    // Unix/macOS/Windows home directory paths
    pattern: /(?:\/home\/|\/Users\/|C:\\Users\\)[a-zA-Z0-9._\-]+/gi,
  },
  {
    name: 'api_key',
    // Common API key patterns: sk-xxx, ghp_xxx, AKIA, etc.
    pattern: /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9\-]{10,})\b/g,
  },
];

/** Default exempt fields (encrypted content shouldn't be scanned) */
const DEFAULT_EXEMPT_FIELDS = new Set([
  'encrypted_blob',
  'encrypted_blob_sha256',
  'encrypted_size_bytes',
  'data',
  'agent_native_event',
]);

// ---------------------------------------------------------------------------
// PII Filter Class
// ---------------------------------------------------------------------------

export class PIIFilter {
  private config: PIIFilterConfig;
  private patterns: Array<{ name: PIIType; pattern: RegExp }>;

  constructor(config?: Partial<PIIFilterConfig>) {
    this.config = {
      action: config?.action || 'redact',
      exemptFields: config?.exemptFields || DEFAULT_EXEMPT_FIELDS,
      customPatterns: config?.customPatterns,
    };
    this.patterns = [...PII_PATTERNS, ...(config?.customPatterns || [])];
  }

  /**
   * Scan a value for PII patterns.
   */
  scanValue(value: string): PIIDetection[] {
    if (typeof value !== 'string') return [];

    const detections: PIIDetection[] = [];
    for (const { name, pattern } of this.patterns) {
      // Reset lastIndex for global patterns
      const p = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = p.exec(value)) !== null) {
        detections.push({
          type: name,
          field: '',
          match: redactMatch(match[0]),
        });
      }
    }
    return detections;
  }

  /**
   * Scan an entire metadata object for PII.
   */
  scanMetadata(metadata: Record<string, unknown>): PIIDetection[] {
    const detections: PIIDetection[] = [];
    this.scanObject(metadata, '', detections);
    return detections;
  }

  private scanObject(
    obj: Record<string, unknown>,
    prefix: string,
    detections: PIIDetection[],
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;

      // Skip exempt fields
      if (this.config.exemptFields.has(key)) continue;

      if (typeof value === 'string') {
        const fieldDetections = this.scanValue(value);
        for (const d of fieldDetections) {
          detections.push({ ...d, field: fieldPath });
        }
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this.scanObject(value as Record<string, unknown>, fieldPath, detections);
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (typeof item === 'string') {
            const itemDetections = this.scanValue(item);
            for (const d of itemDetections) {
              detections.push({ ...d, field: `${fieldPath}[${i}]` });
            }
          } else if (typeof item === 'object' && item !== null) {
            this.scanObject(item as Record<string, unknown>, `${fieldPath}[${i}]`, detections);
          }
        }
      }
    }
  }

  /**
   * Filter metadata by scanning and either redacting or rejecting.
   */
  filterMetadata(
    metadata: Record<string, unknown>,
  ): { clean: Record<string, unknown>; detections: PIIDetection[]; rejected: boolean } {
    const detections = this.scanMetadata(metadata);

    if (detections.length === 0) {
      return { clean: metadata, detections: [], rejected: false };
    }

    if (this.config.action === 'reject') {
      return { clean: metadata, detections, rejected: true };
    }

    // Redact mode: replace PII in string values
    const clean = deepRedact(metadata, this.patterns, this.config.exemptFields);
    return { clean, detections, rejected: false };
  }
}

// ---------------------------------------------------------------------------
// Standalone Functions
// ---------------------------------------------------------------------------

/**
 * Scan a metadata object for PII patterns.
 */
export function scanForPII(metadata: Record<string, unknown>): PIIDetection[] {
  const filter = new PIIFilter();
  return filter.scanMetadata(metadata);
}

/**
 * Redact PII from a metadata object (returns a new object).
 */
export function redactPII(metadata: Record<string, unknown>): Record<string, unknown> {
  const filter = new PIIFilter({ action: 'redact' });
  const { clean } = filter.filterMetadata(metadata);
  return clean;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function redactMatch(value: string): string {
  if (value.length <= 4) return '***';
  return value.slice(0, 2) + '***' + value.slice(-2);
}

function deepRedact(
  obj: Record<string, unknown>,
  patterns: Array<{ name: PIIType; pattern: RegExp }>,
  exemptFields: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (exemptFields.has(key)) {
      result[key] = value;
      continue;
    }

    if (typeof value === 'string') {
      let cleaned = value;
      for (const { pattern } of patterns) {
        const p = new RegExp(pattern.source, pattern.flags);
        cleaned = cleaned.replace(p, '[REDACTED]');
      }
      result[key] = cleaned;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = deepRedact(value as Record<string, unknown>, patterns, exemptFields);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'string') {
          let cleaned = item;
          for (const { pattern } of patterns) {
            const p = new RegExp(pattern.source, pattern.flags);
            cleaned = cleaned.replace(p, '[REDACTED]');
          }
          return cleaned;
        }
        if (typeof item === 'object' && item !== null) {
          return deepRedact(item as Record<string, unknown>, patterns, exemptFields);
        }
        return item;
      });
    } else {
      result[key] = value;
    }
  }

  return result;
}
