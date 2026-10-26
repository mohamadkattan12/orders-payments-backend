import { useSyncExternalStore } from "react"

// sessionStorage: typed once per browser tab, gone when it closes, never in the bundle or a URL.
const STORAGE_KEY = "admin-key"
const listeners = new Set<() => void>()
let fallback: string | null = null // used only when storage is blocked

function read(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return fallback
  }
}

function write(value: string | null): void {
  fallback = value
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, value)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage blocked: the key lasts until reload
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const setAdminKey = (key: string) => write(key)
export const clearAdminKey = () => write(null)

/** null on the server and until a key is entered. */
export function useAdminKey(): string | null {
  return useSyncExternalStore(subscribe, read, () => null)
}
