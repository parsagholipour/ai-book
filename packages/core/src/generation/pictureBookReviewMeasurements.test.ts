import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPictureBookManuscript, PictureBookReviewIncompleteError } from "./pictureBookReview.js";
import { validatedPictureBookReviewRow } from "./pictureBookReviewValidation.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";
import { countReadableWords, sentenceLengthStats } from "./proseShape.js";
import { pictureBookMeasurementPayload } from "./pictureBookReviewMeasurements.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/falseReviewWordCount0338.json" with { type: "json" };

const input = createProjectSchema.parse({ prompt: captured.brief, category: "KIDS", targetPages: 30,
  mediaSettings: { audienceAgeRange: "6-8", fullIllustrations: false, includeCover: false } });
const plan = makeFallbackPlan(input);
const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
const pages = captured.pages.map(page => ({ ...page, summary: "" }));
const page = pages.find(page => page.index === 5)!;
const original = captured.response.pages.find(row => row.pageIndex === 5)!;
const corrected = () => ({ ...structuredClone(original), score: 100, findings: [], repairAssessment: {
  targetResolved: true, meaningPreserved: true, noNewRegressions: true,
  reason: "The apology and return remain clear; the requested sentence is shorter. No new defect is present on this page."
} });
const options = { input, plan, pages, chapterBriefs: [], checks, repairContext: captured.repairContext };
const schema = () => validatedPictureBookReviewRow({ ...options, pages: new Map(pages.map(page => [page.index, page])) });

it("rechecks the captured false count before it can become a prose-repair instruction", async () => {
  const { model, calls } = scriptedDevelopmentModel([captured.response, { pages: [corrected()] }]);
  const reviews = await reviewPictureBookManuscript({ ...options, textModel: model });
  expect(countReadableWords(page.markdown)).toBe(38);
  expect(reviewPageDraftLocally({ input, plan, pageIndex: 5, draft: { ...page, continuityNotes: [] },
    previousPages: [], nextPages: [], continuityNotes: [] }).approved).toBe(true);
  expect(calls).toHaveLength(2);
  const retry = JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content);
  expect(retry.reviewPageIndexes).toEqual([5]);
  expect(retry.proseMeasurements.pages.find((row: number[]) => row[0] === 5)).toEqual([5, 38, 6.3, 12]);
  expect(JSON.stringify(retry.priorValidationIssues)).toContain("38");
  expect(JSON.stringify(retry.priorValidationIssues)).toContain("33");
  expect(retry.retainedEditorialAssessments ?? []).toEqual([]);
  const repaired = reviews.find(review => review.pageIndex === 5)!;
  expect(repaired.report).toMatchObject({ approved: true, issues: [], requiredRevisions: [] });
  expect(repaired.repairAssessment?.noNewRegressions).toBe(true);
  // The other captured finding is a real arc problem, not arithmetic.
  expect(reviews.find(review => review.pageIndex === 2)!.findings).toEqual(captured.response.pages[0]!.findings);
  expect(reviews.find(review => review.pageIndex === 2)!.report.approved).toBe(false);
  expect(reviews.map(review => review.draftMarkdown)).toEqual(pages.map(page => page.markdown));
});

