import { Injectable } from '@nestjs/common';
import { CALL_TIMEOUT_MS, config } from '../common/config.js';

export interface ProviderCharge {
  id: string;
  merchantReference: string;
  amountHalalas: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  failureReason: string | null;
}

export interface ProviderRefund {
  id: string;
  chargeId: string;
  merchantReference: string;
  amountHalalas: number;
  status: 'pending' | 'succeeded';
}

/** accepted: the provider has it; refused: it definitely did nothing; unknown: it may or may not. */
export type CallResult<T> =
  | { kind: 'accepted'; value: T }
  | { kind: 'refused'; status: number; error: string }
  | { kind: 'unknown'; error: string };

@Injectable()
export class FakepayClient {
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
    idempotencyKey?: string,
  ): Promise<CallResult<T>> {
    try {
      const res = await fetch(`${config.fakesUrl()}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) return { kind: 'accepted', value: json as T };
      // 5xx and 429 say nothing about whether the provider acted: treat them as unknown.
      if (res.status >= 500 || res.status === 429)
        return { kind: 'unknown', error: `HTTP ${res.status}` };
      return {
        kind: 'refused',
        status: res.status,
        error: json.error ?? `HTTP ${res.status}`,
      };
    } catch (error) {
      return {
        kind: 'unknown',
        error: String((error as Error)?.message ?? error),
      };
    }
  }

  /** Our payment id is both the idempotency key and the merchant reference. */
  createCharge(paymentId: string, amountHalalas: number, token: string) {
    return this.call<ProviderCharge>(
      'POST',
      '/fakepay/charges',
      { amountHalalas, currency: 'SAR', token, merchantReference: paymentId },
      paymentId,
    );
  }

  findCharge(paymentId: string) {
    return this.call<ProviderCharge>(
      'GET',
      `/fakepay/charges?merchant_reference=${encodeURIComponent(paymentId)}`,
    );
  }

  /** Our refund id is both the idempotency key and the merchant reference. */
  createRefund(refundId: string, chargeId: string, amountHalalas: number) {
    return this.call<ProviderRefund>(
      'POST',
      '/fakepay/refunds',
      { chargeId, amountHalalas, merchantReference: refundId },
      refundId,
    );
  }

  findRefund(refundId: string) {
    return this.call<ProviderRefund>(
      'GET',
      `/fakepay/refunds?merchant_reference=${encodeURIComponent(refundId)}`,
    );
  }
}
