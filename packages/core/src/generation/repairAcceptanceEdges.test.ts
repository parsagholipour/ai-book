import { expect, it } from "vitest";
import captured from "./testing/repairAcceptanceEdges.json" with { type: "json" };
import { reviewPageDraftLocally, type LocalPageReviewOptions } from "./pagesLocalQa.js";
import { originalDevelopmentPlan, developmentInput } from "./testing/bookDevelopmentFixtures.js";
import { sentenceLengthStats } from "./proseShape.js";

const input = { ...developmentInput, category: "KIDS" as const, targetPages: 30,
  mediaSettings: { ...developmentInput.mediaSettings, audienceAgeRange: "6-8" as const } };

it("keeps Quick's saved candidate blocked after the readability relaxation failed live verification", () => {
  const page = captured.quickPage;
  const report = reviewPageDraftLocally({ input, plan: originalDevelopmentPlan(), pageIndex: page.index,
    draft: { ...page, continuityNotes: [] }, previousPages: [], continuityNotes: [] });
  expect(report.approved).toBe(false);
  expect(report.issues).toHaveLength(1);
  expect(report.issues[0]).toMatch(/Sentences are too long.*average 13\.0/s);
});

it.each(["larger_mean", "longest_sentence", "younger_band", "explicit_limit", "prompt_leak", "repetition"])(
  "keeps %s blocking after citation recovery changes", kind => {
    let markdown = captured.quickPage.markdown;
    const options: LocalPageReviewOptions = { input: structuredClone(input), plan: originalDevelopmentPlan(), pageIndex: 17,
      draft: { ...captured.quickPage, continuityNotes: [] }, previousPages: [], continuityNotes: [] };
    if (kind === "larger_mean") markdown = markdown.replace("From the near bank", "From beside the near bank");
    if (kind === "longest_sentence") markdown = markdown.replace("From the near bank", "From the rocky and muddy near bank") + " They took small steps.";
    if (kind === "younger_band") options.input.mediaSettings.audienceAgeRange = "4-6";
    if (kind === "explicit_limit") options.input.prompt += " Keep average sentence length at or below 12 words.";
    if (kind === "prompt_leak") markdown += " As an AI language model, I cannot provide generation instructions.";
    if (kind === "repetition") options.previousPages.push({ ...captured.quickPage, index: 16 });
    options.draft.markdown = markdown;
    const report = reviewPageDraftLocally(options);
    expect(report.approved).toBe(false);
    if (["larger_mean", "longest_sentence", "younger_band", "explicit_limit"].includes(kind)) expect(report.issues.join(" ")).toMatch(/Sentences are too long/);
    if (kind === "larger_mean") expect(sentenceLengthStats(markdown).average).toBeGreaterThan(13);
    if (kind === "longest_sentence") {
      expect(sentenceLengthStats(markdown).max).toBeGreaterThan(22);
      expect(sentenceLengthStats(markdown).average).toBeLessThanOrEqual(12);
    }
  });
