import { useQuery } from "@tanstack/react-query";
import type { UsageStats } from "../src/types/usage.js";
import { ApiClient } from "../lib/api-client.js";
import { TIMING } from "../lib/constants.js";

/**
 * React Query hook for fetching usage data from a daemon.
 * Polls every 30 seconds when enabled.
 */
export function useUsage(serverId: string, baseUrl: string) {
  const client = new ApiClient(baseUrl);

  return useQuery({
    queryKey: ["usage", serverId],
    queryFn: ({ signal }) =>
      client.get<UsageStats>("/api/usage", { signal }),
    refetchInterval: TIMING.usagePollInterval,
    enabled: !!serverId && !!baseUrl,
  });
}
