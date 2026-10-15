/**
 * What the credits a reader spent were worth in money, by where they came from.
 *
 * The dashboard used to multiply every credit by a flat $0.01 (`CREDIT_USD_VALUE`).
 * No credit is sold at a cent: after Google's fee a plan credit earns
 * $0.0021–0.0028, a pack credit $0.0064–0.0068, and a welcome credit nothing, so
 * every margin read 3.5–4.7× too rosy and a free reader's book looked like
 * income. Everything on the dashboard that turns credits into dollars now comes
 * through here.
 *
 * ## The method
 *
 * A balance is two pools (`packages/db/CLAUDE.md`), and every charge records how
 * much of itself came from each (`planCreditsDelta` is the allowance share).
 *
 * - **The allowance share** is worth what the plan period it was spent in
 *   brought in per credit: the reader's latest allowance grant at or before the
 *   charge, valued at its catalog price × (1 − Google's fee) ÷ the credits a full
 *   period grants (`netUsdPerCredit`). An intro period is valued at the intro's
 *   own price and credits; a prorated switch at its plan's full-period rate,
 *   because its cash and its credits are both a share of a period. A legacy free
 *   monthly allowance is worth $0.
 * - **The bought share** is valued oldest grant first. The bought pool holds
 *   welcome and operator credits ($0) beside packs (pack price × (1 − fee) ÷
 *   credits), and the reader's bought-pool spending is laid end to end against
 *   those grants in the order they arrived. So a reader who used up their
 *   welcome credits and then bought a pack is valued at the pack's rate from
 *   then on, and one who never paid is worth $0 however much they spent. A
 *   store-refunded grant keeps only the credits Google did not take back.
 *   Bought-pool credits beyond every grant — an allowance refunded after its
 *   period ended lands there — are valued at the reader's latest paid rate.
 * - **A refunded charge** keeps its value per credit; only the part not given
 *   back counts as delivered, and the rest is reported as refunded at the same
 *   rate.
 *
 * It values credits at catalog prices, which is what `PurchasePayment` records
 * too: a later price change revalues earlier grants of that product. Only
 * readers who were ever granted a paid credit are read at all, since nobody
 * else's spending can be worth anything — which also keeps the queries to the
 * ledgers of paying readers.
 */

