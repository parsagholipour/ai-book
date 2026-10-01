import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { calculateTextGenerationCost } from "./costs.js";
import {
  applySearchGroundingAllowance,
  calculateSearchGroundingFee,
  searchCallCostHint,
  searchGroundingAllowance,
  searchGroundingClaim,
  searchGroundingMetadata,
  searchGroundingPeriod,
  searchGroundingRateForPool
} from "./searchGroundingCost.js";

const flash = { provider: "gemini", model: "gemini-2.5-flash" };
const grounded = { searchQueries: 4, webSources: 10 };
const flashRate = searchGroundingRateForPool("gemini-2.5-flash")!;
const gemini3Rate = searchGroundingRateForPool("gemini-3")!;
const noon = new Date("2026-09-30T19:00:00.000Z");

/** The fee a flash prompt settles at once its counter returned `countAfter`. */
function flashFeeAt(countAfter: number, allowances = {}) {
  const fee = calculateSearchGroundingFee({ ...flash, grounding: grounded });
  const claim = searchGroundingClaim(fee, { at: noon, allowances })!;
  return applySearchGroundingAllowance(fee, claim, countAfter);
}

describe("search grounding list price", () => {
  it("bills a Gemini 2.5 grounded prompt once, whatever it searched, and only when it cited a source", () => {
    expect(calculateSearchGroundingFee({ ...flash, grounding: { searchQueries: 6, webSources: 11 } }))
      .toEqual({ usd: 0.035, listUsd: 0.035, units: 1, groundedPrompt: true, pool: "gemini-2.5-flash" });
    expect(calculateSearchGroundingFee({ ...flash, grounding: { searchQueries: 3, webSources: 0 } }))
      .toEqual({ usd: 0, listUsd: 0, units: 0, groundedPrompt: false, pool: "gemini-2.5-flash" });
    expect(calculateSearchGroundingFee({ provider: "gemini", model: "gemini-2.5-flash-lite-preview-06-17", grounding: grounded }).pool)
      .toBe("gemini-2.5-flash");
    expect(calculateSearchGroundingFee({ provider: "gemini", model: "gemini-2.5-pro", grounding: grounded }))
      .toMatchObject({ usd: 0.035, pool: "gemini-2.5-pro" });
  });

  it("bills Gemini 3 per search query", () => {
    expect(calculateSearchGroundingFee({ provider: "gemini", model: "gemini-3.5-flash", grounding: { searchQueries: 4, webSources: 9 } }))
      .toEqual({ usd: 0.056, listUsd: 0.056, units: 4, groundedPrompt: true, pool: "gemini-3" });
  });

  it("leaves grounding on an unknown model unpriced rather than free, but a search that ran nothing costs nothing", () => {
    expect(calculateSearchGroundingFee({ provider: "gemini", model: "gemini-9-ultra", grounding: { searchQueries: 2, webSources: 3 } }))
      .toEqual({ usd: null, listUsd: null, units: 0, groundedPrompt: true, pool: null });
    expect(calculateSearchGroundingFee({ provider: "gemini", model: "gemini-9-ultra", grounding: { searchQueries: 0, webSources: 0 } }).usd)
      .toBe(0);
    expect(calculateSearchGroundingFee({ provider: "openai", model: "gemini-2.5-flash", grounding: grounded }).usd).toBeNull();
  });
});

