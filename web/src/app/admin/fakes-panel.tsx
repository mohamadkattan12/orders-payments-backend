"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { DataState } from "./states"
import { StatusBadge } from "./status-badge"
import type { FakeMode } from "./types"
import { useAction, useApi } from "./use-api"

// What each fake can do (spec amendment 14). The fakes enforce it; this only hides impossible choices.
const ALLOWED: Record<string, string[]> = {
  fakepay: [
    "ok",
    "down",
    "response_lost",
    "webhook_lost",
    "duplicate",
    "out_of_order",
    "slow",
  ],
  erp: ["ok", "down", "flaky", "duplicate"],
  courier: ["ok", "flaky", "duplicate", "out_of_order"],
  einvoice: ["ok", "down", "flaky"],
}
const LABEL: Record<string, string> = {
  fakepay: "FakePay (payments)",
  erp: "ERP",
  courier: "Courier",
  einvoice: "E-invoicing portal",
}

function ModeForm({
  current,
  onChanged,
}: {
  current: FakeMode
  onChanged: () => void
}) {
  const [mode, setMode] = useState(current.mode)
  const [failCount, setFailCount] = useState(String(current.failCount || 3))
  const [delayMs, setDelayMs] = useState(String(current.delayMs || 2000))
  const action = useAction<FakeMode>()
  const id = `mode-${current.system}`

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
      onSubmit={async (e) => {
        e.preventDefault()
        const body = {
          mode,
          ...(mode === "flaky" ? { failCount: Number(failCount) } : {}),
          ...(mode === "slow" ? { delayMs: Number(delayMs) } : {}),
        }
        if (await action.run(`/admin/fakes/${current.system}/mode`, body))
          onChanged()
      }}
    >
      <div className="min-w-40 flex-1 space-y-1">
        <p className="text-sm font-medium">
          {LABEL[current.system] ?? current.system}
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          Now: <StatusBadge status={current.mode} />
          {current.mode === "flaky" && `${current.failCount} failures left`}
          {current.mode === "slow" && `${current.delayMs} ms`}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={id}>Mode</Label>
        <NativeSelect
          id={id}
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          {(ALLOWED[current.system] ?? [current.mode]).map((m) => (
            <NativeSelectOption key={m} value={m}>
              {m.replaceAll("_", " ")}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {mode === "flaky" && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-fails`}>Fail first</Label>
          <Input
            id={`${id}-fails`}
            name="failCount"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            required
            className="w-24"
            value={failCount}
            onChange={(e) => setFailCount(e.target.value)}
          />
        </div>
      )}
      {mode === "slow" && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-delay`}>Delay (ms)</Label>
          <Input
            id={`${id}-delay`}
            name="delayMs"
            type="number"
            inputMode="numeric"
            min={0}
            max={60000}
            required
            className="w-28"
            value={delayMs}
            onChange={(e) => setDelayMs(e.target.value)}
          />
        </div>
      )}
      <Button type="submit" disabled={action.status === "pending"}>
        {action.status === "pending" ? "Applying…" : "Apply"}
      </Button>
      <p aria-live="polite" className="basis-full text-xs empty:hidden">
        {action.status === "done" && (
          <span className="text-muted-foreground">
            Applied: {action.data.mode.replaceAll("_", " ")}.
          </span>
        )}
        {action.status === "error" && (
          <span className="text-destructive">{action.error}</span>
        )}
      </p>
    </form>
  )
}

export function FakesPanel() {
  const modes = useApi<FakeMode[]>("/admin/fakes/modes")
  return (
    <div className="space-y-3">
      <DataState
        {...modes}
        isEmpty={(d) => d.length === 0}
        empty="The fakes service reported no systems."
      >
        {(data) => (
          <div className="grid gap-3">
            {data.map((m) => (
              <ModeForm key={m.system} current={m} onChanged={modes.reload} />
            ))}
          </div>
        )}
      </DataState>
    </div>
  )
}
