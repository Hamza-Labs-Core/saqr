import { useQuery } from "@tanstack/react-query";
import type { SessionSummary } from "../src/types/session.js";
import { ApiClient } from "../lib/api-client.js";
import { TIMING } from "../lib/constants.js";

/**
 * React Query hook for fetching session history from a daemon.
 * Polls every 10 seconds when enabled.
 */
export function useSessions(serverId: string, baseUrl: string) {
  const client = new ApiClient(baseUrl);

  return useQuery({
    queryKey: ["sessions", serverId],
    queryFn: ({ signal }) =>
      client.get<SessionSummary[]>("/api/sessions", { signal }),
    refetchInterval: TIMING.sessionPollInterval,
    enabled: !!serverId && !!baseUrl,
  });
}
