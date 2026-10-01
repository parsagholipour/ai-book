/**
 * What grounded web search cost, beside the tokens it spent.
 *
 * Google bills Grounding with Google Search per grounded prompt (Gemini 2.5) or
 * per search query (3.x), on top of the model's tokens, and waives a number of
 * them per Google project per Pacific-time day (2.5) or month (3.x). Each
 * grounded search claims its ordinal in that pool-period from a counter in the
 * transaction that writes its row, and is priced by it: free inside the
 * allowance, list price past it (`packages/core/src/searchGroundingCost.ts`).
 * So `metadata.groundingFeeUsd` is the fee actually billed, it is already inside
 * the row's `costHint`, and every total on the Costs tab includes exactly it —
 * a non-null `costHint` is still a settled, priced call.
 *
 * This module breaks that out per allowance period: units used against the
 * allowance the recorder assumed, the units it covered, the fee billed and the
 * fee at list. The allowance is the deployment's setting
 * (`SEARCH_GROUNDING_FREE_*`, Google's numbers by default), recorded on each
 * row, because Google's pool also counts whatever else holds the key and only
 * an operator knows how much that is (apps/api/src/admin/CLAUDE.md). A row's
 * `groundingOrdinal` is the pool-period count when it was written, so the
 * period's highest ordinal is the count to date even when the window opens
 * mid-period.
 */

import { prisma } from "@book-maker/db";
import type { AdminWindow } from "./metrics.js";

export type SearchGroundingPeriodSummary = {
  /** The allowance pool, e.g. `gemini-2.5-flash` (Flash and Flash-Lite share one). */
  pool: string;
  /** The Pacific-time day (`2026-09-30`) or month (`2026-09`). */
  period: string;
  /** Billable units this window logged: grounded prompts, or search queries. */
  units: number;
  /** Of those, the units the allowance covered. */
  freeUnits: number;
  /** The period's count when its latest logged call was written — units the pool had used by then. */
  countedThrough: number;
  /** The allowance the recorder priced against, as configured when it ran. */
  allowance: number | null;
  /** The fee billed for this period's units — the part of the totals that is grounding. */
  billedFeeUsd: number;
  /** The same units at list price, as if no allowance existed. */
  listFeeUsd: number;
};

export type SearchGroundingSummary = {
  /** Research rows that recorded their grounding at all. */
  searchCalls: number;
  /** Of those, the prompts that came back citing at least one web source. */
  groundedPrompts: number;
  /** Search queries the model reported running, over the same rows. */
  searchQueries: number;
  /** Billable units across every pool, and those the free allowance covered. */
  units: number;
  freeUnits: number;
  /** The grounding fee actually billed — already inside the Costs tab's totals. */
  billedFeeUsd: number;
  /** The fee the same units would have cost at list price. */
  listFeeUsd: number;
  /** Grounded rows no rate card could price; their `costHint` is null, so they count as unrated. */
  unpricedCalls: number;
  /** Newest period first. */
  periods: SearchGroundingPeriodSummary[];
};

/** One `(pool, period)` group, straight off the query below; rows that claimed nothing have neither. */
export type SearchGroundingRow = {
  pool: string | null;
  period: string | null;
  search_calls: number | null;
  grounded_prompts: number | null;
  search_queries: number | null;
  units: number | null;
  free_units: number | null;
  counted_through: number | null;
  allowance: number | null;
  billed_fee_usd: number | null;
  list_fee_usd: number | null;
  unpriced_calls: number | null;
};

export async function loadSearchGroundingSummary(window: AdminWindow): Promise<SearchGroundingSummary> {
  return searchGroundingSummaryFromRows(await loadSearchGroundingRows(window));
}

/**
 * `-> 'groundingFeeUsd' IS NOT NULL` is true for a JSON `null` too, which is
 * the point: an unpriced grounded row still belongs to the count. Fees are
 * summed over rows with a `costHint` only, so the billed fee is exactly the
 * part of the Costs tab's total that grounding accounts for.
 */
