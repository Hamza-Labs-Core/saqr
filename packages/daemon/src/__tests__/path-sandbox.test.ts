/**
 * Tests for PathSandbox — path validation and traversal prevention.
 *
 * Uses real temp directories to test symlink handling.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  PathSandbox,
  PathViolationError,
} from "../security/path-sandbox.js";

describe("PathSandbox", () => {
  let tmpDir: string;
  let allowedDir: string;
  let sandbox: PathSandbox;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-sandbox-test-"));
    allowedDir = path.join(tmpDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    sandbox = new PathSandbox({
      allowedPaths: [allowedDir],
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Basic path validation
  // -------------------------------------------------------------------------

  describe("isPathAllowed", () => {
    it("should allow paths within allowed directory", () => {
      expect(sandbox.isPathAllowed(path.join(allowedDir, "file.txt"))).toBe(
        true,
      );
    });

    it("should allow the allowed directory itself", () => {
      expect(sandbox.isPathAllowed(allowedDir)).toBe(true);
    });

    it("should allow nested paths within allowed directory", () => {
      expect(
        sandbox.isPathAllowed(path.join(allowedDir, "sub", "dir", "file.txt")),
      ).toBe(true);
    });

    it("should reject paths outside allowed directory", () => {
      expect(sandbox.isPathAllowed("/etc/passwd")).toBe(false);
    });

    it("should reject parent directory of allowed path", () => {
      expect(sandbox.isPathAllowed(tmpDir)).toBe(false);
    });

    it("should reject paths that share a prefix but are not under allowed dir", () => {
      // e.g., if allowed is /tmp/allowed, reject /tmp/allowed-extra
      const sneakyPath = allowedDir + "-extra";
      expect(sandbox.isPathAllowed(sneakyPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Path traversal prevention
  // -------------------------------------------------------------------------

  describe("traversal prevention", () => {
    it("should block .. traversal", () => {
      const traversal = path.join(allowedDir, "..", "outside");
      expect(sandbox.isPathAllowed(traversal)).toBe(false);
    });

    it("should block deep .. traversal", () => {
      const traversal = path.join(
        allowedDir,
        "sub",
        "..",
        "..",
        "..",
        "etc",
        "passwd",
      );
      expect(sandbox.isPathAllowed(traversal)).toBe(false);
    });

    it("should normalize . components", async () => {
      await writeFile(path.join(allowedDir, "file.txt"), "test");
      const dotPath = path.join(allowedDir, ".", "file.txt");
      expect(sandbox.isPathAllowed(dotPath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Null byte injection
  // -------------------------------------------------------------------------

  describe("null byte injection", () => {
    it("should reject paths with null bytes", () => {
      expect(() =>
        sandbox.sanitizePath(allowedDir + "/file.txt\0.jpg"),
      ).toThrow(PathViolationError);
    });

    it("should reject paths with embedded null bytes", () => {
      expect(() =>
        sandbox.sanitizePath(allowedDir + "/\0malicious"),
      ).toThrow(PathViolationError);
    });

    it("should include 'null bytes' in the error reason", () => {
      try {
        sandbox.sanitizePath("test\0path");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PathViolationError);
        expect((e as PathViolationError).reason).toContain("null bytes");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Empty and invalid paths
  // -------------------------------------------------------------------------

  describe("empty and invalid paths", () => {
    it("should reject empty string", () => {
      expect(() => sandbox.sanitizePath("")).toThrow(PathViolationError);
    });

    it("should reject whitespace-only string", () => {
      expect(() => sandbox.sanitizePath("   ")).toThrow(PathViolationError);
    });
  });

  // -------------------------------------------------------------------------
  // Symlink handling
  // -------------------------------------------------------------------------

  describe("symlink handling", () => {
    it("should detect symlink escape outside sandbox", async () => {
      const outsideDir = path.join(tmpDir, "outside");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(path.join(outsideDir, "secret.txt"), "secret");

      // Create symlink inside allowed dir pointing outside
      const linkPath = path.join(allowedDir, "escape-link");
      await symlink(outsideDir, linkPath);

      // The symlink resolves outside the sandbox
      expect(sandbox.isPathAllowed(path.join(linkPath, "secret.txt"))).toBe(
        false,
      );
    });

    it("should allow symlinks that stay within sandbox", async () => {
      const subDir = path.join(allowedDir, "subdir");
      await mkdir(subDir, { recursive: true });
      await writeFile(path.join(subDir, "data.txt"), "data");

      // Create symlink within allowed dir pointing to subdir
      const linkPath = path.join(allowedDir, "internal-link");
      await symlink(subDir, linkPath);

      expect(sandbox.isPathAllowed(path.join(linkPath, "data.txt"))).toBe(
        true,
      );
    });

    it("should work with symlinks disabled", async () => {
      const noSymlinkSandbox = new PathSandbox({
        allowedPaths: [allowedDir],
        resolveSymlinks: false,
      });

      // Without symlink resolution, the path looks allowed
      const outsideDir = path.join(tmpDir, "outside");
      await mkdir(outsideDir, { recursive: true });
      const linkPath = path.join(allowedDir, "link");
      await symlink(outsideDir, linkPath);

      // With symlinks disabled, it just checks the literal path
      // which is inside the allowed dir
      expect(
        noSymlinkSandbox.isPathAllowed(path.join(linkPath, "file.txt")),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // sanitizePath
  // -------------------------------------------------------------------------

  describe("sanitizePath", () => {
    it("should return the resolved path for valid paths", async () => {
      await writeFile(path.join(allowedDir, "valid.txt"), "data");

      const result = sandbox.sanitizePath(
        path.join(allowedDir, "valid.txt"),
      );
      expect(result).toBe(path.join(allowedDir, "valid.txt"));
    });

    it("should throw PathViolationError for invalid paths", () => {
      expect(() => sandbox.sanitizePath("/etc/shadow")).toThrow(
        PathViolationError,
      );
    });

    it("PathViolationError should contain the violating path", () => {
      try {
        sandbox.sanitizePath("/etc/shadow");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PathViolationError);
        expect((e as PathViolationError).violatingPath).toBe("/etc/shadow");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Multiple allowed paths
  // -------------------------------------------------------------------------

  describe("multiple allowed paths", () => {
    it("should allow paths under any of the allowed directories", async () => {
      const secondAllowed = path.join(tmpDir, "second-allowed");
      await mkdir(secondAllowed, { recursive: true });

      const multiSandbox = new PathSandbox({
        allowedPaths: [allowedDir, secondAllowed],
      });

      expect(
        multiSandbox.isPathAllowed(path.join(allowedDir, "file1.txt")),
      ).toBe(true);
      expect(
        multiSandbox.isPathAllowed(path.join(secondAllowed, "file2.txt")),
      ).toBe(true);
      expect(multiSandbox.isPathAllowed("/etc/passwd")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Dynamic path management
  // -------------------------------------------------------------------------

  describe("dynamic path management", () => {
    it("should add allowed paths", async () => {
      const newDir = path.join(tmpDir, "new-allowed");
      await mkdir(newDir, { recursive: true });

      expect(sandbox.isPathAllowed(path.join(newDir, "file.txt"))).toBe(false);

      sandbox.addAllowedPath(newDir);
      expect(sandbox.isPathAllowed(path.join(newDir, "file.txt"))).toBe(true);
    });

    it("should remove allowed paths", () => {
      expect(sandbox.isPathAllowed(path.join(allowedDir, "file.txt"))).toBe(
        true,
      );

      const removed = sandbox.removeAllowedPath(allowedDir);
      expect(removed).toBe(true);
      expect(sandbox.isPathAllowed(path.join(allowedDir, "file.txt"))).toBe(
        false,
      );
    });

    it("should return false when removing non-existent path", () => {
      const removed = sandbox.removeAllowedPath("/nonexistent");
      expect(removed).toBe(false);
    });

    it("should not duplicate allowed paths", () => {
      sandbox.addAllowedPath(allowedDir);
      sandbox.addAllowedPath(allowedDir);
      expect(sandbox.getAllowedPaths().length).toBe(1);
    });
  });
});
