/**
 * Error classes for agent process orchestration.
 *
 * All errors extend a common AgentOrchestrationError base with
 * machine-readable `code` and HTTP `httpStatus` fields.
 */

export class AgentOrchestrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 500,
  ) {
    super(message);
    this.name = "AgentOrchestrationError";
  }
}

export class InvalidStateTransitionError extends AgentOrchestrationError {
  constructor(from: string, to: string, reason?: string) {
    super(
      "INVALID_STATE",
      `Invalid state transition from "${from}" to "${to}"${reason ? `: ${reason}` : ""}`,
      409,
    );
    this.name = "InvalidStateTransitionError";
  }
}

export class ProviderNotInstalledError extends AgentOrchestrationError {
  constructor(providerId: string, installHint?: string) {
    super(
      "PROVIDER_NOT_INSTALLED",
      `Provider "${providerId}" is not installed.${installHint ? ` Install it: ${installHint}` : ""}`,
      400,
    );
    this.name = "ProviderNotInstalledError";
  }
}

export class ProviderNotRegisteredError extends AgentOrchestrationError {
  constructor(providerId: string) {
    super(
      "PROVIDER_NOT_REGISTERED",
      `No provider with ID "${providerId}" is registered`,
      400,
    );
    this.name = "ProviderNotRegisteredError";
  }
}

export class MaxAgentsReachedError extends AgentOrchestrationError {
  constructor(maxAgents: number) {
    super(
      "MAX_AGENTS_REACHED",
      `Cannot create another agent: maximum of ${maxAgents} concurrent agents reached`,
      429,
    );
    this.name = "MaxAgentsReachedError";
  }
}

export class AgentNotFoundError extends AgentOrchestrationError {
  constructor(sessionId: string) {
    super(
      "AGENT_NOT_FOUND",
      `Agent session "${sessionId}" not found`,
      404,
    );
    this.name = "AgentNotFoundError";
  }
}

export class PermissionTimeoutError extends AgentOrchestrationError {
  constructor(permissionId: string, timeoutMs: number) {
    super(
      "PERMISSION_TIMEOUT",
      `Permission "${permissionId}" timed out after ${timeoutMs}ms: no client responded`,
      408,
    );
    this.name = "PermissionTimeoutError";
  }
}

export class SpawnFailedError extends AgentOrchestrationError {
  constructor(providerId: string, reason: string) {
    super(
      "SPAWN_FAILED",
      `Failed to spawn ${providerId} agent: ${reason}`,
      500,
    );
    this.name = "SpawnFailedError";
  }
}

export class WorktreeFailedError extends AgentOrchestrationError {
  constructor(reason: string) {
    super(
      "WORKTREE_FAILED",
      `Git worktree operation failed: ${reason}`,
      500,
    );
    this.name = "WorktreeFailedError";
  }
}

export class PermissionAlreadyResolved extends AgentOrchestrationError {
  constructor(permissionId: string, resolvedBy: string) {
    super(
      "PERMISSION_ALREADY_RESOLVED",
      `Permission "${permissionId}" already resolved by ${resolvedBy}`,
      409,
    );
    this.name = "PermissionAlreadyResolved";
  }
}
