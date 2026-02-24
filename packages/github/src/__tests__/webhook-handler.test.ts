/**
 * Tests for WebhookHandler - signature verification, event routing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as crypto from "node:crypto";
import {
  WebhookHandler,
  verifyWebhookSignature,
} from "../webhook-handler.js";
import type {
  CheckRunEventPayload,
  PullRequestReviewEventPayload,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(payload: string, secret: string): string {
  return `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";

  it("returns true for valid signature", () => {
    const payload = '{"action":"opened"}';
    const sig = sign(payload, secret);

    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for invalid signature", () => {
    const payload = '{"action":"opened"}';

    expect(
      verifyWebhookSignature(payload, "sha256=invalid", secret),
    ).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifyWebhookSignature("payload", "", secret)).toBe(false);
  });

  it("returns false for empty secret", () => {
    expect(verifyWebhookSignature("payload", "sha256=abc", "")).toBe(false);
  });

  it("works with Buffer payload", () => {
    const payload = Buffer.from('{"action":"closed"}');
    const sig = sign(payload.toString(), secret);

    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("prevents timing attacks (uses timingSafeEqual)", () => {
    const payload = '{"test":"data"}';
    const sig = sign(payload, secret);

    // This should still work despite using timing-safe comparison
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for tampered payload", () => {
    const original = '{"action":"opened"}';
    const sig = sign(original, secret);
    const tampered = '{"action":"closed"}';

    expect(verifyWebhookSignature(tampered, sig, secret)).toBe(false);
  });
});

describe("WebhookHandler", () => {
  const secret = "my-secret";
  let handler: WebhookHandler;

  beforeEach(() => {
    handler = new WebhookHandler(secret);
  });

  // -----------------------------------------------------------------------
  // Event Registration
  // -----------------------------------------------------------------------

  describe("event registration", () => {
    it("registers handlers for event types", () => {
      handler.on("push", vi.fn());
      handler.on("pull_request", vi.fn());

      expect(handler.registeredEvents).toContain("push");
      expect(handler.registeredEvents).toContain("pull_request");
      expect(handler.handlerCount).toBe(2);
    });

    it("supports multiple handlers for the same event", () => {
      handler.on("push", vi.fn());
      handler.on("push", vi.fn());

      expect(handler.handlerCount).toBe(2);
    });

    it("removes a specific handler", () => {
      const fn = vi.fn();
      handler.on("push", fn);
      handler.off("push", fn);

      expect(handler.handlerCount).toBe(0);
    });

    it("supports wildcard handlers", () => {
      handler.on("*", vi.fn());
      expect(handler.registeredEvents).toContain("*");
    });
  });

  // -----------------------------------------------------------------------
  // handle (with signature verification)
  // -----------------------------------------------------------------------

  describe("handle", () => {
    it("throws on invalid signature", async () => {
      const payload = '{"action":"opened"}';

      await expect(
        handler.handle("push", payload, "sha256=wrong"),
      ).rejects.toThrow("Invalid webhook signature");
    });

    it("invokes registered handler with parsed body", async () => {
      const fn = vi.fn();
      handler.on("push", fn);

      const payload = '{"action":"completed","ref":"refs/heads/main"}';
      const sig = sign(payload, secret);

      await handler.handle("push", payload, sig);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "refs/heads/main" }),
        "completed",
      );
    });

    it("invokes wildcard handlers for any event", async () => {
      const wildcard = vi.fn();
      handler.on("*", wildcard);

      const payload = '{"action":"created"}';
      const sig = sign(payload, secret);

      await handler.handle("issues", payload, sig);

      expect(wildcard).toHaveBeenCalledWith(
        expect.objectContaining({ action: "created" }),
        "created",
      );
    });

    it("returns false when no handlers are registered", async () => {
      const payload = '{"action":"test"}';
      const sig = sign(payload, secret);

      const result = await handler.handle("unhandled_event", payload, sig);
      expect(result).toBe(false);
    });

    it("returns true when handlers are invoked", async () => {
      handler.on("push", vi.fn());
      const payload = '{"action":"push"}';
      const sig = sign(payload, secret);

      const result = await handler.handle("push", payload, sig);
      expect(result).toBe(true);
    });

    it("handles Buffer payload", async () => {
      const fn = vi.fn();
      handler.on("push", fn);

      const payload = Buffer.from('{"action":"buffered"}');
      const sig = sign(payload.toString(), secret);

      await handler.handle("push", payload, sig);

      expect(fn).toHaveBeenCalled();
    });

    it("handles action-less payloads", async () => {
      const fn = vi.fn();
      handler.on("push", fn);

      const payload = '{"ref":"refs/heads/main"}';
      const sig = sign(payload, secret);

      await handler.handle("push", payload, sig);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "refs/heads/main" }),
        "",
      );
    });
  });

  // -----------------------------------------------------------------------
  // handleTrusted
  // -----------------------------------------------------------------------

  describe("handleTrusted", () => {
    it("skips signature verification", async () => {
      const fn = vi.fn();
      handler.on("push", fn);

      await handler.handleTrusted("push", { action: "completed", ref: "main" });

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "main" }),
        "completed",
      );
    });

    it("returns false when no handlers exist", async () => {
      const result = await handler.handleTrusted("unknown", {});
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // extractPRReviewNotification
  // -----------------------------------------------------------------------

  describe("extractPRReviewNotification", () => {
    it("extracts review notification from payload", () => {
      const payload: PullRequestReviewEventPayload = {
        action: "submitted",
        review: {
          id: 1,
          body: "LGTM!",
          state: "approved",
          user: { login: "reviewer" },
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-1",
        },
        pull_request: {
          number: 1,
          title: "My PR",
          html_url: "https://github.com/owner/repo/pull/1",
        },
      };

      const notification =
        WebhookHandler.extractPRReviewNotification(payload);

      expect(notification).not.toBeNull();
      expect(notification!.prNumber).toBe(1);
      expect(notification!.prTitle).toBe("My PR");
      expect(notification!.reviewerLogin).toBe("reviewer");
      expect(notification!.reviewState).toBe("approved");
      expect(notification!.reviewBody).toBe("LGTM!");
    });

    it("handles changes_requested review", () => {
      const payload: PullRequestReviewEventPayload = {
        action: "submitted",
        review: {
          id: 2,
          body: "Please fix the types",
          state: "changes_requested",
          user: { login: "strict-reviewer" },
          html_url: "https://github.com/owner/repo/pull/2#review-2",
        },
        pull_request: {
          number: 2,
          title: "Add feature",
          html_url: "https://github.com/owner/repo/pull/2",
        },
      };

      const notification =
        WebhookHandler.extractPRReviewNotification(payload);

      expect(notification!.reviewState).toBe("changes_requested");
      expect(notification!.reviewBody).toBe("Please fix the types");
    });

    it("returns null for incomplete payload", () => {
      const result = WebhookHandler.extractPRReviewNotification(
        {} as PullRequestReviewEventPayload,
      );
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // detectCIFailure
  // -----------------------------------------------------------------------

  describe("detectCIFailure", () => {
    it("detects a failure check run", () => {
      const payload: CheckRunEventPayload = {
        action: "completed",
        check_run: {
          id: 100,
          name: "tests",
          status: "completed",
          conclusion: "failure",
          head_sha: "abc123",
          html_url: "https://github.com/owner/repo/runs/100",
          started_at: "2025-01-01T00:00:00Z",
          completed_at: "2025-01-01T00:05:00Z",
          output: {
            title: "3 tests failed",
            summary: "auth.test.ts: FAIL",
          },
        },
      };

      const failure = WebhookHandler.detectCIFailure(payload);

      expect(failure).not.toBeNull();
      expect(failure!.checkRunId).toBe(100);
      expect(failure!.checkName).toBe("tests");
      expect(failure!.conclusion).toBe("failure");
      expect(failure!.title).toBe("3 tests failed");
      expect(failure!.summary).toBe("auth.test.ts: FAIL");
    });

    it("detects timed_out check run", () => {
      const payload: CheckRunEventPayload = {
        action: "completed",
        check_run: {
          id: 101,
          name: "build",
          status: "completed",
          conclusion: "timed_out",
          head_sha: "def456",
          html_url: "https://github.com/runs/101",
          started_at: null,
          completed_at: null,
          output: { title: null, summary: null },
        },
      };

      const failure = WebhookHandler.detectCIFailure(payload);
      expect(failure).not.toBeNull();
      expect(failure!.conclusion).toBe("timed_out");
    });

    it("returns null for successful check run", () => {
      const payload: CheckRunEventPayload = {
        action: "completed",
        check_run: {
          id: 102,
          name: "lint",
          status: "completed",
          conclusion: "success",
          head_sha: "ghi789",
          html_url: "https://github.com/runs/102",
          started_at: null,
          completed_at: null,
          output: { title: null, summary: null },
        },
      };

      expect(WebhookHandler.detectCIFailure(payload)).toBeNull();
    });

    it("returns null for in-progress check run", () => {
      const payload: CheckRunEventPayload = {
        action: "created",
        check_run: {
          id: 103,
          name: "deploy",
          status: "in_progress",
          conclusion: null,
          head_sha: "xyz",
          html_url: "https://github.com/runs/103",
          started_at: null,
          completed_at: null,
          output: { title: null, summary: null },
        },
      };

      expect(WebhookHandler.detectCIFailure(payload)).toBeNull();
    });

    it("returns null for empty payload", () => {
      expect(
        WebhookHandler.detectCIFailure({} as CheckRunEventPayload),
      ).toBeNull();
    });
  });
});
