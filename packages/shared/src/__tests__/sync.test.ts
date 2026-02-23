import { describe, it, expect } from "vitest";
import type {
  EncryptedBlob,
  CleartextMetadata,
  SyncPushPayload,
  SyncPullRequest,
  SyncPullResponse,
  SyncCursor,
  SyncConfig,
} from "../sync/index.js";

describe("sync/types", () => {
  describe("EncryptedBlob interface", () => {
    it("should accept a valid EncryptedBlob (compile-time check)", () => {
      const blob: EncryptedBlob = {
        ciphertext: "base64encodedciphertext==",
        nonce: "base64encodednonce==",
        key_id: "key-001",
        algorithm: "xchacha20-poly1305",
      };

      expect(blob.algorithm).toBe("xchacha20-poly1305");
      expect(blob.key_id).toBe("key-001");
    });
  });

  describe("CleartextMetadata interface", () => {
    it("should accept a valid CleartextMetadata (compile-time check)", () => {
      const meta: CleartextMetadata = {
        event_id: "550e8400-e29b-41d4-a716-446655440000",
        event_type: "ToolCallCompleted",
        project_id: "my-project-a3f7b2",
        session_id: "abc123",
        sequence: 42,
        timestamp: "2026-02-22T10:00:00.000Z",
        agent_provider: "claude-code",
        model: "claude-opus-4-6",
        input_tokens: 5000,
        output_tokens: 1000,
        machine_id: "machine-1",
      };

      expect(meta.event_type).toBe("ToolCallCompleted");
      expect(meta.machine_id).toBe("machine-1");
    });

    it("should work with only required fields", () => {
      const meta: CleartextMetadata = {
        event_id: "id-1",
        event_type: "SessionStarted",
        project_id: "proj-1",
        session_id: "sess-1",
        sequence: 1,
        timestamp: "2026-02-22T10:00:00.000Z",
        agent_provider: "opencode",
        machine_id: "m-1",
      };

      expect(meta.model).toBeUndefined();
      expect(meta.input_tokens).toBeUndefined();
    });
  });

  describe("SyncPushPayload interface", () => {
    it("should combine metadata and encrypted blob", () => {
      const payload: SyncPushPayload = {
        metadata: {
          event_id: "id-1",
          event_type: "SessionStarted",
          project_id: "proj-1",
          session_id: "sess-1",
          sequence: 1,
          timestamp: "2026-02-22T10:00:00.000Z",
          agent_provider: "claude-code",
          machine_id: "m-1",
        },
        encrypted: {
          ciphertext: "encrypted==",
          nonce: "nonce==",
          key_id: "key-001",
          algorithm: "xchacha20-poly1305",
        },
      };

      expect(payload.metadata.event_id).toBe("id-1");
      expect(payload.encrypted.algorithm).toBe("xchacha20-poly1305");
    });
  });

  describe("SyncPullRequest interface", () => {
    it("should accept a request with cursor", () => {
      const request: SyncPullRequest = {
        machine_id: "machine-2",
        cursor: {
          last_timestamp: "2026-02-22T09:00:00.000Z",
          last_event_id: "id-100",
          machine_id: "machine-2",
        },
        project_ids: ["proj-1", "proj-2"],
        limit: 50,
      };

      expect(request.cursor?.last_event_id).toBe("id-100");
      expect(request.limit).toBe(50);
    });

    it("should accept a request with null cursor (initial pull)", () => {
      const request: SyncPullRequest = {
        machine_id: "all",
        cursor: null,
      };

      expect(request.cursor).toBeNull();
      expect(request.machine_id).toBe("all");
    });
  });

  describe("SyncPullResponse interface", () => {
    it("should contain events, cursor, and has_more flag", () => {
      const response: SyncPullResponse = {
        events: [],
        cursor: {
          last_timestamp: "2026-02-22T10:00:00.000Z",
          last_event_id: "id-50",
          machine_id: "machine-1",
        },
        has_more: false,
      };

      expect(response.events).toHaveLength(0);
      expect(response.has_more).toBe(false);
    });
  });

  describe("SyncConfig interface", () => {
    it("should accept a full configuration", () => {
      const config: SyncConfig = {
        enabled: true,
        serverUrl: "https://sync.saqr.dev",
        authToken: "jwt-token-here",
        machineId: "machine-abc",
        machineName: "Linux Dev VM",
        syncProjectIds: ["proj-1"],
        pushIntervalMs: 5000,
        pullIntervalMs: 30000,
        pushBatchSize: 100,
        useWebSocket: true,
      };

      expect(config.enabled).toBe(true);
      expect(config.serverUrl).toBe("https://sync.saqr.dev");
      expect(config.pushBatchSize).toBe(100);
    });

    it("should work with minimal required fields", () => {
      const config: SyncConfig = {
        enabled: false,
        serverUrl: "",
        machineId: "m-1",
        syncProjectIds: [],
        pushIntervalMs: 5000,
        pullIntervalMs: 30000,
        pushBatchSize: 100,
        useWebSocket: true,
      };

      expect(config.authToken).toBeUndefined();
      expect(config.machineName).toBeUndefined();
    });
  });
});
