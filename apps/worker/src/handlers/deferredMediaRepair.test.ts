import { expect, it } from "vitest";
import { createProjectSchema, makeFallbackPlan, shouldIllustratePage, type PageQualityReport } from "@book-maker/core";
import { failedQaPageIndexesForCompile } from "./compileExportCitationRepair.js";

const requirement = "Exactly 10 interior illustrations, on story pages 3, 6, 9, 12, 15, 18, 21, 24, 27, 30.";
const input = createProjectSchema.parse({ prompt: `A story with Rabbit and Wise Turtle. ${requirement}`, category: "KIDS", targetPages: 30,
  mediaSettings: { fullIllustrations: true, illustrationCadence: "every-third-page" } });
const context = { input, plan: makeFallbackPlan(input), strategy: { shouldIllustratePage } };
const prose = "Rabbit stared down the dark path. “I’ll fetch every lantern myself!” He crouched to spring away.";
const checks = { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: true };
const deferredPage = (index: number): { index: number; markdown: string; status: string; qualityReport: PageQualityReport & { deferredMedia: NonNullable<PageQualityReport["deferredMedia"]> } } => ({ index, markdown: prose, status: "FAILED_QA", qualityReport: {
  approved: true, score: 86, notes: "", groundedOk: true, groundingStatus: "not_applicable", unsupportedClaims: [], issues: [], requiredRevisions: [], checks,
  deferredMedia: { stage: "before_illustrations", pageIndex: index, draftMarkdown: prose, brief: input.prompt,
    requirements: [{ kind: "interior_illustration", pageIndex: index, requirementQuote: requirement, quote: prose }] }
} });

it("keeps the genuine page30 repetition repair while deferring all ten scheduled asset obligations", () => {
  // Retained Premium media-only findings affected3..27; page30 independently
  // repeated the moonrise status. New producer reports retain that prose defect.
  const pages = Array.from({ length: 10 }, (_, i) => deferredPage((i + 1) * 3));
  const mixed = pages.at(-1)!;
  mixed.qualityReport = { ...mixed.qualityReport, approved: false, score: 80,
    checks: { ...checks, repetitionOk: false },
    issues: ["The ending repeats the just-established fact that the moon has not risen, after the same deadline status was stated on pages 28 and 29."],
    requiredRevisions: ["Let the final sentence emphasize the shared picnic or the characters’ choices instead of restating the moon’s position."] };
  expect(failedQaPageIndexesForCompile(pages, [], context)).toEqual([30]);
  expect(failedQaPageIndexesForCompile(pages, [])).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
});

it("defaults to repair for stale, ungrounded, unsupported or unscheduled deferred-media proof", () => {
  const base = deferredPage(3);
  for (const mutation of [
    { markdown: `${prose} New prose.` },
    { qualityReport: { ...base.qualityReport, deferredMedia: undefined } },
    { qualityReport: { ...base.qualityReport, checks: undefined } },
    { qualityReport: { ...base.qualityReport, groundedOk: false } },
    { qualityReport: { ...base.qualityReport, groundingStatus: "unavailable" } },
    { qualityReport: { ...base.qualityReport, groundingStatus: undefined } },
    { qualityReport: { ...base.qualityReport, groundingAvailability: "unavailable" } },
    { qualityReport: { ...base.qualityReport, qualityAdvisories: [{ check: "style", status: "unverified", message: "Unverified style." }] } },
    { qualityReport: { ...base.qualityReport, deferredMedia: { ...base.qualityReport.deferredMedia, stage: "after_illustrations" } } },
    { qualityReport: { ...base.qualityReport, deferredMedia: { ...base.qualityReport.deferredMedia, pageIndex: 6 } } },
    ...[{ kind: "cover" }, { pageIndex: 6 }, { requirementQuote: "Invented request" }, { quote: "Not in this manuscript" }].map((requirementChange) => ({
      qualityReport: { ...base.qualityReport, deferredMedia: { ...base.qualityReport.deferredMedia,
        requirements: [{ ...base.qualityReport.deferredMedia.requirements[0], ...requirementChange }] } }
    }))
  ]) expect(failedQaPageIndexesForCompile([{ ...base, ...mutation }], [], context)).toEqual([3]);
  expect(failedQaPageIndexesForCompile([deferredPage(2)], [], context)).toEqual([2]);
  expect(failedQaPageIndexesForCompile([base], [], { ...context, input: { ...input, prompt: "A changed requirement." } })).toEqual([3]);
  expect(failedQaPageIndexesForCompile([base], [], { ...context, input: { ...input, prompt: `${input.prompt} A new rescue scene is required.` } })).toEqual([3]);
});

it("does not reinterpret old untyped media complaints as a successful prose review", () => {
  const old = deferredPage(3);
  const report = { approved: false, score: 86, issues: ["The supplied page entry contains the prose for this required illustrated scene but no interior illustration deliverable."],
    requiredRevisions: ["Add the page 3 illustration of Rabbit leaning toward the dark path as Wise Turtle points to the wind-bent grass."] };
  expect(failedQaPageIndexesForCompile([{ ...old, qualityReport: report }], [], context)).toEqual([3]);
});
