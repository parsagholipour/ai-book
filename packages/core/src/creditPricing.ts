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
  // Ordinary chat is priced by subscription plan, independently of book effort.
  // Free accounts spend their welcome/purchased balance on every message.
  // The daily limit is an abuse ceiling, not an included message allowance.
  messageCreditsFree: 1,
  messageDailyLimitFree: 50,
  messageResetCreditsFree: 50,
  messageResetEnabledFree: 1,
  // A paid plan's messages are free up to its daily limit, and the limit is the
  // spend: at the old 150/300/600 a Creator reader chatting to the cap cost an
  // estimated $9–45 a month on its own (launch review, 2026-10-13).
  messageCreditsCreator: 0,
  messageDailyLimitCreator: 60,
  messageResetCreditsCreator: 100,
  messageResetEnabledCreator: 1,
  messageCreditsPro: 0,
  messageDailyLimitPro: 120,
  messageResetCreditsPro: 150,
  messageResetEnabledPro: 1,
  messageCreditsMax: 0,
  messageDailyLimitMax: 300,
  messageResetCreditsMax: 200,
  messageResetEnabledMax: 1,

  // Initial planning follows the same model tier as the book it shapes. The
  // unsuffixed key remains Balanced; `planGenerationCreditCost` is the only
  // initial-plan resolver and selects the concrete key for the other tiers.
  planGeneration: 40,
  planGenerationFast: 20,
  planGenerationPremium: 80,
  planGenerationUltra: 120,
  previewGeneration: 0,
  fullBookBase: 350,
  fullBookPerPage: 8,
  imageGeneration: 45,
  coverRegeneration: 120,
  premiumReview: 200,
  // Retired 2026-10-15: a finished book downloads free, so nothing charges
  // this. Held at 0 (its ceiling is 0, so a stored 150 reads as 0) rather than
  // deleted, because installed apps add `creditCosts.exportUnlock` to their
  // book quote and fall back to 150 when the key is missing. Not a price:
  // `RETIRED_CREDIT_PRICING_KEYS` keeps it out of every projection.
  exportUnlock: 0,
  // A revision runs the same planner the first plan ran, so it climbs the same
  // ladder; the unsuffixed key is still the balanced rate.
  planRevision: 40,
  planRevisionFast: 20,
  planRevisionPremium: 80,
  planRevisionUltra: 120,
  bookTextEditBase: 25,
  bookTextEditPerPage: 10,
  pageRegenerationPerPage: 80,
  // Pages a finished book *gains* — a chat continuation's new chapters and a
  // structural insert's new pages — are priced like the book they join: this
  // flat base, then the tier's own `fullBookPerPage` for each page added
  // (`addedPagesCreditCost` in apps/api). They used to bill
  // `pageRegenerationPerPage`, so ten more pages cost more than a new ten-page
  // book. A rewrite of an existing page keeps the rewrite rate.
  addedPagesBase: 100,
  bookReplanBase: 120,
  // The quality tier's own rates. An unsuffixed key above *is* the balanced
  // rate — the tier that existed when there was only one — so every price
  // revision written before tiers were priced still means exactly what it
  // meant, and `normalizeCreditPricing` backfills these from the defaults.
  // Read them only through `tierPrice` in `billing.ts`; see `TIER_PRICED_KEYS`
  // for why these rates and not the flat charges beside them.
  //
  // The per-page rates are floored at the *Max* plan's break-even, not the
  // ratio to balanced. A credit is worth $0.002832 to a Creator subscriber but
  // only $0.002125 to a Max one after Google Play's cut, and Max is the plan
  // someone can burn 80,000 credits of writing on — so a rate that merely
  // tracked the provider-cost ratio (22 for premium, against $0.05 a page)
  // billed a long premium book at a loss. 30 clears it by ~25%.
  fullBookBaseFast: 220,
  fullBookBasePremium: 500,
  fullBookPerPageFast: 5,
  fullBookPerPagePremium: 30,
  // Fast and balanced share an image model, so this deliberately equals the
  // balanced rate. It exists anyway so the resolver has no hole to special-case
  // and an operator can separate them later without a deploy.
  imageGenerationFast: 45,
  imageGenerationPremium: 85,
  pageRegenerationPerPageFast: 40,
  pageRegenerationPerPagePremium: 220,
  bookTextEditPerPageFast: 5,
  bookTextEditPerPagePremium: 28,
  fullBookBaseUltra: 650,
  // Max break-even on the one measured ultra book, not on an assumed page cost:
  // 20 pages cost $5.97 to write (docs/tier-audit-20-pages-2026-09-20.md), so the
  // whole charge has to clear $5.97 / $0.002125 × 1.25 ≈ 3,510 credits, and
  // (3,510 − 650 base − 120 plan − 150 export) / 20 ≈ 130. The old 71 assumed
  // $0.12 a page and billed that book at $5.40 on Max. That run predates the
  // 2026-09-21 effort fix, so this is the safe side of an unmeasured number:
  // re-measure and lower it at /pricing, which needs no release. The 150
  // export unlock that sum counted was removed on 2026-10-15, so that book now
  // charges 3,370 (×1.20 of cost, not ×1.25); re-measure before switching
  // Ultra on.
  fullBookPerPageUltra: 130,
  imageGenerationUltra: 85,
  pageRegenerationPerPageUltra: 280,
  bookTextEditPerPageUltra: 36,
  // Modelled at $0.57–2.60 per ten minutes and never measured; at 60 a busy
  // call lost money on every plan. Voice calls are a plan perk now as well
  // (`routes/voice.ts`); measure on the Operations tab before lowering this.
  voiceCallPerMinute: 120,
  audiobookBase: 80,
  // Narration is billed by the words read aloud, because that is what the
  // speech provider bills: $0.00025 a second of audio, ~155 words a minute, so
  // 100 words cost ~$0.0097 and clear the Max break-even ×1.25 at 6 credits.
  // A flat 12 a page lost money on every prose page (~450 words, ~$0.044 of
  // audio) and charged a 60-word picture-book page twelve times its cost.
  // `audiobookPerPage` stays an operator knob and defaults to nothing.
  audiobookPerPage: 0,
  audiobookPer100Words: 6,
  characterPortraitGeneration: 45,
  // Not prices — the free tier's limits. They live here because they are the
  // same kind of knob: something an operator has to be able to move against
  // abuse without a deploy, with the same audit trail behind it. Paid tiers take
  // their allowance from the product catalog instead, since those numbers are
  // pinned to a Play price point that cannot change without one.
  // Retained for older clients and pricing revisions; recurring free grants are disabled.
  freeMonthlyCredits: 0,
  // Enough for any free reader's first book on Balanced, with its plan and a
  // few chat messages, so no reader meets the paywall before their first book
  // exists. No book's price carries an export unlock, so the largest
  // non-picture book, a 30-page illustrated workbook, is 905 plus its 40-credit
  // plan, and the largest picture book — 30 pages, twelve pictures
  // (`pictureBookIllustrationCap`), a drawn cover — is 1,175 plus its plan:
  // 1,215. 1,150 left every picture book of 22 pages or more out (migration
  // 000110 moves an installation still on it); `welcomeCredits.test.ts` in core
  // walks every free length.
  welcomeCredits: 1_250,
  welcomeCreditsEnabled: 1,
  welcomeCreditsRegionalEnabled: 0,
  welcomeCreditsHighIncome: 1_250,
  welcomeCreditsLowMiddleIncome: 1_250,
  // Accounts one address may be welcomed on in 30 days. A grant waits for a
  // verified email now, so the cap only has to stop a farm, not every second
  // sign-up: at one, a whole carrier NAT or a family on one router got nothing
  // past its first reader, silently (launch review, 2026-10-13; migration 000110).
  welcomeCreditsAccountsPerIpHighIncome: 3,
  welcomeCreditsAccountsPerIpLowMiddleIncome: 2,
  freeIllustratedBooksPerMonth: 3,
  freeManuscriptImportsPerMonth: 1,
  // The longest book a free account may have generated. Longer books — up to
  // the 600-page ceiling every request schema already enforces — are a plan
  // perk. Zero would refuse every free generation.
  freeMaxBookPages: 30,
  // The longest book *any* account may have generated, a plan included. Until
  // a long illustrated compile is measured on the production host, nothing
  // longer is offered; imports and Studio books are not generated and stay
  // exempt (`bookPageLimit.ts`). Bounded 30–600 (`CREDIT_PRICING_MINIMUMS`).
  paidMaxBookPages: 200,
  // A switch, not a price: 1 lets new books start on the Ultra effort, 0 hides
  // it. Off at launch — Ultra is unmeasured on today's routing and its one
  // measured run failed and cost $8. Books already on Ultra keep their tier for
  // every edit (`ultraTier.ts` in apps/api).
  ultraTierEnabled: 0
} as const;

