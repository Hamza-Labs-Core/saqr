/**
 * Sessions module — session tracking, filesystem watching, and attach mode.
 *
 * @module sessions
 */

export { SessionManager } from "./session-manager.js";
export type { SessionInfo, SessionFilter } from "./session-manager.js";

export { SessionWatcher } from "./session-watcher.js";
export type {
  SessionWatcherEvents,
  SessionWatcherConfig,
} from "./session-watcher.js";

export { RingBuffer } from "./ring-buffer.js";

export { ProcessCorrelator } from "./process-correlator.js";
export type {
  ProcessInfo,
  ProcessDiscovery,
} from "./process-correlator.js";

export { SessionRegistry } from "./session-registry.js";
export type {
  AttachSessionInfo,
  SessionAttachState,
} from "./session-registry.js";

export { SessionTakeover } from "./session-takeover.js";
export type {
  PtyProcess,
  PtyFactory,
  TakeoverOptions,
  TakeoverResult,
  IDisposable,
} from "./session-takeover.js";

export { TimelineStreamer } from "./timeline-streamer.js";
export type { TimelineItem, TimelineClient } from "./timeline-streamer.js";
