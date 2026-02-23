/**
 * Agent Status API — connect to daemon socket for agent status.
 *
 * Provides endpoints for listing running agents, sending prompts,
 * and approving permissions via the daemon's HTTP API.
 */

import http from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentInfo {
  agent_id: string;
  session_id: string;
  project_id: string;
  provider: string;
  state: string;
  started_at: string;
  description?: string;
}

export interface DaemonConnection {
  host: string;
  port: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to the daemon.
 */
async function daemonRequest(
  conn: DaemonConnection,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: conn.host,
      port: conn.port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, data });
        }
      });
    });

    req.on("error", (err: Error) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Daemon request timeout"));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * List running agents from the daemon.
 */
export async function listAgents(conn: DaemonConnection): Promise<AgentInfo[]> {
  try {
    const result = await daemonRequest(conn, "GET", "/api/agents");
    if (result.status === 200 && Array.isArray(result.data)) {
      return result.data as AgentInfo[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Send a prompt to a specific agent.
 */
export async function sendPrompt(
  conn: DaemonConnection,
  agentId: string,
  prompt: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await daemonRequest(
      conn,
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/prompt`,
      JSON.stringify({ prompt }),
    );
    return { success: result.status === 200 };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Approve a permission request for an agent.
 */
export async function approvePermission(
  conn: DaemonConnection,
  agentId: string,
  permissionId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await daemonRequest(
      conn,
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/permissions/${encodeURIComponent(permissionId)}/approve`,
      "{}",
    );
    return { success: result.status === 200 };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
