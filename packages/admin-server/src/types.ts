/**
 * Type definitions for the Saqr admin server.
 *
 * The admin server is a separate Cloudflare Worker that manages
 * codeguard curated rules, popular list moderation, and user roles.
 * It shares AUTH_KV and REGISTRY_KV with sync-server.
 */

// ---------------------------------------------------------------------------
// Environment Bindings
// ---------------------------------------------------------------------------

export interface AdminEnv {
  /** Shared with sync-server — user records, login verification */
  AUTH_KV: KVNamespace;
  /** Shared with sync-server — codeguard curated/popular data */
  REGISTRY_KV: KVNamespace;
  /** Same secret as sync-server for JWT verification */
  JWT_SECRET: string;
  /** JWT issuer (e.g., "saqr") */
  JWT_ISSUER: string;
  /** JWT audience for admin server (e.g., "saqr-admin") */
  JWT_AUDIENCE: string;
  /** Admin-specific CORS origins */
  ALLOWED_ORIGINS: string;
}

// ---------------------------------------------------------------------------
// Auth Context
// ---------------------------------------------------------------------------

export type UserRole = 'user' | 'admin';

export interface AdminAuthContext {
  userId: string;
  email: string;
  role: UserRole;
}

// ---------------------------------------------------------------------------
// KV Records (must match sync-server's KVUserRecord + role)
// ---------------------------------------------------------------------------

export interface KVUserRecord {
  userId: string;
  passwordHash: string;
  email: string;
  tier: 'free' | 'pro' | 'team';
  createdAt: string;
  role?: UserRole;
}

// ---------------------------------------------------------------------------
// JWT Payload (extended with role)
// ---------------------------------------------------------------------------

export interface JWTPayload {
  sub: string;
  email: string;
  tier: string;
  role?: UserRole;
  iat: number;
  exp: number;
  nbf?: number;
  iss: string;
  aud: string;
}

// ---------------------------------------------------------------------------
// Curated Rules
// ---------------------------------------------------------------------------

export interface CuratedRule {
  id: string;
  description: string;
  severity: 'block' | 'warn';
  enabled: boolean;
  file_patterns: string[];
  patterns: string[];
  exclude_patterns: string[];
  suggestion: string;
  order: number;
  added_at: string;
  added_by: string;
}

export interface CuratedRulesData {
  version: number;
  updated: string;
  updated_by: string;
  rules: CuratedRule[];
}

// ---------------------------------------------------------------------------
// Popular Rules
// ---------------------------------------------------------------------------

export interface PopularRuleEntry {
  rule: {
    id: string;
    description: string;
    severity: 'block' | 'warn';
    enabled: boolean;
    file_patterns: string[];
    patterns: string[];
    exclude_patterns: string[];
    suggestion: string;
  };
  total_installs: number;
  total_blocks: number;
  hidden: boolean;
  first_seen: string;
  last_updated: string;
}

export interface PopularRulesData {
  updated: string;
  rules: PopularRuleEntry[];
}
