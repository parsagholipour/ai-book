import { describe, expect, it } from "vitest";
import {
  CREDIT_COSTS,
  buildMarginEstimate,
  estimateFullBookCreditCost,
  estimateInteriorImageCount,
  estimateProviderCostForProject
} from "./billing.js";
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
        expect.objectContaining({ code: "EXPORT_UNLOCK", credits: CREDIT_COSTS.exportUnlock })
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
      expect.objectContaining({ code: "PREMIUM_REVIEW", credits: CREDIT_COSTS.premiumReview })
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
