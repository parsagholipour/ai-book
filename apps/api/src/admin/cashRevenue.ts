/**
 * Cash the window's payments brought in: gross, Google's fee, net, by day and
 * by the buyer's own currency.
 *
 * `PurchasePayment.amountMicros` is the USD *catalog* price of the order —
 * before Google's service fee and in dollars whatever the buyer paid in. So
 * three things are reported, and labelled apart on the console:
 *
 * - **Collected** — catalog USD less cumulative refunds. The figure the
 *   dashboard always showed, kept because it is what the reader was charged.
 * - **Net** — collected less Google's fee: `PLAY_SUBSCRIPTION_FEE_RATE` on a
 *   subscription, `PLAY_ONE_TIME_PRODUCT_FEE_RATE` on anything else (core
 *   `billing.ts`; 15% on packs only while the account is enrolled in Play's 15%
 *   tier). This is what pairs against provider spend.
 * - **By currency** — `localPriceMicros` in `localCurrency`, what the order cost
 *   in the buyer's currency before tax and Google's cut (migration 000104). It
 *   is never converted: nothing here has an exchange rate, and Play's own
 *   settlement report is the only true dollar figure for a foreign order. A
 *   refund is applied to it pro rata, the way `refundPurchasePaymentsTx` sizes
 *   the USD refund. Orders recorded before the column, or by a build that did
 *   not report a price, have no local amount and are counted on their own row.
 *   These columns never decide anything.
 */

import { playServiceFeeRate } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import type { AdminWindow } from "./metrics.js";

export type PaymentRow = {
  paidAt: Date;
  amountMicros: bigint;
  refundedAmountMicros: bigint;
  localPriceMicros: bigint | null;
  localCurrency: string | null;
  localPriceSource: string | null;
  productType: string | null;
};

export type CurrencyRevenue = {
  /** ISO 4217, or null for orders with no local price on record. */
  currency: string | null;
  orders: number;
  refundedOrders: number;
  /** In the currency's own units, before tax and Google's fee, refunds not subtracted. */
  localGross: number;
  /** `localGross` less the refunded share of each order. */
  localKept: number;
  /** How each order's local price was learned. */
  sources: { client: number; playRecurringPrice: number };
  /** The same orders' USD catalog figure, less refunds, before Google's fee. */
  catalogUsd: number;
};

export type CashDay = { collectedUsd: number; netUsd: number };

export type CashSummary = {
  orders: number;
  /** Catalog USD less refunds, before Google's fee. */
  collectedUsd: number;
  feeUsd: number;
  netUsd: number;
  byDay: Map<string, CashDay>;
  byCurrency: CurrencyRevenue[];
};

export async function loadWindowPayments(window: AdminWindow): Promise<PaymentRow[]> {
  return loadPayments({ paidAt: { gte: window.since, lte: window.until } });
}

/** One reader's payments, every one they made — the user inspector's cash (`inspection.ts`). */
export async function loadUserPayments(userId: string): Promise<PaymentRow[]> {
  return loadPayments({ userId });
}

async function loadPayments(where: { paidAt: { gte: Date; lte: Date } } | { userId: string }): Promise<PaymentRow[]> {
  const rows = await prisma.purchasePayment.findMany({
    where,
    select: {
      paidAt: true,
      amountMicros: true,
      refundedAmountMicros: true,
      localPriceMicros: true,
      localCurrency: true,
      localPriceSource: true,
      purchaseRecord: { select: { product: { select: { productType: true } } } }
    }
  });
  return rows.map((row) => ({
    paidAt: row.paidAt,
    amountMicros: row.amountMicros,
    refundedAmountMicros: row.refundedAmountMicros,
    localPriceMicros: row.localPriceMicros ?? null,
    localCurrency: row.localCurrency ?? null,
    localPriceSource: row.localPriceSource ?? null,
    productType: row.purchaseRecord?.product?.productType ?? null
  }));
}

export function summarizePayments(rows: readonly PaymentRow[]): CashSummary {
  let collected = 0;
  let net = 0;
  const byDay = new Map<string, CashDay>();
  const byCurrency = new Map<string, CurrencyRevenue>();

  for (const row of rows) {
    const amount = Number(row.amountMicros) / 1_000_000;
    const refunded = Math.min(Math.max(Number(row.refundedAmountMicros) / 1_000_000, 0), amount);
    const kept = amount - refunded;
    const keptNet = kept * (1 - playServiceFeeRate(row.productType));
    collected += kept;
    net += keptNet;

    const dayKey = row.paidAt.toISOString().slice(0, 10);
    const dayTotals = byDay.get(dayKey) ?? { collectedUsd: 0, netUsd: 0 };
    dayTotals.collectedUsd += kept;
    dayTotals.netUsd += keptNet;
    byDay.set(dayKey, dayTotals);

    const currency = row.localPriceMicros !== null && row.localCurrency ? row.localCurrency.toUpperCase() : null;
    const group = byCurrency.get(currency ?? "") ?? {
      currency,
      orders: 0,
      refundedOrders: 0,
      localGross: 0,
      localKept: 0,
      sources: { client: 0, playRecurringPrice: 0 },
      catalogUsd: 0
    };
    group.orders += 1;
    group.catalogUsd += kept;
    if (refunded > 0) group.refundedOrders += 1;
    if (currency !== null) {
      const local = Number(row.localPriceMicros) / 1_000_000;
      group.localGross += local;
      group.localKept += amount > 0 ? local * (kept / amount) : local;
      if (row.localPriceSource === "play_recurring_price") group.sources.playRecurringPrice += 1;
      else group.sources.client += 1;
    }
    byCurrency.set(currency ?? "", group);
  }

  return {
    orders: rows.length,
    collectedUsd: round2(collected),
    feeUsd: round2(collected - net),
    netUsd: round2(net),
    byDay: new Map([...byDay].map(([key, totals]) => [key, { collectedUsd: round2(totals.collectedUsd), netUsd: round2(totals.netUsd) }])),
    byCurrency: [...byCurrency.values()]
      .map((group) => ({
        ...group,
        localGross: round2(group.localGross),
        localKept: round2(group.localKept),
        catalogUsd: round2(group.catalogUsd)
      }))
      // Most orders first; the orders with no local price always last.
      .sort((left, right) => Number(left.currency === null) - Number(right.currency === null) || right.orders - left.orders)
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
