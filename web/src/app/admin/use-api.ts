"use client"

import { useEffect, useState } from "react"
import { clearAdminKey, useAdminKey } from "@/lib/admin-key"
import { api, ApiError } from "@/lib/api"

type Result<T> = { path: string; run: number; data?: T; error?: string }

/**
 * GET an admin endpoint. Keeps the last data while a reload runs; a 401 forgets the key so the
 * key form shows again.
 */
export function useApi<T>(path: string) {
  const key = useAdminKey()
  const [run, setRun] = useState(0)
  const [result, setResult] = useState<Result<T> | null>(null)

  useEffect(() => {
    if (!key) return
    let live = true
    api<T>(path, key).then(
      (data) => live && setResult({ path, run, data }),
      (error: ApiError) => {
        if (!live) return
        if (error.status === 401) clearAdminKey()
        setResult({ path, run, error: error.message })
      }
    )
    return () => {
      live = false
    }
  }, [path, run, key])

  const same = result?.path === path ? result : null
  return {
    data: same?.data,
    error: same?.error,
    loading: !same || same.run !== run,
    reload: () => setRun((n) => n + 1),
  }
}

/** A POST with its own pending / done / error state. */
export function useAction<T>() {
  const key = useAdminKey()
  const [state, setState] = useState<
    | { status: "idle" | "pending" }
    | { status: "done"; data: T }
    | { status: "error"; error: string }
  >({ status: "idle" })

  async function run(path: string, body: object = {}): Promise<boolean> {
    if (!key) return false
    setState({ status: "pending" })
    try {
      setState({ status: "done", data: await api<T>(path, key, body) })
      return true
    } catch (error) {
      if ((error as ApiError).status === 401) clearAdminKey()
      setState({ status: "error", error: (error as Error).message })
      return false
    }
  }
  return { ...state, run }
}
