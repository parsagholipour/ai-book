import { pictureBookReviewChapters, runLocalFinalQa, runRequiredFinalQa, validateStoryExtractEvidence,
  validateStyleAuditEvidence, withStoryContradictions, withStyleAudit, type FinalBookQa } from "@book-maker/core";
import { toFinalQaPage } from "./bookHelpers.js";
import { usesShortPictureBookReview } from "./shortPictureBook.js";
import { loadPictureBookReviewSnapshot, shortPictureBookChecks } from "./shortPictureBookReviewCache.js";
import type { QualityGateContext } from "./qualityEnrichment.js";
import type { reviewFinalizationManuscript } from "../handlers/compileFinalizationReview.js";

export async function reuseShortPictureBookFinalReview(options: Parameters<typeof reviewFinalizationManuscript>[0],
  reuse: { generationJobId?: string | undefined; planId?: string | undefined; quality: QualityGateContext }): Promise<FinalBookQa | undefined> {
  const checks = shortPictureBookChecks(reuse.quality);
  if (!checks.pageModelReview || !usesShortPictureBookReview(options)) return undefined;
  const chapters = pictureBookReviewChapters(options.plan);
  // The reviewer saw this exact partition. Changed/unknown export divisions need a fresh check.
  if (!chapters.length || chapters.at(-1)?.endPageIndex !== options.input.targetPages || options.pages.some((page) => {
    const chapter = chapters.find((item) => page.index >= item.startPageIndex && page.index <= item.endPageIndex);
    return !chapter || page.chapter?.index !== chapter.index || page.chapter.title !== chapter.title;
  })) return undefined;
  const reviews = await loadPictureBookReviewSnapshot({ ...options, checks, generationJobId: reuse.generationJobId, planId: reuse.planId });
  if (!reviews) return undefined;
  const localIssues = (options.skipLocalChecks ? runRequiredFinalQa : runLocalFinalQa)(options.input, options.pages.map(toFinalQaPage));
  const issues = [...localIssues];
  const requiredFixes = [...localIssues];
  let score = localIssues.length ? Math.max(0, 100 - localIssues.length * 15) : 100;
  let approved = localIssues.length === 0;
  for (const review of reviews) {
    const page = options.pages.find((item) => item.index === review.pageIndex)!;
    let report = review.report;
    if (review.storyExtract) report = withStoryContradictions(report, validateStoryExtractEvidence(review.storyExtract, page, options.pages).contradictions);
    if (review.styleAudit) report = withStyleAudit(report, validateStyleAuditEvidence(review.styleAudit, page.markdown));
    approved &&= report.approved && report.score >= 80;
    score = Math.min(score, report.score);
    issues.push(...report.issues.map((issue) => `Page ${review.pageIndex}: ${issue}`));
    requiredFixes.push(...report.requiredRevisions.map((fix) => `Page ${review.pageIndex}: ${fix}`));
    if ((!report.approved || report.score < 80) && !report.issues.length)
      issues.push(`Page ${review.pageIndex}: The full-prose review did not approve this page (score ${report.score}).`);
  }
  return { approved, score, issues: [...new Set(issues)], requiredFixes: [...new Set(requiredFixes)],
    notes: "Reused the complete frozen manuscript review, including opening and all chapter transitions; local final checks reran." };
}
