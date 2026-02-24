import type { CleartextMetadata } from '@saqr/shared';

/**
 * Sensitive fields that must always be encrypted before leaving the machine.
 * These fields contain user content, file paths, code, or other private data.
 */
const SENSITIVE_FIELDS = new Set([
  'prompt',
  'tool_input',
  'tool_response',
  'error',
  'transcript_path',
  'cwd',
  'summary',
  'result',
  'task',
  'description',
]);

/**
 * Cleartext data fields that are safe for server-side indexing.
 * These fields contain only operational metadata (types, IDs, counts, flags).
 */
const CLEARTEXT_DATA_FIELDS = new Set([
  'tool_name',
  'tool_use_id',
  'source',
  'model',
  'stop_hook_active',
  'trigger',
  'reason',
  'agent_id',
  'agent_type',
  'is_interrupt',
  'subagent_id',
  'success',
  'is_followup',
  'stop_reason',
  'input_tokens',
  'output_tokens',
  'total_input_tokens',
  'total_output_tokens',
  'duration_ms',
  'messages_before',
  'messages_after',
  'permission_id',
  'granted',
  'error_code',
]);

/**
 * Result of splitting an event into cleartext metadata and sensitive payload.
 */
export interface SplitResult {
  /** Cleartext metadata safe for server-side indexing */
  metadata: CleartextMetadata;
  /** Sensitive payload that must be encrypted */
  sensitive: Record<string, unknown>;
}

/**
 * Split an event into cleartext metadata and sensitive payload.
 *
 * Cleartext metadata includes timestamps, event types, token counts, model names,
 * and other operational data that the sync server can use for indexing and aggregation.
 *
 * Sensitive payload includes prompts, responses, file paths, tool inputs/outputs,
 * and all other user content that must be encrypted before leaving the machine.
 *
 * @param event - A full unified event envelope
 * @returns Split result with cleartext metadata and sensitive payload
 */
export function splitEvent(event: Record<string, unknown>): SplitResult {
  const data = (event.data as Record<string, unknown>) || {};

  // Build cleartext metadata from envelope fields
  const metadata: CleartextMetadata = {
    event_id: event.event_id as string,
    event_type: event.event_type as string,
    project_id: event.project_id as string,
    session_id: event.session_id as string,
    sequence: event.sequence as number,
    timestamp: event.timestamp as string,
    agent_provider: (event.agent_provider as string) || 'unknown',
    machine_id: (event.machine_id as string) || '',
  };

  // Add optional cleartext data fields
  if (data.model != null) metadata.model = data.model as string;
  if (data.input_tokens != null) metadata.input_tokens = data.input_tokens as number;
  if (data.output_tokens != null) metadata.output_tokens = data.output_tokens as number;

  // Collect cleartext data fields for metadata (non-sensitive operational fields)
  const cleartextData: Record<string, unknown> = {};
  for (const key of CLEARTEXT_DATA_FIELDS) {
    if (data[key] !== undefined && data[key] !== null) {
      cleartextData[key] = data[key];
    }
  }

  // Build sensitive payload containing all potentially sensitive fields
  const sensitiveData: Record<string, unknown> = {};
  for (const key of SENSITIVE_FIELDS) {
    if (data[key] !== undefined && data[key] !== null) {
      sensitiveData[key] = data[key];
    }
  }

  // Include the full raw data for complete reconstruction on decrypt
  const sensitive: Record<string, unknown> = {
    ...sensitiveData,
    _raw_data: data,
  };

  return { metadata, sensitive };
}

/**
 * Reassemble a full event from cleartext metadata and decrypted sensitive payload.
 *
 * @param metadata - Cleartext metadata from the sync server
 * @param sensitive - Decrypted sensitive payload
 * @returns Full event envelope
 */
export function reassembleEvent(
  metadata: CleartextMetadata,
  sensitive: Record<string, unknown>
): Record<string, unknown> {
  return {
    event_id: metadata.event_id,
    event_type: metadata.event_type,
    project_id: metadata.project_id,
    session_id: metadata.session_id,
    sequence: metadata.sequence,
    timestamp: metadata.timestamp,
    agent_provider: metadata.agent_provider,
    machine_id: metadata.machine_id,
    data: sensitive._raw_data as Record<string, unknown>,
  };
}
