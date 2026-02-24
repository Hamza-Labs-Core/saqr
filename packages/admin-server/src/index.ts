/**
 * @saqr/admin-server — Cloudflare Workers admin server for Saqr platform
 *
 * Manages codeguard curated rules, popular list moderation, and user roles.
 * Shares AUTH_KV and REGISTRY_KV with sync-server.
 */

export { default } from './worker.js';
