import { playServiceFeeRate } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { DEFAULT_LOCAL_ADMIN_USER_ID } from "../requestAuth.js";
import { summarizePayments, type PaymentRow } from "./cashRevenue.js";
import type { AdminWindow } from "./metrics.js";

/**
 * The money half of the growth funnel (`productFunnel.ts`): cash per product
 * and per signup country, net of Google's fee, whether an intro month turned
 * into a full-price one, and how many subscribers each month lost.
 *
 * Every figure is read from billing rows the product already writes, so it is
 * true of every reader since launch. Cash follows `cashRevenue.ts`: the USD
 * catalog price less refunds is *collected*, less Google's fee
 * (`playServiceFeeRate`) is *net*, and a buyer's own currency is summed per
 * currency and never converted.
 */

export type SkuCash = {
  sku: string;
  payments: number;
  buyers: number;
  /** Catalog USD less refunds, before Google's fee. */
  cashUsd: number;
  /** `cashUsd` less Google's fee: what the window's orders of this product brought in. */
  netUsd: number;
};

export type CountryRevenue = {
  /** The buyer's signup country (ISO 3166 alpha-2, from `WelcomeCreditGrant`), or null when none was recorded. */
  country: string | null;
  orders: number;
  buyers: number;
  collectedUsd: number;
  netUsd: number;
  /** The same orders in the buyers' own currencies, refunds taken pro rata; null currency = no local price on record. */
  byCurrency: Array<{ currency: string | null; orders: number; localKept: number }>;
};

/**
 * Intro payments in the window and whether the reader went on to pay full
 * price. `renewed` counts only intros that are `due` — old enough that the
 * full-price period should have been charged — so `renewed / due` is the rate.
 */
export type IntroConversion = { sku: string; intros: number; due: number; renewed: number };

/**
 * One UTC month of paid plans. `activeAtStart` readers held a paid plan as the
 * month opened; `ended` of them held none when it closed (or now, for the month
 * in progress), `refunded` of those because Google refunded it; `started`
 * readers took one up in the month without holding one at its start.
 */
export type ChurnMonth = {
  month: string;
  activeAtStart: number;
  ended: number;
  refunded: number;
  started: number;
  /** The month is still running, so `ended` is so far. */
  partial: boolean;
};

/**
 * A one-month intro is due its first full-price charge a month after it was
 * paid; Google then retries a declined card through the grace period (seven
 * days by default for a monthly plan) before the plan lapses, and the renewal
 * is recorded when it is first observed. Until then the intro is not counted
 * either way.
 */
export const INTRO_RENEWAL_DUE_DAYS = 38;

/** The `PurchasePayment.amountSource` values of an introductory period (`subscriptionAllowance.ts`). */
const INTRO_AMOUNT_SOURCES = ["intro_offer", "catalog_snapshot_unknown_offer"] as const;

type GrowthPaymentRow = PaymentRow & { userId: string; sku: string | null; country: string | null };

export async function loadGrowthPayments(window: AdminWindow): Promise<GrowthPaymentRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      user_id: string;
      paid_at: Date;
      amount_micros: bigint;
      refunded_micros: bigint;
      local_micros: bigint | null;
      local_currency: string | null;
      local_source: string | null;
      sku: string | null;
      product_type: string | null;
      country: string | null;
    }>
  >`
    SELECT p."userId" AS user_id, p."paidAt" AS paid_at, p."amountMicros" AS amount_micros,
      p."refundedAmountMicros" AS refunded_micros, p."localPriceMicros" AS local_micros,
      p."localCurrency" AS local_currency, p."localPriceSource" AS local_source,
      c.sku, c."productType"::text AS product_type, g."countryCode" AS country
    FROM "PurchasePayment" p
    JOIN "PurchaseRecord" r ON r.id = p."purchaseRecordId"
    LEFT JOIN "ProductCatalog" c ON c.id = r."productId"
    LEFT JOIN "WelcomeCreditGrant" g ON g."userId" = p."userId"
    WHERE p."paidAt" >= ${window.since} AND p."paidAt" <= ${window.until}
  `;
  return rows.map((row) => ({
    userId: row.user_id,
    paidAt: row.paid_at,
    amountMicros: BigInt(row.amount_micros),
    refundedAmountMicros: BigInt(row.refunded_micros),
    localPriceMicros: row.local_micros === null ? null : BigInt(row.local_micros),
    localCurrency: row.local_currency,
    localPriceSource: row.local_source,
    productType: row.product_type,
    sku: row.sku,
    country: row.country ? row.country.trim().toUpperCase() || null : null
  }));
}