it("does not promote an arithmetic rejection to semantic approval when the bounded recheck also fails", async () => {
  const { model, calls } = scriptedDevelopmentModel([captured.response, { pages: [original] }]);
  const error = await reviewPictureBookManuscript({ ...options, textModel: model }).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.unresolvedPageIndexes).toEqual([5]);
  expect(error.checkpoint.reviews.map((review: { pageIndex: number }) => review.pageIndex)).toEqual([2]);
  expect(error.checkpoint.editorialRows).toEqual([]);
  expect(calls).toHaveLength(2);
  await expect(reviewPictureBookManuscript({ ...options, textModel: model, resume: error.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it("requires reassessment when false arithmetic is only in the repair verdict", () => {
  const result = schema().safeParse({ ...original, findings: [] });
  expect(result.success).toBe(false);
});

it.each([
  "This page has 33 words, below the requested target of 35–100 words per page.",
  "The resulting page is only 33 words, below the requested 35-word minimum.",
  "At 33 words, this page falls below the minimum.",
  "The page's word count is 33.",
  "This page has 38 words, below the requested 35-word minimum.",
  "The average sentence length is 14 words.",
  "Sentences are too long for ages 6-8 (average 14.3 words, longest 24; target average <= 12, longest <= 22).",
  "The longest sentence contains 24 words."
])("rejects an explicit contradictory measurement: %s", message => {
  const row = corrected();
  const result = schema().safeParse({ ...row, findings: [{ ...original.findings[0]!, message }] });
  expect(result.success).toBe(false);
});

it("preserves grammatical and editorial findings even when all length checks pass", () => {
  const row = { ...corrected(), findings: [{ ...original.findings[0]!,
    message: "The shorter sentence loses the subject of the comparison.", guidance: "Restore the subject while keeping the sentence clear." }],
    repairAssessment: { targetResolved: true, meaningPreserved: false, noNewRegressions: false,
      reason: "The comparison is now a fragment, despite meeting the word-count target." } };
  const parsed = schema().parse(row);
  expect(parsed.findings).toEqual(row.findings);
  expect(parsed.repairAssessment).toEqual(row.repairAssessment);
});

it("accepts accurate measurements with normal decimal rounding and leaves semantic judgments intact", () => {
  const stats = sentenceLengthStats(page.markdown);
  const row = { ...corrected(), findings: [{ ...original.findings[0]!,
    message: `This page has 38 words. Its average sentence length is ${stats.average.toFixed(1)} words. The longest sentence contains ${stats.max} words. The dialogue lacks a clear speaker.`,
    guidance: "Clarify who speaks." }] };
  expect(schema().parse(row).findings).toEqual(row.findings);
});

it("does not compare original-prose measurements or quoted story dialogue with the candidate count", () => {
  const row = { ...corrected(), repairAssessment: { ...corrected().repairAssessment,
    reason: "The original page had 60 words. The candidate preserves its meaning." },
    findings: [{ ...original.findings[0]!, message: 'Rabbit says “This page has 33 words,” but Turtle was the speaker.', guidance: "Preserve the correct speaker." }] };
  expect(schema().parse(row).findings).toEqual(row.findings);
});

it.each(["This page has 33 words of narration.", "This page has 33 words, excluding dialogue.",
  "The original page has 60 words.", "Page 2 has 60 words."])("does not guess a different measurement scope: %s", message => {
  const row = { ...corrected(), findings: [{ ...original.findings[0]!, message }] };
  expect(schema().parse(row).findings).toEqual(row.findings);
});

it("uses the local-QA Unicode counters and omits titles and figure metadata", () => {
  const markdown = "لاک‌پشت فانوس را آورد. خرگوش منتظر ماند.\n小兔等着。乌龟来了。";
  const payload = pictureBookMeasurementPayload(input, [{ index: 1, markdown: `${markdown}\n\n\`\`\`figure\n{"title":"A very long figure title that is not prose"}\n\`\`\`` }]);
  const sentences = sentenceLengthStats(markdown);
  expect(payload.pages).toEqual([[1, countReadableWords(markdown), Number(sentences.average.toFixed(1)), sentences.max]]);
  expect(payload.readingLimits).toEqual({ minWords: 35, maxWords: 120, maxAverageSentenceWords: 12, maxSentenceWords: 22 });
  const { audienceAgeRange: _age, ...mediaSettings } = input.mediaSettings;
  expect(pictureBookMeasurementPayload({ ...input, mediaSettings }, []).readingLimits).toEqual({
    minWords: 20, maxWords: 78, maxAverageSentenceWords: 9, maxSentenceWords: 16
  });
});

it("applies the measurement check to style-only assessments as well", async () => {
  const raw = { ...corrected(), repairAssessment: undefined, styleAudit: { styleOk: false,
    styleIssues: ["This page has 33 words, below the requested 35-word minimum."], evidence: [] } };
  const { model, calls } = scriptedDevelopmentModel([{ pages: [raw] }, { pages: [{ ...raw, styleAudit: "clean" }] }]);
  const reviews = await reviewPictureBookManuscript({ input, plan, pages: [page], chapterBriefs: [],
    checks: { pageModelReview: false, storyExtractAudit: false, styleAuditor: true }, textModel: model });
  expect(calls).toHaveLength(2);
  expect(reviews[0]?.styleAudit?.styleOk).toBe(true);
});

it("keeps real local length failures instead of converting them to approval", () => {
  const short = { ...page, markdown: "Rabbit waits beside the gate. Wise Turtle carries the lantern." };
  const words = countReadableWords(short.markdown);
  const row = { ...corrected(), findings: [{ ...original.findings[0]!, quote: short.markdown,
    message: `This page has ${words} words, below the requested target of 35–100 words per page.` }] };
  expect(validatedPictureBookReviewRow({ ...options, pages: new Map([[5, short]]) }).parse(row).findings).toEqual(row.findings);
  expect(reviewPageDraftLocally({ input, plan, pageIndex: 5, draft: { ...short, continuityNotes: [] },
    previousPages: [], nextPages: [], continuityNotes: [] }).approved).toBe(false);
});

it("preserves a stricter explicit user requirement even when the age-band limits pass", () => {
  const requirementQuote = "Use at most 35 words per page.";
  const row = { ...corrected(), findings: [{ ...original.findings[0]!, basis: "missing_requirement", requirementQuote,
    message: "This page has 38 words, above the required 35-word maximum.", guidance: "Meet the explicit word limit without losing meaning." }] };
  const parsed = validatedPictureBookReviewRow({ ...options, input: { ...input, prompt: `${input.prompt} ${requirementQuote}` },
    pages: new Map([[5, page]]) }).parse(row);
  expect(parsed.findings).toEqual(row.findings);
});

it("does not add a measurement payload to story-extraction-only requests", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: [{ pageIndex: 5, score: 100, findings: [], storyExtract: "no_changes", styleAudit: null }] }]);
  await reviewPictureBookManuscript({ input, plan, pages: [page], chapterBriefs: [], textModel: model,
    checks: { pageModelReview: false, storyExtractAudit: true, styleAuditor: false } });
  const payload = JSON.parse(calls[0]!.messages.find(message => message.role === "user")!.content);
  expect(payload).not.toHaveProperty("proseMeasurements");
});
