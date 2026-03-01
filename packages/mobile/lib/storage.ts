import type { StateStorage } from "zustand/middleware";

/**
 * AsyncStorage-backed Zustand persistence adapter.
 *
 * Uses a simple in-memory Map as a fallback when AsyncStorage is not
 * available (e.g., in vitest). In the real app, replace the backing
 * store with @react-native-async-storage/async-storage.
 */

const memoryStore = new Map<string, string>();

export const zustandStorage: StateStorage = {
  getItem: async (key: string): Promise<string | null> => {
    return memoryStore.get(key) ?? null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    memoryStore.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    memoryStore.delete(key);
  },
};

/** Clear all stored data (useful for testing). */
export function clearStorage(): void {
  memoryStore.clear();
}
