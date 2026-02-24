/**
 * Tests for RepositoryBrowser - repo listing, search, caching.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RepositoryBrowser } from "../repository-browser.js";
import type { GitHubApiClient } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockApiClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } satisfies GitHubApiClient;
}

function makeRepoResponse(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: Math.floor(Math.random() * 100000),
    name,
    full_name: `owner/${name}`,
    owner: { login: "owner" },
    description: `Description of ${name}`,
    private: false,
    default_branch: "main",
    clone_url: `https://github.com/owner/${name}.git`,
    ssh_url: `git@github.com:owner/${name}.git`,
    topics: ["typescript"],
    language: "TypeScript",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RepositoryBrowser", () => {
  let client: ReturnType<typeof createMockApiClient>;
  let browser: RepositoryBrowser;

  beforeEach(() => {
    client = createMockApiClient();
    browser = new RepositoryBrowser(client);
  });

  // -----------------------------------------------------------------------
  // listRepositories
  // -----------------------------------------------------------------------

  describe("listRepositories", () => {
    it("lists repos with pagination params", async () => {
      client.get.mockResolvedValue([
        makeRepoResponse("repo-a"),
        makeRepoResponse("repo-b"),
      ]);

      const result = await browser.listRepositories(1, 30);

      expect(client.get).toHaveBeenCalledWith("/user/repos", {
        page: "1",
        per_page: "30",
        sort: "updated",
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe("repo-a");
      expect(result.items[1].name).toBe("repo-b");
    });

    it("maps API response to Repository type", async () => {
      client.get.mockResolvedValue([
        makeRepoResponse("mapped-repo", {
          description: "A cool repo",
          private: true,
          topics: ["ai", "agents"],
          language: "Rust",
        }),
      ]);

      const result = await browser.listRepositories();
      const repo = result.items[0];

      expect(repo.fullName).toBe("owner/mapped-repo");
      expect(repo.owner).toBe("owner");
      expect(repo.description).toBe("A cool repo");
      expect(repo.private).toBe(true);
      expect(repo.topics).toEqual(["ai", "agents"]);
      expect(repo.language).toBe("Rust");
    });

    it("indicates next page when results fill the page", async () => {
      const repos = Array.from({ length: 30 }, (_, i) =>
        makeRepoResponse(`repo-${i}`),
      );
      client.get.mockResolvedValue(repos);

      const result = await browser.listRepositories(1, 30);

      expect(result.hasNextPage).toBe(true);
      expect(result.nextPage).toBe(2);
    });

    it("indicates no next page when results are fewer than page size", async () => {
      client.get.mockResolvedValue([makeRepoResponse("only-one")]);

      const result = await browser.listRepositories(1, 30);

      expect(result.hasNextPage).toBe(false);
      expect(result.nextPage).toBeNull();
    });

    it("caches results for identical calls", async () => {
      client.get.mockResolvedValue([makeRepoResponse("cached")]);

      await browser.listRepositories(1, 30);
      await browser.listRepositories(1, 30);

      expect(client.get).toHaveBeenCalledOnce();
    });

    it("does not use cache for different pagination params", async () => {
      client.get.mockResolvedValue([makeRepoResponse("page1")]);

      await browser.listRepositories(1, 30);
      await browser.listRepositories(2, 30);

      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // searchRepositories
  // -----------------------------------------------------------------------

  describe("searchRepositories", () => {
    it("searches with query string", async () => {
      client.get.mockResolvedValue({
        total_count: 1,
        items: [makeRepoResponse("search-hit")],
      });

      const result = await browser.searchRepositories("saqr");

      expect(client.get).toHaveBeenCalledWith("/search/repositories", {
        q: "saqr",
        page: "1",
        per_page: "30",
      });
      expect(result.items).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });

    it("appends topic filter to query", async () => {
      client.get.mockResolvedValue({ total_count: 0, items: [] });

      await browser.searchRepositories("agent", { topic: "ai" });

      expect(client.get).toHaveBeenCalledWith("/search/repositories", {
        q: "agent topic:ai",
        page: "1",
        per_page: "30",
      });
    });

    it("appends language filter to query", async () => {
      client.get.mockResolvedValue({ total_count: 0, items: [] });

      await browser.searchRepositories("cli", { language: "TypeScript" });

      expect(client.get).toHaveBeenCalledWith("/search/repositories", {
        q: "cli language:TypeScript",
        page: "1",
        per_page: "30",
      });
    });

    it("combines topic and language filters", async () => {
      client.get.mockResolvedValue({ total_count: 0, items: [] });

      await browser.searchRepositories("saqr", {
        topic: "agents",
        language: "Rust",
      });

      expect(client.get).toHaveBeenCalledWith("/search/repositories", {
        q: "saqr topic:agents language:Rust",
        page: "1",
        per_page: "30",
      });
    });

    it("caches search results", async () => {
      client.get.mockResolvedValue({ total_count: 1, items: [makeRepoResponse("cached")] });

      await browser.searchRepositories("saqr");
      await browser.searchRepositories("saqr");

      expect(client.get).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // listBranches
  // -----------------------------------------------------------------------

  describe("listBranches", () => {
    it("lists branches for a repository", async () => {
      client.get.mockResolvedValue([
        { name: "main", commit: { sha: "abc123" }, protected: true },
        { name: "develop", commit: { sha: "def456" }, protected: false },
      ]);

      const branches = await browser.listBranches("owner", "repo");

      expect(client.get).toHaveBeenCalledWith("/repos/owner/repo/branches");
      expect(branches).toHaveLength(2);
      expect(branches[0]).toEqual({
        name: "main",
        sha: "abc123",
        protected: true,
      });
      expect(branches[1]).toEqual({
        name: "develop",
        sha: "def456",
        protected: false,
      });
    });

    it("caches branch list", async () => {
      client.get.mockResolvedValue([
        { name: "main", commit: { sha: "abc" }, protected: true },
      ]);

      await browser.listBranches("owner", "repo");
      await browser.listBranches("owner", "repo");

      expect(client.get).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // getFileTree
  // -----------------------------------------------------------------------

  describe("getFileTree", () => {
    it("fetches file tree with recursive flag", async () => {
      client.get.mockResolvedValue({
        tree: [
          { path: "src/index.ts", type: "blob", size: 100, sha: "aaa" },
          { path: "src", type: "tree", sha: "bbb" },
          { path: "lib/external", type: "commit", sha: "ccc" },
        ],
      });

      const tree = await browser.getFileTree("owner", "repo", "main");

      expect(client.get).toHaveBeenCalledWith(
        "/repos/owner/repo/git/trees/main",
        { recursive: "1" },
      );
      expect(tree).toHaveLength(3);
      expect(tree[0]).toEqual({
        path: "src/index.ts",
        type: "file",
        size: 100,
        sha: "aaa",
      });
      expect(tree[1]).toEqual({
        path: "src",
        type: "dir",
        size: undefined,
        sha: "bbb",
      });
      expect(tree[2]).toEqual({
        path: "lib/external",
        type: "submodule",
        size: undefined,
        sha: "ccc",
      });
    });

    it("defaults treeSha to HEAD", async () => {
      client.get.mockResolvedValue({ tree: [] });

      await browser.getFileTree("owner", "repo");

      expect(client.get).toHaveBeenCalledWith(
        "/repos/owner/repo/git/trees/HEAD",
        { recursive: "1" },
      );
    });

    it("caches file tree", async () => {
      client.get.mockResolvedValue({ tree: [] });

      await browser.getFileTree("owner", "repo", "main");
      await browser.getFileTree("owner", "repo", "main");

      expect(client.get).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Cache Management
  // -----------------------------------------------------------------------

  describe("cache management", () => {
    it("clearCache clears all cached data", async () => {
      client.get.mockResolvedValue([makeRepoResponse("cached")]);

      await browser.listRepositories();
      expect(browser.cacheSize).toBeGreaterThan(0);

      browser.clearCache();
      expect(browser.cacheSize).toBe(0);

      // Next call should hit the API
      await browser.listRepositories();
      expect(client.get).toHaveBeenCalledTimes(2);
    });

    it("expired cache entries are not returned", async () => {
      // Use a 1ms TTL so entries expire immediately
      const shortTtlBrowser = new RepositoryBrowser(client, 1);
      client.get.mockResolvedValue([makeRepoResponse("quick-expire")]);

      await shortTtlBrowser.listRepositories();

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      await shortTtlBrowser.listRepositories();

      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });
});
