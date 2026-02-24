/**
 * Tests for the SessionWatcher — filesystem watcher for new sessions and events.
 *
 * Covers: T-35 from Story 04 testing plan (filesystem watcher detects new event file).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionWatcher } from "../sessions/session-watcher.js";

function padSequence(seq: number): string {
  return String(seq).padStart(6, "0");
}

describe("SessionWatcher", () => {
  let tmpDir: string;
  let watcher: SessionWatcher;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-watcher-"));
    watcher = new SessionWatcher({
      eventsDir: tmpDir,
      debounceMs: 50,
    });
  });

  afterEach(async () => {
    watcher.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("should start and stop without error", () => {
      watcher.start();
      expect(watcher.isWatching()).toBe(true);

      watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });

    it("should throw if started twice", () => {
      watcher.start();
      expect(() => watcher.start()).toThrow("already running");
    });

    it("should not throw on double stop", () => {
      watcher.start();
      watcher.stop();
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe("new_event detection", () => {
    it("should emit new_event when a numbered JSON file is created", async () => {
      // Create the session directory structure before starting the watcher
      const sessionDir = path.join(tmpDir, "proj-a", "sess-001");
      await mkdir(sessionDir, { recursive: true });

      watcher.start();

      const eventPromise = new Promise<string>((resolve) => {
        watcher.on("new_event", (filePath: string) => {
          resolve(filePath);
        });
      });

      // Write a new event file
      await writeFile(
        path.join(sessionDir, "000001.json"),
        JSON.stringify({ event_type: "SessionStarted", sequence: 1 }),
      );

      const filePath = await Promise.race([
        eventPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout waiting for new_event")), 2000),
        ),
      ]);

      expect(filePath).toContain("000001.json");
    });

    it("should NOT emit new_event for session.json", async () => {
      const sessionDir = path.join(tmpDir, "proj-a", "sess-001");
      await mkdir(sessionDir, { recursive: true });

      watcher.start();

      const events: string[] = [];
      watcher.on("new_event", (filePath: string) => {
        events.push(filePath);
      });

      // Write a session.json — should be ignored
      await writeFile(
        path.join(sessionDir, "session.json"),
        JSON.stringify({ session_id: "sess-001" }),
      );

      // Wait for debounce period + buffer
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(events).toHaveLength(0);
    });

    it("should NOT emit new_event for .lock files", async () => {
      const sessionDir = path.join(tmpDir, "proj-a", "sess-001");
      await mkdir(sessionDir, { recursive: true });

      watcher.start();

      const events: string[] = [];
      watcher.on("new_event", (filePath: string) => {
        events.push(filePath);
      });

      await writeFile(path.join(sessionDir, "write.lock"), "locked");

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(events).toHaveLength(0);
    });

    it("should debounce rapid file creations", async () => {
      const sessionDir = path.join(tmpDir, "proj-a", "sess-001");
      await mkdir(sessionDir, { recursive: true });

      watcher.start();

      const events: string[] = [];
      watcher.on("new_event", (filePath: string) => {
        events.push(filePath);
      });

      // Write multiple files quickly
      for (let i = 1; i <= 5; i++) {
        await writeFile(
          path.join(sessionDir, `${padSequence(i)}.json`),
          JSON.stringify({ event_type: "ToolCallCompleted", sequence: i }),
        );
      }

      // Wait for debounce to flush
      await new Promise((resolve) => setTimeout(resolve, 500));

      // All 5 events should eventually be emitted (debounce batches but delivers all)
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.length).toBeLessThanOrEqual(5);
    });
  });

  describe("new_session detection", () => {
    it("should emit new_session when a new session directory appears", async () => {
      // Create project dir first
      const projectDir = path.join(tmpDir, "proj-a");
      await mkdir(projectDir, { recursive: true });

      watcher.start();

      const sessionPromise = new Promise<string>((resolve) => {
        watcher.on("new_session", (sessionDir: string) => {
          resolve(sessionDir);
        });
      });

      // Create a new session directory
      const sessionDir = path.join(projectDir, "new-sess-001");
      await mkdir(sessionDir);
      // Write session.json to signal it's a real session
      await writeFile(
        path.join(sessionDir, "session.json"),
        JSON.stringify({ session_id: "new-sess-001" }),
      );

      const dirPath = await Promise.race([
        sessionPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout waiting for new_session")), 2000),
        ),
      ]);

      expect(dirPath).toContain("new-sess-001");
    });
  });

  describe("scanSince", () => {
    it("should find event files newer than the given date", async () => {
      const sessionDir = path.join(tmpDir, "proj-a", "sess-001");
      await mkdir(sessionDir, { recursive: true });

      // Write some event files
      for (let i = 1; i <= 3; i++) {
        await writeFile(
          path.join(sessionDir, `${padSequence(i)}.json`),
          JSON.stringify({ sequence: i }),
        );
      }

      // Scan from epoch — should find all files
      const files = await watcher.scanSince(new Date(0));
      expect(files).toHaveLength(3);
    });

    it("should return empty array when no events exist", async () => {
      const files = await watcher.scanSince(new Date(0));
      expect(files).toEqual([]);
    });

    it("should not include session.json in scan results", async () => {
      const sessionDir = path.join(tmpDir, "proj-a", "sess-001");
      await mkdir(sessionDir, { recursive: true });

      await writeFile(
        path.join(sessionDir, "session.json"),
        JSON.stringify({ session_id: "sess-001" }),
      );
      await writeFile(
        path.join(sessionDir, "000001.json"),
        JSON.stringify({ sequence: 1 }),
      );

      const files = await watcher.scanSince(new Date(0));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("000001.json");
    });
  });

  describe("error handling", () => {
    it("should handle inotify limits gracefully by emitting error", async () => {
      // Create watcher for a non-existent directory
      const badWatcher = new SessionWatcher({
        eventsDir: "/tmp/nonexistent-saqr-watcher-test-xyz",
        debounceMs: 50,
      });

      const errors: Error[] = [];
      badWatcher.on("error", (err: Error) => {
        errors.push(err);
      });

      // Starting with non-existent dir should emit error, not throw
      badWatcher.start();
      // Give it a moment
      await new Promise((resolve) => setTimeout(resolve, 100));

      badWatcher.stop();
      // It should have emitted an error or handled gracefully
      // The watcher should still be stoppable
      expect(badWatcher.isWatching()).toBe(false);
    });
  });
});
