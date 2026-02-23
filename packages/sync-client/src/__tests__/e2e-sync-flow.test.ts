import { describe, it, expect, beforeAll } from 'vitest';
import { EncryptionManager } from '../encryption.js';
import { splitEvent, reassembleEvent } from '../metadata-splitter.js';
import type { CleartextMetadata } from '@saqr/shared';

/**
 * End-to-end tests for the sync-client encryption + sync pipeline.
 *
 * These tests verify the full lifecycle: event creation -> metadata splitting
 * -> encryption -> wire format -> decryption -> reassembly, ensuring that
 * sensitive data is never exposed in cleartext and that events survive
 * the full roundtrip intact.
 */

// ---------------------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------------------

function makeEventEnvelope(
  eventType: string,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: overrides.event_id ?? `evt-${eventType.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`,
    event_type: eventType,
    project_id: overrides.project_id ?? 'saqr-proj-a1b2c3',
    session_id: overrides.session_id ?? 'session-e2e-test-001',
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.timestamp ?? '2026-02-23T12:00:00.000Z',
    agent_provider: overrides.agent_provider ?? 'claude-code',
    machine_id: overrides.machine_id ?? 'machine-e2e-test',
    data,
  };
}

/** Sensitive strings that must never appear in cleartext metadata. */
const SENSITIVE_STRINGS = [
  'my secret API key sk-abc123xyz789',
  'cat /etc/shadow',
  'root:$6$rounds=5000$salt$hash',
  '/home/user/.ssh/id_rsa',
  '/home/user/classified/top-secret.ts',
  'Implement the backdoor in auth module',
  'SELECT * FROM users WHERE password',
  'The quick brown fox jumps over the lazy dog -- private note',
  'Error: EACCES permission denied /var/secrets/config.yaml',
  'npm_token_abcdef1234567890',
];

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('E2E Sync Flow: encryption + sync pipeline', () => {
  let encryption: EncryptionManager;

  beforeAll(async () => {
    encryption = new EncryptionManager();
    await encryption.init();
    await encryption.generateMasterKey();
  });

  // =========================================================================
  // 1. Full Push Flow
  // =========================================================================

  describe('1. Full Push Flow', () => {
    it('should split, encrypt, and build a valid push payload for UserPromptReceived', async () => {
      const sensitivePrompt = 'Write a function that reads /etc/passwd and extracts usernames. My API key is sk-secret-key-12345.';

      const event = makeEventEnvelope('UserPromptReceived', {
        session_id: 'session-e2e-001',
        prompt: sensitivePrompt,
        is_followup: false,
        model: 'claude-opus-4-6',
      }, { session_id: 'session-e2e-001' });

      // Step 1: Split into metadata and sensitive payload
      const { metadata, sensitive } = splitEvent(event);

      // Step 2: Encrypt the sensitive payload
      const sensitiveStr = JSON.stringify(sensitive);
      const encResult = await encryption.encryptString(sensitiveStr);

      // Step 3: Build the push request body (matching SyncClient.pushEvent format)
      const machineId = 'machine-push-test';
      metadata.machine_id = machineId;

      const pushPayload = {
        machine_id: machineId,
        key_id: encryption.getKeyId(),
        events: [
          {
            metadata,
            encrypted: encResult.ciphertext,
            nonce: encResult.nonce,
          },
        ],
      };

      // Verify wire format structure
      expect(pushPayload).toHaveProperty('machine_id', machineId);
      expect(pushPayload).toHaveProperty('key_id');
      expect(pushPayload.key_id).toMatch(/^[0-9a-f]{16}$/);
      expect(pushPayload.events).toHaveLength(1);

      const wireEvent = pushPayload.events[0];
      expect(wireEvent).toHaveProperty('metadata');
      expect(wireEvent).toHaveProperty('encrypted');
      expect(wireEvent).toHaveProperty('nonce');

      // Verify metadata contains the expected cleartext fields
      expect(wireEvent.metadata.event_id).toBe(event.event_id);
      expect(wireEvent.metadata.event_type).toBe('UserPromptReceived');
      expect(wireEvent.metadata.project_id).toBe('saqr-proj-a1b2c3');
      expect(wireEvent.metadata.session_id).toBe('session-e2e-001');
      expect(wireEvent.metadata.sequence).toBe(1);
      expect(wireEvent.metadata.timestamp).toBe('2026-02-23T12:00:00.000Z');
      expect(wireEvent.metadata.agent_provider).toBe('claude-code');
      expect(wireEvent.metadata.machine_id).toBe(machineId);
      expect(wireEvent.metadata.model).toBe('claude-opus-4-6');

      // Verify encrypted and nonce are base64 strings
      expect(typeof wireEvent.encrypted).toBe('string');
      expect(wireEvent.encrypted.length).toBeGreaterThan(0);
      expect(typeof wireEvent.nonce).toBe('string');
      expect(wireEvent.nonce.length).toBeGreaterThan(0);

      // Verify NO sensitive data appears in cleartext metadata
      const metadataJson = JSON.stringify(wireEvent.metadata);
      expect(metadataJson).not.toContain(sensitivePrompt);
      expect(metadataJson).not.toContain('/etc/passwd');
      expect(metadataJson).not.toContain('sk-secret-key-12345');
      // Note: we check that the prompt *value* does not appear, not the word "prompt"
      // itself, since the event_type "UserPromptReceived" legitimately contains it.
      expect(metadataJson).not.toContain('Write a function that reads');
    });

    it('should produce encrypted payload that differs from plaintext', async () => {
      const event = makeEventEnvelope('UserPromptReceived', {
        session_id: 'session-e2e-002',
        prompt: 'This is my secret prompt that must be hidden',
      });

      const { sensitive } = splitEvent(event);
      const sensitiveStr = JSON.stringify(sensitive);
      const encResult = await encryption.encryptString(sensitiveStr);

      // The encrypted payload must not contain the plaintext
      expect(encResult.ciphertext).not.toContain('This is my secret prompt');
      expect(encResult.ciphertext).not.toContain(sensitiveStr);
    });
  });

  // =========================================================================
  // 2. Full Pull + Decrypt Flow
  // =========================================================================

  describe('2. Full Pull + Decrypt Flow', () => {
    it('should decrypt an encrypted push payload and reconstruct the original event', async () => {
      // Create and encrypt an event (simulating push)
      const originalEvent = makeEventEnvelope('ToolCallCompleted', {
        session_id: 'session-pull-001',
        tool_name: 'Bash',
        tool_input: { command: 'cat /home/user/secrets/credentials.json' },
        tool_response: '{"api_key": "sk-live-abc123", "db_password": "hunter2"}',
        tool_use_id: 'tu_pull_001',
      });

      const { metadata, sensitive } = splitEvent(originalEvent);
      const sensitiveStr = JSON.stringify(sensitive);
      const encResult = await encryption.encryptString(sensitiveStr);

      // Simulate a server response (pull) containing this encrypted event
      const serverResponse = {
        metadata,
        encrypted: encResult.ciphertext,
        nonce: encResult.nonce,
        key_id: encryption.getKeyId(),
      };

      // Decrypt (matching SyncClient.pullEvents logic)
      const ciphertext = encryption.fromBase64(serverResponse.encrypted);
      const nonce = encryption.fromBase64(serverResponse.nonce);
      const plaintext = await encryption.decrypt(ciphertext, nonce);
      const decryptedSensitive = JSON.parse(
        encryption.toString(plaintext),
      ) as Record<string, unknown>;

      // Reassemble the full event
      const reassembled = reassembleEvent(serverResponse.metadata, decryptedSensitive);

      // Verify the reassembled event matches the original
      expect(reassembled.event_id).toBe(originalEvent.event_id);
      expect(reassembled.event_type).toBe(originalEvent.event_type);
      expect(reassembled.project_id).toBe(originalEvent.project_id);
      expect(reassembled.session_id).toBe(originalEvent.session_id);
      expect(reassembled.sequence).toBe(originalEvent.sequence);
      expect(reassembled.timestamp).toBe(originalEvent.timestamp);
      expect(reassembled.agent_provider).toBe(originalEvent.agent_provider);
      expect(reassembled.data).toEqual(originalEvent.data);
    });

    it('should handle events with complex nested data through the full roundtrip', async () => {
      const complexData = {
        session_id: 'session-complex',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/home/user/project/src/auth.ts',
          old_string: 'const password = "hardcoded";',
          new_string: 'const password = process.env.DB_PASSWORD;',
        },
        tool_response: 'File edited successfully',
        tool_use_id: 'tu_complex_001',
      };

      const originalEvent = makeEventEnvelope('ToolCallCompleted', complexData);

      // Full roundtrip: split -> encrypt -> decrypt -> reassemble
      const { metadata, sensitive } = splitEvent(originalEvent);
      const encResult = await encryption.encryptString(JSON.stringify(sensitive));

      const ciphertext = encryption.fromBase64(encResult.ciphertext);
      const nonce = encryption.fromBase64(encResult.nonce);
      const decrypted = JSON.parse(
        encryption.toString(await encryption.decrypt(ciphertext, nonce)),
      ) as Record<string, unknown>;

      const reassembled = reassembleEvent(metadata, decrypted);
      expect(reassembled.data).toEqual(complexData);
    });
  });

  // =========================================================================
  // 3. Multi-Event Roundtrip
  // =========================================================================

  describe('3. Multi-Event Roundtrip', () => {
    it('should encrypt, pull, and decrypt multiple events of different types', async () => {
      const events: Record<string, unknown>[] = [
        makeEventEnvelope('UserPromptReceived', {
          session_id: 'session-multi-001',
          prompt: 'Refactor the authentication module to use JWT tokens',
          is_followup: false,
          model: 'claude-opus-4-6',
        }, { sequence: 1 }),

        makeEventEnvelope('ToolCallCompleted', {
          session_id: 'session-multi-001',
          tool_name: 'Read',
          tool_input: { file_path: '/home/user/project/src/auth.ts' },
          tool_response: 'import jwt from "jsonwebtoken";\n// ... 200 lines of auth code',
          tool_use_id: 'tu_multi_001',
        }, { sequence: 2 }),

        makeEventEnvelope('SessionStarted', {
          session_id: 'session-multi-001',
          cwd: '/home/user/project',
          model: 'claude-opus-4-6',
          transcript_path: '/home/user/.claude/transcripts/session-multi-001.json',
        }, { sequence: 3 }),

        makeEventEnvelope('ToolCallFailed', {
          session_id: 'session-multi-001',
          tool_name: 'Bash',
          tool_input: { command: 'npm test -- --coverage' },
          error: 'ENOENT: no such file or directory /home/user/project/jest.config.js',
          error_code: 'ENOENT',
          tool_use_id: 'tu_multi_002',
        }, { sequence: 4 }),
      ];

      // Encrypt all events (simulating push)
      const encryptedEvents: Array<{
        metadata: CleartextMetadata;
        encrypted: string;
        nonce: string;
        key_id: string;
      }> = [];

      for (const event of events) {
        const { metadata, sensitive } = splitEvent(event);
        const encResult = await encryption.encryptString(JSON.stringify(sensitive));
        encryptedEvents.push({
          metadata,
          encrypted: encResult.ciphertext,
          nonce: encResult.nonce,
          key_id: encryption.getKeyId(),
        });
      }

      // Simulate pull response with all encrypted events
      expect(encryptedEvents).toHaveLength(4);

      // Decrypt and reassemble all events
      const decryptedEvents: Record<string, unknown>[] = [];

      for (const syncEvent of encryptedEvents) {
        const ciphertext = encryption.fromBase64(syncEvent.encrypted);
        const nonce = encryption.fromBase64(syncEvent.nonce);
        const plaintext = await encryption.decrypt(ciphertext, nonce);
        const sensitive = JSON.parse(
          encryption.toString(plaintext),
        ) as Record<string, unknown>;
        const reassembled = reassembleEvent(syncEvent.metadata, sensitive);
        decryptedEvents.push(reassembled);
      }

      // Verify each reconstructed event matches its original
      expect(decryptedEvents).toHaveLength(events.length);

      for (let i = 0; i < events.length; i++) {
        const original = events[i];
        const reconstructed = decryptedEvents[i];

        expect(reconstructed.event_id).toBe(original.event_id);
        expect(reconstructed.event_type).toBe(original.event_type);
        expect(reconstructed.project_id).toBe(original.project_id);
        expect(reconstructed.session_id).toBe(original.session_id);
        expect(reconstructed.sequence).toBe(original.sequence);
        expect(reconstructed.timestamp).toBe(original.timestamp);
        expect(reconstructed.agent_provider).toBe(original.agent_provider);
        expect(reconstructed.data).toEqual(original.data);
      }
    });

    it('should maintain event ordering through the roundtrip', async () => {
      const eventTypes = [
        'SessionStarted',
        'UserPromptReceived',
        'ToolCallRequested',
        'ToolCallCompleted',
        'TurnCompleted',
        'SessionEnded',
      ];

      const events = eventTypes.map((type, i) =>
        makeEventEnvelope(type, { session_id: 'session-order-test' }, { sequence: i + 1 }),
      );

      // Encrypt all
      const encrypted = await Promise.all(
        events.map(async (event) => {
          const { metadata, sensitive } = splitEvent(event);
          const encResult = await encryption.encryptString(JSON.stringify(sensitive));
          return { metadata, encrypted: encResult.ciphertext, nonce: encResult.nonce };
        }),
      );

      // Decrypt all
      const decrypted = await Promise.all(
        encrypted.map(async (syncEvent) => {
          const ct = encryption.fromBase64(syncEvent.encrypted);
          const nc = encryption.fromBase64(syncEvent.nonce);
          const pt = await encryption.decrypt(ct, nc);
          const sensitive = JSON.parse(encryption.toString(pt)) as Record<string, unknown>;
          return reassembleEvent(syncEvent.metadata, sensitive);
        }),
      );

      // Verify ordering is preserved
      for (let i = 0; i < eventTypes.length; i++) {
        expect(decrypted[i].event_type).toBe(eventTypes[i]);
        expect(decrypted[i].sequence).toBe(i + 1);
      }
    });
  });

  // =========================================================================
  // 4. Key Rotation Scenario
  // =========================================================================

  describe('4. Key Rotation Scenario', () => {
    it('should handle key rotation: old key decrypts old events, new key decrypts new events', async () => {
      // Create encryption manager A with key A
      const encryptionA = new EncryptionManager();
      await encryptionA.init();
      const masterKeyA = await encryptionA.generateMasterKey();
      const keyIdA = encryptionA.getKeyId();

      // Encrypt events with key A
      const eventA1 = makeEventEnvelope('UserPromptReceived', {
        session_id: 'session-keyrot-001',
        prompt: 'Event encrypted with key A - batch 1',
      }, { sequence: 1 });

      const eventA2 = makeEventEnvelope('ToolCallCompleted', {
        session_id: 'session-keyrot-001',
        tool_name: 'Read',
        tool_input: { file_path: '/src/index.ts' },
        tool_response: 'export function main() {}',
        tool_use_id: 'tu_keyrot_001',
      }, { sequence: 2 });

      const splitA1 = splitEvent(eventA1);
      const encA1 = await encryptionA.encryptString(JSON.stringify(splitA1.sensitive));

      const splitA2 = splitEvent(eventA2);
      const encA2 = await encryptionA.encryptString(JSON.stringify(splitA2.sensitive));

      // Generate new key B
      const encryptionB = new EncryptionManager();
      await encryptionB.init();
      const masterKeyB = await encryptionB.generateMasterKey();
      const keyIdB = encryptionB.getKeyId();

      // Verify keys are different
      expect(keyIdA).not.toBe(keyIdB);
      expect(masterKeyA.keyBytes).not.toBe(masterKeyB.keyBytes);

      // Encrypt new events with key B
      const eventB1 = makeEventEnvelope('UserPromptReceived', {
        session_id: 'session-keyrot-002',
        prompt: 'Event encrypted with key B',
      }, { sequence: 3 });

      const splitB1 = splitEvent(eventB1);
      const encB1 = await encryptionB.encryptString(JSON.stringify(splitB1.sensitive));

      // Verify events encrypted with key A can be decrypted with key A
      const ctA1 = encryptionA.fromBase64(encA1.ciphertext);
      const ncA1 = encryptionA.fromBase64(encA1.nonce);
      const ptA1 = await encryptionA.decrypt(ctA1, ncA1);
      const sensitiveA1 = JSON.parse(encryptionA.toString(ptA1)) as Record<string, unknown>;
      const reassembledA1 = reassembleEvent(splitA1.metadata, sensitiveA1);
      expect(reassembledA1.data).toEqual(eventA1.data);

      const ctA2 = encryptionA.fromBase64(encA2.ciphertext);
      const ncA2 = encryptionA.fromBase64(encA2.nonce);
      const ptA2 = await encryptionA.decrypt(ctA2, ncA2);
      const sensitiveA2 = JSON.parse(encryptionA.toString(ptA2)) as Record<string, unknown>;
      const reassembledA2 = reassembleEvent(splitA2.metadata, sensitiveA2);
      expect(reassembledA2.data).toEqual(eventA2.data);

      // Verify events encrypted with key B can be decrypted with key B
      const ctB1 = encryptionB.fromBase64(encB1.ciphertext);
      const ncB1 = encryptionB.fromBase64(encB1.nonce);
      const ptB1 = await encryptionB.decrypt(ctB1, ncB1);
      const sensitiveB1 = JSON.parse(encryptionB.toString(ptB1)) as Record<string, unknown>;
      const reassembledB1 = reassembleEvent(splitB1.metadata, sensitiveB1);
      expect(reassembledB1.data).toEqual(eventB1.data);

      // Verify cross-key decryption FAILS: key B cannot decrypt key A's events
      await expect(
        encryptionB.decrypt(ctA1, ncA1),
      ).rejects.toThrow();

      // Verify cross-key decryption FAILS: key A cannot decrypt key B's events
      // Need to decode from base64 using encryptionA's fromBase64
      const ctB1forA = encryptionA.fromBase64(encB1.ciphertext);
      const ncB1forA = encryptionA.fromBase64(encB1.nonce);
      await expect(
        encryptionA.decrypt(ctB1forA, ncB1forA),
      ).rejects.toThrow();
    });

    it('should produce different key IDs for rotated keys', async () => {
      const em = new EncryptionManager();
      await em.init();

      const key1 = await em.generateMasterKey();
      const id1 = em.getKeyId();

      const key2 = await em.generateMasterKey();
      const id2 = em.getKeyId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{16}$/);
      expect(id2).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should allow using an explicit old key to decrypt after rotation', async () => {
      const em = new EncryptionManager();
      await em.init();

      // Generate key A and encrypt
      const keyA = await em.generateMasterKey();
      const keyABytes = em.fromBase64(keyA.keyBytes);
      const encResult = await em.encryptString('payload encrypted with key A');

      // Rotate to key B
      const keyB = await em.generateMasterKey();

      // Decrypt with explicit old key A bytes
      const ct = em.fromBase64(encResult.ciphertext);
      const nc = em.fromBase64(encResult.nonce);
      const decrypted = await em.decryptToString(ct, nc, keyABytes);

      expect(decrypted).toBe('payload encrypted with key A');

      // Verify the current (key B) cannot decrypt
      await expect(em.decrypt(ct, nc)).rejects.toThrow();
    });
  });

  // =========================================================================
  // 5. Metadata Sanitization Verification
  // =========================================================================

  describe('5. Metadata Sanitization Verification', () => {
    /**
     * For each of the 12 event types, create a realistic event with
     * sensitive data and verify the cleartext metadata never leaks it.
     */
    const sensitiveFields = [
      'prompt', 'tool_input', 'tool_response', 'error',
      'cwd', 'transcript_path', 'summary', 'result',
      'task', 'description',
    ];

    const requiredMetadataFields = [
      'event_id', 'event_type', 'project_id', 'session_id',
      'sequence', 'timestamp', 'machine_id',
    ];

    const allEventFixtures: Array<{ type: string; data: Record<string, unknown> }> = [
      {
        type: 'SessionStarted',
        data: {
          session_id: 'session-san-001',
          cwd: '/home/user/classified/top-secret-project',
          model: 'claude-opus-4-6',
          transcript_path: '/home/user/.claude/transcripts/secret-session.json',
        },
      },
      {
        type: 'UserPromptReceived',
        data: {
          session_id: 'session-san-001',
          prompt: 'my secret API key sk-abc123xyz789 -- find all passwords in the codebase',
          is_followup: false,
        },
      },
      {
        type: 'ToolCallRequested',
        data: {
          session_id: 'session-san-001',
          tool_name: 'Bash',
          tool_input: { command: 'cat /etc/shadow && grep -r password /home/user' },
          tool_use_id: 'tu_san_001',
        },
      },
      {
        type: 'ToolCallCompleted',
        data: {
          session_id: 'session-san-001',
          tool_name: 'Bash',
          tool_input: { command: 'cat /home/user/secrets/credentials.json' },
          tool_response: '{"db_password": "hunter2", "api_key": "sk-live-xyz"}',
          tool_use_id: 'tu_san_002',
        },
      },
      {
        type: 'ToolCallFailed',
        data: {
          session_id: 'session-san-001',
          tool_name: 'Write',
          tool_input: { file_path: '/home/user/.ssh/authorized_keys', content: 'ssh-rsa AAAA...' },
          error: 'EACCES: permission denied, open /home/user/.ssh/authorized_keys',
          error_code: 'EACCES',
          tool_use_id: 'tu_san_003',
        },
      },
      {
        type: 'AgentSpawned',
        data: {
          session_id: 'session-san-001',
          subagent_id: 'sub-001',
          task: 'Analyze /home/user/classified/military-contract.ts for vulnerabilities',
          model: 'claude-opus-4-6',
        },
      },
      {
        type: 'AgentCompleted',
        data: {
          session_id: 'session-san-001',
          subagent_id: 'sub-001',
          result: 'Found 3 critical SQL injection vulnerabilities in auth.ts with hardcoded credentials',
          success: true,
        },
      },
      {
        type: 'TurnCompleted',
        data: {
          session_id: 'session-san-001',
          input_tokens: 15000,
          output_tokens: 3500,
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'CompactionTriggered',
        data: {
          session_id: 'session-san-001',
          summary: 'User asked to refactor auth.ts at /home/user/project/src/auth.ts. Found hardcoded passwords.',
          messages_before: 150,
          messages_after: 15,
        },
      },
      {
        type: 'SessionEnded',
        data: {
          session_id: 'session-san-001',
          reason: 'user_exit',
          total_input_tokens: 85000,
          total_output_tokens: 22000,
          duration_ms: 600000,
        },
      },
      {
        type: 'PermissionRequested',
        data: {
          session_id: 'session-san-001',
          permission_id: 'perm-001',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /home/user/important-data' },
          description: 'Agent wants to delete /home/user/important-data which contains 500 sensitive files',
        },
      },
      {
        type: 'PermissionResponded',
        data: {
          session_id: 'session-san-001',
          permission_id: 'perm-001',
          granted: false,
          reason: 'Dangerous operation on /home/user/important-data',
        },
      },
    ];

    it.each(allEventFixtures)(
      'should never leak sensitive data in cleartext metadata for $type events',
      ({ type, data }) => {
        const event = makeEventEnvelope(type, data);
        const { metadata } = splitEvent(event);

        // Serialize metadata to check for leaks
        const metadataJson = JSON.stringify(metadata);

        // Verify required metadata fields ARE present
        for (const field of requiredMetadataFields) {
          expect(metadata).toHaveProperty(field);
          const value = (metadata as Record<string, unknown>)[field];
          expect(value).toBeDefined();
          expect(value).not.toBeNull();
        }

        // Verify sensitive fields do NOT appear in metadata
        const metadataRecord = metadata as unknown as Record<string, unknown>;
        for (const field of sensitiveFields) {
          if (data[field] !== undefined) {
            // The sensitive field's value must not appear in the serialized metadata
            const sensitiveValue = typeof data[field] === 'string'
              ? data[field] as string
              : JSON.stringify(data[field]);

            // Only check if the sensitive value is a substantial string
            if (typeof sensitiveValue === 'string' && sensitiveValue.length > 3) {
              expect(metadataJson).not.toContain(sensitiveValue);
            }
          }
        }

        // Verify prompt text never appears
        if (data.prompt) {
          expect(metadataJson).not.toContain(data.prompt as string);
        }

        // Verify tool_response content never appears
        if (data.tool_response && typeof data.tool_response === 'string') {
          expect(metadataJson).not.toContain(data.tool_response);
        }

        // Verify error messages never appear
        if (data.error && typeof data.error === 'string') {
          expect(metadataJson).not.toContain(data.error);
        }

        // Verify file paths from cwd/transcript_path never appear
        if (data.cwd && typeof data.cwd === 'string') {
          expect(metadataJson).not.toContain(data.cwd);
        }
        if (data.transcript_path && typeof data.transcript_path === 'string') {
          expect(metadataJson).not.toContain(data.transcript_path);
        }
      },
    );

    it('should preserve all required metadata fields across all 12 event types', () => {
      expect(allEventFixtures).toHaveLength(12);

      for (const { type, data } of allEventFixtures) {
        const event = makeEventEnvelope(type, data);
        const { metadata } = splitEvent(event);

        expect(metadata.event_id).toBeDefined();
        expect(metadata.event_type).toBe(type);
        expect(metadata.project_id).toBe('saqr-proj-a1b2c3');
        expect(metadata.session_id).toBe('session-e2e-test-001');
        expect(typeof metadata.sequence).toBe('number');
        expect(metadata.timestamp).toBe('2026-02-23T12:00:00.000Z');
        expect(metadata.machine_id).toBeDefined();
      }
    });

    it('should put all sensitive field values into the sensitive bucket', () => {
      for (const { type, data } of allEventFixtures) {
        const event = makeEventEnvelope(type, data);
        const { sensitive } = splitEvent(event);

        // _raw_data should contain the complete original data for reconstruction
        expect(sensitive._raw_data).toEqual(data);

        // Each sensitive field present in data should also be in sensitive
        for (const field of sensitiveFields) {
          if (data[field] !== undefined) {
            expect(sensitive[field]).toEqual(data[field]);
          }
        }
      }
    });
  });

  // =========================================================================
  // 6. Wire Format Compatibility
  // =========================================================================

  describe('6. Wire Format Compatibility', () => {
    it('should produce a push payload matching the SyncClient wire format', async () => {
      const machineId = 'machine-wire-format-001';
      const event = makeEventEnvelope('UserPromptReceived', {
        session_id: 'session-wire-001',
        prompt: 'Test prompt for wire format verification',
        model: 'claude-opus-4-6',
      });

      // Reproduce exactly what SyncClient.pushEvent does
      const { metadata, sensitive } = splitEvent(event);
      metadata.machine_id = machineId;

      const sensitiveStr = JSON.stringify(sensitive);
      const encResult = await encryption.encryptString(sensitiveStr);

      const pushPayload = {
        machine_id: machineId,
        key_id: encryption.getKeyId(),
        events: [
          {
            metadata,
            encrypted: encResult.ciphertext,
            nonce: encResult.nonce,
          },
        ],
      };

      // Verify the top-level structure
      const payloadJson = JSON.stringify(pushPayload);
      const parsed = JSON.parse(payloadJson) as Record<string, unknown>;

      expect(parsed).toHaveProperty('machine_id');
      expect(parsed).toHaveProperty('key_id');
      expect(parsed).toHaveProperty('events');
      expect(typeof parsed.machine_id).toBe('string');
      expect(typeof parsed.key_id).toBe('string');
      expect(Array.isArray(parsed.events)).toBe(true);

      // Verify each event in the events array
      const eventsArray = parsed.events as Array<Record<string, unknown>>;
      expect(eventsArray).toHaveLength(1);

      const wireEvent = eventsArray[0];
      expect(wireEvent).toHaveProperty('metadata');
      expect(wireEvent).toHaveProperty('encrypted');
      expect(wireEvent).toHaveProperty('nonce');

      // Verify metadata structure matches CleartextMetadata
      const meta = wireEvent.metadata as Record<string, unknown>;
      expect(meta).toHaveProperty('event_id');
      expect(meta).toHaveProperty('event_type');
      expect(meta).toHaveProperty('project_id');
      expect(meta).toHaveProperty('session_id');
      expect(meta).toHaveProperty('sequence');
      expect(meta).toHaveProperty('timestamp');
      expect(meta).toHaveProperty('agent_provider');
      expect(meta).toHaveProperty('machine_id');

      // Verify encrypted and nonce are base64 strings (non-empty)
      expect(typeof wireEvent.encrypted).toBe('string');
      expect((wireEvent.encrypted as string).length).toBeGreaterThan(0);
      expect(typeof wireEvent.nonce).toBe('string');
      expect((wireEvent.nonce as string).length).toBeGreaterThan(0);

      // Verify the key_id matches the encryption manager's key ID
      expect(parsed.key_id).toBe(encryption.getKeyId());
      expect((parsed.key_id as string)).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should produce valid base64 in encrypted and nonce fields', async () => {
      const event = makeEventEnvelope('ToolCallCompleted', {
        session_id: 'session-b64-test',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        tool_response: 'hello',
        tool_use_id: 'tu_b64_001',
      });

      const { sensitive } = splitEvent(event);
      const encResult = await encryption.encryptString(JSON.stringify(sensitive));

      // Verify the base64 values can be decoded back to Uint8Array
      const ciphertextBytes = encryption.fromBase64(encResult.ciphertext);
      const nonceBytes = encryption.fromBase64(encResult.nonce);

      expect(ciphertextBytes).toBeInstanceOf(Uint8Array);
      expect(ciphertextBytes.length).toBeGreaterThan(0);
      expect(nonceBytes).toBeInstanceOf(Uint8Array);
      // XChaCha20 nonce is 24 bytes
      expect(nonceBytes.length).toBe(24);
    });

    it('should survive JSON serialization and deserialization of the full payload', async () => {
      const machineId = 'machine-json-roundtrip';
      const originalEvent = makeEventEnvelope('AgentSpawned', {
        session_id: 'session-json-rt',
        subagent_id: 'sub-json-001',
        task: 'Analyze the security vulnerabilities in /home/user/project/src/auth.ts',
        model: 'claude-opus-4-6',
      });

      const { metadata, sensitive } = splitEvent(originalEvent);
      metadata.machine_id = machineId;

      const encResult = await encryption.encryptString(JSON.stringify(sensitive));

      const pushPayload = {
        machine_id: machineId,
        key_id: encryption.getKeyId(),
        events: [{
          metadata,
          encrypted: encResult.ciphertext,
          nonce: encResult.nonce,
        }],
      };

      // Simulate network transmission: serialize and deserialize
      const wireJson = JSON.stringify(pushPayload);
      const received = JSON.parse(wireJson) as typeof pushPayload;

      // Decrypt from the deserialized payload
      const receivedEvent = received.events[0];
      const ct = encryption.fromBase64(receivedEvent.encrypted);
      const nc = encryption.fromBase64(receivedEvent.nonce);
      const pt = await encryption.decrypt(ct, nc);
      const decryptedSensitive = JSON.parse(encryption.toString(pt)) as Record<string, unknown>;

      const reassembled = reassembleEvent(
        receivedEvent.metadata as CleartextMetadata,
        decryptedSensitive,
      );

      expect(reassembled.event_type).toBe('AgentSpawned');
      expect(reassembled.data).toEqual(originalEvent.data);
    });

    it('should batch multiple events in a single push payload', async () => {
      const machineId = 'machine-batch-001';
      const events = [
        makeEventEnvelope('UserPromptReceived', {
          session_id: 'session-batch',
          prompt: 'First prompt',
        }, { sequence: 1 }),
        makeEventEnvelope('ToolCallCompleted', {
          session_id: 'session-batch',
          tool_name: 'Bash',
          tool_input: { command: 'echo test' },
          tool_response: 'test',
          tool_use_id: 'tu_batch_001',
        }, { sequence: 2 }),
        makeEventEnvelope('TurnCompleted', {
          session_id: 'session-batch',
          input_tokens: 1000,
          output_tokens: 500,
          stop_reason: 'end_turn',
        }, { sequence: 3 }),
      ];

      const encryptedEvents: Array<{
        metadata: CleartextMetadata;
        encrypted: string;
        nonce: string;
      }> = [];

      for (const event of events) {
        const { metadata, sensitive } = splitEvent(event);
        metadata.machine_id = machineId;
        const encResult = await encryption.encryptString(JSON.stringify(sensitive));
        encryptedEvents.push({
          metadata,
          encrypted: encResult.ciphertext,
          nonce: encResult.nonce,
        });
      }

      const batchPayload = {
        machine_id: machineId,
        key_id: encryption.getKeyId(),
        events: encryptedEvents,
      };

      // Verify batch structure
      expect(batchPayload.events).toHaveLength(3);
      expect(batchPayload.machine_id).toBe(machineId);
      expect(batchPayload.key_id).toBe(encryption.getKeyId());

      // Verify each event in the batch has the correct structure
      for (const evt of batchPayload.events) {
        expect(evt).toHaveProperty('metadata');
        expect(evt).toHaveProperty('encrypted');
        expect(evt).toHaveProperty('nonce');
        expect(evt.metadata.machine_id).toBe(machineId);
      }

      // Verify we can decrypt all events in the batch
      const decrypted: Record<string, unknown>[] = [];
      for (const evt of batchPayload.events) {
        const ct = encryption.fromBase64(evt.encrypted);
        const nc = encryption.fromBase64(evt.nonce);
        const pt = await encryption.decrypt(ct, nc);
        const sensitive = JSON.parse(encryption.toString(pt)) as Record<string, unknown>;
        decrypted.push(reassembleEvent(evt.metadata, sensitive));
      }

      expect(decrypted).toHaveLength(3);
      expect(decrypted[0].event_type).toBe('UserPromptReceived');
      expect(decrypted[1].event_type).toBe('ToolCallCompleted');
      expect(decrypted[2].event_type).toBe('TurnCompleted');

      // Verify data integrity
      expect((decrypted[0].data as Record<string, unknown>).prompt).toBe('First prompt');
      expect((decrypted[1].data as Record<string, unknown>).tool_response).toBe('test');
      expect((decrypted[2].data as Record<string, unknown>).input_tokens).toBe(1000);
    });

    it('should have unique nonces across all events in a batch', async () => {
      const events = Array.from({ length: 20 }, (_, i) =>
        makeEventEnvelope('UserPromptReceived', {
          session_id: 'session-nonce-unique',
          prompt: `Prompt number ${i}`,
        }, { sequence: i }),
      );

      const nonces = new Set<string>();

      for (const event of events) {
        const { sensitive } = splitEvent(event);
        const encResult = await encryption.encryptString(JSON.stringify(sensitive));
        nonces.add(encResult.nonce);
      }

      // All 20 nonces must be unique
      expect(nonces.size).toBe(20);
    });
  });
});
