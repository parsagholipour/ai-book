import { expect, it, vi } from "vitest";
import { createProjectSchema, makeFallbackPlan, type BookGenerationStrategy } from "@book-maker/core";
import { quickDraftPageQuality, quickDraftQaForPage, quickDraftQaTargets, quickDraftRepairTargets, usesQuickDraftReview } from "./quickDraftReviewPolicy.js";
import { reviewPageWithQualityGates } from "./pageQualityGateReview.js";

const input = createProjectSchema.parse({ prompt: "A quiet bedtime story.", category: "KIDS", targetPages: 12,
  mediaSettings: { modelTier: "fast" } });
const allEnabled = { enabled: () => true };

it("defers page calls and repair loops but retains chapter editing and arithmetic checks", () => {
  const quality = quickDraftPageQuality(input, allEnabled);
  for (const feature of ["pageModelReview", "pageQaRewrite", "smartUnslop", "storyExtractAudit", "styleAuditor", "claimVerifier"] as const)
    expect(quality.enabled(feature), feature).toBe(false);
  for (const feature of ["chapterEditorPass", "chapterEditAcceptance", "proseArithmeticCheck", "pageLocalQa", "finalBookQa"] as const)
    expect(quality.enabled(feature), feature).toBe(true);
});

it("preserves other tiers, explicit edits, author manuscripts and disabled gates", () => {
  for (const modelTier of ["balanced", "premium", "ultra"] as const)
    expect(quickDraftPageQuality({ ...input, mediaSettings: { ...input.mediaSettings, modelTier } }, allEnabled)).toBe(allEnabled);
  expect(quickDraftPageQuality(input, allEnabled, "Rewrite the dialogue")).toBe(allEnabled);
  expect(quickDraftPageQuality({ ...input, mediaSettings: { ...input.mediaSettings, mobile: { import: { source: "file" } } } }, allEnabled)).toBe(allEnabled);
  expect(quickDraftPageQuality(input, { enabled: () => false }).enabled("finalBookQa")).toBe(false);
});

it("runs only local integrity checks even with every operator gate enabled", async () => {
  const reviewPageDraft = vi.fn();
  const result = await reviewPageWithQualityGates({
    quality: quickDraftPageQuality(input, allEnabled), strategy: { reviewPageDraft } as unknown as BookGenerationStrategy,
    reviewOptions: { input, plan: makeFallbackPlan(input), pageIndex: 1,
      draft: { title: "Moon", markdown: "We need output only prose, no meta.", summary: "Moon", continuityNotes: [] },
      previousPages: [], continuityNotes: [], textModel: {} as never }
  });
  expect(result.checks.promptLeakFree).toBe(false);
  expect(reviewPageDraft).not.toHaveBeenCalled();
});

it("caps real repair pages before consumed claims are filtered on resume", () => {
  const pages = [7, 2, 4, 1, 6].map((index) => ({ index, id: `p${index}` }));
  const selected = quickDraftRepairTargets(pages, new Set([0, 1, 2, 3, 4, 6, 7, 99]));
  expect(selected.map((page) => page.index)).toEqual([1, 2, 4]);
  expect(selected.filter((page) => page.index !== 1).map((page) => page.index)).toEqual([2, 4]);
  expect(pages.map((page) => page.index)).toEqual([7, 2, 4, 1, 6]);
});

it("never cuts a linked repair group in half to fill the page budget", () => {
  const pages = [1, 2, 3, 4].map(index => ({ index }));
  const qa = { approved: false, score: 60, notes: "", issues: [], requiredFixes: [],
    focusedReview: { rejectedFindings: 0, repairGroups: [[1, 2], [2, 3], [3, 4]] } };
  expect(quickDraftRepairTargets(pages, new Set([1, 2, 3, 4]), qa)).toEqual([]);
  expect(quickDraftRepairTargets(pages, new Set([1, 2, 3]), qa)).toEqual([]);
});

it("blocks a partial repair overlapping unverified dependencies while allowing independent repairs", () => {
  const pages = [18, 19, 22, 42].map(index => ({ index }));
  const qa = { approved: false, score: 0, notes: "", issues: [], requiredFixes: [],
    focusedReview: { rejectedFindings: 1, repairGroups: [[19], [22, 42]], unverifiedRepairPageIndexes: [18, 19] } };
  expect(quickDraftRepairTargets(pages, new Set([19, 22, 42]), qa).map(page => page.index)).toEqual([22, 42]);
});

it("requires an explicit server experiment switch for Balanced and preserves other tiers", () => {
  const balanced = { ...input, mediaSettings: { ...input.mediaSettings, modelTier: "balanced" as const } };
  try {
    vi.stubEnv("BOOK_MAKER_BALANCED_LIGHT_REVIEW", "0");
    expect(usesQuickDraftReview(balanced)).toBe(false);
    vi.stubEnv("BOOK_MAKER_BALANCED_LIGHT_REVIEW", "1");
    expect(usesQuickDraftReview(balanced)).toBe(true);
    expect(usesQuickDraftReview({ ...balanced, mediaSettings: { ...balanced.mediaSettings, modelTier: "premium" } })).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});


it("repairs the identified defective page without rewriting pages cited as evidence", () => {
  const qa = { approved: false, score: 60, notes: "", issues: ["Page 4: Repeats the scene on page 2."],
    requiredFixes: ["Page 4: Remove the copied scene; keep page 2 unchanged."] };
  expect(quickDraftQaTargets(qa)).toEqual([4]);
  expect(quickDraftQaForPage(qa, 2).issues).toEqual([]);
  expect(quickDraftQaForPage(qa, 4)).toEqual(qa);
});
