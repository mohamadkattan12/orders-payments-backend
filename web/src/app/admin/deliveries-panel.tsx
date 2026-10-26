"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { when } from "@/lib/format"
import { DataState } from "./states"
import { StatusBadge } from "./status-badge"
import { DELIVERY_STATUSES, type Delivery, type Page } from "./types"
import { useAction, useApi } from "./use-api"
import { useUrlState } from "./url-state"

function ReplayButton({
  delivery,
  onReplayed,
}: {
  delivery: Delivery
  onReplayed: () => void
}) {
  const replay = useAction<{ replayed: true }>()
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={replay.status === "pending"}
        aria-label={`Replay ${delivery.eventType} to ${delivery.destination}`}
        onClick={async () => {
          if (await replay.run(`/admin/deliveries/${delivery.id}/replay`))
            onReplayed()
        }}
      >
        {replay.status === "pending" ? "Replaying…" : "Replay"}
      </Button>
      {replay.status === "error" && (
        <span role="alert" className="text-xs text-destructive">
          {replay.error}
        </span>
      )}
    </span>
  )
}

/** Dead letters by default; other statuses (e.g. blocked) for diagnosis. */
export function DeliveriesPanel({
  onSelectOrder,
}: {
  onSelectOrder: (id: string) => void
}) {
  const url = useUrlState()
  const status = (DELIVERY_STATUSES as readonly string[]).includes(
    url.get("deliveries")
  )
    ? url.get("deliveries")
    : "dead"
  const deliveries = useApi<Page<Delivery>>(
    `/admin/deliveries?status=${status}&limit=50`
  )
  const [notice, setNotice] = useState("")

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="delivery-filter">Status</Label>
          <NativeSelect
            id="delivery-filter"
            value={status}
            onChange={(e) =>
              url.set({
                deliveries: e.target.value === "dead" ? "" : e.target.value,
              })
            }
          >
            {DELIVERY_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {s === "dead" ? "dead letters" : s}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button
          variant="outline"
          onClick={deliveries.reload}
          disabled={deliveries.loading}
        >
          {deliveries.loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {notice}
      </p>
      <DataState
        {...deliveries}
        isEmpty={(d) => d.items.length === 0}
        empty={
          status === "dead"
            ? "No dead letters. A delivery lands here after 8 failed attempts."
            : `No ${status} deliveries.`
        }
      >
        {(data) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Updated</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-end">Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{when(d.updatedAt)}</TableCell>
                  <TableCell>{d.destination}</TableCell>
                  <TableCell>{d.eventType}</TableCell>
                  <TableCell>
                    <StatusBadge status={d.status} />
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {d.attempts}
                  </TableCell>
                  <TableCell
                    className="max-w-64 truncate"
                    title={d.lastError ?? undefined}
                  >
                    {d.lastError ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      size="sm"
                      className="px-0 font-mono text-xs"
                      aria-label={`Show timeline of order ${d.orderId.slice(0, 8)}`}
                      onClick={() => onSelectOrder(d.orderId)}
                    >
                      {d.orderId.slice(0, 8)}
                    </Button>
                  </TableCell>
                  <TableCell className="text-end">
                    {d.status === "dead" && (
                      <ReplayButton
                        delivery={d}
                        onReplayed={() => {
                          setNotice(
                            `Replayed ${d.eventType} to ${d.destination}. The worker delivers it from attempt 1.`
                          )
                          deliveries.reload()
                        }}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataState>
    </div>
  )
}
