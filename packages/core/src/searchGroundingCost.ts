import type { SearchGroundingUsage } from "./adapters/types.js";

/**
 * What Grounding with Google Search costs, apart from the tokens around it.
 *
 * Google's list price (ai.google.dev/gemini-api/docs/pricing, read 2026-09-30):
 *
 * - Gemini 2.5 Flash, Flash-Lite and Pro: $35 per 1,000 grounded prompts — one
 *   charge per prompt however many searches it ran, and only for a prompt that
 *   came back with at least one web source. Flash and Flash-Lite share 1,500
 *   free prompts a Pacific-time day; Pro has its own 1,500.
 * - Gemini 3.x: $14 per 1,000 search queries — each query the model chose to
 *   run — with 5,000 free a month across every 3.x model.
 *
 * A call is priced by **where its units fall in its pool's free allowance**:
 * the recorder claims them from a per-pool, per-period counter
 * (`@book-maker/db/searchGroundingAllowance`) in the transaction that writes
 * the call's row, and the units inside the allowance cost nothing. The
 * allowance is a setting (`SEARCH_GROUNDING_FREE_*`) because the counter sees
 * only the calls this system logs, while Google's pool is per Google project:
 * anything else holding the key draws on it too. Reasoning in
 * adapters/CLAUDE.md and apps/api/src/admin/CLAUDE.md.
 */

/** The settings that override Google's published allowance, one per pool; 0 prices every unit at list. */
export type SearchGroundingAllowanceConfig = {
  SEARCH_GROUNDING_FREE_GEMINI_25_FLASH_PER_DAY?: number | undefined;
  SEARCH_GROUNDING_FREE_GEMINI_25_PRO_PER_DAY?: number | undefined;
  SEARCH_GROUNDING_FREE_GEMINI_3_PER_MONTH?: number | undefined;
};

export type SearchGroundingRate = {
  /** The free allowance these calls draw on; the models in one pool share it. */
  pool: string;
  basis: "grounded_prompt" | "search_query";
  usdPerUnit: number;
  /** Google's published allowance per Pacific-time day or month, and the setting that overrides it. */
  allowance: { period: "day" | "month"; units: number; setting: keyof SearchGroundingAllowanceConfig };
};

export type SearchGroundingFee = {
  /**
   * What the call adds to `costHint`: list price for its units past the free
   * allowance, nothing for those inside it. `null` when the call grounded on a
   * model no rate card knows — it is then unpriced, never priced on tokens alone.
   */
  usd: number | null;
  /** The same units at list price, as if no allowance existed. */
  listUsd: number | null;
  /** What was billable: one grounded prompt or none on 2.5, the search queries on 3.x. */
  units: number;
  groundedPrompt: boolean;
  pool: string | null;
  /** Where the units fell in their pool's allowance; absent until a counter has been claimed. */
  allowance?: {
    period: string;
    /** The pool-period's count including this call's units — its last unit's ordinal. */
    ordinal: number;
    allowanceUnits: number;
    freeUnits: number;
    covered: boolean;
  } | undefined;
};

/** The units one call claims from its pool's counter for a period. */
export type SearchGroundingClaim = { pool: string; period: string; units: number; allowanceUnits: number };

const SEARCH_GROUNDING_RATES: readonly SearchGroundingRate[] = [
  {
    pool: "gemini-2.5-flash", basis: "grounded_prompt", usdPerUnit: 0.035,
    allowance: { period: "day", units: 1_500, setting: "SEARCH_GROUNDING_FREE_GEMINI_25_FLASH_PER_DAY" }
  },
  {
    pool: "gemini-2.5-pro", basis: "grounded_prompt", usdPerUnit: 0.035,
    allowance: { period: "day", units: 1_500, setting: "SEARCH_GROUNDING_FREE_GEMINI_25_PRO_PER_DAY" }
  },
  {
    pool: "gemini-3", basis: "search_query", usdPerUnit: 0.014,
    allowance: { period: "month", units: 5_000, setting: "SEARCH_GROUNDING_FREE_GEMINI_3_PER_MONTH" }
  }
];

/** A dated, preview or `-latest` build is billed as the model it builds. */
const SEARCH_GROUNDING_POOL_BY_MODEL: ReadonlyArray<[RegExp, string]> = [
  [/^gemini-2\.5-flash(?:-lite)?(?:-(?:preview|latest|\d)[\w.-]*)?$/, "gemini-2.5-flash"],
  [/^gemini-2\.5-pro(?:-(?:preview|latest|\d)[\w.-]*)?$/, "gemini-2.5-pro"],
  [/^gemini-3(?:\.\d+)?-(?:flash|pro)(?:-lite)?(?:-(?:preview|latest|\d)[\w.-]*)?$/, "gemini-3"]
];

/** Google resets its daily quotas at midnight Pacific time; the parts keep this independent of locale. */
const PACIFIC_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit"
});

export function searchGroundingRateForPool(pool: string): SearchGroundingRate | null {
  return SEARCH_GROUNDING_RATES.find((rate) => rate.pool === pool) ?? null;
}

/** The free units per period this deployment assumes for a pool: the setting if one is given, else Google's number. */
export function searchGroundingAllowance(rate: SearchGroundingRate, config: SearchGroundingAllowanceConfig = {}): number {
  const configured = config[rate.allowance.setting];
  return typeof configured === "number" && Number.isInteger(configured) && configured >= 0 ? configured : rate.allowance.units;
}

