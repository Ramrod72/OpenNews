"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * All personalization (bookmarks, followed/hidden topics, saved searches)
 * lives entirely in the browser's localStorage — there is no account
 * system and nothing is sent to the server. This keeps the app usable with
 * zero backend state and no tracking, per the project's privacy goals.
 * The architecture doesn't preclude adding optional accounts + sync later;
 * this hook would simply become the local cache layer for that.
 */
const listeners = new Map<string, Set<() => void>>();

function emit(key: string) {
  listeners.get(key)?.forEach((fn) => fn());
}

function readValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function useLocalStorage<T>(
  key: string,
  fallback: T,
): [T, (updater: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onStoreChange);

      const onStorage = (e: StorageEvent) => {
        if (e.key === key) onStoreChange();
      };
      window.addEventListener("storage", onStorage);

      return () => {
        set!.delete(onStoreChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => JSON.stringify(readValue(key, fallback)), [key, fallback]);
  const getServerSnapshot = useCallback(() => JSON.stringify(fallback), [fallback]);

  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const value = JSON.parse(raw) as T;

  const setValue = useCallback(
    (updater: T | ((prev: T) => T)) => {
      const current = readValue(key, fallback);
      const next = typeof updater === "function" ? (updater as (prev: T) => T)(current) : updater;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // localStorage unavailable (private browsing, quota) — fail silently, in-memory state is lost on reload
      }
      emit(key);
    },
    [key, fallback],
  );

  return [value, setValue];
}
