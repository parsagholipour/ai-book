import { afterEach, describe, expect, it } from "vitest";
import {
  CREDIT_PRICING_KEYS,
  CREDIT_PRICING_LIMITS,
  DEFAULT_CREDIT_COSTS,
  creditPricing,
  creditPricingInputSchema,
  diffCreditPricing,
  normalizeCreditPricing,
  resetCreditPricing,
  setCreditPricing
} from "./creditPricing.js";
import { creditCostForOperation, estimateFullBookCreditCost } from "./billing.js";
import { createProjectSchema } from "./schemas/book.js";

afterEach(() => {
  resetCreditPricing();
});

const sampleInput = createProjectSchema.parse({
  prompt: "Create a practical workbook about onboarding new managers.",
  category: "EDUCATION",
  subcategory: "Workbook or Study Guide",
  targetPages: 28,
  mediaSettings: { fullIllustrations: true, includeCover: true }
});

describe("normalizeCreditPricing", () => {
  it("fills every key from the defaults when nothing is stored", () => {
    expect(normalizeCreditPricing(undefined)).toEqual({ ...DEFAULT_CREDIT_COSTS });
    expect(normalizeCreditPricing({})).toEqual({ ...DEFAULT_CREDIT_COSTS });
    expect(normalizeCreditPricing("not an object")).toEqual({ ...DEFAULT_CREDIT_COSTS });
  });

  it("keeps a stored override and fills the gaps around it", () => {
    const values = normalizeCreditPricing({ imageGeneration: 90 });
    expect(values.imageGeneration).toBe(90);
    expect(values.fullBookBase).toBe(DEFAULT_CREDIT_COSTS.fullBookBase);
  });

  it("keeps zero, which is a real price for two operations today", () => {
    expect(normalizeCreditPricing({ planGeneration: 0 }).planGeneration).toBe(0);
  });

  it("falls back to the default for anything it cannot charge", () => {
    // A malformed row must not stop the API booting; the default is the safe
    // wrong answer.
    const values = normalizeCreditPricing({
      imageGeneration: -5,
      fullBookPerPage: 8.5,
      exportUnlock: "150",
      premiumReview: Number.NaN,
      bookReplanBase: CREDIT_PRICING_LIMITS.bookReplanBase + 1
    });
    expect(values.imageGeneration).toBe(DEFAULT_CREDIT_COSTS.imageGeneration);
    expect(values.fullBookPerPage).toBe(DEFAULT_CREDIT_COSTS.fullBookPerPage);
    expect(values.exportUnlock).toBe(DEFAULT_CREDIT_COSTS.exportUnlock);
    expect(values.premiumReview).toBe(DEFAULT_CREDIT_COSTS.premiumReview);
    expect(values.bookReplanBase).toBe(DEFAULT_CREDIT_COSTS.bookReplanBase);
  });

  it("drops keys this build does not know about", () => {
    expect(Object.keys(normalizeCreditPricing({ somethingNew: 12 })).sort()).toEqual([...CREDIT_PRICING_KEYS].sort());
  });
});

describe("creditPricingInputSchema", () => {
  it("accepts a complete set of in-range integers", () => {
    expect(creditPricingInputSchema.safeParse({ ...DEFAULT_CREDIT_COSTS }).success).toBe(true);
  });

  it("rejects on a write what normalize would forgive on a read", () => {
    const strict = (patch: Record<string, unknown>) =>
      creditPricingInputSchema.safeParse({ ...DEFAULT_CREDIT_COSTS, ...patch }).success;
    expect(strict({ imageGeneration: -1 })).toBe(false);
    expect(strict({ fullBookPerPage: 8.5 })).toBe(false);
    expect(strict({ fullBookPerPage: CREDIT_PRICING_LIMITS.fullBookPerPage + 1 })).toBe(false);
    expect(strict({ somethingNew: 12 })).toBe(false);
  });

  it("rejects a partial body so a half-filled form cannot zero the rest", () => {
    expect(creditPricingInputSchema.safeParse({ imageGeneration: 45 }).success).toBe(false);
  });

  it("holds every per-unit rate to a tighter ceiling than the flat charges", () => {
    // These multiply by page count or minutes, so a typo costs proportionally more.
    expect(CREDIT_PRICING_LIMITS.fullBookPerPage).toBeLessThan(CREDIT_PRICING_LIMITS.fullBookBase);
    expect(CREDIT_PRICING_LIMITS.bookTextEditPerPage).toBeLessThan(CREDIT_PRICING_LIMITS.bookTextEditBase);
  });
});

describe("the live snapshot", () => {
  it("starts at the defaults", () => {
    expect(creditPricing()).toEqual({ ...DEFAULT_CREDIT_COSTS });
  });

  it("moves what the pricing functions charge", () => {
    const before = estimateFullBookCreditCost(sampleInput).totalCredits;
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, exportUnlock: 400, fullBookBase: 700 });
    expect(creditCostForOperation("EXPORT_UNLOCK")).toBe(400);
    expect(estimateFullBookCreditCost(sampleInput).totalCredits).toBe(before + 250 + 350);
  });

  it("is frozen, so nobody can reprice the product by mutating it in place", () => {
    expect(() => {
      creditPricing().exportUnlock = 99_999;
    }).toThrow();
    expect(creditPricing().exportUnlock).toBe(DEFAULT_CREDIT_COSTS.exportUnlock);
  });

  it("is bypassed entirely by an explicit pricing argument", () => {
    // This is what the dashboard preview relies on: price a proposed change
    // without making it real for anyone else mid-request.
    const proposed = { ...DEFAULT_CREDIT_COSTS, exportUnlock: 400 };
    expect(creditCostForOperation("EXPORT_UNLOCK", proposed)).toBe(400);
    expect(creditCostForOperation("EXPORT_UNLOCK")).toBe(DEFAULT_CREDIT_COSTS.exportUnlock);
  });

  it("resets back to the defaults", () => {
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, exportUnlock: 400 });
    expect(resetCreditPricing()).toEqual({ ...DEFAULT_CREDIT_COSTS });
    expect(creditPricing().exportUnlock).toBe(DEFAULT_CREDIT_COSTS.exportUnlock);
  });
});

describe("diffCreditPricing", () => {
  it("reports only the keys that moved", () => {
    expect(diffCreditPricing(DEFAULT_CREDIT_COSTS, { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 })).toEqual({
      imageGeneration: { from: DEFAULT_CREDIT_COSTS.imageGeneration, to: 90 }
    });
  });

  it("is empty when nothing changed", () => {
    expect(diffCreditPricing(DEFAULT_CREDIT_COSTS, { ...DEFAULT_CREDIT_COSTS })).toEqual({});
  });
});