/** The allowance period a moment belongs to: its Pacific date (`2026-09-30`) or month (`2026-09`). */
export function searchGroundingPeriod(rate: SearchGroundingRate, at: Date): string {
  const parts = Object.fromEntries(PACIFIC_DATE.formatToParts(at).map((part) => [part.type, part.value]));
  const month = `${parts.year}-${parts.month}`;
  return rate.allowance.period === "month" ? month : `${month}-${parts.day}`;
}

function searchGroundingRate(provider: string | null | undefined, model: string | null | undefined): SearchGroundingRate | null {
  const name = typeof model === "string" ? model.trim().toLowerCase().replace(/^models\//, "") : "";
  if (typeof provider !== "string" || provider.trim().toLowerCase() !== "gemini" || !name) {
    return null;
  }
  const pool = SEARCH_GROUNDING_POOL_BY_MODEL.find(([pattern]) => pattern.test(name))?.[1];
  return pool ? searchGroundingRateForPool(pool) : null;
}

/** The call's fee at list price, before any allowance is claimed. */
export function calculateSearchGroundingFee(input: {
  provider?: string | null | undefined;
  model?: string | null | undefined;
  grounding: SearchGroundingUsage;
}): SearchGroundingFee {
  const searchQueries = wholeCount(input.grounding.searchQueries);
  const groundedPrompt = wholeCount(input.grounding.webSources) > 0;
  const rate = searchGroundingRate(input.provider, input.model);
  if (searchQueries === 0 && !groundedPrompt) {
    // Nothing searched and nothing cited: there is no grounding to bill, on any model.
    return { usd: 0, listUsd: 0, units: 0, groundedPrompt, pool: rate?.pool ?? null };
  }
  if (!rate) {
    return { usd: null, listUsd: null, units: 0, groundedPrompt, pool: null };
  }
  const units = rate.basis === "grounded_prompt" ? (groundedPrompt ? 1 : 0) : searchQueries;
  const listUsd = roundUsd(units * rate.usdPerUnit);
  return { usd: listUsd, listUsd, units, groundedPrompt, pool: rate.pool };
}

/** What a call must claim from its pool's counter before it can be priced, or `null` when it bills nothing. */
export function searchGroundingClaim(
  fee: SearchGroundingFee,
  options: { at: Date; allowances?: SearchGroundingAllowanceConfig | undefined }
): SearchGroundingClaim | null {
  const rate = fee.pool ? searchGroundingRateForPool(fee.pool) : null;
  if (!rate || fee.usd === null || fee.units <= 0) {
    return null;
  }
  return {
    pool: rate.pool,
    period: searchGroundingPeriod(rate, options.at),
    units: fee.units,
    allowanceUnits: searchGroundingAllowance(rate, options.allowances)
  };
}

/**
 * Prices a claimed call by where its units fell. `countAfter` is the
 * pool-period's count *including* this call's units, as the counter returned
 * it: every unit at or below the allowance is free, every one past it is billed
 * at list.
 */
export function applySearchGroundingAllowance(fee: SearchGroundingFee, claim: SearchGroundingClaim, countAfter: number): SearchGroundingFee {
  const rate = searchGroundingRateForPool(claim.pool);
  if (!rate || fee.usd === null) {
    return fee;
  }
  const before = Math.max(0, countAfter - claim.units);
  const freeUnits = Math.max(0, Math.min(claim.units, claim.allowanceUnits - before));
  return {
    ...fee,
    usd: roundUsd((claim.units - freeUnits) * rate.usdPerUnit),
    allowance: { period: claim.period, ordinal: countAfter, allowanceUnits: claim.allowanceUnits, freeUnits, covered: freeUnits === claim.units }
  };
}

/** A search call's settled price: its tokens plus its grounding fee, and unpriced when either is. */
export function searchCallCostHint(tokenCostUsd: number | null, fee: SearchGroundingFee): number | null {
  return tokenCostUsd === null || fee.usd === null ? null : roundUsd(tokenCostUsd + fee.usd);
}

/**
 * What a search call's `ProviderCallLog.metadata` carries, written the same by
 * every recorder and by the re-price script. `groundingFeeUsd` is the part of
 * `costHint` that is grounding — `null` included, its presence is what marks a
 * row as a grounded search to the project summary's replay — and the
 * `groundingPeriod` / `groundingOrdinal` / `groundingAllowanceCovered` triple
 * is where the call fell in its pool's free allowance.
 */
export function searchGroundingMetadata(grounding: SearchGroundingUsage, fee: SearchGroundingFee) {
  return {
    groundedPrompt: fee.groundedPrompt,
    webSearchQueries: wholeCount(grounding.searchQueries),
    groundingSources: wholeCount(grounding.webSources),
    groundingFeeUsd: fee.usd,
    groundingListFeeUsd: fee.listUsd,
    ...(fee.pool ? { groundingPool: fee.pool, groundingUnits: fee.units } : {}),
    ...(fee.allowance
      ? {
          groundingPeriod: fee.allowance.period,
          groundingOrdinal: fee.allowance.ordinal,
          groundingAllowance: fee.allowance.allowanceUnits,
          groundingFreeUnits: fee.allowance.freeUnits,
          groundingAllowanceCovered: fee.allowance.covered
        }
      : {})
  };
}

function wholeCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** The precision every cost here is settled at (`COST_PRECISION` in costs.ts). */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