export type CreditPricingKey = keyof typeof DEFAULT_CREDIT_COSTS;
export type CreditPricing = { [K in CreditPricingKey]: number };

/** Earlier persisted names, shared by value and revision-history readers. */
export const LEGACY_CREDIT_PRICING_KEYS: Partial<Record<CreditPricingKey, string>> = {
  welcomeCreditsHighIncome: "welcomeCreditsUsEuCanada",
  welcomeCreditsLowMiddleIncome: "welcomeCreditsAsiaAfricaSouthAmerica"
};

export const CREDIT_PRICING_KEYS = Object.keys(DEFAULT_CREDIT_COSTS) as CreditPricingKey[];

/**
 * The entries that are a plan limit rather than a price per unit of work.
 *
 * They share this table because they share the operator workflow — same audit
 * trail, same live reload — but they are not multiplied by a quantity, so
 * anything projecting revenue has to leave them out or it will invent income
 * from the free tier.
 */
export const PLAN_ALLOWANCE_KEYS = [
  "messageDailyLimitFree",
  "messageResetEnabledFree",
  "messageDailyLimitCreator",
  "messageResetEnabledCreator",
  "messageDailyLimitPro",
  "messageResetEnabledPro",
  "messageDailyLimitMax",
  "messageResetEnabledMax",

  "freeMonthlyCredits",
  "welcomeCredits",
  "welcomeCreditsEnabled",
  "welcomeCreditsRegionalEnabled",
  "welcomeCreditsHighIncome",
  "welcomeCreditsLowMiddleIncome",
  "welcomeCreditsAccountsPerIpHighIncome",
  "welcomeCreditsAccountsPerIpLowMiddleIncome",
  "freeIllustratedBooksPerMonth",
  "freeManuscriptImportsPerMonth",
  "freeMaxBookPages",
  "paidMaxBookPages",
  "ultraTierEnabled"
] as const;

