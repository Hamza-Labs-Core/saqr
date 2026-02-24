/**
 * @saqr/mobile - Mobile app data layer for the Saqr Agent Management Platform.
 *
 * This package provides the pure TypeScript data layer and business logic
 * for the mobile app. It includes:
 *
 * - **Types**: Navigation, daemon, agent, session, usage, file, notification, crypto, error types
 * - **Connection Manager**: WebSocket connection lifecycle and reconnection
 * - **Daemon Registry**: CRUD for registered daemons with QR pairing
 * - **Agent Data Aggregator**: Unified agent view across daemons
 * - **Session History Manager**: Cross-machine session browsing
 * - **Usage Data Aggregator**: Token usage aggregation and formatting
 * - **Notification Manager**: Event-to-notification mapping and queue
 * - **Offline Cache Manager**: Cache invalidation and sync queue
 * - **Encryption Key Manager**: Key metadata and QR transfer protocol
 * - **Voice Input Manager**: Audio state machine for speech-to-text
 *
 * @packageDocumentation
 */

// Types
export * from "./types/index.js";

// Services
export * from "./services/index.js";
