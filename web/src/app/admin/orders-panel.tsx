"use client"

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
import { sar, when } from "@/lib/format"
import { DataState } from "./states"
import { StatusBadge } from "./status-badge"
import { ORDER_STATUSES, type Order, type Page } from "./types"
import { useApi } from "./use-api"
import { useUrlState } from "./url-state"

const PAGE_SIZE = 20

export function OrdersPanel({
  selected,
  onSelect,
}: {
  selected: string | null
  onSelect: (id: string) => void
}) {
  const url = useUrlState()
  const status = (ORDER_STATUSES as readonly string[]).includes(
    url.get("status")
  )
    ? url.get("status")
    : ""
  const page = Math.max(0, Math.floor(Number(url.get("page")) || 0))
  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
    ...(status ? { status } : {}),
  })
  const orders = useApi<Page<Order>>(`/admin/orders?${query}`)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="status-filter">Status</Label>
          <NativeSelect
            id="status-filter"
            value={status}
            onChange={(e) => url.set({ status: e.target.value, page: "" })}
          >
            <NativeSelectOption value="">All statuses</NativeSelectOption>
            {ORDER_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {s.replaceAll("_", " ")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button
          variant="outline"
          onClick={orders.reload}
          disabled={orders.loading}
        >
          {orders.loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <DataState
        {...orders}
        isEmpty={(d) => d.items.length === 0}
        empty={
          status
            ? `No ${status.replaceAll("_", " ")} orders. Pick another status to see more.`
            : "No orders yet. Orders appear here after a checkout (POST /orders)."
        }
      >
        {(data) => (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-end">Total</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((o) => (
                  <TableRow
                    key={o.id}
                    data-state={o.id === selected ? "selected" : undefined}
                  >
                    <TableCell>{when(o.createdAt)}</TableCell>
                    <TableCell className="max-w-48 truncate">
                      <bdi>{o.customerName}</bdi>, {o.city}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {sar(o.totalHalalas)}
                    </TableCell>
                    <TableCell className="text-end">
                      <Button
                        size="sm"
                        variant={o.id === selected ? "default" : "outline"}
                        aria-pressed={o.id === selected}
                        aria-label={`Show timeline of order ${o.id.slice(0, 8)}`}
                        onClick={() => onSelect(o.id)}
                      >
                        Timeline
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <nav
              aria-label="Orders pages"
              className="flex items-center justify-between gap-2 text-sm text-muted-foreground"
            >
              <span>
                {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + data.items.length} of{" "}
                {data.total}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() =>
                    url.set({ page: page > 1 ? String(page - 1) : "" })
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE_SIZE >= data.total}
                  onClick={() => url.set({ page: String(page + 1) })}
                >
                  Next
                </Button>
              </span>
            </nav>
          </>
        )}
      </DataState>
    </div>
  )
}
