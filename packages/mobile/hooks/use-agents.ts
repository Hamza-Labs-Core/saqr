import { useQuery } from "@tanstack/react-query";
import type { AgentSummary } from "../src/types/agent.js";
import { ApiClient } from "../lib/api-client.js";
import { TIMING } from "../lib/constants.js";

/**
 * React Query hook for fetching the agent list from a daemon.
 * Polls every 5 seconds when enabled.
 */
export function useAgents(serverId: string, baseUrl: string) {
  const client = new ApiClient(baseUrl);

  return useQuery({
    queryKey: ["agents", serverId],
    queryFn: ({ signal }) =>
      client.get<AgentSummary[]>("/api/agents", { signal }),
    refetchInterval: TIMING.agentPollInterval,
    enabled: !!serverId && !!baseUrl,
  });
}