export type PlanAllowanceKey = (typeof PLAN_ALLOWANCE_KEYS)[number];

/**
 * Keys nothing charges any more, held at 0 by a ceiling of 0. They stay in the
 * table so a stored price list still parses and the billing payload still
 * carries them for installed apps that read them, but they are no price: a
 * projection that counted them would invent income from work that is free.
 * `exportUnlock` is the one — every finished book downloads free since
 * 2026-10-15 (`apps/api/src/mobile/CLAUDE.md`).
 */
export const RETIRED_CREDIT_PRICING_KEYS = ["exportUnlock"] as const;

export type RetiredCreditPricingKey = (typeof RETIRED_CREDIT_PRICING_KEYS)[number];
export type CreditPriceKey = Exclude<CreditPricingKey, PlanAllowanceKey | RetiredCreditPricingKey>;

export const CREDIT_PRICE_KEYS = CREDIT_PRICING_KEYS.filter(
  (key): key is CreditPriceKey =>
    !(PLAN_ALLOWANCE_KEYS as readonly string[]).includes(key) &&
    !(RETIRED_CREDIT_PRICING_KEYS as readonly string[]).includes(key)
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
  messageCreditsFree: 1000,
  messageDailyLimitFree: 100000,
  messageResetCreditsFree: 100000,
  messageResetEnabledFree: 1,
  messageCreditsCreator: 1000,
  messageDailyLimitCreator: 100000,
  messageResetCreditsCreator: 100000,
  messageResetEnabledCreator: 1,
  messageCreditsPro: 1000,
  messageDailyLimitPro: 100000,
  messageResetCreditsPro: 100000,
  messageResetEnabledPro: 1,
  messageCreditsMax: 1000,
  messageDailyLimitMax: 100000,
  messageResetCreditsMax: 100000,
  messageResetEnabledMax: 1,

  planGeneration: 5_000,
  planGenerationFast: 5_000,
  planGenerationPremium: 5_000,
  planGenerationUltra: 5_000,
  previewGeneration: 5_000,
  fullBookBase: 100_000,
  fullBookPerPage: 2_000,
  imageGeneration: 5_000,
  coverRegeneration: 10_000,
  premiumReview: 20_000,
  // Retired: a write cannot set it and a stored 150 reads back as 0.
  exportUnlock: 0,
  planRevision: 5_000,
  planRevisionFast: 5_000,
  planRevisionPremium: 5_000,
  planRevisionUltra: 5_000,
  bookTextEditBase: 5_000,
  bookTextEditPerPage: 2_000,
  pageRegenerationPerPage: 5_000,
  addedPagesBase: 20_000,
  bookReplanBase: 20_000,
  // Each tier rate is bounded exactly like the balanced rate it varies, so a
  // premium multiplier cannot be given more room than the price it derives from.
  fullBookBaseFast: 100_000,
  fullBookBasePremium: 100_000,
  fullBookPerPageFast: 2_000,
  fullBookPerPagePremium: 2_000,
  imageGenerationFast: 5_000,
  imageGenerationPremium: 5_000,
  pageRegenerationPerPageFast: 5_000,
  pageRegenerationPerPagePremium: 5_000,
  bookTextEditPerPageFast: 2_000,
  bookTextEditPerPagePremium: 2_000,
  fullBookBaseUltra: 100_000,
  fullBookPerPageUltra: 2_000,
  imageGenerationUltra: 5_000,
  pageRegenerationPerPageUltra: 5_000,
  bookTextEditPerPageUltra: 2_000,
  voiceCallPerMinute: 2_000,
  audiobookBase: 20_000,
  audiobookPerPage: 2_000,
  audiobookPer100Words: 2_000,
  characterPortraitGeneration: 5_000,
  // Generous ceilings: the failure mode for an allowance is giving too much
  // away, which is bounded and reversible, not an instant charge.
  freeMonthlyCredits: 0,
  welcomeCredits: 100_000,
  welcomeCreditsEnabled: 1,
  welcomeCreditsRegionalEnabled: 1,
  welcomeCreditsHighIncome: 100_000,
  welcomeCreditsLowMiddleIncome: 100_000,
  welcomeCreditsAccountsPerIpHighIncome: 100,
  welcomeCreditsAccountsPerIpLowMiddleIncome: 100,
  freeIllustratedBooksPerMonth: 100,
  freeManuscriptImportsPerMonth: 100,
  freeMaxBookPages: 600,
  paidMaxBookPages: 600,
  ultraTierEnabled: 1
};

