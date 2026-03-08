/**
 * Tests for the API client.
 *
 * Verifies HTTP methods, retry logic on server errors,
 * and error propagation on client errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, ApiError } from "../../../lib/api-client.js";

describe("ApiClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("GET request returns parsed JSON on success", async () => {
    const mockData = { agents: [{ id: "a1" }] };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const client = new ApiClient("http://localhost:9120");
    const result = await client.get("/api/agents");
    expect(result).toEqual(mockData);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9120/api/agents",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("POST request sends JSON body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const client = new ApiClient("http://localhost:9120");
    await client.post("/api/prompt", { text: "hello" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9120/api/prompt",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
  });

  it("retries on 500 error up to 2 times", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return { ok: false, status: 500, statusText: "Internal Server Error" };
      }
      return { ok: true, json: () => Promise.resolve({ ok: true }) };
    });

    const client = new ApiClient("http://localhost:9120");
    const promise = client.get("/api/test");

    // Advance through the retry delays
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(3); // 1 initial + 2 retries
    vi.useRealTimers();
  });

  it("throws ApiError on 4xx without retrying", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const client = new ApiClient("http://localhost:9120");
    await expect(client.get("/api/missing")).rejects.toThrow(ApiError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // No retry for 4xx
  });

  it("retries on network error and verifies call count", async () => {
    // Test that fetch is called 3 times (initial + 2 retries)
    // by checking call count after partial execution.
    // We use a mock that succeeds on the 3rd call to avoid unhandled rejections.
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("Network error");
      }
      return { ok: true, json: () => Promise.resolve({ recovered: true }) };
    });

    vi.useFakeTimers();
    const client = new ApiClient("http://localhost:9120");
    const promise = client.get("/api/test");

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toEqual({ recovered: true });
    expect(callCount).toBe(3); // 1 initial + 2 retries, 3rd succeeds
    vi.useRealTimers();
  });

  it("DELETE request works correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    });

    const client = new ApiClient("http://localhost:9120");
    const result = await client.delete("/api/item/1");
    expect(result).toEqual({ deleted: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9120/api/item/1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
