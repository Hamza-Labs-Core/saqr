/**
 * HTTP client with retry logic for daemon API calls.
 *
 * Retries up to 2 times with exponential backoff on server errors (5xx)
 * and network failures.
 */
export class ApiClient {
  constructor(private baseUrl: string) {}

  async get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "GET",
      signal: options?.signal,
    });
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "DELETE",
    });
    return response.json() as Promise<T>;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries = 2,
    delay = 1000,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok) return response;
        if (response.status >= 500 && attempt < retries) {
          await this.sleep(delay * Math.pow(2, attempt));
          continue;
        }
        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (attempt === retries) throw error;
        await this.sleep(delay * Math.pow(2, attempt));
      }
    }
    throw new Error("Max retries exceeded");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
