/**
 * Tests for the mobile type system and data models.
 *
 * Validates that types compile correctly, runtime constants are correct,
 * and factory helpers produce valid instances.
 */
import { describe, it, expect } from "vitest";
import {
  DEEP_LINK_CONFIG,
  TAB_NAMES,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
  DEFAULT_KEY_STORAGE_OPTIONS,
  PAIRING_URL_SCHEME,
  KEY_TRANSFER_URL_SCHEME,
  QR_MAX_AGE_MS,
  KEY_TRANSFER_MAX_AGE_MS,
} from "../types/index.js";
import type {
  RootTabParamList,
  AgentsStackParamList,
  SessionsStackParamList,
  DashboardStackParamList,
  SettingsStackParamList,
  ConnectionState,
  HostProfile,
  AgentStatus,
  AgentSummary,
  TokenUsage,
  SessionSummary,
  SessionFilter,
  SessionSearchResult,
  SearchMatch,
  UsageStats,
  DailyUsage,
  ProjectUsage,
  ModelUsage,
  DateRange,
  FileEntry,
  GitFileStatus,
  AgentNotification,
  NotificationSettings,
  KeyInfo,
  KeyStorageOptions,
  PairingPayload,
  KeyTransferPayload,
  QRScanError,
  VoiceInputError,
  ConnectionError,
  TabName,
} from "../types/index.js";

describe("Navigation Types", () => {
  it("exports TAB_NAMES with all 4 tabs", () => {
    expect(TAB_NAMES).toHaveLength(4);
    expect(TAB_NAMES).toContain("AgentsTab");
    expect(TAB_NAMES).toContain("SessionsTab");
    expect(TAB_NAMES).toContain("DashboardTab");
    expect(TAB_NAMES).toContain("SettingsTab");
  });

  it("DEEP_LINK_CONFIG has correct screen paths", () => {
    expect(DEEP_LINK_CONFIG.screens.AgentsTab.screens.AgentDetail).toBe(
      "agent/:hostId/:agentId"
    );
    expect(DEEP_LINK_CONFIG.screens.AgentsTab.screens.AgentSession).toBe(
      "session/:hostId/:sessionId"
    );
    expect(DEEP_LINK_CONFIG.screens.SessionsTab.screens.SessionDetail).toBe(
      "session/:hostId/:sessionId"
    );
  });

  it("TabName type matches TAB_NAMES", () => {
    const tabName: TabName = "AgentsTab";
    expect(TAB_NAMES).toContain(tabName);
  });

  it("RootTabParamList has correct structure", () => {
    const params: RootTabParamList = {
      AgentsTab: undefined,
      SessionsTab: undefined,
      DashboardTab: undefined,
      SettingsTab: undefined,
    };
    expect(params.AgentsTab).toBeUndefined();
  });

  it("AgentsStackParamList requires hostId and agentId for detail", () => {
    const params: AgentsStackParamList["AgentDetail"] = {
      hostId: "host-1",
      agentId: "agent-1",
    };
    expect(params.hostId).toBe("host-1");
    expect(params.agentId).toBe("agent-1");
  });

  it("SessionsStackParamList requires hostId and sessionId", () => {
    const params: SessionsStackParamList["SessionDetail"] = {
      hostId: "host-1",
      sessionId: "sess-1",
    };
    expect(params.hostId).toBe("host-1");
    expect(params.sessionId).toBe("sess-1");
  });

  it("DashboardStackParamList includes project detail params", () => {
    const params: DashboardStackParamList["ProjectUsageDetail"] = {
      projectId: "proj-1",
      projectName: "My Project",
    };
    expect(params.projectId).toBe("proj-1");
    expect(params.projectName).toBe("My Project");
  });

  it("SettingsStackParamList includes QR scanner modes", () => {
    const params: SettingsStackParamList["QRScanner"] = {
      mode: "pairing",
    };
    expect(params.mode).toBe("pairing");

    const transferParams: SettingsStackParamList["QRScanner"] = {
      mode: "key-transfer",
    };
    expect(transferParams.mode).toBe("key-transfer");
  });
});

