/**
 * DaemonRegistry - CRUD operations for registered daemon HostProfiles.
 *
 * Manages the list of registered daemons, provides persistence serialization,
 * and handles QR pairing payload parsing and validation.
 *
 * @module services/daemon-registry
 */

import type { HostProfile } from "../types/daemon.js";
import type { PairingPayload } from "../types/crypto.js";
import type { QRScanError } from "../types/errors.js";
import { PAIRING_URL_SCHEME, QR_MAX_AGE_MS } from "../types/crypto.js";

/** Result of parsing a QR payload URL. */
export type ParseResult =
  | { success: true; payload: PairingPayload }
  | { success: false; error: QRScanError };

/**
 * Registry for managing daemon host profiles.
 */
export class DaemonRegistry {
  private hosts: Map<string, HostProfile> = new Map();

  /**
   * Get the number of registered hosts.
   */
  count(): number {
    return this.hosts.size;
  }

  /**
   * Get all registered host profiles (returns a copy).
   */
  getAll(): HostProfile[] {
    return Array.from(this.hosts.values()).map((h) => ({ ...h }));
  }

  /**
   * Get a host profile by ID.
   */
  getById(id: string): HostProfile | undefined {
    const host = this.hosts.get(id);
    return host ? { ...host } : undefined;
  }

  /**
   * Get a host profile by machine ID.
   */
  getByMachineId(machineId: string): HostProfile | undefined {
    for (const host of this.hosts.values()) {
      if (host.machineId === machineId) return { ...host };
    }
    return undefined;
  }

  /**
   * Get a host profile by hostname.
   */
  getByHostname(hostname: string): HostProfile | undefined {
    for (const host of this.hosts.values()) {
      if (host.hostname === hostname) return { ...host };
    }
    return undefined;
  }

  /**
   * Add a host. If a host with the same machineId exists, update it.
   */
  addHost(host: HostProfile): void {
    // Check for duplicate machineId
    const existing = this.getByMachineId(host.machineId);
    if (existing) {
      // Update existing host with new data
      this.hosts.set(existing.id, { ...existing, ...host, id: existing.id });
      return;
    }
    this.hosts.set(host.id, { ...host });
  }

  /**
   * Remove a host by ID.
   */
  removeHost(id: string): void {
    this.hosts.delete(id);
  }

  /**
   * Update specific fields on a host.
   */
  updateHost(id: string, updates: Partial<HostProfile>): void {
    const host = this.hosts.get(id);
    if (!host) return;
    this.hosts.set(id, { ...host, ...updates, id });
  }

  /**
   * Serialize all hosts to JSON string.
   */
  toJSON(): string {
    return JSON.stringify(this.getAll());
  }

  /**
   * Deserialize hosts from a JSON string.
   * Returns an empty registry on invalid input.
   */
  static fromJSON(json: string | null): DaemonRegistry {
    const registry = new DaemonRegistry();
    if (!json) return registry;
    try {
      const parsed = JSON.parse(json) as HostProfile[];
      if (Array.isArray(parsed)) {
        for (const host of parsed) {
          registry.hosts.set(host.id, host);
        }
      }
    } catch {
      // Invalid JSON, return empty registry
    }
    return registry;
  }

  /**
   * Parse and validate a QR pairing payload URL.
   *
   * Expected format: agentctx://pair?data=<base64url-encoded-json>
   */
  static parseQRPayloadUrl(url: string): ParseResult {
    // Check URL scheme
    if (!url.startsWith(PAIRING_URL_SCHEME)) {
      return {
        success: false,
        error: {
          type: "INVALID_FORMAT",
          message:
            "Invalid QR code -- this doesn't appear to be an AgentContext pairing code",
        },
      };
    }

    // Extract data parameter
    const dataMatch = url.match(/[?&]data=([^&]+)/);
    if (!dataMatch) {
      return {
        success: false,
        error: {
          type: "INVALID_FORMAT",
          message: "QR code is missing the data parameter",
        },
      };
    }

    // Decode base64url
    let decoded: string;
    try {
      decoded = Buffer.from(dataMatch[1], "base64url").toString("utf-8");
    } catch {
      return {
        success: false,
        error: {
          type: "PARSE_ERROR",
          message: "QR code data could not be decoded",
        },
      };
    }

    // Parse JSON
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        error: {
          type: "PARSE_ERROR",
          message: "QR code data is not valid JSON",
        },
      };
    }

    // Validate version
    if (payload["version"] !== 1) {
      return {
        success: false,
        error: {
          type: "INVALID_FORMAT",
          message: `Unsupported QR code version: ${String(payload["version"])}`,
        },
      };
    }

    // Validate required fields
    const requiredFields = [
      "hostname",
      "os",
      "machineId",
      "ephemeralPublicKey",
      "expiresAt",
    ];
    for (const field of requiredFields) {
      if (!payload[field]) {
        return {
          success: false,
          error: {
            type: "PARSE_ERROR",
            message: `QR code is missing required field: ${field}`,
          },
        };
      }
    }

    // Check expiry
    const expiresAt = new Date(payload["expiresAt"] as string).getTime();
    const now = Date.now();
    if (now - expiresAt > QR_MAX_AGE_MS) {
      return {
        success: false,
        error: {
          type: "EXPIRED",
          message: "QR code has expired. Please generate a new one.",
        },
      };
    }

    return {
      success: true,
      payload: payload as unknown as PairingPayload,
    };
  }

  /**
   * Create a HostProfile from a validated pairing payload.
   */
  static createHostFromPayload(
    payload: PairingPayload,
    daemonPublicKey: string
  ): HostProfile {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const hasLan = Boolean(payload.lan);
    const connectionType = hasLan ? "lan" : "relay";
    const lanAddress = payload.lan
      ? `${payload.lan.address}:${payload.lan.port}`
      : undefined;

    return {
      id,
      name: payload.hostname,
      hostname: payload.hostname,
      connectionType: connectionType as "lan" | "relay",
      lanAddress,
      relayServerId: payload.relay?.serverId,
      publicKey: daemonPublicKey,
      pairedAt: now,
      lastSeen: now,
      connectionState: "disconnected",
      daemonVersion: payload.daemonVersion,
      os: payload.os,
      machineId: payload.machineId,
    };
  }
}
