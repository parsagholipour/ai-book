import { describe, expect, it } from "vitest";
import {
  CREDIT_USD_VALUE,
  PROVIDER_COST_ASSUMPTIONS_USD,
  buildMarginEstimate,
  creditCostForOperation,
  estimateAudiobookCreditCost,
  estimateFullBookCreditCost,
  estimateInteriorImageCount,
  estimateProviderCostForProject,
  providerCostAssumptionsForInput
} from "./billing.js";
import { DEFAULT_CREDIT_COSTS } from "./creditPricing.js";
import { createProjectSchema } from "./schemas/book.js";

describe("billing credit assumptions", () => {
  it("keeps a standard workbook package inside one standard export credit", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a practical workbook about onboarding new managers.",
      category: "EDUCATION",
      subcategory: "Workbook or Study Guide",
      targetPages: 28,
      complexity: 5,
      temperature: 0.65,
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "minimal",
        finalReview: true,
        toneProfile: "neutral"
      }
    });

    const estimate = estimateFullBookCreditCost(input);

    expect(estimate.totalCredits).toBe(994);
    expect(estimate.lineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FULL_BOOK_GENERATION", credits: 574 }),
        expect.objectContaining({ code: "IMAGE_GENERATION", quantity: 6, credits: 270 }),
        expect.objectContaining({ code: "EXPORT_UNLOCK", credits: DEFAULT_CREDIT_COSTS.exportUnlock })
      ])
    );
  });

  it("adds premium review credits when the mobile preset uses best-of drafting", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a premium guide about pricing consulting retainers.",
      category: "BUSINESS",
      subcategory: "Lead Magnet Ebook",
      targetPages: 24,
      complexity: 6,
      temperature: 0.55,
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "business",
        finalReview: true,
        toneProfile: "confident",
        draftCandidates: 2
      }
    });

    const estimate = estimateFullBookCreditCost(input);

    expect(estimate.assumptions.includesPremiumReview).toBe(true);
    expect(estimate.lineItems).toContainEqual(
      expect.objectContaining({ code: "PREMIUM_REVIEW", credits: DEFAULT_CREDIT_COSTS.premiumReview })
    );
  });

  it("adjusts provider cost assumptions per model tier without changing credit prices", () => {
    const mediaSettings = {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "business",
      finalReview: true,
      toneProfile: "confident"
    };
    const inputForTier = (modelTier?: "fast" | "balanced" | "premium") =>
      createProjectSchema.parse({
        prompt: "Create a premium guide about pricing consulting retainers.",
        category: "BUSINESS",
        subcategory: "Lead Magnet Ebook",
        targetPages: 24,
        mediaSettings: { ...mediaSettings, ...(modelTier ? { modelTier } : {}) }
      });

    expect(providerCostAssumptionsForInput(inputForTier())).toEqual(PROVIDER_COST_ASSUMPTIONS_USD);
    expect(providerCostAssumptionsForInput(inputForTier("balanced"))).toEqual(PROVIDER_COST_ASSUMPTIONS_USD);
    expect(providerCostAssumptionsForInput(inputForTier("fast"))).toMatchObject({ textPerPage: 0.008 });
    expect(providerCostAssumptionsForInput(inputForTier("premium"))).toMatchObject({
      textPerPage: 0.05,
      imageGeneration: 0.067,
      coverIncluded: 0.134
    });

    const fastEstimate = estimateProviderCostForProject(inputForTier("fast"));
    const balancedEstimate = estimateProviderCostForProject(inputForTier("balanced"));
    const premiumEstimate = estimateProviderCostForProject(inputForTier("premium"));
    expect(fastEstimate.estimatedUsd).toBeLessThan(balancedEstimate.estimatedUsd);
    expect(premiumEstimate.estimatedUsd).toBeGreaterThan(balancedEstimate.estimatedUsd);

    // Credit charges are tier-independent: tiers change what we spend, not what users pay.
    expect(estimateFullBookCreditCost(inputForTier("premium")).totalCredits).toBe(
      estimateFullBookCreditCost(inputForTier("fast")).totalCredits
    );
  });

  it("builds margin summaries from estimated revenue and actual provider cost", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a short story about a lighthouse keeper.",
      category: "STORY",
      subcategory: "Short Story",
      targetPages: 16,
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "fiction",
        finalReview: true,
        toneProfile: "narrative"
      }
    });

    const creditEstimate = estimateFullBookCreditCost(input);
    const providerEstimate = estimateProviderCostForProject(input);
    const margin = buildMarginEstimate({
      creditEstimate,
      providerEstimate,
      actualProviderCostUsd: 1.25
    });

    expect(estimateInteriorImageCount(input)).toBe(4);
    expect(margin.estimatedRevenueUsd).toBe(8.08);
    expect(margin.actualProviderCostUsd).toBe(1.25);
    expect(margin.actualMarginUsd).toBe(6.83);
    expect(margin.actualMarginPercent).toBeGreaterThan(80);
  });
});

describe("audiobook pricing", () => {
  it("charges a base plus the real page count", () => {
    const estimate = estimateAudiobookCreditCost(60);
    expect(estimate.totalCredits).toBe(
      DEFAULT_CREDIT_COSTS.audiobookBase + 60 * DEFAULT_CREDIT_COSTS.audiobookPerPage
    );
    expect(estimate.lineItems).toHaveLength(1);
    expect(estimate.lineItems[0]).toMatchObject({
      code: "AUDIOBOOK_GENERATION",
      quantity: 60,
      unitCredits: DEFAULT_CREDIT_COSTS.audiobookPerPage
    });
  });

  it("does not bundle an export unlock, because narrating is not downloading", () => {
    expect(estimateAudiobookCreditCost(20).assumptions.includesExportUnlock).toBe(false);
  });

  it("prices a book with no pages at the base alone rather than going negative", () => {
    expect(estimateAudiobookCreditCost(0).totalCredits).toBe(DEFAULT_CREDIT_COSTS.audiobookBase);
    expect(estimateAudiobookCreditCost(-5).totalCredits).toBe(DEFAULT_CREDIT_COSTS.audiobookBase);
  });

  it("honours operator overrides instead of the compiled defaults", () => {
    const pricing = { ...DEFAULT_CREDIT_COSTS, audiobookBase: 500, audiobookPerPage: 20 };
    expect(estimateAudiobookCreditCost(10, pricing).totalCredits).toBe(700);
    expect(creditCostForOperation("AUDIOBOOK_GENERATION", pricing)).toBe(500);
  });

  it("keeps a comfortable margin over the provider's per-second TTS rate", () => {
    // ~14.5 characters/second of speech, ~1,800 characters/page, so a page is
    // roughly two minutes of audio at $0.00025/second.
    const pages = 60;
    const providerUsd = pages * ((1800 / 14.5) * 0.00025);
    const revenueUsd = estimateAudiobookCreditCost(pages).totalCredits * CREDIT_USD_VALUE;
    expect(revenueUsd).toBeGreaterThan(providerUsd * 2);
  });
});
