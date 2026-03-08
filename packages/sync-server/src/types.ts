/**
 * Type definitions for the Saqr sync server.
 *
 * Defines all interfaces for the Worker API gateway, Durable Object,
 * middleware chain, and request/response formats.
 */

// ---------------------------------------------------------------------------
// Environment Bindings
// ---------------------------------------------------------------------------

export interface Env {
  USER_SYNC: DurableObjectNamespace;
  SYNC_BUCKET: R2Bucket;
  AUTH_KV: KVNamespace;
  REGISTRY_KV: KVNamespace;
  JWT_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  // CORS: comma-separated list of allowed origins (e.g. "https://app.saqr.dev,https://admin.saqr.dev")
  ALLOWED_ORIGINS: string;
  // Website base URL for device-code verification links (e.g. "https://saqr.dev")
  WEBSITE_URL?: string;
  // Tier limits (string values from wrangler.toml [vars])
  FREE_TIER_STORAGE_BYTES: string;
  PRO_TIER_STORAGE_BYTES: string;
  TEAM_TIER_STORAGE_BYTES: string;
  FREE_TIER_MACHINES: string;
  PRO_TIER_MACHINES: string;
  TEAM_TIER_MACHINES: string;
  FREE_TIER_RATE_PER_MIN: string;
  PRO_TIER_RATE_PER_MIN: string;
  TEAM_TIER_RATE_PER_MIN: string;
  FREE_TIER_RETENTION_DAYS: string;
  PRO_TIER_RETENTION_DAYS: string;
  TEAM_TIER_RETENTION_DAYS: string;
}

// ---------------------------------------------------------------------------
// Auth Context
// ---------------------------------------------------------------------------

export type Tier = 'free' | 'pro' | 'team';

export interface AuthContext {
  userId: string;
  email: string;
  tier: Tier;
  machineId?: string;
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

export interface JWTPayload {
  sub: string;
  email: string;
  tier: Tier;
  role?: 'user' | 'admin';
  iat: number;
  exp: number;
  nbf?: number;
  iss: string;
  aud: string;
}

// ---------------------------------------------------------------------------
// Auth Request/Response
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: {
    user_id: string;
    email: string;
    tier: Tier;
  };
}

// ---------------------------------------------------------------------------
// Sync Request/Response
// ---------------------------------------------------------------------------

export interface PushEvent {
  project_id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  event_type: string;
  encrypted_blob_sha256: string;
  encrypted_size_bytes: number;
  metadata?: {
    token_count_input?: number;
    token_count_output?: number;
    model?: string;
    tool_name?: string;
  };
}

export interface PushRequest {
  machine_id: string;
  events: PushEvent[];
  blobs: Record<string, string>; // sha256 -> base64 encoded encrypted blob
}

export interface PushResponse {
  accepted: number;
  rejected: number;
  cursor: string | null;
  storage_used_bytes: number;
  storage_quota_bytes: number;
}

export interface PullRequest {
  machine_id: string;
  cursor: string | null;
  limit?: number;
  project_id?: string;
}

export interface PullEventResponse {
  project_id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  event_type: string;
  source_machine_id: string;
  encrypted_blob_key: string;
  encrypted_size_bytes: number;
  metadata: {
    token_count_input: number;
    token_count_output: number;
    model: string | null;
    tool_name: string | null;
  };
}

export interface PullResponse {
  events: PullEventResponse[];
  cursor: string | null;
  has_more: boolean;
  total_pending: number;
}

// ---------------------------------------------------------------------------
// Machine Registration
// ---------------------------------------------------------------------------

export interface RegisterMachineRequest {
  machine_id: string;
  name: string;
  os: string;
  arch: string;
  hostname: string;
  agent_version?: string;
}

export interface MachineInfo {
  machine_id: string;
  name: string;
  os: string;
  arch: string;
  hostname: string;
  registered_at: string;
  last_sync_at: string | null;
  last_seen_at: string | null;
  agent_version: string | null;
  is_active: number;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface AccountRow {
  user_id: string;
  email: string;
  password_hash: string;
  tier: Tier;
  email_verified: number;
  storage_used_bytes: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AccountInfo {
  user_id: string;
  email: string;
  tier: Tier;
  email_verified: boolean;
  storage_used_bytes: number;
  created_at: string;
}

export interface DeleteAccountRequest {
  confirmation: string;
}

// ---------------------------------------------------------------------------
// Event Metadata Row (SQLite)
// ---------------------------------------------------------------------------

export interface EventMetaRow {
  id: number;
  machine_id: string;
  project_id: string;
  session_id: string;
  sequence: number;
  event_type: string;
  timestamp: string;
  encrypted_blob_key: string;
  encrypted_blob_sha256: string;
  encrypted_size_bytes: number;
  token_count_input: number;
  token_count_output: number;
  model: string | null;
  tool_name: string | null;
  synced_at: string;
}

// ---------------------------------------------------------------------------
// Tier Limits
// ---------------------------------------------------------------------------

export interface TierLimits {
  machineLimit: number; // 0 = unlimited
  storageBytes: number;
  retentionDays: number; // 0 = unlimited
  ratePerMin: number;
}

// ---------------------------------------------------------------------------
// KV Stored Types
// ---------------------------------------------------------------------------

export interface KVUserRecord {
  userId: string;
  passwordHash: string;
  email: string;
  tier: Tier;
  createdAt: string;
  role?: 'user' | 'admin';
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type Middleware = (
  request: Request,
  env: Env,
  authCtx: AuthContext | null,
) => Promise<{ response?: Response; authCtx?: AuthContext }>;
