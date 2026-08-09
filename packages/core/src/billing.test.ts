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
  it("itemizes a standard workbook package including its initial cover", () => {
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

    expect(estimate.totalCredits).toBe(1_039);
    expect(estimate.lineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FULL_BOOK_GENERATION", credits: 574 }),
        expect.objectContaining({ code: "IMAGE_GENERATION", quantity: 6, credits: 270 }),
        expect.objectContaining({
          code: "IMAGE_GENERATION",
          label: "Cover image generation",
          quantity: 1,
          credits: DEFAULT_CREDIT_COSTS.imageGeneration
        }),
        expect.objectContaining({ code: "EXPORT_UNLOCK", credits: DEFAULT_CREDIT_COSTS.exportUnlock })
      ])
    );
  });

  it("prices an initial cover as one image generation, never as a cover regeneration", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a concise guide with a generated cover.",
      category: "BUSINESS",
      targetPages: 8,
      mediaSettings: {
        fullIllustrations: false,
        includeCover: false
      }
    });
    const pricing = {
      ...DEFAULT_CREDIT_COSTS,
      imageGeneration: 37,
      coverRegeneration: 999
    };
    const withoutCover = estimateFullBookCreditCost(input, pricing);
    const withCover = estimateFullBookCreditCost(
      { ...input, mediaSettings: { ...input.mediaSettings, includeCover: true } },
      pricing
    );

    expect(withCover.totalCredits - withoutCover.totalCredits).toBe(37);
    expect(withCover.assumptions).toMatchObject({ includesCover: true, estimatedInteriorImages: 0 });
    expect(withoutCover.assumptions.includesCover).toBe(false);
    expect(withCover.lineItems).toContainEqual(
      expect.objectContaining({
        code: "IMAGE_GENERATION",
        label: "Cover image generation",
        quantity: 1,
        unitCredits: 37,
        credits: 37
      })
    );
    expect(withoutCover.lineItems).toContainEqual(
      expect.objectContaining({ label: "Cover image generation", quantity: 0, credits: 0 })
    );
    expect(withCover.lineItems.some((item) => item.code === "COVER_REGENERATION")).toBe(false);
  });

  it("charges for the cover only when a model draws it", () => {
    const base = {
      prompt: "Create a concise guide with a cover.",
      category: "BUSINESS",
      targetPages: 8,
      mediaSettings: { fullIllustrations: false }
    };
    const quote = (mediaSettings: Record<string, unknown>) =>
      estimateFullBookCreditCost(
        createProjectSchema.parse({ ...base, mediaSettings: { ...base.mediaSettings, ...mediaSettings } })
      );

    const ai = quote({ includeCover: true, coverArtSource: "ai" });
    const designed = quote({ includeCover: false, coverArtSource: "design" });
    const none = quote({ includeCover: false, coverArtSource: "none" });

    expect(ai.totalCredits - designed.totalCredits).toBe(DEFAULT_CREDIT_COSTS.imageGeneration);
    // A bundled design is drawn from the catalog, so it costs the same as no
    // cover at all even though the book ends up with one.
    expect(designed.totalCredits).toBe(none.totalCredits);
    expect(designed.assumptions.includesCover).toBe(false);
    expect(ai.assumptions.includesCover).toBe(true);
  });

  it("keeps quoting projects written before coverArtSource existed", () => {
    // The legacy flag is the only thing older rows carry, and `includeCover:
    // false` now means a designed cover — the quote must not move for either.
    const legacy = (includeCover: boolean) =>
      estimateFullBookCreditCost(
        createProjectSchema.parse({
          prompt: "Create a concise guide with a cover.",
          category: "BUSINESS",
          targetPages: 8,
          mediaSettings: { fullIllustrations: false, includeCover }
        })
      );

    expect(legacy(true).assumptions.includesCover).toBe(true);
    expect(legacy(false).assumptions.includesCover).toBe(false);
    expect(legacy(true).totalCredits - legacy(false).totalCredits).toBe(DEFAULT_CREDIT_COSTS.imageGeneration);
  });

  it("adds premium review credits for the premium preset, not for an inert best-of knob", () => {
    const inputWith = (mediaExtras: Record<string, unknown>) =>
      createProjectSchema.parse({
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
          ...mediaExtras
        }
      });

    const premium = estimateFullBookCreditCost(inputWith({ mobile: { qualityPreset: "premium" } }));
    expect(premium.assumptions.includesPremiumReview).toBe(true);
    expect(premium.lineItems).toContainEqual(
      expect.objectContaining({ code: "PREMIUM_REVIEW", credits: DEFAULT_CREDIT_COSTS.premiumReview })
    );

    // `draftCandidates` alone no longer prices premium review: mobile lengths
    // route to strategies that never read the knob, so it charged for nothing.
    const knobOnly = estimateFullBookCreditCost(inputWith({ draftCandidates: 2 }));
    expect(knobOnly.assumptions.includesPremiumReview).toBe(false);
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
    expect(margin.estimatedRevenueUsd).toBe(8.53);
    expect(margin.actualProviderCostUsd).toBe(1.25);
    expect(margin.actualMarginUsd).toBe(7.28);
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
