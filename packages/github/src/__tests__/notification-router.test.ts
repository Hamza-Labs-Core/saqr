/**
 * Tests for NotificationRouter - notification routing, priority, filtering.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotificationRouter } from "../notification-router.js";
import type { Notification } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id: `notif-${Math.random().toString(36).slice(2)}`,
    type: "pr_review",
    priority: "info",
    title: "Test notification",
    body: "Test body",
    repository: "owner/repo",
    timestamp: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NotificationRouter", () => {
  let router: NotificationRouter;

  beforeEach(() => {
    router = new NotificationRouter();
  });

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  describe("subscription", () => {
    it("subscribe returns an ID", () => {
      const id = router.subscribe(vi.fn());
      expect(id).toBeTypeOf("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("tracks subscription count", () => {
      router.subscribe(vi.fn());
      router.subscribe(vi.fn());
      expect(router.subscriptionCount).toBe(2);
    });

    it("unsubscribe removes the subscription", () => {
      const id = router.subscribe(vi.fn());
      expect(router.unsubscribe(id)).toBe(true);
      expect(router.subscriptionCount).toBe(0);
    });

    it("unsubscribe returns false for unknown ID", () => {
      expect(router.unsubscribe("nonexistent")).toBe(false);
    });

    it("clearSubscriptions removes all", () => {
      router.subscribe(vi.fn());
      router.subscribe(vi.fn());
      router.clearSubscriptions();
      expect(router.subscriptionCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------------

  describe("route", () => {
    it("delivers notification to all subscribers", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe(handler1);
      router.subscribe(handler2);

      const notif = makeNotification();
      const count = await router.route(notif);

      expect(count).toBe(2);
      expect(handler1).toHaveBeenCalledWith(notif);
      expect(handler2).toHaveBeenCalledWith(notif);
    });

    it("returns 0 when no subscribers match", async () => {
      router.subscribe(vi.fn(), { types: ["ci_failure"] });

      const notif = makeNotification({ type: "pr_review" });
      const count = await router.route(notif);

      expect(count).toBe(0);
    });

    it("filters by notification type", async () => {
      const handler = vi.fn();
      router.subscribe(handler, { types: ["ci_failure"] });

      await router.route(makeNotification({ type: "pr_review" }));
      expect(handler).not.toHaveBeenCalled();

      await router.route(makeNotification({ type: "ci_failure" }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it("filters by minimum priority", async () => {
      const handler = vi.fn();
      router.subscribe(handler, { minPriority: "warning" });

      await router.route(makeNotification({ priority: "info" }));
      expect(handler).not.toHaveBeenCalled();

      await router.route(makeNotification({ priority: "warning" }));
      expect(handler).toHaveBeenCalledOnce();

      await router.route(makeNotification({ priority: "critical" }));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("filters by repository", async () => {
      const handler = vi.fn();
      router.subscribe(handler, { repository: "owner/repo" });

      await router.route(makeNotification({ repository: "other/repo" }));
      expect(handler).not.toHaveBeenCalled();

      await router.route(makeNotification({ repository: "owner/repo" }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it("filters by PR number", async () => {
      const handler = vi.fn();
      router.subscribe(handler, { prNumber: 42 });

      await router.route(makeNotification({ prNumber: 10 }));
      expect(handler).not.toHaveBeenCalled();

      await router.route(makeNotification({ prNumber: 42 }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it("combines multiple filters (AND logic)", async () => {
      const handler = vi.fn();
      router.subscribe(handler, {
        types: ["ci_failure"],
        minPriority: "warning",
        repository: "owner/repo",
      });

      // Wrong type
      await router.route(
        makeNotification({
          type: "pr_review",
          priority: "critical",
          repository: "owner/repo",
        }),
      );
      expect(handler).not.toHaveBeenCalled();

      // Wrong priority
      await router.route(
        makeNotification({
          type: "ci_failure",
          priority: "info",
          repository: "owner/repo",
        }),
      );
      expect(handler).not.toHaveBeenCalled();

      // Wrong repo
      await router.route(
        makeNotification({
          type: "ci_failure",
          priority: "critical",
          repository: "other/repo",
        }),
      );
      expect(handler).not.toHaveBeenCalled();

      // All match
      await router.route(
        makeNotification({
          type: "ci_failure",
          priority: "critical",
          repository: "owner/repo",
        }),
      );
      expect(handler).toHaveBeenCalledOnce();
    });

    it("continues delivery when a handler throws", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("boom"));
      const succeeding = vi.fn();

      router.subscribe(failing);
      router.subscribe(succeeding);

      const notif = makeNotification();
      const count = await router.route(notif);

      // Both were attempted, but only one succeeded
      expect(count).toBe(1);
      expect(succeeding).toHaveBeenCalledWith(notif);
    });
  });

  // -----------------------------------------------------------------------
  // routePRReview
  // -----------------------------------------------------------------------

  describe("routePRReview", () => {
    it("creates and routes a PR review notification", async () => {
      const handler = vi.fn();
      router.subscribe(handler);

      const notification = await router.routePRReview(
        {
          prNumber: 42,
          prTitle: "Fix bug",
          prUrl: "https://github.com/owner/repo/pull/42",
          reviewerLogin: "alice",
          reviewState: "approved",
          reviewBody: "LGTM",
          reviewUrl: "https://github.com/owner/repo/pull/42#review-1",
        },
        "owner/repo",
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(notification.type).toBe("pr_review");
      expect(notification.prNumber).toBe(42);
      expect(notification.repository).toBe("owner/repo");
      expect(notification.title).toContain("approved");
    });

    it("sets warning priority for changes_requested", async () => {
      const handler = vi.fn();
      router.subscribe(handler);

      const notification = await router.routePRReview(
        {
          prNumber: 10,
          prTitle: "Feature",
          prUrl: "",
          reviewerLogin: "bob",
          reviewState: "changes_requested",
          reviewBody: "Fix types",
          reviewUrl: "",
        },
        "owner/repo",
      );

      expect(notification.priority).toBe("warning");
    });

    it("sets info priority for approved", async () => {
      const handler = vi.fn();
      router.subscribe(handler);

      const notification = await router.routePRReview(
        {
          prNumber: 10,
          prTitle: "Feature",
          prUrl: "",
          reviewerLogin: "bob",
          reviewState: "approved",
          reviewBody: null,
          reviewUrl: "",
        },
        "owner/repo",
      );

      expect(notification.priority).toBe("info");
    });

    it("includes metadata with reviewer and state", async () => {
      const handler = vi.fn();
      router.subscribe(handler);

      const notification = await router.routePRReview(
        {
          prNumber: 5,
          prTitle: "PR",
          prUrl: "",
          reviewerLogin: "reviewer",
          reviewState: "commented",
          reviewBody: "Note",
          reviewUrl: "",
        },
        "o/r",
      );

      expect(notification.metadata).toEqual({
        reviewerLogin: "reviewer",
        reviewState: "commented",
      });
    });
  });

  // -----------------------------------------------------------------------
  // routeCIFailure
  // -----------------------------------------------------------------------

  describe("routeCIFailure", () => {
    it("creates and routes a CI failure notification", async () => {
      const handler = vi.fn();
      router.subscribe(handler);

      const notification = await router.routeCIFailure(
        {
          checkRunId: 100,
          checkName: "tests",
          headSha: "abc123",
          conclusion: "failure",
          htmlUrl: "https://github.com/runs/100",
          title: "3 tests failed",
          summary: "auth.test.ts FAIL",
        },
        "owner/repo",
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(notification.type).toBe("ci_failure");
      expect(notification.priority).toBe("critical");
      expect(notification.title).toContain("tests");
      expect(notification.repository).toBe("owner/repo");
    });

    it("uses summary as body when available", async () => {
      const handler = vi.fn();
      router.subscribe(handler);

      const notification = await router.routeCIFailure(
        {
          checkRunId: 101,
          checkName: "lint",
          headSha: "def",
          conclusion: "failure",
          htmlUrl: "",
          title: null,
          summary: "ESLint found errors",
        },
        "o/r",
      );

      expect(notification.body).toBe("ESLint found errors");
    });

    it("falls back to generic body when no summary", async () => {
      const handler = vi.fn();
      router.subscribe(handler);

      const notification = await router.routeCIFailure(
        {
          checkRunId: 102,
          checkName: "build",
          headSha: "ghi",
          conclusion: "timed_out",
          htmlUrl: "",
          title: null,
          summary: null,
        },
        "o/r",
      );

      expect(notification.body).toContain("build");
      expect(notification.body).toContain("timed_out");
    });
  });

  // -----------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------

  describe("history", () => {
    it("records routed notifications", async () => {
      await router.route(makeNotification({ type: "a" }));
      await router.route(makeNotification({ type: "b" }));

      const history = router.getHistory();
      expect(history).toHaveLength(2);
    });

    it("limits history to maxHistory", async () => {
      const smallRouter = new NotificationRouter(3);

      await smallRouter.route(makeNotification({ type: "a" }));
      await smallRouter.route(makeNotification({ type: "b" }));
      await smallRouter.route(makeNotification({ type: "c" }));
      await smallRouter.route(makeNotification({ type: "d" }));

      const history = smallRouter.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].type).toBe("b"); // oldest kept
      expect(history[2].type).toBe("d"); // newest
    });

    it("filters history by criteria", async () => {
      await router.route(
        makeNotification({ type: "ci_failure", priority: "critical" }),
      );
      await router.route(
        makeNotification({ type: "pr_review", priority: "info" }),
      );

      const criticalOnly = router.getHistory({ minPriority: "critical" });
      expect(criticalOnly).toHaveLength(1);
      expect(criticalOnly[0].type).toBe("ci_failure");
    });

    it("clearHistory removes all entries", async () => {
      await router.route(makeNotification());
      router.clearHistory();
      expect(router.getHistory()).toHaveLength(0);
    });
  });
});
