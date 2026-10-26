import { Injectable } from '@nestjs/common';
import { CALL_TIMEOUT_MS, config } from '../common/config.js';
import { apiError } from '../common/errors.js';
import { DeliveryService } from '../outbox/delivery.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  DeliveriesQuery,
  ModeDto,
  OrdersQuery,
  PageQuery,
} from './admin.dto.js';

/** Read models for the operator page, plus replay and the fakes' mode switches. */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: DeliveryService,
  ) {}

  async orders({ status, limit, offset }: OrdersQuery) {
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Everything that happened to one order, grouped by kind and time-ordered within each group.
   * Grouped rather than one merged list: a delivery changes over time (attempts, last error), so a
   * single timestamp per row would misstate it; each row keeps all of its own timestamps instead.
   */
  async timeline(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: { orderBy: { sku: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' }, include: { refund: true } },
        shipment: true,
        invoices: { orderBy: { issuedAt: 'asc' } },
      },
    });
    if (!order) throw apiError(404, 'order_not_found', 'No such order.');
    const { payments, shipment, invoices, ...rest } = order;
    const refunds = payments.flatMap((p) => (p.refund ? [p.refund] : []));
    // FakePay webhooks name our payment or refund id; courier webhooks name the order.
    const refs = [...payments.map((p) => p.id), ...refunds.map((r) => r.id)];
    const [webhooks, outboxEvents, deliveries] = await Promise.all([
      this.prisma.$queryRaw`
        SELECT id, source, "eventId", type, status, error, payload, "receivedAt"
        FROM inbound_webhooks
        WHERE payload->'data'->>'merchantReference' = ANY(${refs}::text[])
           OR payload->'data'->>'orderId' = ${id}
        ORDER BY "receivedAt"`,
      this.prisma.outboxEvent.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.delivery.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      order: rest,
      payments: payments.map(({ refund: _refund, ...p }) => p),
      refunds,
      webhooks,
      outboxEvents,
      deliveries,
      shipment,
      invoices,
    };
  }

  async deliveryList({ status, limit, offset }: DeliveriesQuery) {
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.delivery.count({ where }),
    ]);
    return { items, total };
  }

  async replay(id: string) {
    const exists = await this.prisma.delivery.count({ where: { id } });
    if (!exists) throw apiError(404, 'delivery_not_found', 'No such delivery.');
    if (!(await this.deliveries.replay(id)))
      throw apiError(
        409,
        'delivery_not_dead',
        'Only dead deliveries can be replayed.',
      );
    return { replayed: true };
  }

  async stockAdjustments({ limit, offset }: PageQuery) {
    const [rows, total] = await Promise.all([
      this.prisma.stockAdjustment.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
        include: { product: { select: { sku: true, nameEn: true } } },
      }),
      this.prisma.stockAdjustment.count(),
    ]);
    return {
      items: rows.map(({ product, ...a }) => ({ ...a, ...product })),
      total,
    };
  }

  fakeModes() {
    return this.control('');
  }

  setFakeMode(system: string, dto: ModeDto) {
    return this.control(`/${system}`, dto);
  }

  /** Calls the fakes' control API with the control key, which never leaves the server. */
  private async control(path: string, body?: object): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${config.fakesUrl()}/control${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Control-Key': config.fakesControlKey(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      throw apiError(
        502,
        'fakes_unavailable',
        `The fake systems did not answer: ${String((error as Error)?.message ?? error)}`,
      );
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    if (res.ok) return json;
    // A 400 is the operator's request (e.g. a mode that system can't have); 403 means our key is wrong.
    if (res.status === 400)
      throw apiError(
        400,
        json.error ?? 'invalid_mode',
        String(json.message ?? 'Rejected by the fake systems.'),
      );
    throw apiError(
      502,
      'fakes_unavailable',
      `The fake systems answered HTTP ${res.status}.`,
    );
  }
}