describe("Daemon Types", () => {
  it("HostProfile can represent a LAN-connected host", () => {
    const host: HostProfile = {
      id: "uuid-1",
      name: "Work MacBook",
      hostname: "work-macbook",
      connectionType: "lan",
      lanAddress: "192.168.1.42:9120",
      publicKey: "base64key==",
      pairedAt: "2026-02-15T10:00:00Z",
      lastSeen: "2026-02-22T14:30:00Z",
      connectionState: "connected",
      daemonVersion: "1.0.0",
      os: "macos",
      machineId: "a3f7b2c9d1e4",
    };
    expect(host.connectionType).toBe("lan");
    expect(host.lanAddress).toBe("192.168.1.42:9120");
  });

  it("HostProfile can represent a relay-connected host", () => {
    const host: HostProfile = {
      id: "uuid-2",
      name: "Linux VM",
      hostname: "linux-vm",
      connectionType: "relay",
      relayServerId: "server-abc123",
      publicKey: "base64key==",
      pairedAt: "2026-02-15T10:00:00Z",
      lastSeen: "2026-02-22T14:30:00Z",
      connectionState: "connecting",
      daemonVersion: "1.0.0",
      os: "linux",
      machineId: "b4e8c3d2f1a5",
    };
    expect(host.connectionType).toBe("relay");
    expect(host.relayServerId).toBe("server-abc123");
  });

  it("ConnectionState covers all states", () => {
    const states: ConnectionState[] = [
      "connected",
      "disconnected",
      "connecting",
      "error",
    ];
    expect(states).toHaveLength(4);
  });
});

describe("Agent Types", () => {
  it("AgentSummary can represent a running agent", () => {
    const agent: AgentSummary = {
      id: "agent-1",
      hostId: "host-1",
      hostName: "Work MacBook",
      provider: "claude-code",
      model: "claude-opus-4-6",
      status: "running",
      projectName: "my-project",
      projectPath: "/Users/me/my-project",
      currentActivity: "Running Bash command",
      lastPrompt: "Fix the bug in...",
      sessionId: "sess-1",
      startedAt: "2026-02-22T10:00:00Z",
      lastActivityAt: "2026-02-22T14:30:00Z",
      tokenUsage: {
        inputTokens: 8200,
        outputTokens: 3100,
        cacheReadTokens: 4000,
        estimatedCost: 0.42,
      },
      pendingPermissions: 2,
    };
    expect(agent.status).toBe("running");
    expect(agent.tokenUsage.estimatedCost).toBe(0.42);
  });

  it("AgentStatus includes disconnected state", () => {
    const statuses: AgentStatus[] = [
      "initializing",
      "idle",
      "running",
      "waiting_permission",
      "error",
      "completed",
      "disconnected",
    ];
    expect(statuses).toHaveLength(7);
  });

  it("TokenUsage can have zero cost", () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      estimatedCost: 0,
    };
    expect(usage.estimatedCost).toBe(0);
  });
});

describe("Session Types", () => {
  it("SessionSummary can represent an active session", () => {
    const session: SessionSummary = {
      sessionId: "sess-1",
      hostId: "host-1",
      hostName: "Work MacBook",
      projectId: "proj-1",
      projectName: "my-project",
      startedAt: "2026-02-22T10:00:00Z",
      duration: 8100,
      eventCount: 342,
      promptCount: 5,
      toolCallCount: 47,
      tokenUsage: {
        inputTokens: 50000,
        outputTokens: 25000,
        cacheReadTokens: 100000,
        estimatedCost: 1.23,
      },
      lastPromptPreview: "Add dark mode support to the...",
      status: "active",
      isDecrypted: true,
    };
    expect(session.status).toBe("active");
    expect(session.endedAt).toBeUndefined();
  });

  it("SessionFilter supports all filter fields", () => {
    const filter: SessionFilter = {
      machineId: "host-1",
      projectId: "proj-1",
      dateFrom: "2026-02-01T00:00:00Z",
      dateTo: "2026-02-28T23:59:59Z",
      searchQuery: "dark mode",
      status: "completed",
      sortBy: "date",
      sortDirection: "desc",
      limit: 20,
      cursor: "cursor-abc",
    };
    expect(filter.sortBy).toBe("date");
  });

  it("SearchMatch references event sequence", () => {
    const match: SearchMatch = {
      eventType: "UserPromptReceived",
      fieldName: "prompt",
      snippet: "...add dark <mark>mode</mark> support...",
      eventSequence: 42,
    };
    expect(match.eventSequence).toBe(42);
  });
});

