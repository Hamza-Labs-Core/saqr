/**
 * ConnectionManager - Manages WebSocket connections to registered daemons.
 *
 * Handles connection lifecycle, exponential backoff reconnection,
 * heartbeat management, and app state transitions.
 *
 * @module services/connection-manager
 */

import type { HostProfile, ConnectionState } from "../types/daemon.js";

/** Maximum backoff delay in milliseconds (60 seconds). */
const MAX_BACKOFF_MS = 60000;

/** Heartbeat interval in foreground (10 seconds). */
const FOREGROUND_HEARTBEAT_MS = 10000;

/** Heartbeat interval in background (30 seconds). */
const BACKGROUND_HEARTBEAT_MS = 30000;

/** App state type. */
type AppState = "foreground" | "background";

/** Listener callback type. */
type ConnectionStateListener = (
  hostId: string,
  state: ConnectionState
) => void;

/**
 * Manages persistent WebSocket connections to all registered daemons.
 */
export class ConnectionManager {
  private hosts: Map<string, HostProfile> = new Map();
  private connectionStates: Map<string, ConnectionState> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private heartbeatIntervals: Map<string, number> = new Map();
  private listeners: Set<ConnectionStateListener> = new Set();
  private appState: AppState = "foreground";
  private destroyed = false;

  /**
   * Create a new ConnectionManager instance.
   */
  static create(): ConnectionManager {
    return new ConnectionManager();
  }

  /**
   * Calculate exponential backoff delay for reconnection.
   * @param attempt - The reconnection attempt number (0-based).
   * @returns Delay in milliseconds.
   */
  static calculateBackoff(attempt: number): number {
    const delay = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
    return delay;
  }

  /**
   * Register a host profile. If a host with the same ID exists, update it.
   */
  registerHost(host: HostProfile): void {
    this.hosts.set(host.id, { ...host });
    if (!this.connectionStates.has(host.id)) {
      this.connectionStates.set(host.id, "disconnected");
    }
  }

  /**
   * Remove a host and its connection.
   */
  removeHost(hostId: string): void {
    this.clearReconnect(hostId);
    this.connectionStates.set(hostId, "disconnected");
    this.heartbeatIntervals.delete(hostId);
    this.hosts.delete(hostId);
    this.connectionStates.delete(hostId);
  }

  /**
   * Get the host profile for a given ID.
   */
  getHostProfile(hostId: string): HostProfile | undefined {
    const host = this.hosts.get(hostId);
    return host ? { ...host } : undefined;
  }

  /**
   * Connect to a specific host.
   */
  async connect(hostId: string): Promise<void> {
    if (this.destroyed) return;

    const host = this.hosts.get(hostId);
    if (!host) return;

    // If already connected, no-op
    if (this.connectionStates.get(hostId) === "connected") return;

    this.setConnectionState(hostId, "connecting");

    // In a real implementation, this would create a WebSocket.
    // For the pure data layer, we simulate a successful connection.
    this.setConnectionState(hostId, "connected");
    this.heartbeatIntervals.set(
      hostId,
      this.appState === "foreground"
        ? FOREGROUND_HEARTBEAT_MS
        : BACKGROUND_HEARTBEAT_MS
    );
  }

  /**
   * Disconnect from a specific host.
   */
  async disconnect(hostId: string): Promise<void> {
    this.clearReconnect(hostId);
    if (this.connectionStates.has(hostId)) {
      this.setConnectionState(hostId, "disconnected");
    }
    this.heartbeatIntervals.delete(hostId);
  }

  /**
   * Connect to all registered hosts.
   */
  async connectAll(): Promise<void> {
    const connectPromises: Promise<void>[] = [];
    for (const hostId of this.hosts.keys()) {
      connectPromises.push(this.connect(hostId));
    }
    await Promise.all(connectPromises);
  }

  /**
   * Disconnect from all hosts.
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];
    for (const hostId of this.hosts.keys()) {
      disconnectPromises.push(this.disconnect(hostId));
    }
    await Promise.all(disconnectPromises);
  }

  /**
   * Get the connection state for a host.
   */
  getConnectionState(hostId: string): ConnectionState {
    return this.connectionStates.get(hostId) ?? "disconnected";
  }

  /**
   * Get all host IDs that are currently connected.
   */
  getConnectedHostIds(): string[] {
    const connected: string[] = [];
    for (const [hostId, state] of this.connectionStates) {
      if (state === "connected") connected.push(hostId);
    }
    return connected;
  }

  /**
   * Get all registered host IDs.
   */
  getAllHostIds(): string[] {
    return Array.from(this.hosts.keys());
  }

  /**
   * Register a listener for connection state changes.
   * @returns An unsubscribe function.
   */
  onConnectionStateChange(callback: ConnectionStateListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  scheduleReconnect(hostId: string, attempt: number): void {
    this.clearReconnect(hostId);
    const delay = ConnectionManager.calculateBackoff(attempt);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(hostId);
      void this.connect(hostId);
    }, delay);
    this.reconnectTimers.set(hostId, timer);
  }

  /**
   * Cancel a pending reconnection.
   */
  clearReconnect(hostId: string): void {
    const timer = this.reconnectTimers.get(hostId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(hostId);
    }
  }

  /**
   * Check if a reconnection is scheduled for a host.
   */
  hasReconnectScheduled(hostId: string): boolean {
    return this.reconnectTimers.has(hostId);
  }

  /**
   * Set the app state (foreground/background) to adjust heartbeat intervals.
   */
  setAppState(state: AppState): void {
    this.appState = state;
    const interval =
      state === "foreground"
        ? FOREGROUND_HEARTBEAT_MS
        : BACKGROUND_HEARTBEAT_MS;
    for (const hostId of this.hosts.keys()) {
      if (this.connectionStates.get(hostId) === "connected") {
        this.heartbeatIntervals.set(hostId, interval);
      }
    }
  }

  /**
   * Get the current heartbeat interval for a host.
   */
  getHeartbeatInterval(hostId: string): number {
    return this.heartbeatIntervals.get(hostId) ?? 0;
  }

  /**
   * Destroy the connection manager, clearing all connections and timers.
   */
  destroy(): void {
    this.destroyed = true;
    for (const hostId of this.hosts.keys()) {
      this.clearReconnect(hostId);
      this.connectionStates.set(hostId, "disconnected");
    }
    this.heartbeatIntervals.clear();
    this.listeners.clear();
  }

  private setConnectionState(
    hostId: string,
    state: ConnectionState
  ): void {
    const previous = this.connectionStates.get(hostId);
    if (previous === state) return;
    this.connectionStates.set(hostId, state);
    for (const listener of this.listeners) {
      listener(hostId, state);
    }
  }
}
