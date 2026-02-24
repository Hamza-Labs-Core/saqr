/**
 * SSE (Server-Sent Events) stream implementation.
 *
 * Watches for new events in the event store by polling the filesystem
 * (no chokidar dependency). Broadcasts new events to all connected clients.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readEvents } from "./events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEClient {
  id: number;
  res: ServerResponse;
  projectId: string;
  sessionId: string;
  lastSeq: number;
  alive: boolean;
}

export interface SSEManager {
  clients: SSEClient[];
  addClient: (req: IncomingMessage, res: ServerResponse, projectId: string, sessionId: string, fromSeq: number) => SSEClient;
  removeClient: (client: SSEClient) => void;
  broadcast: (projectId: string, sessionId: string, data: string) => void;
  startPolling: () => void;
  stopPolling: () => void;
  clientCount: () => number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let nextClientId = 1;

export function createSSEManager(
  eventsDir: string,
  pollIntervalMs = 2000,
  heartbeatIntervalMs = 30000,
): SSEManager {
  const clients: SSEClient[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function addClient(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    sessionId: string,
    fromSeq: number,
  ): SSEClient {
    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });

    if (res.socket) {
      res.socket.setNoDelay(true);
    }
    res.flushHeaders();

    // Send initial keepalive comment
    res.write(":ok\n\n");

    const client: SSEClient = {
      id: nextClientId++,
      res,
      projectId,
      sessionId,
      lastSeq: fromSeq,
      alive: true,
    };

    clients.push(client);

    req.on("close", () => {
      client.alive = false;
      removeClient(client);
    });

    return client;
  }

  function removeClient(client: SSEClient) {
    client.alive = false;
    const idx = clients.indexOf(client);
    if (idx >= 0) clients.splice(idx, 1);
  }

  function broadcast(projectId: string, sessionId: string, data: string) {
    for (const client of clients) {
      if (!client.alive) continue;
      if (client.projectId === projectId && client.sessionId === sessionId) {
        try {
          client.res.write(`data: ${data}\n\n`);
        } catch {
          client.alive = false;
        }
      }
    }
  }

  async function pollForNewEvents() {
    // Group clients by project/session
    const grouped = new Map<string, SSEClient[]>();
    for (const client of clients) {
      if (!client.alive) continue;
      const key = `${client.projectId}:${client.sessionId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(client);
    }

    for (const [, groupClients] of grouped) {
      const { projectId, sessionId } = groupClients[0];
      // Find the minimum lastSeq for this group
      const minSeq = Math.min(...groupClients.map((c) => c.lastSeq));

      try {
        const events = await readEvents(eventsDir, {
          projectId,
          sessionId,
          fromSequence: minSeq,
        });

        for (const event of events) {
          for (const client of groupClients) {
            if (!client.alive) continue;
            if (event.sequence > client.lastSeq) {
              try {
                client.res.write(`data: ${JSON.stringify(event)}\n\n`);
                client.lastSeq = event.sequence;
              } catch {
                client.alive = false;
              }
            }
          }
        }
      } catch {
        /* ignore polling errors */
      }
    }

    // Clean up dead clients
    for (let i = clients.length - 1; i >= 0; i--) {
      if (!clients[i].alive) clients.splice(i, 1);
    }
  }

  function sendHeartbeats() {
    for (const client of clients) {
      if (!client.alive) continue;
      try {
        client.res.write(":heartbeat\n\n");
      } catch {
        client.alive = false;
      }
    }
  }

  function startPolling() {
    if (!pollTimer) {
      pollTimer = setInterval(pollForNewEvents, pollIntervalMs);
    }
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(sendHeartbeats, heartbeatIntervalMs);
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clientCount(): number {
    return clients.filter((c) => c.alive).length;
  }

  return {
    clients,
    addClient,
    removeClient,
    broadcast,
    startPolling,
    stopPolling,
    clientCount,
  };
}