import {
  CHEAPEST_PAID_CREDIT_USD_VALUE,
  DEFAULT_BILLING_PRODUCTS,
  PLAY_ONE_TIME_PRODUCT_FEE_RATE,
  PLAY_SUBSCRIPTION_FEE_RATE,
  SUBSCRIPTION_INTRO_OFFERS,
  introOfferForGrant,
  netUsdPerCredit
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

export type CreditSource = "plan" | "intro" | "pack" | "welcome" | "operator" | "free_allowance" | "other";

export type CreditLot = {
  /** Grant time, epoch ms. */
  at: number;
  credits: number;
  usdPerCredit: number;
  source: CreditSource;
};

type PurchasedLot = CreditLot & { start: number; end: number };

/** One reader's grants, split by the pool they landed in, oldest first. */
export type UserLots = { allowance: CreditLot[]; purchased: PurchasedLot[] };

/** A settled `GRANT` row with the product it was sold as and any store-refund reversal. */
export type GrantLotRow = {
  user_id: string;
  created_at: Date;
  operation: string;
  amount_credits: number;
  plan_credits: number;
  reversed_credits: number | null;
  reversed_plan_credits: number | null;
  allowance_basis: string | null;
  sku: string | null;
  product_type: string | null;
  price_micros: number | null;
  product_credits: number | null;
};

/** A settled `SPEND` row, and how much of the reader's bought pool their earlier charges used. */
export type SpendRow = {
  id: string;
  user_id: string;
  created_at: Date;
  operation: string;
  project_id: string | null;
  gross: number;
  /** The allowance share, as a magnitude no larger than `gross`. */
  allowance: number;
  /** The cumulative reversal, as a magnitude. */
  refunded: number;
  /** Bought-pool credits this reader's earlier charges consumed, net of their refunds. */
  purchased_before: number;
};

export type SpendValue = {
  /** What the part of the charge that stuck earned. */
  usd: number;
  /** What the refunded part would have earned, at the same rates. */
  refundedUsd: number;
  /** Credits of the part that stuck that someone paid for; the rest were free. */
  paidCredits: number;
};

export type ValuedSpend = SpendValue & {
  userId: string;
  createdAt: Date;
  operation: string;
  projectId: string | null;
  grossCredits: number;
  refundedCredits: number;
};

/** Which charges to value. Only readers who were ever granted a paid credit come back. */
export type SpendScope =
  | { kind: "window"; since: Date; until: Date }
  | { kind: "projects"; projectIds: readonly string[]; operation?: string };

/** The rate one grant's credits earn, and what kind of credit they are. */
export function grantRate(grant: Pick<GrantLotRow, "operation" | "allowance_basis" | "sku" | "product_type" | "price_micros" | "product_credits" | "amount_credits">): {
  usdPerCredit: number;
  source: CreditSource;
} {
  switch (grant.operation) {
    case "SUBSCRIPTION_CREDIT_GRANT": {
      if (grant.allowance_basis === "intro_offer" && grant.sku) {
        const offer = introOfferForGrant(grant.sku, grant.amount_credits);
        if (offer) {
          return { usdPerCredit: netUsdPerCredit({ ...offer, productType: "SUBSCRIPTION" }), source: "intro" };
        }
      }
      return { usdPerCredit: productRate(grant, "SUBSCRIPTION"), source: "plan" };
    }
    case "PURCHASE_CREDIT_GRANT":
      return { usdPerCredit: productRate(grant, "CREDIT_PACK"), source: "pack" };
    case "WELCOME_GRANT":
      return { usdPerCredit: 0, source: "welcome" };
    case "ADMIN_GRANT":
      return { usdPerCredit: 0, source: "operator" };
    case "PLAN_ALLOWANCE_GRANT":
      return { usdPerCredit: 0, source: "free_allowance" };
    default:
      return { usdPerCredit: 0, source: "other" };
  }
}

/** The grant's catalog row, or the compiled catalog by SKU when the row is gone. */
function productRate(
  grant: Pick<GrantLotRow, "sku" | "product_type" | "price_micros" | "product_credits">,
  fallbackType: string
): number {
  if (grant.price_micros !== null && grant.product_credits !== null) {
    return netUsdPerCredit({
      priceMicros: grant.price_micros,
      creditAmount: grant.product_credits,
      productType: grant.product_type ?? fallbackType
    });
  }
  const compiled = DEFAULT_BILLING_PRODUCTS.find((product) => product.sku === grant.sku);
  return compiled ? netUsdPerCredit(compiled) : 0;
}

/** Every reader's lots, from their grant rows. Rows may arrive in any order. */
export function lotsFromGrants(rows: readonly GrantLotRow[]): Map<string, UserLots> {
  const sorted = [...rows].sort((left, right) => left.created_at.getTime() - right.created_at.getTime());
  const byUser = new Map<string, UserLots>();
  for (const row of sorted) {
    const lots = byUser.get(row.user_id) ?? { allowance: [], purchased: [] };
    byUser.set(row.user_id, lots);
    const { usdPerCredit, source } = grantRate(row);
    const at = row.created_at.getTime();
    const allowance = Math.max(0, Math.min(row.plan_credits, row.amount_credits));
    if (allowance > 0) {
      lots.allowance.push({ at, credits: allowance, usdPerCredit, source });
    }
    // A store refund takes back what it can; only the credits it left are in the pool.
    const reversedPurchased = Math.max(0, (row.reversed_credits ?? 0) - (row.reversed_plan_credits ?? 0));
    const purchased = Math.max(0, row.amount_credits - allowance - reversedPurchased);
    if (purchased > 0) {
      const start = lots.purchased.at(-1)?.end ?? 0;
      lots.purchased.push({ at, credits: purchased, usdPerCredit, source, start, end: start + purchased });
    }
  }
  return byUser;
}

/** The value of one charge, against the reader's lots. A reader with none was never paid. */
export function valueSpend(spend: SpendRow, lots: UserLots | undefined): SpendValue {
  const gross = Math.max(0, spend.gross);
  if (gross === 0 || !lots) {
    return { usd: 0, refundedUsd: 0, paidCredits: 0 };
  }
  const at = spend.created_at.getTime();
  const allowance = Math.min(Math.max(0, spend.allowance), gross);
  const purchased = gross - allowance;
  const kept = Math.max(gross - Math.max(0, spend.refunded), 0) / gross;

  const allowanceRate = latest(lots.allowance, at)?.usdPerCredit ?? 0;
  let grossUsd = allowance * allowanceRate;
  let paid = allowanceRate > 0 ? allowance : 0;

  // The bought share is laid end to end after everything this reader's earlier
  // charges took from the pool, against the grants that existed by then.
  const from = Math.max(0, spend.purchased_before);
  const to = from + purchased;
  let covered = from;
  for (const lot of lots.purchased) {
    if (lot.at > at || covered >= to) break;
    const overlap = Math.max(0, Math.min(to, lot.end) - Math.max(covered, lot.start));
    if (overlap > 0) {
      grossUsd += overlap * lot.usdPerCredit;
      if (lot.usdPerCredit > 0) paid += overlap;
      covered += overlap;
    }
  }
  const beyondGrants = to - covered;
  if (beyondGrants > 0) {
    const rate = latestPaidRate(lots, at);
    grossUsd += beyondGrants * rate;
    if (rate > 0) paid += beyondGrants;
  }

  return { usd: grossUsd * kept, refundedUsd: grossUsd * (1 - kept), paidCredits: paid * kept };
}

/** Paid credits still sitting in a reader's bought pool after `consumed` of it was spent. */
export function remainingPaidValue(lots: UserLots | undefined, consumed: number): { credits: number; usd: number } {
  let credits = 0;
  let usd = 0;
  for (const lot of lots?.purchased ?? []) {
    const left = lot.end - Math.max(lot.start, consumed);
    if (left > 0 && lot.usdPerCredit > 0) {
      credits += left;
      usd += left * lot.usdPerCredit;
    }
  }
  return { credits, usd };
}

function latest<T extends { at: number }>(lots: readonly T[], at: number): T | undefined {
  let found: T | undefined;
  for (const lot of lots) {
    if (lot.at > at) break;
    found = lot;
  }
  return found;
}

function latestPaidRate(lots: UserLots, at: number): number {
  let best: CreditLot | undefined;
  for (const lot of [...lots.allowance, ...lots.purchased]) {
    if (lot.at <= at && lot.usdPerCredit > 0 && (!best || lot.at >= best.at)) best = lot;
  }
  return best?.usdPerCredit ?? 0;
}

/** The bought-pool share of a charge that stuck, as SQL over `h.gross / h.allowance / h.refunded`. */
const PURCHASED_NET_SQL =
  "CASE WHEN h.gross > 0 THEN (h.gross - h.allowance) * GREATEST(h.gross - h.refunded, 0) / h.gross ELSE 0 END";

/** A charge's magnitudes and its cumulative reversal; `e` is the charge, `r` its refund. */
const SPEND_COLUMNS_SQL = `
      ABS(e."amountCredits")::double precision AS gross,
      LEAST(ABS(e."planCreditsDelta"), ABS(e."amountCredits"))::double precision AS allowance,
      GREATEST(COALESCE(r."amountCredits", 0), 0)::double precision AS refunded`;

const REFUND_JOIN_SQL = `LEFT JOIN "CreditLedgerEntry" r
      ON r."reversesEntryId" = e.id AND r."entryType" = 'REFUND' AND r.status = 'SETTLED'`;

/** Readers in `source` (a relation with a `"userId"` column) who were ever granted a credit through a purchase. */
function payingUsersSql(source: string): string {
  return `SELECT u."userId" FROM (SELECT DISTINCT "userId" FROM ${source}) u
    WHERE EXISTS (
      SELECT 1 FROM "PurchaseRecord" pr
      JOIN "CreditLedgerEntry" g ON g."purchaseRecordId" = pr.id
      WHERE pr."userId" = u."userId" AND g."entryType" = 'GRANT' AND g.status = 'SETTLED'
    )`;
}

/** Every settled grant of the readers `userFilter` names, with its product and store-refund reversal. */
function grantLotsSql(userFilter: string): string {
  return `
    SELECT
      g."userId" AS user_id,
      g."createdAt" AS created_at,
      g.operation::text AS operation,
      g."amountCredits"::double precision AS amount_credits,
      g."planCreditsDelta"::double precision AS plan_credits,
      ABS(rv."amountCredits")::double precision AS reversed_credits,
      ABS(rv."planCreditsDelta")::double precision AS reversed_plan_credits,
      g.metadata ->> 'allowanceBasis' AS allowance_basis,
      COALESCE(c.sku, g.metadata ->> 'productSku') AS sku,
      c."productType"::text AS product_type,
      c."priceMicros"::double precision AS price_micros,
      c."creditAmount"::double precision AS product_credits
    FROM "CreditLedgerEntry" g
    LEFT JOIN "CreditLedgerEntry" rv
      ON rv."reversesEntryId" = g.id AND rv."entryType" = 'ADJUSTMENT' AND rv.status = 'SETTLED'
    LEFT JOIN "ProductCatalog" c ON c.id = g."productId"
    WHERE ${userFilter} AND g."entryType" = 'GRANT' AND g.status = 'SETTLED' AND g."amountCredits" > 0`;
}

function scopeFilter(scope: SpendScope): { sql: string; params: unknown[] } {
  if (scope.kind === "window") {
    return { sql: `e."createdAt" >= $1::timestamptz AND e."createdAt" <= $2::timestamptz`, params: [scope.since, scope.until] };
  }
  const placeholders = scope.projectIds.map((_id, index) => `$${index + 1}`).join(", ");
  const params: unknown[] = [...scope.projectIds];
  let sql = `e."projectId" IN (${placeholders})`;
  if (scope.operation) {
    params.push(scope.operation);
    sql += ` AND e.operation::text = $${params.length}`;
  }
  return { sql, params };
}

/**
 * Every settled charge in `scope` made by a reader who was ever paid, valued.
 * A charge that is missing here is worth $0, because its reader never bought a
 * credit — callers sum what comes back and take everyone else as free.
 *
 * The running total reads each paying reader's whole charge history, because
 * which grant a bought credit came from depends on everything spent before it.
 */
export async function loadValuedSpends(scope: SpendScope): Promise<ValuedSpend[]> {
  if (scope.kind === "projects" && scope.projectIds.length === 0) {
    return [];
  }
  const filter = scopeFilter(scope);
  const spends = await prisma.$queryRawUnsafe<SpendRow[]>(
    `
    WITH target AS (
      SELECT e.id, e."userId"
      FROM "CreditLedgerEntry" e
      WHERE e."entryType" = 'SPEND' AND e.status = 'SETTLED' AND ${filter.sql}
    ),
    paying AS (${payingUsersSql("target")}),
    history AS (
      SELECT e.id, e."userId", e."createdAt", e.operation::text AS operation, e."projectId",${SPEND_COLUMNS_SQL}
      FROM "CreditLedgerEntry" e
      JOIN paying p ON p."userId" = e."userId"
      ${REFUND_JOIN_SQL}
      WHERE e."entryType" = 'SPEND' AND e.status = 'SETTLED'
    ),
    running AS (
      SELECT h.*,
        COALESCE(SUM(${PURCHASED_NET_SQL}) OVER (
          PARTITION BY h."userId" ORDER BY h."createdAt", h.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0)::double precision AS purchased_before
      FROM history h
    )
    SELECT run.id, run."userId" AS user_id, run."createdAt" AS created_at, run.operation,
      run."projectId" AS project_id, run.gross, run.allowance, run.refunded, run.purchased_before
    FROM running run
    WHERE run.id IN (SELECT id FROM target)
  `,
    ...filter.params
  );
  if (spends.length === 0) {
    return [];
  }
  const userIds = [...new Set(spends.map((spend) => spend.user_id))];
  const grants = await prisma.$queryRawUnsafe<GrantLotRow[]>(grantLotsSql(`g."userId" = ANY($1::text[])`), userIds);
  const lots = lotsFromGrants(grants);
  return spends.map((spend) => ({
    userId: spend.user_id,
    createdAt: spend.created_at,
    operation: spend.operation,
    projectId: spend.project_id,
    grossCredits: Number(spend.gross),
    refundedCredits: Number(spend.refunded),
    ...valueSpend(normalizeSpend(spend), lots.get(spend.user_id))
  }));
}

/**
 * Paid credits still unspent in readers' bought pools, and what they were
 * bought for. Only pack buyers can hold any: an allowance is not bought-pool
 * credit, and welcome or operator credits were never paid for.
 */
export async function loadOutstandingPaidCredits(): Promise<{ credits: number; usd: number }> {
  const packBuyers = `
    WITH buyers AS (
      SELECT DISTINCT pr."userId" FROM "PurchaseRecord" pr
      JOIN "CreditLedgerEntry" g ON g."purchaseRecordId" = pr.id
      WHERE g."entryType" = 'GRANT' AND g.status = 'SETTLED' AND g."amountCredits" > g."planCreditsDelta"
    )`;
  const [consumption, grants] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ user_id: string; consumed: number | null }>>(
      `${packBuyers},
      history AS (
        SELECT e."userId",${SPEND_COLUMNS_SQL}
        FROM "CreditLedgerEntry" e
        JOIN buyers b ON b."userId" = e."userId"
        ${REFUND_JOIN_SQL}
        WHERE e."entryType" = 'SPEND' AND e.status = 'SETTLED'
      )
      SELECT h."userId" AS user_id, SUM(${PURCHASED_NET_SQL})::double precision AS consumed
      FROM history h
      GROUP BY h."userId"`
    ),
    prisma.$queryRawUnsafe<GrantLotRow[]>(`${packBuyers}${grantLotsSql(`g."userId" IN (SELECT "userId" FROM buyers)`)}`)
  ]);
  const lots = lotsFromGrants(grants);
  const consumed = new Map(consumption.map((row) => [row.user_id, Number(row.consumed ?? 0)]));
  let credits = 0;
  let usd = 0;
  for (const [userId, userLots] of lots) {
    const remaining = remainingPaidValue(userLots, consumed.get(userId) ?? 0);
    credits += remaining.credits;
    usd += remaining.usd;
  }
  return { credits: Math.round(credits), usd };
}