async function loadSearchGroundingRows(window: AdminWindow): Promise<SearchGroundingRow[]> {
  return prisma.$queryRaw<SearchGroundingRow[]>`
    SELECT
      l.metadata ->> 'groundingPool' AS pool,
      l.metadata ->> 'groundingPeriod' AS period,
      COUNT(*)::double precision AS search_calls,
      COUNT(*) FILTER (WHERE l.metadata ->> 'groundedPrompt' = 'true')::double precision AS grounded_prompts,
      COALESCE(SUM(CASE WHEN jsonb_typeof(l.metadata -> 'webSearchQueries') = 'number'
        THEN (l.metadata ->> 'webSearchQueries')::double precision END), 0)::double precision AS search_queries,
      COALESCE(SUM(CASE WHEN jsonb_typeof(l.metadata -> 'groundingUnits') = 'number'
        THEN (l.metadata ->> 'groundingUnits')::double precision END), 0)::double precision AS units,
      COALESCE(SUM(CASE WHEN jsonb_typeof(l.metadata -> 'groundingFreeUnits') = 'number'
        THEN (l.metadata ->> 'groundingFreeUnits')::double precision END), 0)::double precision AS free_units,
      MAX(CASE WHEN jsonb_typeof(l.metadata -> 'groundingOrdinal') = 'number'
        THEN (l.metadata ->> 'groundingOrdinal')::double precision END) AS counted_through,
      MAX(CASE WHEN jsonb_typeof(l.metadata -> 'groundingAllowance') = 'number'
        THEN (l.metadata ->> 'groundingAllowance')::double precision END) AS allowance,
      COALESCE(SUM(CASE WHEN jsonb_typeof(l.metadata -> 'groundingFeeUsd') = 'number'
        THEN (l.metadata ->> 'groundingFeeUsd')::double precision END) FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS billed_fee_usd,
      COALESCE(SUM(CASE WHEN jsonb_typeof(l.metadata -> 'groundingListFeeUsd') = 'number'
        THEN (l.metadata ->> 'groundingListFeeUsd')::double precision END) FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS list_fee_usd,
      COUNT(*) FILTER (WHERE jsonb_typeof(l.metadata -> 'groundingFeeUsd') = 'null')::double precision AS unpriced_calls
    FROM "ProviderCallLog" l
    WHERE l."createdAt" >= ${window.since}::timestamptz AND l."createdAt" <= ${window.until}::timestamptz
      AND l.metadata -> 'groundingFeeUsd' IS NOT NULL
    GROUP BY 1, 2
  `;
}

export function searchGroundingSummaryFromRows(rows: SearchGroundingRow[]): SearchGroundingSummary {
  const summary: SearchGroundingSummary = {
    searchCalls: 0,
    groundedPrompts: 0,
    searchQueries: 0,
    units: 0,
    freeUnits: 0,
    billedFeeUsd: 0,
    listFeeUsd: 0,
    unpricedCalls: 0,
    periods: []
  };
  for (const row of rows) {
    summary.searchCalls += whole(row.search_calls);
    summary.groundedPrompts += whole(row.grounded_prompts);
    summary.searchQueries += whole(row.search_queries);
    summary.units += whole(row.units);
    summary.freeUnits += whole(row.free_units);
    summary.billedFeeUsd += finite(row.billed_fee_usd);
    summary.listFeeUsd += finite(row.list_fee_usd);
    summary.unpricedCalls += whole(row.unpriced_calls);
    if (row.pool && row.period) {
      summary.periods.push({
        pool: row.pool,
        period: row.period,
        units: whole(row.units),
        freeUnits: whole(row.free_units),
        countedThrough: whole(row.counted_through),
        allowance: row.allowance === null || !Number.isFinite(row.allowance) ? null : whole(row.allowance),
        billedFeeUsd: roundUsd(finite(row.billed_fee_usd)),
        listFeeUsd: roundUsd(finite(row.list_fee_usd))
      });
    }
  }
  summary.periods.sort((left, right) => right.period.localeCompare(left.period) || left.pool.localeCompare(right.pool));
  summary.billedFeeUsd = roundUsd(summary.billedFeeUsd);
  summary.listFeeUsd = roundUsd(summary.listFeeUsd);
  return summary;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function finite(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function whole(value: number | null): number {
  return Math.max(0, Math.round(finite(value)));
}