/**
 * Per-key floors, where zero would be a wrong answer rather than a price.
 *
 * Every other key may be zero. Free-plan messages must cost something, and a
 * paid book ceiling under the free tier's 30 would refuse plans the books the
 * free tier writes — so neither a write nor a stored revision may go below.
 */
export const CREDIT_PRICING_MINIMUMS: Partial<Record<CreditPricingKey, number>> = {
  messageCreditsFree: 1,
  paidMaxBookPages: 30
};

function creditPricingMinimum(key: CreditPricingKey): number {
  return CREDIT_PRICING_MINIMUMS[key] ?? 0;
}

/**
 * The strict gate for a *write*.
 *
 * Unknown keys are rejected rather than dropped: a dashboard sending a key this
 * build does not know about is a version mismatch worth surfacing, not something
 * to swallow. Free-plan messages must cost credits, and free monthly grants
 * cannot be re-enabled by an old dashboard or a pricing-history revert.
 */
export const creditPricingInputSchema = z
  .object(
    Object.fromEntries(
      CREDIT_PRICING_KEYS.map((key) => [key, z.number().int().min(creditPricingMinimum(key)).max(CREDIT_PRICING_LIMITS[key])])
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
  activePricing = Object.freeze(normalizeCreditPricing(values));
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
    // Read earlier regional revisions without resetting an operator's amounts.
    const legacyKey = LEGACY_CREDIT_PRICING_KEYS[key];
    const candidate = record[key] ?? (legacyKey ? record[legacyKey] : undefined);
    if (isChargeableInteger(candidate, key)) {
      values[key] = candidate;
      continue;
    }
    const premiumTwin = ultraKeyPremiumTwin(key);
    const premiumCandidate = premiumTwin ? record[premiumTwin] : undefined;
    if (premiumTwin && isChargeableInteger(premiumCandidate, premiumTwin)) {
      values[key] = premiumCandidate;
      continue;
    }
    values[key] = DEFAULT_CREDIT_COSTS[key];
  }
  return values;
}

function isChargeableInteger(candidate: unknown, key: CreditPricingKey): candidate is number {
  return (
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= creditPricingMinimum(key) &&
    candidate <= CREDIT_PRICING_LIMITS[key]
  );
}

function ultraKeyPremiumTwin(key: CreditPricingKey): CreditPricingKey | undefined {
  if (!key.endsWith("Ultra")) {
    return undefined;
  }
  return `${key.slice(0, -"Ultra".length)}Premium` as CreditPricingKey;
}

/** Whether new books may start on the Ultra effort (`ultraTierEnabled`). */
export function isUltraTierEnabled(pricing: CreditPricing = creditPricing()): boolean {
  return pricing.ultraTierEnabled === 1;
}

/** The longest book any account may have generated right now, never past the schemas' 600. */
export function maxGeneratedBookPages(pricing: CreditPricing = creditPricing()): number {
  return Math.min(600, pricing.paidMaxBookPages);
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
