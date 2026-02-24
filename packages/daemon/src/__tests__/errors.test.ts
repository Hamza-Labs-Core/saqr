/**
 * Tests for agent orchestration error classes.
 */
import { describe, it, expect } from "vitest";
import {
  AgentOrchestrationError,
  InvalidStateTransitionError,
  ProviderNotInstalledError,
  ProviderNotRegisteredError,
  MaxAgentsReachedError,
  AgentNotFoundError,
  PermissionTimeoutError,
  SpawnFailedError,
  WorktreeFailedError,
  PermissionAlreadyResolved,
} from "../agents/errors.js";

describe("Agent Orchestration Errors", () => {
  it("AgentOrchestrationError has code and httpStatus", () => {
    const err = new AgentOrchestrationError("TEST_CODE", "test message", 400);
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.httpStatus).toBe(400);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentOrchestrationError);
  });

  it("InvalidStateTransitionError has code INVALID_STATE and status 409", () => {
    const err = new InvalidStateTransitionError("idle", "error");
    expect(err.code).toBe("INVALID_STATE");
    expect(err.httpStatus).toBe(409);
    expect(err.message).toContain("idle");
    expect(err.message).toContain("error");
  });

  it("InvalidStateTransitionError includes reason when provided", () => {
    const err = new InvalidStateTransitionError(
      "closed",
      "idle",
      "closed is terminal",
    );
    expect(err.message).toContain("closed is terminal");
  });

  it("ProviderNotInstalledError includes install hint", () => {
    const err = new ProviderNotInstalledError(
      "opencode",
      "go install github.com/opencode-ai/opencode@latest",
    );
    expect(err.code).toBe("PROVIDER_NOT_INSTALLED");
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain("opencode");
    expect(err.message).toContain("go install");
  });

  it("ProviderNotRegisteredError has code PROVIDER_NOT_REGISTERED", () => {
    const err = new ProviderNotRegisteredError("unknown");
    expect(err.code).toBe("PROVIDER_NOT_REGISTERED");
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain("unknown");
  });

  it("MaxAgentsReachedError has code MAX_AGENTS_REACHED and status 429", () => {
    const err = new MaxAgentsReachedError(5);
    expect(err.code).toBe("MAX_AGENTS_REACHED");
    expect(err.httpStatus).toBe(429);
    expect(err.message).toContain("5");
  });

  it("AgentNotFoundError has code AGENT_NOT_FOUND and status 404", () => {
    const err = new AgentNotFoundError("abc-123");
    expect(err.code).toBe("AGENT_NOT_FOUND");
    expect(err.httpStatus).toBe(404);
    expect(err.message).toContain("abc-123");
  });

  it("PermissionTimeoutError has code PERMISSION_TIMEOUT and status 408", () => {
    const err = new PermissionTimeoutError("perm-1", 300000);
    expect(err.code).toBe("PERMISSION_TIMEOUT");
    expect(err.httpStatus).toBe(408);
    expect(err.message).toContain("perm-1");
    expect(err.message).toContain("300000");
  });

  it("SpawnFailedError has code SPAWN_FAILED", () => {
    const err = new SpawnFailedError("claude-code", "binary not found");
    expect(err.code).toBe("SPAWN_FAILED");
    expect(err.httpStatus).toBe(500);
    expect(err.message).toContain("claude-code");
    expect(err.message).toContain("binary not found");
  });

  it("WorktreeFailedError has code WORKTREE_FAILED", () => {
    const err = new WorktreeFailedError("branch conflict");
    expect(err.code).toBe("WORKTREE_FAILED");
    expect(err.httpStatus).toBe(500);
    expect(err.message).toContain("branch conflict");
  });

  it("PermissionAlreadyResolved has code PERMISSION_ALREADY_RESOLVED", () => {
    const err = new PermissionAlreadyResolved("perm-1", "client-1");
    expect(err.code).toBe("PERMISSION_ALREADY_RESOLVED");
    expect(err.httpStatus).toBe(409);
    expect(err.message).toContain("perm-1");
    expect(err.message).toContain("client-1");
  });

  it("all errors are instances of AgentOrchestrationError", () => {
    const errors = [
      new InvalidStateTransitionError("a", "b"),
      new ProviderNotInstalledError("x"),
      new ProviderNotRegisteredError("x"),
      new MaxAgentsReachedError(5),
      new AgentNotFoundError("x"),
      new PermissionTimeoutError("x", 1000),
      new SpawnFailedError("x", "y"),
      new WorktreeFailedError("y"),
      new PermissionAlreadyResolved("x", "y"),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(AgentOrchestrationError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
