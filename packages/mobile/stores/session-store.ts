import { create } from "zustand";
import { SessionHistoryManager } from "../src/services/session-history-manager.js";
import type { SessionSummary, SessionFilter } from "../src/types/session.js";

interface SessionState {
  sessions: SessionSummary[];
  filter: SessionFilter;
  pageIndex: number;
  hasMore: boolean;
  totalCount: number;

  setSessionsForHost: (hostId: string, sessions: SessionSummary[]) => void;
  removeHost: (hostId: string) => void;
  setFilter: (filter: Partial<SessionFilter>) => void;
  loadPage: (pageIndex: number, pageSize?: number) => void;
  nextPage: (pageSize?: number) => void;
  getSession: (sessionId: string) => SessionSummary | undefined;

  _manager: SessionHistoryManager;
}

export const useSessionStore = create<SessionState>()((set, get) => {
  const manager = new SessionHistoryManager();

  return {
    sessions: [],
    filter: {},
    pageIndex: 0,
    hasMore: false,
    totalCount: 0,
    _manager: manager,

    setSessionsForHost: (hostId: string, sessions: SessionSummary[]) => {
      manager.setSessionsForHost(hostId, sessions);
      const page = manager.getPage(get().pageIndex, 20, get().filter);
      set({
        sessions: page.sessions,
        hasMore: page.hasMore,
        totalCount: page.totalCount,
      });
    },

    removeHost: (hostId: string) => {
      manager.removeHost(hostId);
      const page = manager.getPage(get().pageIndex, 20, get().filter);
      set({
        sessions: page.sessions,
        hasMore: page.hasMore,
        totalCount: page.totalCount,
      });
    },

    setFilter: (filter: Partial<SessionFilter>) => {
      const newFilter = { ...get().filter, ...filter };
      const page = manager.getPage(0, 20, newFilter);
      set({
        filter: newFilter,
        pageIndex: 0,
        sessions: page.sessions,
        hasMore: page.hasMore,
        totalCount: page.totalCount,
      });
    },

    loadPage: (pageIndex: number, pageSize = 20) => {
      const page = manager.getPage(pageIndex, pageSize, get().filter);
      set({
        pageIndex,
        sessions: page.sessions,
        hasMore: page.hasMore,
        totalCount: page.totalCount,
      });
    },

    nextPage: (pageSize = 20) => {
      const { pageIndex, hasMore, filter } = get();
      if (!hasMore) return;
      const nextIdx = pageIndex + 1;
      const page = manager.getPage(nextIdx, pageSize, filter);
      set({
        pageIndex: nextIdx,
        sessions: page.sessions,
        hasMore: page.hasMore,
        totalCount: page.totalCount,
      });
    },

    getSession: (sessionId: string) => {
      return manager.getCachedSession(sessionId);
    },
  };
});