export function summarizeSkuCash(rows: readonly GrowthPaymentRow[]): SkuCash[] {
  const groups = new Map<string, { payments: number; buyers: Set<string>; cash: number; net: number }>();
  for (const row of rows) {
    const sku = row.sku ?? "unknown";
    const group = groups.get(sku) ?? { payments: 0, buyers: new Set<string>(), cash: 0, net: 0 };
    const kept = keptUsd(row);
    group.payments += 1;
    group.buyers.add(row.userId);
    group.cash += kept;
    group.net += kept * (1 - playServiceFeeRate(row.productType));
    groups.set(sku, group);
  }
  return [...groups]
    .map(([sku, group]) => ({
      sku,
      payments: group.payments,
      buyers: group.buyers.size,
      cashUsd: round2(group.cash),
      netUsd: round2(group.net)
    }))
    .sort((left, right) => right.payments - left.payments || right.netUsd - left.netUsd);
}

export function summarizeRevenueByCountry(rows: readonly GrowthPaymentRow[]): CountryRevenue[] {
  const groups = new Map<string, GrowthPaymentRow[]>();
  for (const row of rows) {
    const key = row.country ?? "";
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups]
    .map(([key, group]) => {
      const cash = summarizePayments(group);
      return {
        country: key === "" ? null : key,
        orders: cash.orders,
        buyers: new Set(group.map((row) => row.userId)).size,
        collectedUsd: cash.collectedUsd,
        netUsd: cash.netUsd,
        byCurrency: cash.byCurrency.map((currency) => ({
          currency: currency.currency,
          orders: currency.orders,
          localKept: currency.localKept
        }))
      };
    })
    // Most money first; buyers with no recorded country always last.
    .sort((left, right) => Number(left.country === null) - Number(right.country === null) || right.netUsd - left.netUsd);
}

export async function loadIntroConversion(window: AdminWindow, now: Date = new Date()): Promise<IntroConversion[]> {
  const dueBefore = new Date(now.getTime() - INTRO_RENEWAL_DUE_DAYS * 24 * 60 * 60 * 1000);
  // A full-price payment by the same reader after the intro: a renewal on the
  // intro's own token or a switch to another plan (a new token). Refunded in
  // full, it was not kept, so it does not count.
  const rows = await prisma.$queryRaw<Array<{ sku: string | null; intros: bigint; due: bigint; renewed: bigint }>>`
    WITH intros AS (
      SELECT p."userId", p."paidAt", c.sku
      FROM "PurchasePayment" p
      JOIN "PurchaseRecord" r ON r.id = p."purchaseRecordId"
      LEFT JOIN "ProductCatalog" c ON c.id = r."productId"
      WHERE p."amountSource" IN (${INTRO_AMOUNT_SOURCES[0]}, ${INTRO_AMOUNT_SOURCES[1]})
        AND p."paidAt" >= ${window.since} AND p."paidAt" <= ${window.until}
        AND p."userId" <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
    )
    SELECT i.sku, count(*) AS intros,
      count(*) FILTER (WHERE i."paidAt" <= ${dueBefore}) AS due,
      count(*) FILTER (WHERE i."paidAt" <= ${dueBefore} AND EXISTS (
        SELECT 1 FROM "PurchasePayment" f
        JOIN "PurchaseRecord" fr ON fr.id = f."purchaseRecordId"
        JOIN "ProductCatalog" fc ON fc.id = fr."productId"
        WHERE f."userId" = i."userId" AND f."paidAt" > i."paidAt"
          AND fc."productType" = 'SUBSCRIPTION'
          AND f."amountSource" NOT IN (${INTRO_AMOUNT_SOURCES[0]}, ${INTRO_AMOUNT_SOURCES[1]}, 'free_trial')
          AND f."amountMicros" > 0 AND f."refundedAmountMicros" < f."amountMicros"
      )) AS renewed
    FROM intros i
    GROUP BY i.sku
    ORDER BY intros DESC
  `;
  return rows.map((row) => ({
    sku: row.sku ?? "unknown",
    intros: Number(row.intros),
    due: Number(row.due),
    renewed: Number(row.renewed)
  }));
}

