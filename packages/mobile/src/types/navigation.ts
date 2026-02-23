/**
 * Navigation Types for the Saqr Mobile App.
 *
 * Defines the parameter lists for all navigators: root tab navigator,
 * per-tab stack navigators, and modal overlays.
 *
 * @module types/navigation
 */

/** Parameters for the root bottom tab navigator. */
export interface RootTabParamList {
  AgentsTab: undefined;
  SessionsTab: undefined;
  DashboardTab: undefined;
  SettingsTab: undefined;
}

/** Parameters for the Agents tab stack navigator. */
export interface AgentsStackParamList {
  AgentList: undefined;
  AgentDetail: { hostId: string; agentId: string };
  AgentSession: { hostId: string; sessionId: string };
}

/** Parameters for the Sessions tab stack navigator. */
export interface SessionsStackParamList {
  SessionList: undefined;
  SessionDetail: { hostId: string; sessionId: string };
  SessionFileExplorer: { hostId: string; agentId: string; rootPath: string };
}

/** Parameters for the Dashboard tab stack navigator. */
export interface DashboardStackParamList {
  UsageDashboard: undefined;
  ProjectUsageDetail: { projectId: string; projectName: string };
}

/** Parameters for the Settings tab stack navigator. */
export interface SettingsStackParamList {
  Settings: undefined;
  DaemonRegistry: undefined;
  DaemonDetail: { hostId: string };
  EncryptionKey: undefined;
  QRScanner: { mode: "pairing" | "key-transfer" };
  NotificationSettings: undefined;
  KeyTransferSend: undefined;
  KeyTransferReceive: undefined;
}

/** Deep link configuration mapping URL paths to screens. */
export interface DeepLinkConfig {
  screens: {
    AgentsTab: {
      screens: {
        AgentDetail: string;
        AgentSession: string;
      };
    };
    SessionsTab: {
      screens: {
        SessionDetail: string;
      };
    };
  };
}

/** Default deep link configuration. */
export const DEEP_LINK_CONFIG: DeepLinkConfig = {
  screens: {
    AgentsTab: {
      screens: {
        AgentDetail: "agent/:hostId/:agentId",
        AgentSession: "session/:hostId/:sessionId",
      },
    },
    SessionsTab: {
      screens: {
        SessionDetail: "session/:hostId/:sessionId",
      },
    },
  },
};

/** All tab names for the root navigator. */
export const TAB_NAMES = [
  "AgentsTab",
  "SessionsTab",
  "DashboardTab",
  "SettingsTab",
] as const;

/** Type representing a valid tab name. */
export type TabName = (typeof TAB_NAMES)[number];
