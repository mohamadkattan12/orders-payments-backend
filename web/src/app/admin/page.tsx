import type { Metadata } from "next"
import { Suspense } from "react"
import { AdminApp } from "./admin-app"
import { Loading } from "./states"

export const metadata: Metadata = { title: "Store admin" }

// Client-only: the admin key lives in sessionStorage and every call carries it from the browser.
export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-4 py-6">
          <Loading rows={6} />
        </main>
      }
    >
      <AdminApp />
    </Suspense>
  )
}
