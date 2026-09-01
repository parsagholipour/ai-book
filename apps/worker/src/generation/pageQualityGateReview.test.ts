import { describe, expect, it, vi } from "vitest";
import { pageReviewPassesFor, reviewPageWithQualityGates } from "./pageQualityGateReview.js";

describe("pageReviewPassesFor", () => {
  it("owns the configurable local/model decision used by execution and progress", () => {
    const quality = { enabled: (feature: string) => feature === "pageModelReview" };

    expect(pageReviewPassesFor({ quality })).toEqual({
      localEnabled: false,
      smartUnslopEnabled: false,
      modelEnabled: true,
      anyConfiguredPassEnabled: true
    });
    expect(pageReviewPassesFor({ quality, allowModelReview: false })).toEqual({
      localEnabled: false,
      smartUnslopEnabled: false,
      modelEnabled: false,
      anyConfiguredPassEnabled: false
    });
    expect(pageReviewPassesFor({ quality: { enabled: () => false } })).toEqual({
      localEnabled: false,
      smartUnslopEnabled: false,
      modelEnabled: false,
      anyConfiguredPassEnabled: false
    });
    expect(
      pageReviewPassesFor({
        quality: { enabled: (feature: string) => feature === "smartUnslop" },
        allowSmartUnslop: false
      })
    ).toEqual({
      localEnabled: false,
      smartUnslopEnabled: false,
      modelEnabled: false,
      anyConfiguredPassEnabled: false
    });
  });

  it("counts Smart unslop as a configured review pass", () => {
    expect(
      pageReviewPassesFor({ quality: { enabled: (feature: string) => feature === "smartUnslop" } })
    ).toEqual({
      localEnabled: false,
      smartUnslopEnabled: true,
      modelEnabled: false,
      anyConfiguredPassEnabled: true
    });
  });
});

const checks = {
  placeholderFree: true,
  promptLeakFree: true,
  titleClean: true,
  repetitionOk: true,
  progressionOk: true,
  styleNatural: true
};

const approvedModelReport = {
  approved: true,
  score: 94,
  issues: [] as string[],
  requiredRevisions: [] as string[],
  notes: "Model review passed.",
  groundedOk: true,
  unsupportedClaims: [] as string[],
  checks
};

function reviewOptions(markdown: string) {
  return {
    input: { category: "EDUCATION", targetPages: 8, language: "en", mediaSettings: {} },
    plan: { title: "Clear Water", premise: "How city water reaches a tap", chapters: [] },
    pageIndex: 2,
    draft: {
      title: "The treatment line",
      markdown,
      summary: "Water moves through a treatment plant.",
      continuityNotes: []
    },
    previousPages: [],
    continuityNotes: [],
    textModel: {}
  } as never;
}

describe("reviewPageWithQualityGates Smart unslop", () => {
  it("applies the tier-resolved page-review prompt mode to the model review", async () => {
    const strategy = { reviewPageDraft: vi.fn().mockResolvedValue(approvedModelReport) };

    await reviewPageWithQualityGates({
      strategy: strategy as never,
      quality: {
        pageReviewPromptMode: "compact",
        enabled: (feature: string) => feature === "pageModelReview"
      } as never,
      reviewOptions: reviewOptions("Operators measure turbidity before the water leaves the plant.")
    });

    expect(strategy.reviewPageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ pageReviewPromptMode: "compact" })
    );
  });

  it("turns a significant slop cluster into the existing page rewrite report", async () => {
    const strategy = { reviewPageDraft: vi.fn().mockResolvedValue(approvedModelReport) };
    const report = await reviewPageWithQualityGates({
      strategy: strategy as never,
      quality: {
        enabled: (feature: string) => feature === "pageModelReview" || feature === "smartUnslop"
      } as never,
      reviewOptions: reviewOptions(
        "Here's the thing: treatment takes several steps. At its core, filtration removes particles. " +
          "The result serves as a testament to careful plant operation."
      )
    });

    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(report).toMatchObject({ approved: false, score: 70 });
    expect(report.issues[0]).toContain("Smart unslop candidate scan found 3 possible formulaic AI-writing signals");
    expect(report.requiredRevisions[0]).toContain("They are not definite problems");
    expect(report.requiredRevisions[0]).toContain("return the page exactly unchanged");
    expect(report.checks.styleNatural).toBe(false);
  });

  it("does not reject one isolated stock phrase", async () => {
    const strategy = { reviewPageDraft: vi.fn().mockResolvedValue(approvedModelReport) };
    const report = await reviewPageWithQualityGates({
      strategy: strategy as never,
      quality: {
        enabled: (feature: string) => feature === "pageModelReview" || feature === "smartUnslop"
      } as never,
      reviewOptions: reviewOptions(
        "At its core, the sand bed catches suspended particles. Operators measure turbidity before the water leaves."
      )
    });

    expect(report).toBe(approvedModelReport);
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
  });

  it("does not run the detector when the operator disables its gate", async () => {
    const strategy = { reviewPageDraft: vi.fn().mockResolvedValue(approvedModelReport) };
    const report = await reviewPageWithQualityGates({
      strategy: strategy as never,
      quality: { enabled: (feature: string) => feature === "pageModelReview" } as never,
      reviewOptions: reviewOptions(
        "Here's the thing: treatment takes several steps. At its core, filtration removes particles. " +
          "The result serves as a testament to careful plant operation."
      )
    });

    expect(report).toBe(approvedModelReport);
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
  });

  it("does not rerun Smart unslop after its conditional rewrite", async () => {
    const strategy = { reviewPageDraft: vi.fn().mockResolvedValue(approvedModelReport) };
    const report = await reviewPageWithQualityGates({
      strategy: strategy as never,
      quality: {
        enabled: (feature: string) => feature === "pageModelReview" || feature === "smartUnslop"
      } as never,
      allowSmartUnslop: false,
      reviewOptions: reviewOptions(
        "Here's the thing: treatment takes several steps. At its core, filtration removes particles. " +
          "The result serves as a testament to careful plant operation."
      )
    });

    expect(report).toBe(approvedModelReport);
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
  });
});
