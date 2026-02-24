/**
 * Daemon Types for the Saqr Mobile App.
 *
 * Defines the HostProfile data structure for registered daemons,
 * connection states, and registry state.
 *
 * @module types/daemon
 */

/** Connection state for a daemon WebSocket. */
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "connecting"
  | "error";

/** Represents a registered daemon/development machine. */
export interface HostProfile {
  /** UUID, generated on pairing. */
  id: string;
  /** User-provided label (e.g., "Work MacBook", "Linux VM"). */
  name: string;
  /** Machine hostname from daemon. */
  hostname: string;
  /** Connection method: LAN direct or E2EE relay. */
  connectionType: "lan" | "relay";
  /** LAN address, e.g., "192.168.1.42:9120". */
  lanAddress?: string;
  /** Relay server ID for E2EE connections. */
  relayServerId?: string;
  /** Daemon's Curve25519 public key (base64). */
  publicKey: string;
  /** ISO 8601 timestamp when pairing occurred. */
  pairedAt: string;
  /** ISO 8601 timestamp of last successful communication. */
  lastSeen: string;
  /** Current connection state. */
  connectionState: ConnectionState;
  /** Daemon software version. */
  daemonVersion: string;
  /** Operating system of the daemon machine. */
  os: "linux" | "macos" | "windows";
  /** Daemon's unique machine identifier. */
  machineId: string;
}

/** Aggregate state of the daemon registry. */
export interface DaemonRegistryState {
  /** All registered host profiles. */
  hosts: HostProfile[];
}