describe("the free allowance", () => {
  it("prices the 1,500th grounded prompt of a Pacific day free and the 1,501st at list", () => {
    expect(flashFeeAt(1_500)).toMatchObject({
      usd: 0, listUsd: 0.035,
      allowance: { period: "2026-09-30", ordinal: 1_500, allowanceUnits: 1_500, freeUnits: 1, covered: true }
    });
    expect(flashFeeAt(1_501)).toMatchObject({
      usd: 0.035, listUsd: 0.035,
      allowance: { period: "2026-09-30", ordinal: 1_501, allowanceUnits: 1_500, freeUnits: 0, covered: false }
    });
  });

  it("rolls the daily period over at Pacific midnight, through daylight saving too", () => {
    expect(searchGroundingPeriod(flashRate, new Date("2026-10-01T06:59:59.999Z"))).toBe("2026-09-30");
    expect(searchGroundingPeriod(flashRate, new Date("2026-10-01T07:00:00.000Z"))).toBe("2026-10-01");
    // PST is UTC-8 once daylight saving ends on 2026-11-01.
    expect(searchGroundingPeriod(flashRate, new Date("2026-12-01T07:59:59.999Z"))).toBe("2026-11-30");
    expect(searchGroundingPeriod(flashRate, new Date("2026-12-01T08:00:00.000Z"))).toBe("2026-12-01");
  });

  it("pools Gemini 3 queries by Pacific month, and splits a call that straddles the allowance", () => {
    expect(searchGroundingPeriod(gemini3Rate, new Date("2026-10-01T06:59:59.999Z"))).toBe("2026-09");
    expect(searchGroundingPeriod(gemini3Rate, new Date("2026-10-01T07:00:00.000Z"))).toBe("2026-10");
    const fee = calculateSearchGroundingFee({ provider: "gemini", model: "gemini-3.7-flash", grounding: { searchQueries: 4, webSources: 6 } });
    const claim = searchGroundingClaim(fee, { at: noon })!;
    expect(claim).toEqual({ pool: "gemini-3", period: "2026-09", units: 4, allowanceUnits: 5_000 });
    // Queries 4,999–5,002: two inside the 5,000, two billed at $0.014.
    expect(applySearchGroundingAllowance(fee, claim, 5_002)).toMatchObject({
      usd: 0.028, listUsd: 0.056, allowance: { ordinal: 5_002, freeUnits: 2, covered: false }
    });
  });

  it("charges list price for every prompt when the allowance is set to 0", () => {
    expect(flashFeeAt(1, { SEARCH_GROUNDING_FREE_GEMINI_25_FLASH_PER_DAY: 0 }))
      .toMatchObject({ usd: 0.035, allowance: { ordinal: 1, allowanceUnits: 0, freeUnits: 0, covered: false } });
  });

  it("reads the allowance from configuration, falling back to Google's number", () => {
    expect(searchGroundingAllowance(flashRate, loadConfig({ NODE_ENV: "development" }))).toBe(1_500);
    expect(searchGroundingAllowance(flashRate, loadConfig({ NODE_ENV: "development", SEARCH_GROUNDING_FREE_GEMINI_25_FLASH_PER_DAY: "0" }))).toBe(0);
    expect(searchGroundingAllowance(gemini3Rate, loadConfig({ NODE_ENV: "development", SEARCH_GROUNDING_FREE_GEMINI_3_PER_MONTH: "1200" }))).toBe(1_200);
    expect(() => loadConfig({ NODE_ENV: "development", SEARCH_GROUNDING_FREE_GEMINI_25_PRO_PER_DAY: "-1" })).toThrow();
    expect(searchGroundingAllowance(flashRate, { SEARCH_GROUNDING_FREE_GEMINI_25_FLASH_PER_DAY: Number.NaN })).toBe(1_500);
  });

  it("claims nothing for a call that bills nothing, or that no rate card priced", () => {
    const ungrounded = calculateSearchGroundingFee({ ...flash, grounding: { searchQueries: 2, webSources: 0 } });
    const unknown = calculateSearchGroundingFee({ provider: "gemini", model: "gemini-9-ultra", grounding: grounded });
    expect(searchGroundingClaim(ungrounded, { at: noon })).toBeNull();
    expect(searchGroundingClaim(unknown, { at: noon })).toBeNull();
  });
});

describe("a search call's row", () => {
  it("settles at tokens plus the billed fee, and unpriced when either half is", () => {
    // 198 × $0.30/M + 1,518 × $2.50/M, the 2026-09-30 Quick Draft averages, is $0.0038544 in tokens.
    const tokens = calculateTextGenerationCost({ ...flash, promptTokens: 198, outputTokens: 1_518 });
    expect(tokens).toBe(0.003854);
    expect(searchCallCostHint(tokens, flashFeeAt(12))).toBe(0.003854);
    expect(searchCallCostHint(tokens, flashFeeAt(1_501))).toBe(0.038854);
    expect(searchCallCostHint(null, flashFeeAt(1_501))).toBeNull();
    expect(searchCallCostHint(tokens, { ...flashFeeAt(1), usd: null })).toBeNull();
  });

  it("records where the call fell in its allowance, and the project summary replays the billed fee", () => {
    const metadata = searchGroundingMetadata(grounded, flashFeeAt(790));
    expect(metadata).toEqual({
      groundedPrompt: true, webSearchQueries: 4, groundingSources: 10,
      groundingFeeUsd: 0, groundingListFeeUsd: 0.035, groundingPool: "gemini-2.5-flash", groundingUnits: 1,
      groundingPeriod: "2026-09-30", groundingOrdinal: 790, groundingAllowance: 1_500, groundingFreeUnits: 1, groundingAllowanceCovered: true
    });
    const row = { ...flash, promptTokens: 198, outputTokens: 1_518 };
    expect(calculateTextGenerationCost({ ...row, metadata })).toBe(0.003854);
    expect(calculateTextGenerationCost({ ...row, metadata: searchGroundingMetadata(grounded, flashFeeAt(1_501)) })).toBe(0.038854);
    expect(calculateTextGenerationCost({ ...row, metadata: { ...metadata, groundingFeeUsd: null } })).toBeNull();
    expect(calculateTextGenerationCost({ ...row, costHint: 0.5, metadata: { ...metadata, groundingFeeUsd: null } })).toBe(0.5);
  });

  it("names each pool's published allowance", () => {
    expect(searchGroundingRateForPool("gemini-2.5-flash")).toEqual({
      pool: "gemini-2.5-flash", basis: "grounded_prompt", usdPerUnit: 0.035,
      allowance: { period: "day", units: 1_500, setting: "SEARCH_GROUNDING_FREE_GEMINI_25_FLASH_PER_DAY" }
    });
    expect(searchGroundingRateForPool("gemini-3")?.allowance).toMatchObject({ period: "month", units: 5_000 });
    expect(searchGroundingRateForPool("bing")).toBeNull();
  });
});