function normalizeSpend(spend: SpendRow): SpendRow {
  return {
    ...spend,
    gross: Number(spend.gross),
    allowance: Number(spend.allowance),
    refunded: Number(spend.refunded),
    purchased_before: Number(spend.purchased_before ?? 0)
  };
}

/** Sum valued charges by a key; a charge with no key is left out. */
export function sumValued(
  spends: readonly ValuedSpend[],
  keyOf: (spend: ValuedSpend) => string | null
): Map<string, { usd: number; refundedUsd: number; paidCredits: number }> {
  const totals = new Map<string, { usd: number; refundedUsd: number; paidCredits: number }>();
  for (const spend of spends) {
    const key = keyOf(spend);
    if (key === null) continue;
    const total = totals.get(key) ?? { usd: 0, refundedUsd: 0, paidCredits: 0 };
    total.usd += spend.usd;
    total.refundedUsd += spend.refundedUsd;
    total.paidCredits += spend.paidCredits;
    totals.set(key, total);
  }
  return totals;
}

export type CreditValuationSummary = {
  /** The sentence the console prints beside every valued figure. */
  method: string;
  subscriptionFeeRate: number;
  oneTimeFeeRate: number;
  /** What one credit of each kind earns after Google's fee. */
  rates: Array<{ key: string; label: string; usdPerCredit: number }>;
  /** The least a paid credit earns — what a projection with no ledger behind it should use. */
  cheapestPaidUsdPerCredit: number;
};

