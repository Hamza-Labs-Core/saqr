/**
 * @saqr/daemon — AgentContext daemon package.
 *
 * The daemon is the core of the Saqr platform. It orchestrates multi-agent
 * hook capture, event storage, projections, agent process management,
 * and real-time streaming to clients (dashboard, mobile, CLI).
 *
 * @example
 * ```typescript
 * import { Daemon, loadConfig } from "@saqr/daemon";
 *
 * const config = loadConfig();
 * const daemon = new Daemon(config);
 * await daemon.start();
 * ```
 *
 * @packageDocumentation
 */

// Core
export { Daemon } from "./daemon.js";
export { type DaemonConfig, loadConfig, getDefaultConfig } from "./config.js";
export { Logger, initLogger, getLogger, type LogLevel, type LoggerOptions } from "./logger.js";

// Event Bus
export { EventBus } from "./event-bus/index.js";

// Hooks
export { HookManager } from "./hooks/index.js";

// Agents
export { AgentManager } from "./agents/index.js";

// Sessions
export { SessionManager } from "./sessions/index.js";
export { RingBuffer } from "./sessions/index.js";
export { ProcessCorrelator } from "./sessions/index.js";
export { SessionRegistry } from "./sessions/index.js";
export { SessionTakeover } from "./sessions/index.js";
export { TimelineStreamer } from "./sessions/index.js";

// Server
export { HttpServer } from "./server/index.js";

// Store
export { EventStore } from "./store/index.js";

// Security
export {
  FileKeychainStore,
  DesktopKeychainStore,
  createKeychainStore,
  PathSandbox,
  PathViolationError,
  HostAllowlist,
  validateHost,
  corsHeaders,
  DownloadTokenManager,
  createDownloadToken,
  verifyDownloadToken,
  QRKeyTransfer,
  DefaultCryptoProvider,
  generateQRPayload,
  completeKeyTransfer,
  E2EERelay,
  createRelaySession,
  SecurityMiddleware,
  securityMiddleware,
} from "./security/index.js";
