/**
 * Tray State Manager.
 *
 * Computes tray menu state from daemon status, agent counts,
 * and update availability. Produces tooltip text and menu items.
 *
 * @module tray-state
 */

import type {
  DaemonStatus,
  AgentInfo,
  TrayState,
  TrayMenuState,
} from "./ipc-types.js";

// ---------------------------------------------------------------------------
// Tray Menu Item
// ---------------------------------------------------------------------------

/** Represents a single tray menu item. */
export interface TrayMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  separator?: boolean;
}

// ---------------------------------------------------------------------------
// Tray State Manager
// ---------------------------------------------------------------------------

/**
 * Manages the tray icon state, tooltip, and menu based on
 * daemon status, running agents, and update availability.
 */
export class TrayStateManager {
  private _state: TrayState = "error";
  private _agents: AgentInfo[] = [];
  private _hasUpdate = false;
  private _daemonRunning = false;
  private _activeAgentCount = 0;
  private _needsPermission = false;

  get currentState(): TrayState {
    return this._state;
  }

  get agents(): AgentInfo[] {
    return [...this._agents];
  }

  get hasUpdate(): boolean {
    return this._hasUpdate;
  }

  /** Update the tray state based on daemon status. */
  updateDaemonStatus(status: DaemonStatus): void {
    this._daemonRunning = status.running;
    this._activeAgentCount = status.active_agents;
    this.recomputeState();
  }

  /** Update the agent list. Sets attention state if any agent needs permission. */
  updateAgents(agents: AgentInfo[]): void {
    this._agents = [...agents];
    this._needsPermission = agents.some(
      (a) => a.status === "waiting_permission"
    );
    this.recomputeState();
  }

  /** Set whether an update is available. */
  setUpdateAvailable(available: boolean): void {
    this._hasUpdate = available;
    this.recomputeState();
  }

  /** Set the daemon as offline. */
  setDaemonOffline(): void {
    this._daemonRunning = false;
    this.recomputeState();
  }

  private recomputeState(): void {
    this._state = computeTrayState(
      this._daemonRunning,
      this._activeAgentCount,
      this._needsPermission,
      this._hasUpdate
    );
  }
}

// ---------------------------------------------------------------------------
// Pure State Computation
// ---------------------------------------------------------------------------

/**
 * Computes the tray state from individual flags.
 * Priority: error > attention > updating > running > idle
 */
export function computeTrayState(
  daemonRunning: boolean,
  activeAgentCount: number,
  needsPermission: boolean,
  hasUpdate: boolean
): TrayState {
  if (!daemonRunning) return "error";
  if (needsPermission) return "attention";
  if (hasUpdate) return "updating";
  if (activeAgentCount > 0) return "running";
  return "idle";
}

// ---------------------------------------------------------------------------
// Tooltip Formatting
// ---------------------------------------------------------------------------

/**
 * Formats the tooltip text for the tray icon.
 */
export function formatTooltip(state: TrayState, agents: AgentInfo[]): string {
  switch (state) {
    case "idle":
      return "AgentContext -- No active agents";
    case "running": {
      const count = agents.length;
      const plural = count === 1 ? "agent" : "agents";
      return `AgentContext -- ${count} ${plural} running`;
    }
    case "attention":
      return "AgentContext -- Action required";
    case "error":
      return "AgentContext -- Daemon disconnected";
    case "updating":
      return "AgentContext -- Updating...";
  }
}

// ---------------------------------------------------------------------------
// Menu Building
// ---------------------------------------------------------------------------

/**
 * Builds the tray menu items from the current state.
 */
export function buildTrayMenuItems(menuState: TrayMenuState): TrayMenuItem[] {
  const items: TrayMenuItem[] = [];
  const { state, agents, daemonStatus, version } = menuState;

  // Header
  items.push({
    id: "header",
    label: `AgentContext v${version}`,
    enabled: false,
  });

  // Daemon status
  if (daemonStatus.running) {
    items.push({
      id: "daemon-status",
      label: `Daemon: Running (PID ${daemonStatus.pid})`,
      enabled: false,
    });
  } else {
    items.push({
      id: "daemon-status",
      label: "Daemon: Stopped",
      enabled: false,
    });
  }

  // Separator
  items.push({ id: "sep-1", label: "", enabled: false, separator: true });

  // Agent count
  const agentCount = agents.length;
  const agentPlural = agentCount === 1 ? "agent" : "agents";
  items.push({
    id: "agent-count",
    label: `${agentCount} ${agentPlural} running`,
    enabled: false,
  });

  // Separator
  items.push({ id: "sep-2", label: "", enabled: false, separator: true });

  // Open Dashboard
  items.push({
    id: "open-dashboard",
    label: "Open Dashboard",
    enabled: true,
  });

  // Start New Agent
  items.push({
    id: "start-new-agent",
    label: "Start New Agent...",
    enabled: daemonStatus.running,
  });

  // Separator
  items.push({ id: "sep-3", label: "", enabled: false, separator: true });

  // Running agents
  for (const agent of agents) {
    items.push({
      id: `agent-${agent.id}`,
      label: `${agent.name} (${agent.model})`,
      enabled: true,
    });
  }

  // Separator (only if there are agents)
  if (agents.length > 0) {
    items.push({ id: "sep-4", label: "", enabled: false, separator: true });
  }

  // Start/Stop Daemon
  if (daemonStatus.running) {
    items.push({
      id: "stop-daemon",
      label: "Stop Daemon",
      enabled: true,
    });
  } else {
    items.push({
      id: "start-daemon",
      label: "Start Daemon",
      enabled: true,
    });
  }

  // Separator
  items.push({ id: "sep-5", label: "", enabled: false, separator: true });

  // Preferences and Updates
  items.push({
    id: "preferences",
    label: "Preferences...",
    enabled: true,
  });

  items.push({
    id: "check-updates",
    label: "Check for Updates...",
    enabled: true,
  });

  // Separator
  items.push({ id: "sep-6", label: "", enabled: false, separator: true });

  // Quit
  items.push({
    id: "quit",
    label: "Quit AgentContext",
    enabled: true,
  });

  items.push({
    id: "quit-all",
    label: "Quit All",
    enabled: true,
  });

  return items;
}
