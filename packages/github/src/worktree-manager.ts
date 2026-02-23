/**
 * WorktreeManager - Git worktree operations for agent work.
 *
 * Creates, lists, and removes git worktrees. Tracks which agent
 * is using each worktree and detects conflicts between worktrees
 * on the same repository.
 *
 * @module worktree-manager
 */

import type {
  Worktree,
  WorktreeConflict,
  GitCommandRunner,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default Git Command Runner
// ---------------------------------------------------------------------------

/**
 * Default implementation using child_process.
 */
class DefaultGitRunner implements GitCommandRunner {
  async run(args: string[], cwd: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  }
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

/**
 * Manages git worktrees for agent-based parallel work.
 *
 * Each agent gets its own worktree so multiple agents can work
 * on the same repository in parallel without interference.
 */
export class WorktreeManager {
  private readonly git: GitCommandRunner;
  private readonly worktrees = new Map<string, Worktree>();

  constructor(gitRunner?: GitCommandRunner) {
    this.git = gitRunner ?? new DefaultGitRunner();
  }

  /**
   * Create a worktree from a branch for agent work.
   *
   * @param repoPath - Path to the main repository.
   * @param branch - Branch name to check out in the worktree.
   * @param options - Optional configuration.
   * @returns The created worktree metadata.
   */
  async create(
    repoPath: string,
    branch: string,
    options: {
      baseBranch?: string;
      agentId?: string;
      worktreeBase?: string;
    } = {},
  ): Promise<Worktree> {
    const { resolve, join, basename } = await import("node:path");
    const fs = await import("node:fs/promises");

    const resolvedRepo = resolve(repoPath);
    const base =
      options.worktreeBase ??
      join(resolve(resolvedRepo, ".."), ".agent-worktrees");

    // Ensure base directory exists
    await fs.mkdir(base, { recursive: true });

    // Generate a unique worktree directory name
    const safeBranch = branch.replace(/\//g, "-");
    const worktreePath = join(base, `${basename(resolvedRepo)}-${safeBranch}-${Date.now()}`);

    // Create the worktree
    if (options.baseBranch) {
      // Create new branch from the specified base
      await this.git.run(
        ["worktree", "add", "-b", branch, worktreePath, options.baseBranch],
        resolvedRepo,
      );
    } else {
      // Try to create a new branch; if it exists, just check it out
      try {
        await this.git.run(
          ["worktree", "add", "-b", branch, worktreePath],
          resolvedRepo,
        );
      } catch (error) {
        // Branch may already exist - try checking it out directly
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          await this.git.run(
            ["worktree", "add", worktreePath, branch],
            resolvedRepo,
          );
        } else {
          throw error;
        }
      }
    }

    const worktree: Worktree = {
      path: worktreePath,
      branch,
      repoPath: resolvedRepo,
      agentId: options.agentId,
      createdAt: new Date(),
    };

    this.worktrees.set(worktreePath, worktree);
    return worktree;
  }

  /**
   * List all active worktrees for a repository.
   *
   * @param repoPath - Path to the main repository.
   * @returns Array of worktree metadata.
   */
  async list(repoPath: string): Promise<Worktree[]> {
    const { resolve } = await import("node:path");
    const resolvedRepo = resolve(repoPath);

    let output: string;
    try {
      output = await this.git.run(
        ["worktree", "list", "--porcelain"],
        resolvedRepo,
      );
    } catch {
      return [];
    }

    const worktrees: Worktree[] = [];
    const entries = output.split("\n\n").filter((e) => e.trim());

    for (const entry of entries) {
      const lines = entry.split("\n");
      let path = "";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        }
        if (line.startsWith("branch ")) {
          // Branch format: refs/heads/branch-name
          branch = line.slice("branch ".length).replace("refs/heads/", "");
        }
      }

      if (path) {
        // Check if we have agent tracking info
        const tracked = this.worktrees.get(path);
        worktrees.push({
          path,
          branch: branch || "HEAD",
          repoPath: resolvedRepo,
          agentId: tracked?.agentId,
          createdAt: tracked?.createdAt ?? new Date(),
        });
      }
    }

    return worktrees;
  }

  /**
   * Remove a worktree after agent completes.
   *
   * @param worktreePath - Path to the worktree to remove.
   * @param force - Force removal even if there are changes.
   */
  async remove(worktreePath: string, force: boolean = false): Promise<void> {
    const { resolve } = await import("node:path");
    const resolvedPath = resolve(worktreePath);

    // Get the repo path from our tracking, or try to find it
    const tracked = this.worktrees.get(resolvedPath);
    let repoPath: string;

    if (tracked) {
      repoPath = tracked.repoPath;
    } else {
      // Try to get the main worktree from inside this worktree
      try {
        const output = await this.git.run(
          ["rev-parse", "--git-common-dir"],
          resolvedPath,
        );
        const { dirname } = await import("node:path");
        repoPath = dirname(output.trim());
      } catch {
        throw new Error(`Cannot determine repository for worktree: ${resolvedPath}`);
      }
    }

    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(resolvedPath);

    await this.git.run(args, repoPath);
    this.worktrees.delete(resolvedPath);
  }

  /**
   * Detect conflicts between worktrees on the same repo.
   *
   * Two worktrees conflict if they are both modifying the same files.
   *
   * @param repoPath - Path to the main repository.
   * @returns Array of detected conflicts.
   */
  async detectConflicts(repoPath: string): Promise<WorktreeConflict[]> {
    const worktrees = await this.list(repoPath);
    const conflicts: WorktreeConflict[] = [];

    // Get modified files for each worktree
    const modifiedFilesMap = new Map<string, string[]>();

    for (const wt of worktrees) {
      try {
        const output = await this.git.run(
          ["diff", "--name-only", "HEAD"],
          wt.path,
        );
        const files = output
          .trim()
          .split("\n")
          .filter((f) => f.length > 0);
        if (files.length > 0) {
          modifiedFilesMap.set(wt.path, files);
        }
      } catch {
        // Skip worktrees we can't access
      }
    }

    // Compare each pair of worktrees
    const paths = Array.from(modifiedFilesMap.keys());
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const files1 = modifiedFilesMap.get(paths[i])!;
        const files2 = modifiedFilesMap.get(paths[j])!;

        const overlapping = files1.filter((f) => files2.includes(f));
        if (overlapping.length > 0) {
          conflicts.push({
            worktreePath1: paths[i],
            worktreePath2: paths[j],
            conflictingFiles: overlapping,
            description: `Worktrees are both modifying: ${overlapping.join(", ")}`,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Assign an agent to a worktree.
   *
   * @param worktreePath - Path to the worktree.
   * @param agentId - The agent ID to assign.
   */
  assignAgent(worktreePath: string, agentId: string): void {
    const tracked = this.worktrees.get(worktreePath);
    if (tracked) {
      tracked.agentId = agentId;
    }
  }

  /**
   * Get the worktree assigned to an agent.
   *
   * @param agentId - The agent ID to look up.
   * @returns The worktree, or undefined if not found.
   */
  getWorktreeForAgent(agentId: string): Worktree | undefined {
    for (const wt of this.worktrees.values()) {
      if (wt.agentId === agentId) {
        return wt;
      }
    }
    return undefined;
  }
}

export type { Worktree, WorktreeConflict };
