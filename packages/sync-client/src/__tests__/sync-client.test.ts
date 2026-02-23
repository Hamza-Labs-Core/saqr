import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SyncClient } from '../sync-client.js';
import { EncryptionManager } from '../encryption.js';
import type { SyncConfig } from '@saqr/shared';
import type { HttpSender } from '../sync-client.js';

describe('SyncClient', () => {
  let encryption: EncryptionManager;
  let config: SyncConfig;

  beforeAll(async () => {
    encryption = new EncryptionManager();
    await encryption.init();
    await encryption.generateMasterKey();
  });

  beforeEach(() => {
    config = {
      enabled: true,
      serverUrl: 'https://sync.example.com',
      authToken: 'test-jwt-token',
      machineId: 'test-machine-abc123',
      machineName: 'Test Machine',
      syncProjectIds: [],
      pushIntervalMs: 5000,
      pullIntervalMs: 30000,
      pushBatchSize: 100,
      useWebSocket: false,
    };
  });

  const createMockEvent = () => ({
    event_id: '550e8400-e29b-41d4-a716-446655440000',
    event_type: 'ToolCallCompleted',
    project_id: 'my-project-a3f7b2',
    session_id: 'session-abc123',
    sequence: 42,
    timestamp: '2026-02-21T10:30:00.000Z',
    agent_provider: 'claude-code',
    data: {
      tool_name: 'Bash',
      tool_input: { command: 'cat /etc/passwd' },
      tool_response: 'root:x:0:0:root:/root:/bin/bash',
      tool_use_id: 'tu_12345',
    },
  });

  describe('pushEvent()', () => {
    it('should encrypt sensitive data before sending', async () => {
      let capturedBody: string | undefined;

      const mockSender: HttpSender = async (_url, options) => {
        capturedBody = options.body;
        return { ok: true, status: 200, json: async () => ({ accepted: 1, rejected: 0, errors: [] }) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      const event = createMockEvent();

      await client.pushEvent(event);

      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);

      // Should have machine_id and key_id
      expect(parsed.machine_id).toBe('test-machine-abc123');
      expect(parsed.key_id).toBe(encryption.getKeyId());

      // Should have one event with metadata, encrypted, and nonce
      expect(parsed.events).toHaveLength(1);
      const pushed = parsed.events[0];

      // Metadata should contain cleartext fields
      expect(pushed.metadata.event_id).toBe(event.event_id);
      expect(pushed.metadata.event_type).toBe('ToolCallCompleted');

      // Encrypted should be base64 string, NOT contain plaintext sensitive data
      expect(typeof pushed.encrypted).toBe('string');
      expect(typeof pushed.nonce).toBe('string');

      // Sensitive data should NOT appear in plaintext
      expect(capturedBody).not.toContain('cat /etc/passwd');
      expect(capturedBody).not.toContain('root:x:0:0:root:/root:/bin/bash');
    });

    it('should send POST to the correct URL', async () => {
      let capturedUrl: string | undefined;

      const mockSender: HttpSender = async (url) => {
        capturedUrl = url;
        return { ok: true, status: 200, json: async () => ({ accepted: 1, rejected: 0, errors: [] }) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      await client.pushEvent(createMockEvent());

      expect(capturedUrl).toBe('https://sync.example.com/api/sync/push');
    });

    it('should include Authorization header', async () => {
      let capturedHeaders: Record<string, string> | undefined;

      const mockSender: HttpSender = async (_url, options) => {
        capturedHeaders = options.headers;
        return { ok: true, status: 200, json: async () => ({ accepted: 1, rejected: 0, errors: [] }) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      await client.pushEvent(createMockEvent());

      expect(capturedHeaders?.['Authorization']).toBe('Bearer test-jwt-token');
      expect(capturedHeaders?.['Content-Type']).toBe('application/json');
    });

    it('should throw on HTTP error', async () => {
      const mockSender: HttpSender = async () => {
        return { ok: false, status: 500, json: async () => ({}) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      await expect(client.pushEvent(createMockEvent())).rejects.toThrow('Push failed: HTTP 500');
    });

    it('should throw when sync is disabled', async () => {
      const disabledConfig = { ...config, enabled: false };
      const client = new SyncClient(disabledConfig, encryption);
      await expect(client.pushEvent(createMockEvent())).rejects.toThrow('Sync is not enabled');
    });

    it('should update status to synced after successful push', async () => {
      const mockSender: HttpSender = async () => {
        return { ok: true, status: 200, json: async () => ({ accepted: 1, rejected: 0, errors: [] }) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      await client.pushEvent(createMockEvent());

      const status = await client.status();
      expect(status.state).toBe('synced');
      expect(status.lastSync).not.toBeNull();
      expect(status.lastError).toBeNull();
    });

    it('should update status to error after failed push', async () => {
      const mockSender: HttpSender = async () => {
        return { ok: false, status: 500, json: async () => ({}) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      try { await client.pushEvent(createMockEvent()); } catch { /* expected */ }

      const status = await client.status();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('HTTP 500');
    });

    it('should handle 207 Multi-Status as success', async () => {
      const mockSender: HttpSender = async () => {
        return {
          ok: false, // 207 is technically not "ok" via fetch
          status: 207,
          json: async () => ({ accepted: 1, rejected: 0, errors: [] }),
        };
      };

      const client = new SyncClient(config, encryption, mockSender);
      // 207 is handled as success
      await expect(client.pushEvent(createMockEvent())).resolves.toBeUndefined();
    });
  });

  describe('pullEvents()', () => {
    it('should decrypt events received from server', async () => {
      // First, create an encrypted event payload
      const sensitiveData = {
        tool_input: { command: 'secret-command' },
        tool_response: 'secret-output',
        _raw_data: {
          tool_name: 'Bash',
          tool_input: { command: 'secret-command' },
          tool_response: 'secret-output',
          tool_use_id: 'tu_99',
        },
      };

      const encResult = await encryption.encryptString(JSON.stringify(sensitiveData));

      const mockSender: HttpSender = async (url) => {
        if (url.includes('/api/sync/pull')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              events: [
                {
                  metadata: {
                    event_id: 'evt-001',
                    event_type: 'ToolCallCompleted',
                    project_id: 'proj-1',
                    session_id: 'sess-1',
                    sequence: 1,
                    timestamp: '2026-02-21T10:00:00.000Z',
                    agent_provider: 'claude-code',
                    machine_id: 'other-machine',
                  },
                  encrypted: encResult.ciphertext,
                  nonce: encResult.nonce,
                  key_id: encryption.getKeyId(),
                },
              ],
              cursor: '2026-02-21T10:00:00.000Z:1',
              has_more: false,
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      const events = await client.pullEvents(null);

      expect(events).toHaveLength(1);
      expect(events[0].event_id).toBe('evt-001');
      expect(events[0].event_type).toBe('ToolCallCompleted');
      expect((events[0].data as Record<string, unknown>).tool_response).toBe('secret-output');
    });

    it('should skip events with unknown key_id', async () => {
      const encResult = await encryption.encryptString('{}');

      const mockSender: HttpSender = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              {
                metadata: {
                  event_id: 'evt-unknown',
                  event_type: 'SessionStarted',
                  project_id: 'proj-1',
                  session_id: 'sess-1',
                  sequence: 1,
                  timestamp: '2026-02-21T10:00:00.000Z',
                  agent_provider: 'claude-code',
                  machine_id: 'other-machine',
                },
                encrypted: encResult.ciphertext,
                nonce: encResult.nonce,
                key_id: 'unknown-key-id-that-doesnt-match',
              },
            ],
            cursor: '2026-02-21T10:00:00.000Z:1',
            has_more: false,
          }),
        };
      };

      const client = new SyncClient(config, encryption, mockSender);
      const events = await client.pullEvents(null);

      // Should skip the event with unknown key_id
      expect(events).toHaveLength(0);
    });

    it('should include cursor parameters in the request', async () => {
      let capturedUrl: string | undefined;

      const mockSender: HttpSender = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ events: [], cursor: '', has_more: false }),
        };
      };

      const client = new SyncClient(config, encryption, mockSender);
      await client.pullEvents({
        last_timestamp: '2026-02-21T10:00:00.000Z',
        last_event_id: 'evt-42',
        machine_id: 'machine-x',
      });

      expect(capturedUrl).toContain('after=');
      expect(capturedUrl).toContain('machine_id=machine-x');
    });

    it('should throw when sync is disabled', async () => {
      const disabledConfig = { ...config, enabled: false };
      const client = new SyncClient(disabledConfig, encryption);
      await expect(client.pullEvents(null)).rejects.toThrow('Sync is not enabled');
    });

    it('should throw on HTTP error', async () => {
      const mockSender: HttpSender = async () => {
        return { ok: false, status: 403, json: async () => ({}) };
      };

      const client = new SyncClient(config, encryption, mockSender);
      await expect(client.pullEvents(null)).rejects.toThrow('Pull failed: HTTP 403');
    });
  });

  describe('status()', () => {
    it('should return disabled state when sync is disabled', async () => {
      const disabledConfig = { ...config, enabled: false };
      const client = new SyncClient(disabledConfig, encryption);
      const status = await client.status();

      expect(status.state).toBe('disabled');
      expect(status.connected).toBe(false);
    });

    it('should return pending state when sync is enabled but no sync has happened', async () => {
      const client = new SyncClient(config, encryption);
      const status = await client.status();

      expect(status.state).toBe('pending');
      expect(status.lastSync).toBeNull();
    });
  });
});
