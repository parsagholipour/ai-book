import { describe, expect, it } from "vitest";
import { searchGroundingSummaryFromRows, type SearchGroundingRow } from "./searchGrounding.js";

function row(overrides: Partial<SearchGroundingRow>): SearchGroundingRow {
  return {
    pool: "gemini-2.5-flash",
    period: "2026-09-30",
    search_calls: 1,
    grounded_prompts: 1,
    search_queries: 4,
    units: 1,
    free_units: 1,
    counted_through: 1,
    allowance: 1_500,
    billed_fee_usd: 0,
    list_fee_usd: 0.035,
    unpriced_calls: 0,
    ...overrides
  };
}

describe("searchGroundingSummaryFromRows", () => {
  it("reports each period's prompts against its allowance, the free ones, and the fee actually billed", () => {
    const summary = searchGroundingSummaryFromRows([
      // 1,620 grounded prompts on a busy day: the first 1,500 free, the other 120 at $0.035.
      row({ period: "2026-09-29", search_calls: 1_630, grounded_prompts: 1_620, search_queries: 6_480, units: 1_620,
        free_units: 1_500, counted_through: 1_620, billed_fee_usd: 4.2, list_fee_usd: 56.7 }),
      row({ period: "2026-09-30", search_calls: 790, grounded_prompts: 790, search_queries: 3_160, units: 790,
        free_units: 790, counted_through: 790, billed_fee_usd: 0, list_fee_usd: 27.65 })
    ]);

    expect(summary).toMatchObject({
      searchCalls: 2_420, groundedPrompts: 2_410, searchQueries: 9_640, units: 2_410, freeUnits: 2_290,
      billedFeeUsd: 4.2, listFeeUsd: 84.35, unpricedCalls: 0
    });
    expect(summary.periods).toEqual([
      { pool: "gemini-2.5-flash", period: "2026-09-30", units: 790, freeUnits: 790, countedThrough: 790, allowance: 1_500, billedFeeUsd: 0, listFeeUsd: 27.65 },
      { pool: "gemini-2.5-flash", period: "2026-09-29", units: 1_620, freeUnits: 1_500, countedThrough: 1_620, allowance: 1_500, billedFeeUsd: 4.2, listFeeUsd: 56.7 }
    ]);
  });

  it("orders periods newest first across pools, monthly ones included", () => {
    const summary = searchGroundingSummaryFromRows([
      row({ pool: "gemini-3", period: "2026-09", units: 6_000, free_units: 5_000, counted_through: 6_000, allowance: 5_000, billed_fee_usd: 14 }),
      row({ period: "2026-09-30" }),
      row({ pool: "gemini-2.5-pro", period: "2026-09-30" })
    ]);

    expect(summary.periods.map((period) => `${period.pool}@${period.period}`))
      .toEqual(["gemini-2.5-flash@2026-09-30", "gemini-2.5-pro@2026-09-30", "gemini-3@2026-09"]);
  });

  it("counts grounded rows no rate card priced, and rows that claimed nothing, without inventing a period for them", () => {
    const summary = searchGroundingSummaryFromRows([
      row({ pool: null, period: null, search_calls: 2, grounded_prompts: 2, units: 0, free_units: 0, list_fee_usd: 0, unpriced_calls: 2 }),
      row({ period: null, search_calls: 3, grounded_prompts: 0, units: 0, free_units: 0, counted_through: null, list_fee_usd: 0 }),
      row({})
    ]);

    expect(summary).toMatchObject({ searchCalls: 6, groundedPrompts: 3, unpricedCalls: 2, units: 1, freeUnits: 1, billedFeeUsd: 0 });
    expect(summary.periods).toHaveLength(1);
  });

  it("is all zeros for a window with no grounded search", () => {
    expect(searchGroundingSummaryFromRows([])).toEqual({
      searchCalls: 0, groundedPrompts: 0, searchQueries: 0, units: 0, freeUnits: 0, billedFeeUsd: 0, listFeeUsd: 0, unpricedCalls: 0, periods: []
    });
  });
});
