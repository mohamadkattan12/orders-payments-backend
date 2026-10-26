-- CreateTable
CREATE TABLE "idempotent_requests" (
    "system" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotent_requests_pkey" PRIMARY KEY ("system","key")
);

-- CreateTable
CREATE TABLE "system_modes" (
    "system" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ok',
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "delayMs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_modes_pkey" PRIMARY KEY ("system")
);

-- CreateTable
CREATE TABLE "charges" (
    "id" TEXT NOT NULL,
    "merchantReference" TEXT NOT NULL,
    "amountHalalas" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_refunds" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "merchantReference" TEXT NOT NULL,
    "amountHalalas" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_records" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erp_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_shipments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courier_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_invoices" (
    "clearanceId" TEXT NOT NULL,
    "invoiceUuid" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_invoices_pkey" PRIMARY KEY ("clearanceId")
);

-- CreateTable
CREATE TABLE "outgoing_webhooks" (
    "id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "sendAfter" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outgoing_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "charges_merchantReference_key" ON "charges"("merchantReference");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_refunds_merchantReference_key" ON "gateway_refunds"("merchantReference");

-- CreateIndex
CREATE UNIQUE INDEX "portal_invoices_invoiceUuid_key" ON "portal_invoices"("invoiceUuid");

-- CreateIndex
CREATE INDEX "outgoing_webhooks_sentAt_sendAfter_idx" ON "outgoing_webhooks"("sentAt", "sendAfter");

-- AddForeignKey
ALTER TABLE "gateway_refunds" ADD CONSTRAINT "gateway_refunds_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
