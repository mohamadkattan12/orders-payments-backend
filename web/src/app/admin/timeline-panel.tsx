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
import { sar, when } from "@/lib/format"
import { DataState } from "./states"
import { StatusBadge } from "./status-badge"
import type { Timeline } from "./types"
import { useApi } from "./use-api"

/** One kind of record; every row keeps its own timestamps (the API groups by kind). */
function Section({
  title,
  headers,
  rows,
}: {
  title: string
  headers: string[]
  rows: React.ReactNode[][]
}) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((cells, i) => (
              <TableRow key={i}>
                {cells.map((c, j) => (
                  <TableCell
                    key={j}
                    className="max-w-64 truncate"
                    title={typeof c === "string" ? c : undefined}
                  >
                    {c}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

const mono = (s: string | null) =>
  s ? <code className="font-mono text-xs">{s}</code> : "—"

export function TimelinePanel({
  orderId,
  onClose,
}: {
  orderId: string
  onClose: () => void
}) {
  const timeline = useApi<Timeline>(`/admin/orders/${orderId}/timeline`)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">Order {mono(orderId)}</p>
        <span className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={timeline.reload}
            disabled={timeline.loading}
          >
            {timeline.loading ? "Refreshing…" : "Refresh"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close timeline
          </Button>
        </span>
      </div>
      <DataState {...timeline} isEmpty={() => false} empty={null}>
        {(t) => (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge status={t.order.status} />
              </dd>
              <dt className="text-muted-foreground">Total (VAT incl.)</dt>
              <dd className="tabular-nums">{sar(t.order.totalHalalas)}</dd>
              <dt className="text-muted-foreground">VAT</dt>
              <dd className="tabular-nums">{sar(t.order.vatHalalas)}</dd>
              <dt className="text-muted-foreground">Customer</dt>
              <dd>
                <bdi>{t.order.customerName}</bdi>, {t.order.city}
              </dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{when(t.order.createdAt)}</dd>
              <dt className="text-muted-foreground">Expires</dt>
              <dd>{when(t.order.expiresAt)}</dd>
            </dl>
            <Section
              title="Items"
              headers={["SKU", "Qty", "Unit price", "Line total", "Line VAT"]}
              rows={t.order.items.map((i) => [
                mono(i.sku),
                i.qty,
                sar(i.unitPriceHalalas),
                sar(i.lineTotalHalalas),
                sar(i.lineVatHalalas),
              ])}
            />
            <Section
              title="Payments"
              headers={[
                "Created",
                "Status",
                "Amount",
                "Provider id",
                "Failure",
                "Updated",
              ]}
              rows={t.payments.map((p) => [
                when(p.createdAt),
                <StatusBadge key="s" status={p.status} />,
                sar(p.amountHalalas),
                mono(p.providerPaymentId),
                p.failureReason ?? "—",
                when(p.updatedAt),
              ])}
            />
            <Section
              title="Refunds"
              headers={["Created", "Status", "Amount", "Reason", "Updated"]}
              rows={t.refunds.map((r) => [
                when(r.createdAt),
                <StatusBadge key="s" status={r.status} />,
                sar(r.amountHalalas),
                r.reason,
                when(r.updatedAt),
              ])}
            />
            <Section
              title="Inbound webhooks"
              headers={["Received", "Source", "Type", "Result", "Event id"]}
              rows={t.webhooks.map((w) => [
                when(w.receivedAt),
                w.source,
                w.type,
                <span key="s" className="flex items-center gap-1">
                  <StatusBadge status={w.status} />
                  {w.error}
                </span>,
                mono(w.eventId),
              ])}
            />
            <Section
              title="Outbox events"
              headers={["Created", "Type", "Published"]}
              rows={t.outboxEvents.map((e) => [
                when(e.createdAt),
                e.type,
                when(e.publishedAt),
              ])}
            />
            <Section
              title="Deliveries"
              headers={[
                "Created",
                "Destination",
                "Event",
                "Status",
                "Attempts",
                "Last error",
                "External ref",
                "Updated",
              ]}
              rows={t.deliveries.map((d) => [
                when(d.createdAt),
                d.destination,
                d.eventType,
                <StatusBadge key="s" status={d.status} />,
                d.attempts,
                d.lastError ?? "—",
                mono(d.externalRef),
                when(d.updatedAt),
              ])}
            />
            <Section
              title="Shipment"
              headers={["Courier shipment", "Status", "Updated"]}
              rows={
                t.shipment
                  ? [
                      [
                        mono(t.shipment.courierShipmentId),
                        t.shipment.status.replaceAll("_", " "),
                        when(t.shipment.updatedAt),
                      ],
                    ]
                  : []
              }
            />
            <Section
              title="Invoices"
              headers={[
                "Issued",
                "Number",
                "Kind",
                "Total",
                "VAT",
                "Clearance id",
              ]}
              rows={t.invoices.map((i) => [
                when(i.issuedAt),
                i.number,
                i.kind.replaceAll("_", " "),
                sar(i.totalHalalas),
                sar(i.vatHalalas),
                mono(i.clearanceId),
              ])}
            />
          </div>
        )}
      </DataState>
    </div>
  )
}