describe("Usage Types", () => {
  it("DailyUsage uses YYYY-MM-DD date format", () => {
    const day: DailyUsage = {
      date: "2026-02-22",
      inputTokens: 10000,
      outputTokens: 5000,
      cacheReadTokens: 20000,
      cost: 0.5,
      sessionCount: 3,
    };
    expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("ProjectUsage percentage is 0-100", () => {
    const proj: ProjectUsage = {
      projectId: "proj-1",
      projectName: "my-project",
      inputTokens: 10000,
      outputTokens: 5000,
      cost: 0.5,
      percentage: 42,
      sessionCount: 3,
    };
    expect(proj.percentage).toBeGreaterThanOrEqual(0);
    expect(proj.percentage).toBeLessThanOrEqual(100);
  });

  it("DateRange uses ISO 8601 strings", () => {
    const range: DateRange = {
      from: "2026-02-01T00:00:00Z",
      to: "2026-02-28T23:59:59Z",
    };
    expect(range.from).toContain("T");
  });
});

describe("File Types", () => {
  it("FileEntry can represent a file with git status", () => {
    const file: FileEntry = {
      name: "index.ts",
      path: "src/index.ts",
      type: "file",
      size: 1234,
      modifiedAt: "2026-02-22T14:00:00Z",
      gitStatus: "modified",
    };
    expect(file.type).toBe("file");
    expect(file.gitStatus).toBe("modified");
  });

  it("FileEntry can represent a directory with children", () => {
    const dir: FileEntry = {
      name: "src",
      path: "src",
      type: "directory",
      children: [
        { name: "index.ts", path: "src/index.ts", type: "file" },
      ],
    };
    expect(dir.type).toBe("directory");
    expect(dir.children).toHaveLength(1);
  });

  it("GitFileStatus covers all statuses", () => {
    const statuses: GitFileStatus[] = [
      "modified",
      "added",
      "deleted",
      "untracked",
      "renamed",
      "ignored",
      "clean",
    ];
    expect(statuses).toHaveLength(7);
  });
});

describe("Notification Types", () => {
  it("DEFAULT_NOTIFICATION_SETTINGS has correct defaults", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_NOTIFICATION_SETTINGS.perType.permission_request).toBe(true);
    expect(DEFAULT_NOTIFICATION_SETTINGS.perType.agent_completed).toBe(true);
    expect(DEFAULT_NOTIFICATION_SETTINGS.perType.agent_error).toBe(true);
    expect(DEFAULT_NOTIFICATION_SETTINGS.perType.session_ended).toBe(false);
    expect(DEFAULT_NOTIFICATION_SETTINGS.perType.long_running_update).toBe(
      false
    );
    expect(DEFAULT_NOTIFICATION_SETTINGS.quietHours.enabled).toBe(false);
    expect(DEFAULT_NOTIFICATION_SETTINGS.quietHours.startTime).toBe("22:00");
    expect(DEFAULT_NOTIFICATION_SETTINGS.quietHours.endTime).toBe("08:00");
  });

  it("NOTIFICATION_CATEGORIES has 4 categories", () => {
    expect(NOTIFICATION_CATEGORIES).toHaveLength(4);
    const ids = NOTIFICATION_CATEGORIES.map((c) => c.id);
    expect(ids).toContain("agent_permissions");
    expect(ids).toContain("agent_completions");
    expect(ids).toContain("agent_errors");
    expect(ids).toContain("agent_updates");
  });

  it("permission_request is time-sensitive", () => {
    const permCat = NOTIFICATION_CATEGORIES.find(
      (c) => c.id === "agent_permissions"
    );
    expect(permCat?.priority).toBe("time-sensitive");
  });

  it("AgentNotification can represent a permission request", () => {
    const notif: AgentNotification = {
      id: "notif-1",
      type: "permission_request",
      hostId: "host-1",
      hostName: "Work MacBook",
      agentId: "agent-1",
      projectName: "my-project",
      sessionId: "sess-1",
      title: "Permission Required - Work MacBook",
      body: "Claude wants to run: npm install",
      data: {
        hostId: "host-1",
        agentId: "agent-1",
        toolUseId: "tool-1",
      },
      createdAt: "2026-02-22T14:30:00Z",
      read: false,
      priority: "time-sensitive",
    };
    expect(notif.type).toBe("permission_request");
    expect(notif.read).toBe(false);
  });
});

