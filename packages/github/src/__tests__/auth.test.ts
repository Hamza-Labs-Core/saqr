/**
 * Tests for GitHubAuth - JWT generation, token caching, OAuth flow.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as crypto from "node:crypto";
import {
  GitHubAuth,
  createAppJWT,
  requestInstallationToken,
  InMemoryTokenStorage,
} from "../auth.js";
import type { GitHubApiClient, GitHubAppConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a test RSA key pair */
function generateTestKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

/** Create a mock GitHub API client. */
function createMockApiClient(): GitHubApiClient & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAppJWT", () => {
  const keys = generateTestKeyPair();

  it("creates a valid JWT with three parts", () => {
    const jwt = createAppJWT("12345", keys.privateKey);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
  });

  it("has correct header with RS256 algorithm", () => {
    const jwt = createAppJWT("12345", keys.privateKey);
    const header = JSON.parse(
      Buffer.from(jwt.split(".")[0], "base64url").toString(),
    );
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
  });

  it("has correct payload with iss, iat, exp", () => {
    const jwt = createAppJWT("12345", keys.privateKey, 300);
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString(),
    );
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.exp).toBeTypeOf("number");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(360); // iat is backdated 60s
  });

  it("clamps TTL to maximum 600 seconds", () => {
    const jwt = createAppJWT("12345", keys.privateKey, 9999);
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString(),
    );
    // exp - (iat + 60) should be at most 600
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(660);
  });

  it("signature is verifiable with the public key", () => {
    const jwt = createAppJWT("12345", keys.privateKey);
    const [headerB64, payloadB64, signatureB64] = jwt.split(".");

    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();

    // Convert base64url to standard base64
    const sig = signatureB64.replace(/-/g, "+").replace(/_/g, "/");
    const isValid = verifier.verify(keys.publicKey, sig, "base64");
    expect(isValid).toBe(true);
  });

  it("backdates iat by 60 seconds for clock drift", () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = createAppJWT("12345", keys.privateKey);
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString(),
    );
    expect(payload.iat).toBeLessThanOrEqual(now - 59);
  });
});

describe("requestInstallationToken", () => {
  it("calls the correct API endpoint", async () => {
    const client = createMockApiClient();
    client.post.mockResolvedValue({
      token: "ghs_abc123",
      expires_at: "2025-01-01T00:00:00Z",
      permissions: { contents: "write" },
      repository_selection: "all",
    });

    const token = await requestInstallationToken("jwt-123", 42, client);

    expect(client.post).toHaveBeenCalledWith(
      "/app/installations/42/access_tokens",
      {},
    );
    expect(token.token).toBe("ghs_abc123");
    expect(token.expiresAt).toBeInstanceOf(Date);
    expect(token.permissions).toEqual({ contents: "write" });
    expect(token.repositorySelection).toBe("all");
  });
});

describe("InMemoryTokenStorage", () => {
  let storage: InMemoryTokenStorage;

  beforeEach(() => {
    storage = new InMemoryTokenStorage();
  });

  it("stores and retrieves a token", async () => {
    await storage.store("key1", "token123");
    expect(await storage.retrieve("key1")).toBe("token123");
  });

  it("returns null for missing key", async () => {
    expect(await storage.retrieve("missing")).toBeNull();
  });

  it("deletes a token", async () => {
    await storage.store("key1", "token123");
    await storage.delete("key1");
    expect(await storage.retrieve("key1")).toBeNull();
  });

  it("overwrites existing token", async () => {
    await storage.store("key1", "old");
    await storage.store("key1", "new");
    expect(await storage.retrieve("key1")).toBe("new");
  });
});

