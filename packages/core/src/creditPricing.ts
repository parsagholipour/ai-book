/**
 * What every priced operation costs, and where that answer comes from.
 *
 * These numbers used to be a frozen `as const` read straight from the module,
 * which meant changing a price needed a build and a deploy. They are now a
 * *snapshot*: this file owns the defaults and the process-local copy in use,
 * and `packages/db/src/creditPricing.ts` loads the operator's overrides out of
 * Postgres and pushes them in here. Core is the leaf of the dependency graph and
 * cannot reach a database, so it deliberately knows nothing about where the
 * override came from.
 *
 * Two rules keep the snapshot honest:
 *
 * - **Only the API process writes it.** `apps/worker` prices nothing — it
 *   refunds against ledger entries that already record their amount — so a
 *   worker that never initializes the snapshot is correct, not stale.
 * - **Write it only after the change is committed.** Applying a price the
 *   database later rolls back would have the process charging money that no
 *   revision row can account for.
 *
 * The pure pricing functions all accept an explicit `pricing` argument that
 * defaults to {@link creditPricing}. That is what lets the dashboard price a
 * proposed change without making it real for everyone else mid-request.
 */

import { z } from "zod";

export const DEFAULT_CREDIT_COSTS = {
  planGeneration: 0,
  previewGeneration: 0,
  fullBookBase: 350,
  fullBookPerPage: 8,
  imageGeneration: 45,
  coverRegeneration: 120,
  premiumReview: 200,
  exportUnlock: 150,
  planRevision: 40,
  bookTextEditBase: 25,
  bookTextEditPerPage: 10,
  pageRegenerationPerPage: 80,
  bookReplanBase: 120,
  voiceCallPerMinute: 60,
  // Not prices — the free tier's monthly limits. They live here because they are
  // the same kind of knob: something an operator has to be able to move against
  // abuse without a deploy, with the same audit trail behind it. Paid tiers take
  // their allowance from the product catalog instead, since those numbers are
  // pinned to a Play price point that cannot change without one.
  freeMonthlyCredits: 1_000,
  freeIllustratedBooksPerMonth: 3
} as const;

export type CreditPricingKey = keyof typeof DEFAULT_CREDIT_COSTS;
export type CreditPricing = { [K in CreditPricingKey]: number };

export const CREDIT_PRICING_KEYS = Object.keys(DEFAULT_CREDIT_COSTS) as CreditPricingKey[];

/**
 * The entries that are a plan limit rather than a price per unit of work.
 *
 * They share this table because they share the operator workflow — same audit
 * trail, same live reload — but they are not multiplied by a quantity, so
 * anything projecting revenue has to leave them out or it will invent income
 * from the free tier.
 */
export const PLAN_ALLOWANCE_KEYS = ["freeMonthlyCredits", "freeIllustratedBooksPerMonth"] as const;

export type PlanAllowanceKey = (typeof PLAN_ALLOWANCE_KEYS)[number];
export type CreditPriceKey = Exclude<CreditPricingKey, PlanAllowanceKey>;

export const CREDIT_PRICE_KEYS = CREDIT_PRICING_KEYS.filter(
  (key): key is CreditPriceKey => !(PLAN_ALLOWANCE_KEYS as readonly string[]).includes(key)
);

/**
 * Per-key ceilings, because the failure mode here is a typo that charges real
 * money immediately.
 *
 * Rates that multiply — per page, per minute — get a much tighter ceiling than
 * the flat one-off charges: `fullBookPerPage` at 80000 instead of 8 would bill a
 * 300-page book twenty-four million credits before anyone noticed.
 */
export const CREDIT_PRICING_LIMITS: Record<CreditPricingKey, number> = {
  planGeneration: 5_000,
  previewGeneration: 5_000,
  fullBookBase: 100_000,
  fullBookPerPage: 2_000,
  imageGeneration: 5_000,
  coverRegeneration: 10_000,
  premiumReview: 20_000,
  exportUnlock: 20_000,
  planRevision: 5_000,
  bookTextEditBase: 5_000,
  bookTextEditPerPage: 2_000,
  pageRegenerationPerPage: 5_000,
  bookReplanBase: 20_000,
  voiceCallPerMinute: 2_000,
  // Generous ceilings: the failure mode for an allowance is giving too much
  // away, which is bounded and reversible next period, not an instant charge.
  freeMonthlyCredits: 100_000,
  freeIllustratedBooksPerMonth: 100
};

/**
 * The strict gate for a *write*.
 *
 * Unknown keys are rejected rather than dropped: a dashboard sending a key this
 * build does not know about is a version mismatch worth surfacing, not something
 * to swallow. Zero is legal everywhere — two operations are free today.
 */
export const creditPricingInputSchema = z
  .object(
    Object.fromEntries(
      CREDIT_PRICING_KEYS.map((key) => [key, z.number().int().min(0).max(CREDIT_PRICING_LIMITS[key])])
    ) as { [K in CreditPricingKey]: z.ZodNumber }
  )
  .strict();

let activePricing: CreditPricing = Object.freeze({ ...DEFAULT_CREDIT_COSTS });

/**
 * The prices this process is charging right now.
 *
 * Frozen rather than copied per call: this is read on nearly every priced
 * request, and freezing once at write time costs nothing while still making
 * "someone mutated the live prices in place" impossible.
 */
export function creditPricing(): CreditPricing {
  return activePricing;
}

/**
 * Replace the live prices.
 *
 * Takes a complete {@link CreditPricing}, never a partial. Merging a partial
 * would quietly break revert: add a fifteenth key next year and reverting to a
 * revision written before it existed would keep the *current* value for that key
 * instead of restoring its default. {@link normalizeCreditPricing} is the one
 * place a gap is allowed to be filled.
 */
export function setCreditPricing(values: CreditPricing): CreditPricing {
  activePricing = Object.freeze({ ...values });
  return activePricing;
}

/** Drop back to the compiled-in defaults. Tests that mutate pricing must call this. */
export function resetCreditPricing(): CreditPricing {
  activePricing = Object.freeze({ ...DEFAULT_CREDIT_COSTS });
  return activePricing;
}

/**
 * The forgiving gate for a *read*.
 *
 * Anything stored that this build cannot make sense of — an unknown key, a
 * negative, a float, a value past its ceiling — falls back to that key's
 * default. A malformed row must not stop the API booting, and charging the
 * default is the safe wrong answer.
 */
export function normalizeCreditPricing(raw: unknown): CreditPricing {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const values = {} as CreditPricing;
  for (const key of CREDIT_PRICING_KEYS) {
    const candidate = record[key];
    values[key] =
      typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate <= CREDIT_PRICING_LIMITS[key]
        ? candidate
        : DEFAULT_CREDIT_COSTS[key];
  }
  return values;
}

export type CreditPricingChange = { from: number; to: number };

/** Only the keys that moved, so a revision records the change rather than the state. */
export function diffCreditPricing(before: CreditPricing, after: CreditPricing): Partial<Record<CreditPricingKey, CreditPricingChange>> {
  const changed: Partial<Record<CreditPricingKey, CreditPricingChange>> = {};
  for (const key of CREDIT_PRICING_KEYS) {
    if (before[key] !== after[key]) {
      changed[key] = { from: before[key], to: after[key] };
    }
  }
  return changed;
}
