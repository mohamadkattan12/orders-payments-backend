"use client"

import { Button } from "@/components/ui/button"
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
import type { Page, StockAdjustment } from "./types"
import { useApi } from "./use-api"

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

export function StockPanel() {
  const adjustments = useApi<Page<StockAdjustment>>(
    "/admin/stock-adjustments?limit=50"
  )
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        onClick={adjustments.reload}
        disabled={adjustments.loading}
      >
        {adjustments.loading ? "Refreshing…" : "Refresh"}
      </Button>
      <DataState
        {...adjustments}
        isEmpty={(d) => d.items.length === 0}
        empty="No stock adjustments yet. They appear when the ERP sends a stock.adjusted webhook."
      >
        {(data) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-end">Requested</TableHead>
                <TableHead className="text-end">Applied</TableHead>
                <TableHead className="text-end">Shortfall</TableHead>
                <TableHead>ERP adjustment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{when(a.createdAt)}</TableCell>
                  <TableCell className="max-w-56 truncate">
                    <code className="font-mono text-xs">{a.sku}</code>{" "}
                    {a.nameEn}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {signed(a.delta)}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {signed(a.applied)}
                  </TableCell>
                  <TableCell
                    className={
                      a.shortfall > 0
                        ? "text-end font-medium text-destructive tabular-nums"
                        : "text-end tabular-nums"
                    }
                  >
                    {a.shortfall > 0 ? `${a.shortfall} short` : "0"}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{a.adjustmentId}</code>
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
