"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { setAdminKey } from "@/lib/admin-key"
import { api, ApiError } from "@/lib/api"

/** Checks the key against the API before keeping it for this browser tab. */
export function KeyForm() {
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1>Store admin</h1>
        </CardTitle>
        <CardDescription>
          Enter the admin key (ADMIN_KEY on the API). It is kept only for this
          browser tab.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            const key = String(new FormData(e.currentTarget).get("key") ?? "")
            setPending(true)
            setError("")
            try {
              await api("/admin/orders?limit=1", key)
              setAdminKey(key)
            } catch (err) {
              setError(
                (err as ApiError).status === 401
                  ? "That key was rejected. Check ADMIN_KEY on the API and try again."
                  : (err as Error).message
              )
              input.current?.focus()
            } finally {
              setPending(false)
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="admin-key">Admin key</Label>
            <Input
              ref={input}
              id="admin-key"
              name="key"
              type="password"
              autoComplete="off"
              required
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "admin-key-error" : undefined}
            />
            {error && (
              <p
                id="admin-key-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Checking…" : "Open admin"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