/** The rate table and the one-sentence method, for the console to show beside the numbers. */
export function creditValuationSummary(): CreditValuationSummary {
  const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
  const rates = [
    ...DEFAULT_BILLING_PRODUCTS.map((product) => ({
      key: product.sku,
      label: product.title,
      usdPerCredit: netUsdPerCredit(product)
    })),
    ...SUBSCRIPTION_INTRO_OFFERS.map((offer) => ({
      key: `${offer.sku}:${offer.offerId}`,
      label: `${DEFAULT_BILLING_PRODUCTS.find((product) => product.sku === offer.sku)?.title ?? offer.sku} intro offer`,
      usdPerCredit: netUsdPerCredit({ ...offer, productType: "SUBSCRIPTION" })
    })),
    { key: "welcome", label: "Welcome credits", usdPerCredit: 0 },
    { key: "operator", label: "Operator grants", usdPerCredit: 0 }
  ];
  return {
    method:
      `Credits are valued by where they came from, net of Google's fee (${percent(PLAY_SUBSCRIPTION_FEE_RATE)} on ` +
      `subscriptions, ${percent(PLAY_ONE_TIME_PRODUCT_FEE_RATE)} on packs): a plan credit at its plan's price over its ` +
      "allowance (an intro month at its own), a bought credit at its pack's price, oldest grant first, and welcome or " +
      "operator credits at $0.",
    subscriptionFeeRate: PLAY_SUBSCRIPTION_FEE_RATE,
    oneTimeFeeRate: PLAY_ONE_TIME_PRODUCT_FEE_RATE,
    rates,
    cheapestPaidUsdPerCredit: CHEAPEST_PAID_CREDIT_USD_VALUE
  };
}