describe("Crypto Types", () => {
  it("PAIRING_URL_SCHEME is agentctx://pair", () => {
    expect(PAIRING_URL_SCHEME).toBe("agentctx://pair");
  });

  it("KEY_TRANSFER_URL_SCHEME is agentctx://key-transfer", () => {
    expect(KEY_TRANSFER_URL_SCHEME).toBe("agentctx://key-transfer");
  });

  it("QR_MAX_AGE_MS is 5 minutes", () => {
    expect(QR_MAX_AGE_MS).toBe(5 * 60 * 1000);
  });

  it("KEY_TRANSFER_MAX_AGE_MS is 2 minutes", () => {
    expect(KEY_TRANSFER_MAX_AGE_MS).toBe(2 * 60 * 1000);
  });

  it("DEFAULT_KEY_STORAGE_OPTIONS has correct defaults", () => {
    expect(DEFAULT_KEY_STORAGE_OPTIONS.biometricRequired).toBe(true);
    expect(DEFAULT_KEY_STORAGE_OPTIONS.accessLevel).toBe("whenUnlocked");
  });

  it("PairingPayload has required fields", () => {
    const payload: PairingPayload = {
      version: 1,
      hostname: "work-macbook",
      os: "macos",
      daemonVersion: "1.0.0",
      machineId: "a3f7b2c9d1e4",
      lan: { address: "192.168.1.42", port: 9120 },
      relay: { serverId: "server-abc" },
      ephemeralPublicKey: "base64key==",
      expiresAt: "2026-02-22T15:00:00Z",
      nonce: "base64nonce==",
    };
    expect(payload.version).toBe(1);
    expect(payload.os).toBe("macos");
  });

  it("KeyTransferPayload has type discriminator", () => {
    const payload: KeyTransferPayload = {
      version: 1,
      type: "key_transfer",
      ephemeralPublicKey: "base64key==",
      expiresAt: "2026-02-22T15:02:00Z",
      nonce: "base64nonce==",
    };
    expect(payload.type).toBe("key_transfer");
  });
});

describe("Error Types", () => {
  it("QRScanError is a discriminated union", () => {
    const err1: QRScanError = {
      type: "INVALID_FORMAT",
      message: "Not an AgentContext QR code",
    };
    const err2: QRScanError = {
      type: "EXPIRED",
      message: "QR code has expired",
    };
    const err3: QRScanError = {
      type: "PARSE_ERROR",
      message: "Invalid JSON",
    };
    const err4: QRScanError = {
      type: "CAMERA_ERROR",
      message: "Camera unavailable",
    };
    expect(err1.type).toBe("INVALID_FORMAT");
    expect(err2.type).toBe("EXPIRED");
    expect(err3.type).toBe("PARSE_ERROR");
    expect(err4.type).toBe("CAMERA_ERROR");
  });

  it("VoiceInputError is a discriminated union", () => {
    const err: VoiceInputError = {
      type: "PERMISSION_DENIED",
      message: "Microphone access denied",
    };
    expect(err.type).toBe("PERMISSION_DENIED");
  });

  it("ConnectionError includes hostId", () => {
    const err: ConnectionError = {
      type: "TIMEOUT",
      message: "Connection timed out",
      hostId: "host-1",
    };
    expect(err.hostId).toBe("host-1");
  });

  it("ConnectionError CLOSED includes code", () => {
    const err: ConnectionError = {
      type: "CLOSED",
      message: "Connection closed abnormally",
      hostId: "host-1",
      code: 1006,
    };
    expect(err.type).toBe("CLOSED");
    expect(err.code).toBe(1006);
  });
});
