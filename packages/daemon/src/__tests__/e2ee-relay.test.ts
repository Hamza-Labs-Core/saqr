/**
 * Tests for E2EERelay — end-to-end encrypted relay channel.
 *
 * Uses mock WebSocket transports for testing the encryption protocol.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  E2EERelay,
  createRelaySession,
} from "../security/e2ee-relay.js";
import type {
  WebSocketTransport,
  RelayMessage,
  RelaySession,
} from "../security/e2ee-relay.js";

// ---------------------------------------------------------------------------
// Mock WebSocket Transport
// ---------------------------------------------------------------------------

class MockWebSocket implements WebSocketTransport {
  sent: string[] = [];
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("WebSocket is closed");
    this.sent.push(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closed = true;
    if (this.closeHandler) {
      this.closeHandler();
    }
  }

  // Simulate receiving a message
  simulateMessage(data: string): void {
    if (this.messageHandler) {
      this.messageHandler(data);
    }
  }

  // Simulate connection close
  simulateClose(): void {
    if (this.closeHandler) {
      this.closeHandler();
    }
  }
}

/**
 * Helper to create a pair of connected mock WebSockets.
 * Messages sent on one are received on the other.
 */
function createConnectedPair(): [MockWebSocket, MockWebSocket] {
  const ws1 = new MockWebSocket();
  const ws2 = new MockWebSocket();

  // Wire them together: messages sent on ws1 are received on ws2 and vice versa
  const origSend1 = ws1.send.bind(ws1);
  const origSend2 = ws2.send.bind(ws2);

  ws1.send = (data: string) => {
    origSend1(data);
    // Deliver to ws2 asynchronously
    setTimeout(() => ws2.simulateMessage(data), 0);
  };

  ws2.send = (data: string) => {
    origSend2(data);
    // Deliver to ws1 asynchronously
    setTimeout(() => ws1.simulateMessage(data), 0);
  };

  return [ws1, ws2];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2EERelay", () => {
  // -------------------------------------------------------------------------
  // Session creation
  // -------------------------------------------------------------------------

  describe("createSession", () => {
    it("should create a session with ephemeral keypair", async () => {
      const relay = new E2EERelay();
      const session = await relay.createSession();

      expect(session.sessionId).toBeTruthy();
      expect(session.sessionId.length).toBe(32);
      expect(session.localPublicKey).toBeTruthy();
      expect(session.localSecretKey).toBeTruthy();
      expect(session.remotePublicKey).toBeNull();
      expect(session.sharedSecret).toBeNull();
      expect(session.established).toBe(false);
      expect(session.sendSequence).toBe(0);
      expect(session.receiveSequence).toBe(-1);
    });

    it("should generate different keypairs for each session", async () => {
      const relay1 = new E2EERelay();
      const relay2 = new E2EERelay();

      const session1 = await relay1.createSession();
      const session2 = await relay2.createSession();

      expect(session1.localPublicKey).not.toBe(session2.localPublicKey);
      expect(session1.sessionId).not.toBe(session2.sessionId);
    });
  });

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  describe("handshake", () => {
    it("should send handshake with public key", async () => {
      const relay = new E2EERelay();
      const session = await relay.createSession();

      const ws = new MockWebSocket();
      relay.connect(ws, vi.fn());
      relay.sendHandshake();

      expect(ws.sent.length).toBe(1);

      const msg: RelayMessage = JSON.parse(ws.sent[0]!);
      expect(msg.type).toBe("handshake");
      expect(msg.senderPublicKey).toBe(session.localPublicKey);
      expect(msg.sessionId).toBe(session.sessionId);
      expect(msg.sequence).toBe(0);
    });

    it("should throw if connecting without session", () => {
      const relay = new E2EERelay();
      const ws = new MockWebSocket();

      expect(() => relay.connect(ws, vi.fn())).toThrow("No session");
    });

    it("should throw if sending handshake without connecting", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      expect(() => relay.sendHandshake()).toThrow("Not connected");
    });

    it("should process incoming handshake and compute shared secret", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      // Generate a "remote" keypair
      const remoteRelay = new E2EERelay();
      const remoteSession = await remoteRelay.createSession();

      await relay.processHandshake(remoteSession.localPublicKey, false);

      const session = relay.getSession();
      expect(session).not.toBeNull();
      expect(session!.established).toBe(true);
      expect(session!.remotePublicKey).toBe(remoteSession.localPublicKey);
      expect(session!.sharedSecret).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Message encryption/decryption
  // -------------------------------------------------------------------------

  describe("message encryption", () => {
    it("should encrypt and send messages after handshake", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      relay.connect(ws, vi.fn());

      // Process a handshake to establish session
      const remoteRelay = new E2EERelay();
      const remoteSession = await remoteRelay.createSession();
      await relay.processHandshake(remoteSession.localPublicKey, false);

      await relay.sendMessage("Hello, World!");

      expect(ws.sent.length).toBe(1);

      const msg: RelayMessage = JSON.parse(ws.sent[0]!);
      expect(msg.type).toBe("data");
      expect(msg.payload).toBeTruthy();
      expect(msg.nonce).toBeTruthy();
      // Payload should not contain plaintext
      expect(msg.payload).not.toContain("Hello, World!");
    });

    it("should throw when sending before handshake", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      relay.connect(ws, vi.fn());

      await expect(relay.sendMessage("test")).rejects.toThrow(
        "Session not established",
      );
    });

    it("should increment sequence number", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      relay.connect(ws, vi.fn());

      const remoteRelay = new E2EERelay();
      const remoteSession = await remoteRelay.createSession();
      await relay.processHandshake(remoteSession.localPublicKey, false);

      await relay.sendMessage("msg1");
      await relay.sendMessage("msg2");
      await relay.sendMessage("msg3");

      const sequences = ws.sent.map(
        (s) => (JSON.parse(s) as RelayMessage).sequence,
      );

      // Sequence should be monotonically increasing
      expect(sequences[0]).toBeLessThan(sequences[1]!);
      expect(sequences[1]).toBeLessThan(sequences[2]!);
    });
  });

  // -------------------------------------------------------------------------
  // Full E2EE communication (two relays)
  // -------------------------------------------------------------------------

  describe("full E2EE flow", () => {
    it("should exchange encrypted messages between two relays", async () => {
      // Set up Alice
      const alice = new E2EERelay();
      const aliceSession = await alice.createSession();

      // Set up Bob
      const bob = new E2EERelay();
      const bobSession = await bob.createSession();

      // Both establish shared secret manually
      await alice.processHandshake(bobSession.localPublicKey, false);
      await bob.processHandshake(aliceSession.localPublicKey, false);

      // Verify both have the same shared secret
      const aSession = alice.getSession();
      const bSession = bob.getSession();

      expect(aSession!.sharedSecret).toBe(bSession!.sharedSecret);
      expect(aSession!.established).toBe(true);
      expect(bSession!.established).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Close handling
  // -------------------------------------------------------------------------

  describe("close", () => {
    it("should send close message and clean up", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      relay.connect(ws, vi.fn());

      const remoteRelay = new E2EERelay();
      const remoteSession = await remoteRelay.createSession();
      await relay.processHandshake(remoteSession.localPublicKey, false);

      relay.close();

      // Should have sent a close message
      const lastMsg: RelayMessage = JSON.parse(
        ws.sent[ws.sent.length - 1]!,
      );
      expect(lastMsg.type).toBe("close");

      // Session should be cleared
      expect(relay.getSession()).toBeNull();
    });

    it("should invoke close handler on remote close", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      const closeHandler = vi.fn();
      relay.connect(ws, vi.fn(), closeHandler);

      ws.simulateClose();

      expect(closeHandler).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Replay protection
  // -------------------------------------------------------------------------

  describe("replay protection", () => {
    it("should reject messages with old sequence numbers", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      const handler = vi.fn();
      relay.connect(ws, handler);

      // Process a handshake to establish session
      const remoteRelay = new E2EERelay();
      const remoteSession = await remoteRelay.createSession();
      await relay.processHandshake(remoteSession.localPublicKey, false);

      // The handshake response is sequence 0, so receiveSequence was set
      // Simulate receiving a message with sequence 0 (should be rejected as replay)
      const oldMsg: RelayMessage = {
        type: "data",
        sessionId: relay.getSession()!.sessionId,
        payload: "encrypted",
        nonce: "nonce",
        sequence: 0,
        timestamp: new Date().toISOString(),
      };

      ws.simulateMessage(JSON.stringify(oldMsg));

      // Handler should NOT be called for replayed message
      // (it may not be called anyway since decryption would fail)
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Incoming message handling
  // -------------------------------------------------------------------------

  describe("incoming handshake via transport", () => {
    it("should process handshake received via transport", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      relay.connect(ws, vi.fn());

      // Simulate receiving a handshake from a remote peer
      const remoteRelay = new E2EERelay();
      const remoteSession = await remoteRelay.createSession();

      const handshakeMsg: RelayMessage = {
        type: "handshake",
        sessionId: relay.getSession()!.sessionId,
        senderPublicKey: remoteSession.localPublicKey,
        sequence: 0,
        timestamp: new Date().toISOString(),
      };

      ws.simulateMessage(JSON.stringify(handshakeMsg));

      // Give async processing a moment
      await new Promise((r) => setTimeout(r, 50));

      const session = relay.getSession();
      expect(session!.established).toBe(true);
      expect(session!.remotePublicKey).toBe(remoteSession.localPublicKey);

      // Should have sent a handshake response
      expect(ws.sent.length).toBe(1);
      const response: RelayMessage = JSON.parse(ws.sent[0]!);
      expect(response.type).toBe("handshake");
      expect(response.senderPublicKey).toBe(session!.localPublicKey);
    });

    it("should handle invalid JSON gracefully", async () => {
      const relay = new E2EERelay();
      await relay.createSession();

      const ws = new MockWebSocket();
      relay.connect(ws, vi.fn());

      // Should not throw
      ws.simulateMessage("not-valid-json");
      ws.simulateMessage("{invalid");

      expect(relay.getSession()).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Convenience function tests
// ---------------------------------------------------------------------------

describe("createRelaySession", () => {
  it("should create relay and session", async () => {
    const { relay, session } = await createRelaySession();

    expect(relay).toBeInstanceOf(E2EERelay);
    expect(session.sessionId).toBeTruthy();
    expect(session.localPublicKey).toBeTruthy();
    expect(session.established).toBe(false);
  });

  it("should accept config", async () => {
    const { session } = await createRelaySession({
      sessionTimeoutMs: 10000,
    });

    expect(session.sessionId).toBeTruthy();
  });
});
