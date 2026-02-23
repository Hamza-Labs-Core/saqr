/**
 * GitHubAuth - GitHub App authentication module.
 *
 * Provides JWT generation from GitHub App private keys,
 * installation token management with caching, and OAuth device flow
 * for user authentication.
 *
 * @module auth
 */

import * as crypto from "node:crypto";
import type {
  GitHubAppConfig,
  InstallationToken,
  DeviceCodeResponse,
  OAuthTokenResponse,
  TokenStorage,
  GitHubApiClient,
} from "./types.js";

// ---------------------------------------------------------------------------
// JWT Generation
// ---------------------------------------------------------------------------

/**
 * Create a base64url-encoded string from a buffer.
 */
function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Create a JSON Web Token (JWT) for GitHub App authentication.
 *
 * @param appId - The GitHub App ID.
 * @param privateKey - The PEM-encoded private key for the GitHub App.
 * @param ttlSeconds - Token TTL in seconds (max 600, default 600).
 * @returns The signed JWT string.
 */
export function createAppJWT(
  appId: string,
  privateKey: string,
  ttlSeconds: number = 600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const clampedTtl = Math.min(ttlSeconds, 600);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: now - 60, // issued 60s in the past to allow for clock drift
    exp: now + clampedTtl,
    iss: appId,
  };

  const headerEncoded = base64url(Buffer.from(JSON.stringify(header)));
  const payloadEncoded = base64url(Buffer.from(JSON.stringify(payload)));

  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();

  const signature = base64url(sign.sign(privateKey));

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// Installation Token Management
// ---------------------------------------------------------------------------

/**
 * Request an installation access token from GitHub.
 *
 * @param jwt - A valid GitHub App JWT.
 * @param installationId - The installation ID to get a token for.
 * @param apiClient - The GitHub API client to use.
 * @returns The installation token with expiration.
 */
export async function requestInstallationToken(
  jwt: string,
  installationId: number,
  apiClient: GitHubApiClient,
): Promise<InstallationToken> {
  // The apiClient needs to use the JWT for this request.
  // We pass the JWT and let the caller configure the client appropriately.
  const response = await apiClient.post<{
    token: string;
    expires_at: string;
    permissions: Record<string, string>;
    repository_selection: "all" | "selected";
  }>(`/app/installations/${installationId}/access_tokens`, {});

  return {
    token: response.token,
    expiresAt: new Date(response.expires_at),
    permissions: response.permissions,
    repositorySelection: response.repository_selection,
  };
}

// ---------------------------------------------------------------------------
// In-Memory Token Storage
// ---------------------------------------------------------------------------

/**
 * Simple in-memory token storage implementation.
 * For production use, implement the TokenStorage interface with
 * keychain integration.
 */
export class InMemoryTokenStorage implements TokenStorage {
  private readonly tokens = new Map<string, string>();

  async store(key: string, token: string): Promise<void> {
    this.tokens.set(key, token);
  }

  async retrieve(key: string): Promise<string | null> {
    return this.tokens.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.tokens.delete(key);
  }
}

// ---------------------------------------------------------------------------
// GitHubAuth Class
// ---------------------------------------------------------------------------

/**
 * Main authentication class for GitHub App integration.
 *
 * Handles JWT generation, installation token caching/refresh,
 * and OAuth device flow for user authentication.
 */
export class GitHubAuth {
  private readonly config: GitHubAppConfig;
  private readonly apiClient: GitHubApiClient;
  private readonly tokenStorage: TokenStorage;
  private readonly tokenCache = new Map<
    number,
    { token: InstallationToken; fetchedAt: number }
  >();

  /** Token refresh margin in milliseconds (5 minutes before expiry). */
  private static readonly REFRESH_MARGIN_MS = 5 * 60 * 1000;

  constructor(
    config: GitHubAppConfig,
    apiClient: GitHubApiClient,
    tokenStorage?: TokenStorage,
  ) {
    this.config = config;
    this.apiClient = apiClient;
    this.tokenStorage = tokenStorage ?? new InMemoryTokenStorage();
  }

  /**
   * Generate a JWT for this GitHub App.
   *
   * @param ttlSeconds - Token TTL in seconds (max 600).
   * @returns The signed JWT string.
   */
  createJWT(ttlSeconds?: number): string {
    return createAppJWT(this.config.appId, this.config.privateKey, ttlSeconds);
  }

  /**
   * Get an installation token, using cache if still valid.
   *
   * @param installationId - The installation ID.
   * @returns A valid installation token.
   */
  async getInstallationToken(
    installationId: number,
  ): Promise<InstallationToken> {
    const cached = this.tokenCache.get(installationId);

    if (cached && !this.isTokenExpiringSoon(cached.token)) {
      return cached.token;
    }

    // Token is expired or missing - fetch a new one
    const jwt = this.createJWT();
    const token = await requestInstallationToken(
      jwt,
      installationId,
      this.apiClient,
    );

    this.tokenCache.set(installationId, {
      token,
      fetchedAt: Date.now(),
    });

    // Also store in persistent storage
    await this.tokenStorage.store(
      `installation:${installationId}`,
      token.token,
    );

    return token;
  }

  /**
   * Invalidate a cached installation token.
   *
   * @param installationId - The installation ID to invalidate.
   */
  async invalidateToken(installationId: number): Promise<void> {
    this.tokenCache.delete(installationId);
    await this.tokenStorage.delete(`installation:${installationId}`);
  }

  /**
   * Initiate OAuth device flow for user authentication.
   *
   * @returns Device code response with user code and verification URI.
   */
  async initiateDeviceFlow(): Promise<DeviceCodeResponse> {
    if (!this.config.clientId) {
      throw new Error("clientId is required for OAuth device flow");
    }

    const response = await this.apiClient.post<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>("/login/device/code", {
      client_id: this.config.clientId,
      scope: "repo",
    });

    return {
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri: response.verification_uri,
      expiresIn: response.expires_in,
      interval: response.interval,
    };
  }

  /**
   * Poll for OAuth token after user has entered the device code.
   *
   * @param deviceCode - The device code from initiateDeviceFlow.
   * @returns The OAuth access token response, or null if still pending.
   */
  async pollDeviceToken(
    deviceCode: string,
  ): Promise<OAuthTokenResponse | null> {
    if (!this.config.clientId) {
      throw new Error("clientId is required for OAuth device flow");
    }

    try {
      const response = await this.apiClient.post<{
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
      }>("/login/oauth/access_token", {
        client_id: this.config.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });

      if (response.error === "authorization_pending") {
        return null;
      }

      if (response.error) {
        throw new Error(`OAuth error: ${response.error}`);
      }

      if (!response.access_token) {
        return null;
      }

      const tokenResponse: OAuthTokenResponse = {
        accessToken: response.access_token,
        tokenType: response.token_type ?? "bearer",
        scope: response.scope ?? "",
      };

      // Store the token
      await this.tokenStorage.store("oauth:user", tokenResponse.accessToken);

      return tokenResponse;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("authorization_pending")
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Check whether a token is expiring soon (within refresh margin).
   */
  private isTokenExpiringSoon(token: InstallationToken): boolean {
    const now = Date.now();
    const expiresAt = token.expiresAt.getTime();
    return expiresAt - now < GitHubAuth.REFRESH_MARGIN_MS;
  }
}
