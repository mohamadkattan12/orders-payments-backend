"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { clearAdminKey, useAdminKey } from "@/lib/admin-key"
import { DeliveriesPanel } from "./deliveries-panel"
import { FakesPanel } from "./fakes-panel"
import { KeyForm } from "./key-form"
import { OrdersPanel } from "./orders-panel"
import { StockPanel } from "./stock-panel"
import { TimelinePanel } from "./timeline-panel"

function Panel({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 overflow-x-auto">{children}</CardContent>
    </Card>
  )
}

export function AdminApp() {
  const key = useAdminKey()
  // Kept out of the URL: an order id is the customer's capability for that order.
  const [selected, setSelected] = useState<string | null>(null)
  const timelineHeading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (selected) timelineHeading.current?.focus()
  }, [selected])

  if (!key) return <KeyForm />

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Store admin</h1>
        <Button variant="outline" onClick={clearAdminKey}>
          Forget key
        </Button>
      </header>

      <Panel title="Orders" description="Newest first. Prices include 15% VAT.">
        <OrdersPanel selected={selected} onSelect={setSelected} />
      </Panel>

      {selected && (
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>
              <h2 ref={timelineHeading} tabIndex={-1} className="outline-none">
                Order timeline
              </h2>
            </CardTitle>
            <CardDescription>
              Payments, webhooks, outbox events, deliveries, shipment and
              invoices for one order.
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 overflow-x-auto">
            <TimelinePanel
              orderId={selected}
              onClose={() => setSelected(null)}
            />
          </CardContent>
        </Card>
      )}

      <Panel
        title="Deliveries"
        description="Dead letters gave up after 8 attempts; Replay starts them again. Blocked ones wait on a dead predecessor."
      >
        <DeliveriesPanel onSelectOrder={setSelected} />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Fake systems"
          description="Failure modes of the fake external systems."
        >
          <FakesPanel />
        </Panel>
        <Panel
          title="Stock adjustments"
          description="Corrections from the ERP. A shortfall is stock the ERP removed that was already sold or reserved."
        >
          <StockPanel />
        </Panel>
      </div>
    </main>
  )
}
