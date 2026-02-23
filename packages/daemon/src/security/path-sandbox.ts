/**
 * PathSandbox — Restrict daemon file access to approved directories.
 *
 * Prevents path traversal attacks, symlink escapes, and null byte injection.
 * The daemon should only access files within explicitly allowed base paths
 * (e.g., home directory, project directories, event store).
 *
 * @module security/path-sandbox
 */

import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Error thrown when a path violates the sandbox rules.
 */
export class PathViolationError extends Error {
  /** The offending path that was rejected */
  readonly violatingPath: string;
  /** Human-readable reason for rejection */
  readonly reason: string;

  constructor(violatingPath: string, reason: string) {
    super(`Path violation: ${reason} — "${violatingPath}"`);
    this.name = "PathViolationError";
    this.violatingPath = violatingPath;
    this.reason = reason;
  }
}

/**
 * Configuration for the path sandbox.
 */
export interface PathSandboxConfig {
  /** Allowed base directories. Access is permitted only under these paths. */
  allowedPaths: string[];

  /** Whether to follow and validate symlinks (default: true) */
  resolveSymlinks?: boolean;
}

/**
 * PathSandbox restricts file system access to a set of allowed base directories.
 *
 * It validates paths by:
 * 1. Checking for null bytes (injection attack)
 * 2. Resolving to absolute path
 * 3. Normalizing to remove `.` and `..` components
 * 4. Optionally resolving symlinks to detect symlink escapes
 * 5. Verifying the resolved path falls under an allowed base directory
 */
export class PathSandbox {
  private readonly allowedPaths: string[];
  private readonly resolveSymlinks: boolean;

  constructor(config: PathSandboxConfig) {
    // Normalize and resolve all allowed paths
    this.allowedPaths = config.allowedPaths.map((p) =>
      path.resolve(p),
    );
    this.resolveSymlinks = config.resolveSymlinks ?? true;
  }

  /**
   * Check if a path is allowed within the sandbox.
   *
   * @param targetPath - The path to validate
   * @returns true if the path is within an allowed base directory
   */
  isPathAllowed(targetPath: string): boolean {
    try {
      this.sanitizePath(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize and validate a path, returning the resolved safe path.
   *
   * @param targetPath - The path to sanitize
   * @returns The resolved, validated absolute path
   * @throws PathViolationError if the path is outside the sandbox
   */
  sanitizePath(targetPath: string): string {
    // Check for null bytes (injection attack vector)
    if (targetPath.includes("\0")) {
      throw new PathViolationError(
        targetPath,
        "Path contains null bytes",
      );
    }

    // Check for empty path
    if (!targetPath || targetPath.trim() === "") {
      throw new PathViolationError(
        targetPath,
        "Path is empty",
      );
    }

    // Resolve to absolute and normalize (removes . and ..)
    let resolved = path.resolve(targetPath);

    // If resolving symlinks is enabled, try to resolve them
    if (this.resolveSymlinks) {
      try {
        resolved = fs.realpathSync(resolved);
      } catch {
        // If the path doesn't exist yet, resolve parent directories
        // to detect symlink escapes in the parent chain
        resolved = this.resolveParentChain(resolved);
      }
    }

    // Check if the resolved path falls under any allowed base path
    const isAllowed = this.allowedPaths.some((basePath) =>
      this.isUnderPath(resolved, basePath),
    );

    if (!isAllowed) {
      throw new PathViolationError(
        targetPath,
        `Path resolves to "${resolved}" which is outside allowed directories`,
      );
    }

    return resolved;
  }

  /**
   * Get the list of allowed base paths.
   */
  getAllowedPaths(): readonly string[] {
    return [...this.allowedPaths];
  }

  /**
   * Add a new allowed base path.
   */
  addAllowedPath(basePath: string): void {
    const resolved = path.resolve(basePath);
    if (!this.allowedPaths.includes(resolved)) {
      this.allowedPaths.push(resolved);
    }
  }

  /**
   * Remove an allowed base path.
   */
  removeAllowedPath(basePath: string): boolean {
    const resolved = path.resolve(basePath);
    const idx = this.allowedPaths.indexOf(resolved);
    if (idx >= 0) {
      this.allowedPaths.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Check if `child` is a path under `parent`.
   */
  private isUnderPath(child: string, parent: string): boolean {
    // Ensure parent ends with separator so /home/user doesn't match /home/username
    const parentWithSep = parent.endsWith(path.sep)
      ? parent
      : parent + path.sep;
    return child === parent || child.startsWith(parentWithSep);
  }

  /**
   * Walk up the path chain and resolve symlinks in existing parent directories.
   * For paths where the leaf doesn't exist yet, resolve as far as possible.
   */
  private resolveParentChain(targetPath: string): string {
    const parts = targetPath.split(path.sep);
    let current = parts[0] === "" ? path.sep : parts[0];
    let unresolvedSuffix: string[] = [];

    for (let i = parts[0] === "" ? 1 : 0; i < parts.length; i++) {
      const next = path.join(current, parts[i]);
      try {
        current = fs.realpathSync(next);
      } catch {
        // From here on, just append the remaining parts
        unresolvedSuffix = parts.slice(i);
        break;
      }
    }

    if (unresolvedSuffix.length > 0) {
      return path.join(current, ...unresolvedSuffix);
    }

    return current;
  }
}
