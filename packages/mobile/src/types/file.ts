/**
 * File Types for the Saqr Mobile App.
 *
 * Defines file tree entries and git status for the file explorer.
 *
 * @module types/file
 */

/** Git status for a file in the workspace. */
export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "ignored"
  | "clean";

/** A file or directory entry in the remote workspace tree. */
export interface FileEntry {
  /** File or directory name. */
  name: string;
  /** Path relative to workspace root. */
  path: string;
  /** Whether this is a file or directory. */
  type: "file" | "directory";
  /** Size in bytes (files only). */
  size?: number;
  /** ISO 8601 last modified timestamp. */
  modifiedAt?: string;
  /** Git status for this file. */
  gitStatus?: GitFileStatus;
  /** Children for directories (loaded on expand). */
  children?: FileEntry[];
}
