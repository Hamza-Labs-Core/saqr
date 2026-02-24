// paths.mjs -- Base path resolution and directory helpers for the projection engine.
// All path construction flows through getBasePath() which respects CLAUDE_CONTEXT_PATH (M-4).
import path from 'node:path';
import os from 'node:os';

/**
 * Returns the base path for the GlobalContext data directory.
 * Respects CLAUDE_CONTEXT_PATH env var (review issue M-4).
 */
export function getBasePath() {
  return process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), '.claude-context');
}

/**
 * Returns the events directory for a given project and session.
 * Layout: {base}/events/{projectId}/{sessionId}
 * (Amendment 3: project-id directory layer)
 */
export function getEventsDir(projectId, sessionId) {
  if (!projectId || !sessionId) {
    throw new Error('getEventsDir requires both projectId and sessionId');
  }
  return path.join(getBasePath(), 'events', projectId, sessionId);
}

/**
 * Returns the projections directory for a given project and session.
 * Layout: {base}/projections/{projectId}/{sessionId}
 */
export function getProjectionsDir(projectId, sessionId) {
  if (!projectId || !sessionId) {
    throw new Error('getProjectionsDir requires both projectId and sessionId');
  }
  return path.join(getBasePath(), 'projections', projectId, sessionId);
}

/**
 * Returns the per-project latest symlink path.
 * Layout: {base}/projections/{projectId}/latest
 */
export function getLatestSymlink(projectId) {
  if (!projectId) {
    throw new Error('getLatestSymlink requires projectId');
  }
  return path.join(getBasePath(), 'projections', projectId, 'latest');
}