/** One paid-plan entitlement: a plan held from `startsAt` until it expired or was revoked, or still held. */
export type PlanSpan = { userId: string; status: string; startsAt: Date; expiresAt: Date | null; updatedAt: Date };

export async function loadChurn(window: AdminWindow, now: Date = new Date()): Promise<ChurnMonth[]> {
  const months = utcMonths(window.since, window.until);
  const first = months[0];
  if (!first) return [];
  // Paid plans only: a plan the operator granted is not a subscriber. The
  // entitlement is one row per held plan, extended in place at each renewal,
  // so it reads as one span; an upgrade ends one row and opens another in the
  // same write, which the per-reader union below reads as continuous.
  const rows = await prisma.$queryRaw<
    Array<{ user_id: string; status: string; starts_at: Date; expires_at: Date | null; updated_at: Date }>
  >`
    SELECT e."userId" AS user_id, e.status::text AS status, e."startsAt" AS starts_at,
      e."expiresAt" AS expires_at, e."updatedAt" AS updated_at
    FROM "UserEntitlement" e
    WHERE e.type IN ('CREATOR_PLAN', 'PRO_PLAN', 'MAX_PLAN') AND e.source = 'google_play_subscription'
      AND e."userId" <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
      AND e."startsAt" <= ${window.until}
      AND (e.status = 'ACTIVE' OR e."expiresAt" IS NULL OR e."expiresAt" >= ${first})
  `;
  return summarizeChurn(
    rows.map((row) => ({
      userId: row.user_id,
      status: row.status,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at
    })),
    months,
    now
  );
}

/**
 * Per month, from the plan spans: who held a paid plan as it opened, and which
 * of them held none as it closed. A reader holds a plan at an instant when any
 * of their spans covers it; an ACTIVE span covers every instant from its start,
 * because Google has not said it ended (`expiresAt` is the end of the period it
 * last renewed into, and the renewal may simply not be recorded yet). An
 * EXPIRED or REVOKED span always stamps `expiresAt` when it ends.
 */
export function summarizeChurn(spans: readonly PlanSpan[], months: readonly Date[], now: Date): ChurnMonth[] {
  const byUser = new Map<string, PlanSpan[]>();
  for (const span of spans) {
    const userSpans = byUser.get(span.userId);
    if (userSpans) userSpans.push(span);
    else byUser.set(span.userId, [span]);
  }
  const end = (span: PlanSpan) => (span.status === "ACTIVE" ? Infinity : (span.expiresAt ?? span.updatedAt).getTime());
  const holds = (userSpans: readonly PlanSpan[], at: number) =>
    userSpans.some((span) => span.startsAt.getTime() <= at && at < end(span));

  return months
    .filter((month) => month.getTime() <= now.getTime())
    .map((month) => {
      const start = month.getTime();
      const next = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1);
      const close = Math.min(next, now.getTime());
      let activeAtStart = 0;
      let ended = 0;
      let refunded = 0;
      let started = 0;
      for (const userSpans of byUser.values()) {
        if (holds(userSpans, start)) {
          activeAtStart += 1;
          if (!holds(userSpans, close)) {
            ended += 1;
            const refund = userSpans.some((span) => span.status === "REVOKED" && end(span) > start && end(span) <= close);
            if (refund) refunded += 1;
          }
        } else if (userSpans.some((span) => span.startsAt.getTime() >= start && span.startsAt.getTime() < close)) {
          started += 1;
        }
      }
      return {
        month: month.toISOString().slice(0, 7),
        activeAtStart,
        ended,
        refunded,
        started,
        partial: next > now.getTime()
      };
    });
}

/** The first instant of every UTC month from `since`'s through `until`'s. */
export function utcMonths(since: Date, until: Date): Date[] {
  const months: Date[] = [];
  let cursor = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1);
  while (cursor <= until.getTime()) {
    months.push(new Date(cursor));
    const at = new Date(cursor);
    cursor = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  }
  return months;
}

function keptUsd(row: PaymentRow): number {
  const amount = Number(row.amountMicros) / 1_000_000;
  const refunded = Math.min(Math.max(Number(row.refundedAmountMicros) / 1_000_000, 0), amount);
  return amount - refunded;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
