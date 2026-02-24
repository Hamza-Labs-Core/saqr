/**
 * @saqr/sync-client -- Encrypted push/pull sync client for AgentContext
 *
 * Handles client-side encryption (XChaCha20-Poly1305), metadata/payload separation,
 * push sync to Cloudflare, pull sync from other machines, offline queue management.
 */

export { SyncClient } from './sync-client.js';
export type { SyncState, SyncStatus, HttpSender } from './sync-client.js';

export { EncryptionManager } from './encryption.js';

export { SyncQueue, calculateRetryDelay } from './queue.js';
export type { QueueItem, SenderFn } from './queue.js';

export { splitEvent, reassembleEvent } from './metadata-splitter.js';
export type { SplitResult } from './metadata-splitter.js';

export { loadConfig, saveConfig, generateMachineId, getDefaultConfig, getDefaultConfigDir } from './config.js';
export type { SyncLocalConfig } from './config.js';

export { KeyManager } from './key-manager.js';
export type { RecoveryBlob, KeyMetadata } from './key-manager.js';
