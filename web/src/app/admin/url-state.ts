"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

/** Filters and pages live in the URL so a reload or a shared link keeps them. */
export function useUrlState() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  return {
    get: (name: string) => params.get(name) ?? "",
    set: (changes: Record<string, string>) => {
      const next = new URLSearchParams(params.toString())
      for (const [name, value] of Object.entries(changes))
        if (value) next.set(name, value)
        else next.delete(name)
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      })
    },
  }
}
