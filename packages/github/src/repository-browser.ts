/**
 * RepositoryBrowser - Repository listing and search with caching.
 *
 * Provides methods to list accessible repositories, search by name/topic,
 * list branches, and browse file trees. Includes in-memory cache with TTL.
 *
 * @module repository-browser
 */

import type {
  GitHubApiClient,
  Repository,
  Branch,
  PaginatedResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Cache Implementation
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class TTLCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.store.clear();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get size(): number {
    // Purge expired entries before returning size
    for (const [key, entry] of this.store) {
      if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
      }
    }
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// File Tree Types
// ---------------------------------------------------------------------------

/**
 * Represents an entry in a repository file tree.
 */
export interface FileTreeEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size?: number;
  sha: string;
}

// ---------------------------------------------------------------------------
// RepositoryBrowser
// ---------------------------------------------------------------------------

/**
 * Browse GitHub repositories, branches, and file trees.
 *
 * All API responses are cached in memory with a configurable TTL
 * (default 5 minutes) to minimize API calls.
 */
export class RepositoryBrowser {
  private readonly apiClient: GitHubApiClient;
  private readonly cache: TTLCache;

  constructor(apiClient: GitHubApiClient, cacheTtlMs?: number) {
    this.apiClient = apiClient;
    this.cache = new TTLCache(cacheTtlMs);
  }

  /**
   * List repositories accessible to the authenticated user.
   *
   * @param page - Page number (1-indexed).
   * @param perPage - Number of results per page (max 100).
   * @returns Paginated list of repositories.
   */
  async listRepositories(
    page: number = 1,
    perPage: number = 30,
  ): Promise<PaginatedResponse<Repository>> {
    const cacheKey = `repos:${page}:${perPage}`;
    const cached = this.cache.get<PaginatedResponse<Repository>>(cacheKey);
    if (cached) return cached;

    const repos = await this.apiClient.get<
      Array<{
        id: number;
        name: string;
        full_name: string;
        owner: { login: string };
        description: string | null;
        private: boolean;
        default_branch: string;
        clone_url: string;
        ssh_url: string;
        topics: string[];
        language: string | null;
        updated_at: string;
      }>
    >("/user/repos", {
      page: String(page),
      per_page: String(perPage),
      sort: "updated",
    });

    const items = repos.map(mapApiRepo);
    const result: PaginatedResponse<Repository> = {
      items,
      totalCount: items.length,
      hasNextPage: items.length === perPage,
      nextPage: items.length === perPage ? page + 1 : null,
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Search repositories by name and/or topic filters.
   *
   * @param query - Search query string.
   * @param options - Optional topic and language filters.
   * @returns Paginated search results.
   */
  async searchRepositories(
    query: string,
    options: {
      topic?: string;
      language?: string;
      page?: number;
      perPage?: number;
    } = {},
  ): Promise<PaginatedResponse<Repository>> {
    const { topic, language, page = 1, perPage = 30 } = options;
    const cacheKey = `search:${query}:${topic ?? ""}:${language ?? ""}:${page}:${perPage}`;
    const cached = this.cache.get<PaginatedResponse<Repository>>(cacheKey);
    if (cached) return cached;

    let q = query;
    if (topic) q += ` topic:${topic}`;
    if (language) q += ` language:${language}`;

    const response = await this.apiClient.get<{
      total_count: number;
      items: Array<{
        id: number;
        name: string;
        full_name: string;
        owner: { login: string };
        description: string | null;
        private: boolean;
        default_branch: string;
        clone_url: string;
        ssh_url: string;
        topics: string[];
        language: string | null;
        updated_at: string;
      }>;
    }>("/search/repositories", {
      q,
      page: String(page),
      per_page: String(perPage),
    });

    const items = response.items.map(mapApiRepo);
    const result: PaginatedResponse<Repository> = {
      items,
      totalCount: response.total_count,
      hasNextPage: items.length === perPage,
      nextPage: items.length === perPage ? page + 1 : null,
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * List branches for a repository.
   *
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @returns Array of branches.
   */
  async listBranches(owner: string, repo: string): Promise<Branch[]> {
    const cacheKey = `branches:${owner}/${repo}`;
    const cached = this.cache.get<Branch[]>(cacheKey);
    if (cached) return cached;

    const branches = await this.apiClient.get<
      Array<{
        name: string;
        commit: { sha: string };
        protected: boolean;
      }>
    >(`/repos/${owner}/${repo}/branches`);

    const result: Branch[] = branches.map((b) => ({
      name: b.name,
      sha: b.commit.sha,
      protected: b.protected,
    }));

    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Browse the file tree of a repository at a given path.
   *
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param treeSha - The tree SHA or branch name (default: HEAD).
   * @returns Array of file tree entries.
   */
  async getFileTree(
    owner: string,
    repo: string,
    treeSha: string = "HEAD",
  ): Promise<FileTreeEntry[]> {
    const cacheKey = `tree:${owner}/${repo}:${treeSha}`;
    const cached = this.cache.get<FileTreeEntry[]>(cacheKey);
    if (cached) return cached;

    const response = await this.apiClient.get<{
      tree: Array<{
        path: string;
        type: string;
        size?: number;
        sha: string;
      }>;
    }>(`/repos/${owner}/${repo}/git/trees/${treeSha}`, {
      recursive: "1",
    });

    const entries: FileTreeEntry[] = response.tree.map((entry) => ({
      path: entry.path,
      type: mapTreeType(entry.type),
      size: entry.size,
      sha: entry.sha,
    }));

    this.cache.set(cacheKey, entries);
    return entries;
  }

  /**
   * Clear the entire cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (after purging expired entries).
   */
  get cacheSize(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapApiRepo(raw: {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  clone_url: string;
  ssh_url: string;
  topics: string[];
  language: string | null;
  updated_at: string;
}): Repository {
  return {
    id: raw.id,
    name: raw.name,
    fullName: raw.full_name,
    owner: raw.owner.login,
    description: raw.description,
    private: raw.private,
    defaultBranch: raw.default_branch,
    cloneUrl: raw.clone_url,
    sshUrl: raw.ssh_url,
    topics: raw.topics ?? [],
    language: raw.language,
    updatedAt: raw.updated_at,
  };
}

function mapTreeType(
  type: string,
): "file" | "dir" | "symlink" | "submodule" {
  switch (type) {
    case "blob":
      return "file";
    case "tree":
      return "dir";
    case "commit":
      return "submodule";
    default:
      return "file";
  }
}

export type { Repository, Branch };