describe("GitHubAuth", () => {
  const keys = generateTestKeyPair();
  let client: ReturnType<typeof createMockApiClient>;
  let config: GitHubAppConfig;
  let auth: GitHubAuth;

  beforeEach(() => {
    client = createMockApiClient();
    config = {
      appId: "12345",
      privateKey: keys.privateKey,
      clientId: "Iv1.abc123",
      clientSecret: "secret",
      webhookSecret: "whsecret",
    };
    auth = new GitHubAuth(config, client);
  });

  describe("createJWT", () => {
    it("generates a valid JWT", () => {
      const jwt = auth.createJWT();
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("passes custom TTL", () => {
      const jwt = auth.createJWT(120);
      const payload = JSON.parse(
        Buffer.from(jwt.split(".")[1], "base64url").toString(),
      );
      // exp - iat should be about 180 (120 + 60 backdate)
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(180);
    });
  });

  describe("getInstallationToken", () => {
    it("fetches and returns a new token", async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000);
      client.post.mockResolvedValue({
        token: "ghs_fresh",
        expires_at: futureDate.toISOString(),
        permissions: { contents: "read" },
        repository_selection: "selected",
      });

      const token = await auth.getInstallationToken(99);
      expect(token.token).toBe("ghs_fresh");
      expect(client.post).toHaveBeenCalledOnce();
    });

    it("returns cached token on subsequent calls", async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000);
      client.post.mockResolvedValue({
        token: "ghs_cached",
        expires_at: futureDate.toISOString(),
        permissions: {},
        repository_selection: "all",
      });

      const first = await auth.getInstallationToken(99);
      const second = await auth.getInstallationToken(99);

      expect(first.token).toBe("ghs_cached");
      expect(second.token).toBe("ghs_cached");
      expect(client.post).toHaveBeenCalledOnce();
    });

    it("refreshes token when close to expiry", async () => {
      // First call: token expiring in 2 minutes (within 5-min margin)
      const nearExpiry = new Date(Date.now() + 2 * 60 * 1000);
      client.post.mockResolvedValueOnce({
        token: "ghs_expiring",
        expires_at: nearExpiry.toISOString(),
        permissions: {},
        repository_selection: "all",
      });

      await auth.getInstallationToken(99);

      // Second call should fetch a new token since the cached one expires soon
      const farFuture = new Date(Date.now() + 60 * 60 * 1000);
      client.post.mockResolvedValueOnce({
        token: "ghs_renewed",
        expires_at: farFuture.toISOString(),
        permissions: {},
        repository_selection: "all",
      });

      const renewed = await auth.getInstallationToken(99);
      expect(renewed.token).toBe("ghs_renewed");
      expect(client.post).toHaveBeenCalledTimes(2);
    });
  });

  describe("invalidateToken", () => {
    it("forces a fresh fetch after invalidation", async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000);
      client.post.mockResolvedValue({
        token: "ghs_any",
        expires_at: futureDate.toISOString(),
        permissions: {},
        repository_selection: "all",
      });

      await auth.getInstallationToken(99);
      await auth.invalidateToken(99);
      await auth.getInstallationToken(99);

      expect(client.post).toHaveBeenCalledTimes(2);
    });
  });

  describe("initiateDeviceFlow", () => {
    it("sends correct device code request", async () => {
      client.post.mockResolvedValue({
        device_code: "dc-123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });

      const result = await auth.initiateDeviceFlow();

      expect(client.post).toHaveBeenCalledWith("/login/device/code", {
        client_id: "Iv1.abc123",
        scope: "repo",
      });
      expect(result.deviceCode).toBe("dc-123");
      expect(result.userCode).toBe("ABCD-1234");
      expect(result.verificationUri).toBe("https://github.com/login/device");
      expect(result.expiresIn).toBe(900);
      expect(result.interval).toBe(5);
    });

    it("throws if clientId is not configured", async () => {
      const authNoClient = new GitHubAuth(
        { appId: "123", privateKey: keys.privateKey },
        client,
      );

      await expect(authNoClient.initiateDeviceFlow()).rejects.toThrow(
        "clientId is required",
      );
    });
  });

  describe("pollDeviceToken", () => {
    it("returns null when authorization is pending", async () => {
      client.post.mockResolvedValue({
        error: "authorization_pending",
      });

      const result = await auth.pollDeviceToken("dc-123");
      expect(result).toBeNull();
    });

    it("returns token when authorization is complete", async () => {
      client.post.mockResolvedValue({
        access_token: "gho_user_token",
        token_type: "bearer",
        scope: "repo",
      });

      const result = await auth.pollDeviceToken("dc-123");
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("gho_user_token");
      expect(result!.tokenType).toBe("bearer");
      expect(result!.scope).toBe("repo");
    });

    it("throws on non-pending errors", async () => {
      client.post.mockResolvedValue({
        error: "expired_token",
      });

      await expect(auth.pollDeviceToken("dc-123")).rejects.toThrow(
        "OAuth error: expired_token",
      );
    });

    it("throws if clientId is not configured", async () => {
      const authNoClient = new GitHubAuth(
        { appId: "123", privateKey: keys.privateKey },
        client,
      );

      await expect(authNoClient.pollDeviceToken("dc-123")).rejects.toThrow(
        "clientId is required",
      );
    });

    it("stores token in TokenStorage on success", async () => {
      const storage = new InMemoryTokenStorage();
      const authWithStorage = new GitHubAuth(config, client, storage);

      client.post.mockResolvedValue({
        access_token: "gho_stored",
        token_type: "bearer",
        scope: "repo",
      });

      await authWithStorage.pollDeviceToken("dc-123");

      expect(await storage.retrieve("oauth:user")).toBe("gho_stored");
    });
  });
});
