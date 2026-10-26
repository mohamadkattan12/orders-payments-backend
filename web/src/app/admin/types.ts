// Shapes returned by the admin API (api/src/admin). Dates arrive as ISO strings.

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "cancelled",
  "expired",
  "refunded",
] as const
export const DELIVERY_STATUSES = [
  "dead",
  "blocked",
  "pending",
  "delivered",
] as const

export type Page<T> = { items: T[]; total: number }

export type Order = {
  id: string
  status: (typeof ORDER_STATUSES)[number]
  customerName: string
  customerPhone: string
  city: string
  subtotalHalalas: number
  vatHalalas: number
  totalHalalas: number
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export type Delivery = {
  id: string
  eventId: string
  orderId: string
  eventType: string
  destination: string
  status: (typeof DELIVERY_STATUSES)[number]
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  externalRef: string | null
  createdAt: string
  updatedAt: string
}

export type Timeline = {
  order: Order & {
    items: {
      id: string
      sku: string
      qty: number
      unitPriceHalalas: number
      lineTotalHalalas: number
      lineVatHalalas: number
    }[]
  }
  payments: {
    id: string
    providerPaymentId: string | null
    status: string
    amountHalalas: number
    failureReason: string | null
    createdAt: string
    updatedAt: string
  }[]
  refunds: {
    id: string
    paymentId: string
    status: string
    amountHalalas: number
    reason: string
    createdAt: string
    updatedAt: string
  }[]
  webhooks: {
    id: string
    source: string
    eventId: string
    type: string
    status: string
    error: string | null
    receivedAt: string
  }[]
  outboxEvents: {
    id: string
    type: string
    createdAt: string
    publishedAt: string | null
  }[]
  deliveries: Delivery[]
  shipment: {
    courierShipmentId: string
    status: string
    updatedAt: string
  } | null
  invoices: {
    id: string
    number: number
    kind: string
    totalHalalas: number
    vatHalalas: number
    clearanceId: string | null
    issuedAt: string
  }[]
}

export type StockAdjustment = {
  id: string
  adjustmentId: string
  sku: string
  nameEn: string
  delta: number
  applied: number
  shortfall: number
  createdAt: string
}

export type FakeMode = {
  system: string
  mode: string
  failCount: number
  delayMs: number
}
