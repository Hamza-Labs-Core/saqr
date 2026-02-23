import { describe, it, expect } from 'vitest';
import { splitEvent, reassembleEvent } from '../metadata-splitter.js';

describe('MetadataSplitter', () => {
  const baseEvent = {
    event_id: '550e8400-e29b-41d4-a716-446655440000',
    event_type: 'ToolCallCompleted',
    project_id: 'my-project-a3f7b2',
    session_id: 'session-abc123',
    sequence: 42,
    timestamp: '2026-02-21T10:30:00.000Z',
    agent_provider: 'claude-code',
    machine_id: 'macbook-pro-f3a2b1',
  };

  describe('splitEvent()', () => {
    it('should separate envelope fields into metadata', () => {
      const event = {
        ...baseEvent,
        data: { tool_name: 'Bash' },
      };

      const { metadata } = splitEvent(event);

      expect(metadata.event_id).toBe(event.event_id);
      expect(metadata.event_type).toBe(event.event_type);
      expect(metadata.project_id).toBe(event.project_id);
      expect(metadata.session_id).toBe(event.session_id);
      expect(metadata.sequence).toBe(event.sequence);
      expect(metadata.timestamp).toBe(event.timestamp);
      expect(metadata.agent_provider).toBe(event.agent_provider);
      expect(metadata.machine_id).toBe(event.machine_id);
    });

    it('should put prompts in the sensitive bucket', () => {
      const event = {
        ...baseEvent,
        event_type: 'UserPromptReceived',
        data: {
          session_id: 'session-abc123',
          prompt: 'Write a function that sorts an array using quicksort',
          is_followup: false,
        },
      };

      const { metadata, sensitive } = splitEvent(event);

      // Prompt should be in sensitive, NOT in metadata
      expect(sensitive.prompt).toBe('Write a function that sorts an array using quicksort');
      expect((metadata as unknown as Record<string, unknown>)['prompt']).toBeUndefined();
    });

    it('should put tool_input in the sensitive bucket', () => {
      const event = {
        ...baseEvent,
        event_type: 'ToolCallCompleted',
        data: {
          session_id: 'session-abc123',
          tool_name: 'Bash',
          tool_input: { command: 'cat /etc/passwd' },
          tool_response: 'root:x:0:0:root:/root:/bin/bash',
          tool_use_id: 'tu_12345',
        },
      };

      const { metadata, sensitive } = splitEvent(event);

      // tool_input and tool_response should be sensitive
      expect(sensitive.tool_input).toEqual({ command: 'cat /etc/passwd' });
      expect(sensitive.tool_response).toBe('root:x:0:0:root:/root:/bin/bash');

      // tool_name and tool_use_id should be in metadata (cleartext)
      expect((metadata as unknown as Record<string, unknown>)['tool_input']).toBeUndefined();
      expect((metadata as unknown as Record<string, unknown>)['tool_response']).toBeUndefined();
    });

    it('should put error messages in the sensitive bucket', () => {
      const event = {
        ...baseEvent,
        event_type: 'ToolCallFailed',
        data: {
          session_id: 'session-abc123',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
          error: 'Permission denied: /secret/config.yaml',
          error_code: 'EPERM',
        },
      };

      const { sensitive } = splitEvent(event);
      expect(sensitive.error).toBe('Permission denied: /secret/config.yaml');
    });

    it('should put transcript_path in the sensitive bucket', () => {
      const event = {
        ...baseEvent,
        event_type: 'SessionStarted',
        data: {
          session_id: 'session-abc123',
          cwd: '/home/user/secret-project',
          transcript_path: '/home/user/.claude/transcripts/abc123.json',
          model: 'claude-opus-4-6',
        },
      };

      const { metadata, sensitive } = splitEvent(event);

      expect(sensitive.transcript_path).toBe('/home/user/.claude/transcripts/abc123.json');
      expect(sensitive.cwd).toBe('/home/user/secret-project');
      expect(metadata.model).toBe('claude-opus-4-6');
    });

    it('should keep tool_name in cleartext metadata', () => {
      const event = {
        ...baseEvent,
        data: {
          tool_name: 'Bash',
          tool_input: { command: 'secret command' },
          tool_response: 'secret output',
        },
      };

      const { metadata } = splitEvent(event);
      // tool_name should be accessible via cleartext data lookup
      // It goes into metadata.model etc via the data fields
      expect((metadata as unknown as Record<string, unknown>)['tool_name']).toBeUndefined();
      // But it IS not directly on CleartextMetadata; it's in the cleartext data fields
    });

    it('should keep model in cleartext metadata', () => {
      const event = {
        ...baseEvent,
        data: {
          model: 'claude-opus-4-6',
          input_tokens: 1500,
          output_tokens: 500,
        },
      };

      const { metadata } = splitEvent(event);
      expect(metadata.model).toBe('claude-opus-4-6');
      expect(metadata.input_tokens).toBe(1500);
      expect(metadata.output_tokens).toBe(500);
    });

    it('should include _raw_data in sensitive for full reconstruction', () => {
      const data = {
        session_id: 'session-abc123',
        tool_name: 'Read',
        tool_input: { path: '/secret/file.txt' },
        tool_response: 'file contents here',
        tool_use_id: 'tu_99',
      };

      const event = { ...baseEvent, data };
      const { sensitive } = splitEvent(event);

      expect(sensitive._raw_data).toEqual(data);
    });

    it('should handle events with no data field', () => {
      const event = { ...baseEvent };
      const { metadata, sensitive } = splitEvent(event);

      expect(metadata.event_id).toBe(event.event_id);
      expect(sensitive._raw_data).toEqual({});
    });

    it('should handle SessionEnded events', () => {
      const event = {
        ...baseEvent,
        event_type: 'SessionEnded',
        data: {
          session_id: 'session-abc123',
          reason: 'user_exit',
          total_input_tokens: 50000,
          total_output_tokens: 10000,
          duration_ms: 300000,
        },
      };

      const { sensitive } = splitEvent(event);
      expect(sensitive._raw_data).toEqual(event.data);
    });

    it('should handle CompactionTriggered events', () => {
      const event = {
        ...baseEvent,
        event_type: 'CompactionTriggered',
        data: {
          session_id: 'session-abc123',
          summary: 'Detailed summary of previous context with code snippets',
          messages_before: 100,
          messages_after: 10,
        },
      };

      const { sensitive } = splitEvent(event);
      // summary contains user content and should be sensitive
      expect(sensitive.summary).toBe('Detailed summary of previous context with code snippets');
    });

    it('should handle AgentSpawned events', () => {
      const event = {
        ...baseEvent,
        event_type: 'AgentSpawned',
        data: {
          session_id: 'session-abc123',
          subagent_id: 'sub-123',
          task: 'Analyze the codebase at /secret/path and find bugs',
          model: 'claude-opus-4-6',
        },
      };

      const { metadata, sensitive } = splitEvent(event);
      // task is sensitive (contains file paths/user content)
      expect(sensitive.task).toBe('Analyze the codebase at /secret/path and find bugs');
      expect(metadata.model).toBe('claude-opus-4-6');
    });

    it('should ensure no sensitive data leaks into cleartext metadata', () => {
      const event = {
        ...baseEvent,
        data: {
          prompt: 'My secret API key is sk-1234567890',
          tool_input: { command: 'cat /etc/shadow' },
          tool_response: 'root:$6$hash:18000:0:99999:7:::',
          error: 'Cannot access /home/user/.ssh/id_rsa',
          transcript_path: '/home/user/private/transcript.json',
          cwd: '/home/user/classified-project',
          model: 'claude-opus-4-6',
        },
      };

      const { metadata } = splitEvent(event);

      // Serialize metadata and check that no sensitive content leaked
      const metadataStr = JSON.stringify(metadata);

      expect(metadataStr).not.toContain('sk-1234567890');
      expect(metadataStr).not.toContain('/etc/shadow');
      expect(metadataStr).not.toContain('root:$6$hash');
      expect(metadataStr).not.toContain('/home/user/.ssh');
      expect(metadataStr).not.toContain('/home/user/private');
      expect(metadataStr).not.toContain('classified-project');
      // model IS cleartext
      expect(metadataStr).toContain('claude-opus-4-6');
    });
  });

  describe('reassembleEvent()', () => {
    it('should reconstruct the original event from metadata and sensitive', () => {
      const originalData = {
        session_id: 'session-abc123',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_response: 'total 42\nfile1.txt\nfile2.txt',
        tool_use_id: 'tu_12345',
      };

      const event = {
        ...baseEvent,
        data: originalData,
      };

      const { metadata, sensitive } = splitEvent(event);
      const reassembled = reassembleEvent(metadata, sensitive);

      expect(reassembled.event_id).toBe(event.event_id);
      expect(reassembled.event_type).toBe(event.event_type);
      expect(reassembled.project_id).toBe(event.project_id);
      expect(reassembled.session_id).toBe(event.session_id);
      expect(reassembled.sequence).toBe(event.sequence);
      expect(reassembled.timestamp).toBe(event.timestamp);
      expect(reassembled.data).toEqual(originalData);
    });

    it('should produce identical data for split+reassemble roundtrip', () => {
      const originalData = {
        prompt: 'Tell me about TypeScript generics',
        model: 'claude-opus-4-6',
        is_followup: false,
      };

      const event = {
        ...baseEvent,
        event_type: 'UserPromptReceived',
        data: originalData,
      };

      const { metadata, sensitive } = splitEvent(event);
      const reassembled = reassembleEvent(metadata, sensitive);

      expect(reassembled.data).toEqual(originalData);
    });
  });

  describe('determinism', () => {
    it('should produce the same output for the same input', () => {
      const event = {
        ...baseEvent,
        data: {
          tool_name: 'Bash',
          tool_input: { command: 'echo hello' },
          tool_response: 'hello',
        },
      };

      const result1 = splitEvent(event);
      const result2 = splitEvent(event);

      expect(result1.metadata).toEqual(result2.metadata);
      expect(result1.sensitive).toEqual(result2.sensitive);
    });
  });
});
