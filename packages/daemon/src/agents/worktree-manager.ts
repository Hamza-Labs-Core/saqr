/**
 * Git worktree manager for agent process isolation.
 *
 * Each agent session can run in its own git worktree, providing
 * filesystem and branch isolation without cloning the repository.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { WorktreeFailedError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch name used in the worktree */
  branchName: string;
  /** Absolute path to the main repository */
  projectPath: string;
  /** HEAD commit hash at worktree creation */
  commitHash: string;
}

export interface WorktreeCreateOptions {
  /** Main repository path */
  projectPath: string;
  /** Branch to create in the worktree */
  branchName: string;
  /** Branch to fork from (default: HEAD) */
  baseBranch?: string;
}

export interface WorktreeRemoveOptions {
  /** Force removal even if dirty (default: true) */
  force?: boolean;
}

export class WorktreeManager {
  /**
   * Check if a path is a git repository.
   */
  async isGitRepo(dirPath: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--git-dir"], {
        cwd: dirPath,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new git worktree.
   *
   * @returns WorktreeInfo for the created worktree
   * @throws WorktreeFailedError if creation fails
   */
  async createWorktree(options: WorktreeCreateOptions): Promise<WorktreeInfo> {
    const { projectPath, branchName, baseBranch } = options;

    if (!(await this.isGitRepo(projectPath))) {
      throw new WorktreeFailedError(
        `"${projectPath}" is not a git repository`,
      );
    }

    // Determine worktree path: {projectPath}/../.agent-worktrees/{branchName}
    const worktreeBase = path.resolve(projectPath, "..", ".agent-worktrees");
    // Flatten branch name for directory (replace / with -)
    const dirName = branchName.replace(/\//g, "-");
    const worktreePath = path.join(worktreeBase, dirName);

    try {
      // Try creating with a new branch
      const baseRef = baseBranch || "HEAD";
      await execFileAsync(
        "git",
        ["worktree", "add", "-b", branchName, worktreePath, baseRef],
        { cwd: projectPath },
      );
    } catch (err: unknown) {
      // If the branch already exists, try attaching to existing branch
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("already exists") &&
        message.includes("branch")
      ) {
        try {
          await execFileAsync(
            "git",
            ["worktree", "add", worktreePath, branchName],
            { cwd: projectPath },
          );
        } catch (innerErr) {
          throw new WorktreeFailedError(
            innerErr instanceof Error ? innerErr.message : String(innerErr),
          );
        }
      } else {
        throw new WorktreeFailedError(message);
      }
    }

    // Get the HEAD commit hash of the new worktree
    let commitHash = "unknown";
    try {
      const result = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: worktreePath },
      );
      commitHash = result.stdout.trim();
    } catch {
      // Non-fatal: just use "unknown"
    }

    return {
      path: worktreePath,
      branchName,
      projectPath,
      commitHash,
    };
  }

  /**
   * Remove a git worktree.
   */
  async removeWorktree(
    worktreePath: string,
    options: WorktreeRemoveOptions = {},
  ): Promise<void> {
    const { force = true } = options;
    // Determine the main repo by going up from the worktree
    // We find the main repo from worktree's git metadata
    try {
      const args = ["worktree", "remove", worktreePath];
      if (force) {
        args.push("--force");
      }
      // Find the main repo path from worktree
      const { stdout: gitDir } = await execFileAsync(
        "git",
        ["rev-parse", "--git-common-dir"],
        { cwd: worktreePath },
      );
      const mainGitDir = gitDir.trim();
      // The main repo is the parent of the .git directory
      const mainRepoPath = path.resolve(worktreePath, mainGitDir, "..");
      await execFileAsync("git", args, { cwd: mainRepoPath });
    } catch (err) {
      throw new WorktreeFailedError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * List all worktrees for a git repository.
   */
  async listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
    if (!(await this.isGitRepo(projectPath))) {
      return [];
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: projectPath },
      );

      const worktrees: WorktreeInfo[] = [];
      const blocks = stdout.split("\n\n").filter((b) => b.trim());

      for (const block of blocks) {
        const lines = block.split("\n");
        let wtPath = "";
        let branch = "";
        let commit = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            wtPath = line.substring("worktree ".length);
          } else if (line.startsWith("branch ")) {
            branch = line.substring("branch ".length);
            // Strip refs/heads/ prefix
            if (branch.startsWith("refs/heads/")) {
              branch = branch.substring("refs/heads/".length);
            }
          } else if (line.startsWith("HEAD ")) {
            commit = line.substring("HEAD ".length);
          }
        }

        if (wtPath) {
          worktrees.push({
            path: wtPath,
            branchName: branch,
            projectPath,
            commitHash: commit,
          });
        }
      }

      return worktrees;
    } catch (err) {
      throw new WorktreeFailedError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
