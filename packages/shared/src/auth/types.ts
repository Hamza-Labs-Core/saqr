/**
 * Shared auth types for the device-code OAuth flow.
 *
 * Used by sync-server (issuer), CLI, Desktop, Mobile, and Website (consumers).
 * Follows RFC 8628 — OAuth 2.0 Device Authorization Grant.
 *
 * @module auth/types
 */

// ---------------------------------------------------------------------------
// Device Code Flow
// ---------------------------------------------------------------------------

/**
 * Request to initiate a device-code flow.
 * Client sends this to `POST /auth/device-code`.
 */
export interface DeviceCodeRequest {
  /** Identifies the client type (e.g., "cli", "desktop", "mobile"). */
  client_id: string;

  /** Requested auth scopes (default: ["sync"]). */
  scope?: string[];
}

/**
 * Response from `POST /auth/device-code`.
 * Contains the code the user must enter in their browser.
 */
export interface DeviceCodeResponse {
  /** Short code shown to user (e.g., "ABCD-1234"). */
  user_code: string;

  /** Internal device code used for polling (opaque to user). */
  device_code: string;

  /** URL the user should visit to enter the code. */
  verification_uri: string;

  /** Full URL with the code pre-filled (convenience). */
  verification_uri_complete: string;

  /** Seconds until this code expires. */
  expires_in: number;

  /** Minimum seconds between poll requests. */
  interval: number;
}

/**
 * Polling request from client to check if the user approved the device.
 * Client sends this to `POST /auth/device-poll`.
 */
export interface DevicePollRequest {
  /** The device_code from DeviceCodeResponse. */
  device_code: string;

  /** Client identifier (must match the original request). */
  client_id: string;
}

/**
 * Successful poll response — user approved the device.
 */
export interface DevicePollTokenResponse {
  /** JWT access token. */
  access_token: string;

  /** Refresh token for long-lived sessions. */
  refresh_token: string;

  /** Token type (always "Bearer"). */
  token_type: "Bearer";

  /** Seconds until the access token expires. */
  expires_in: number;
}

/**
 * Poll response status when the flow is not yet complete.
 */
export type DevicePollPendingError =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied";

/**
 * Error response during polling.
 */
export interface DevicePollErrorResponse {
  error: DevicePollPendingError;
  error_description: string;
}

// ---------------------------------------------------------------------------
// Device Code KV Record (server-side)
// ---------------------------------------------------------------------------

/** Status of a device code in KV. */
export type DeviceCodeStatus = "pending" | "approved" | "denied" | "expired";

/**
 * Stored in KV under `device:<device_code>`.
 */
export interface DeviceCodeRecord {
  /** Short user-facing code. */
  userCode: string;

  /** Opaque device code (key). */
  deviceCode: string;

  /** Client identifier. */
  clientId: string;

  /** Requested scopes. */
  scope: string[];

  /** Current approval status. */
  status: DeviceCodeStatus;

  /** ISO 8601 timestamp of creation. */
  createdAt: string;

  /** Seconds until expiration (from creation). */
  expiresIn: number;

  /** User ID that approved (set after approval). */
  approvedBy?: string;

  /** Access token (set after approval). */
  accessToken?: string;

  /** Refresh token (set after approval). */
  refreshToken?: string;
}

// ---------------------------------------------------------------------------
// Auth Callback (deep link for Desktop/Mobile fast path)
// ---------------------------------------------------------------------------

/**
 * Parameters sent via deep link callback (saqr://auth/callback).
 */
export interface AuthCallback {
  /** JWT access token. */
  token: string;

  /** Refresh token. */
  refresh_token: string;

  /** Seconds until the access token expires. */
  expires_in: number;
}

// ---------------------------------------------------------------------------
// Token Refresh
// ---------------------------------------------------------------------------

/**
 * Request to refresh an access token.
 * Client sends this to `POST /auth/refresh`.
 */
export interface RefreshTokenRequest {
  /** The refresh token from a previous auth response. */
  refresh_token: string;
}

/**
 * Response from `POST /auth/refresh`.
 */
export interface RefreshTokenResponse {
  /** New JWT access token. */
  access_token: string;

  /** Token type (always "Bearer"). */
  token_type: "Bearer";

  /** Seconds until the new access token expires. */
  expires_in: number;
}
