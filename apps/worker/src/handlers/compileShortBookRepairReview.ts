import {
  reviewPictureBookManuscript, reviewPictureBookSentenceRepair, validateStoryExtractEvidence, validateStyleAuditEvidence,
  withStoryContradictions, withStyleAudit, unchangedPrefixStoryExtracts,
  PictureBookReviewIncompleteError, retainUnverifiedRepairPrefix,
  type PictureBookPageReview, type PictureBookRepairContext, type PictureBookRepairFeedback,
  type repairPictureBookManuscript, type TextModelAdapter, type TextAttemptBudget
} from "@book-maker/core";
import { usesShortPictureBookReview } from "../generation/shortPictureBook.js";
import { shortPictureBookChecks } from "../generation/shortPictureBookReviewCache.js";
import { reviewPageWithQualityGates } from "../generation/pageQualityGateReview.js";
import type { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { hasOnlyInheritedEditorialFindings, RepairRejectedError } from "./compileRepairOutcome.js";

type Candidate = Awaited<ReturnType<typeof repairPictureBookManuscript>>;

/** Rebuild every assessment for the exact combined candidate before publication. */
export async function reviewShortBookRepairCandidate(
  options: Parameters<typeof repairPagesFromFinalQa>[0], candidate: Candidate,
  previous: { pages: Candidate["pages"]; reviews: PictureBookPageReview[] } | undefined, textModel: TextModelAdapter,
  textAttemptBudget: TextAttemptBudget, assertActive: () => Promise<void>,
  baseline?: { pages: Candidate["pages"]; reviews: PictureBookPageReview[] }
): Promise<PictureBookPageReview[]> {
  const checks = shortPictureBookChecks(options.quality);
  let reviews: PictureBookPageReview[];
  if (!usesShortPictureBookReview({ ...options, pages: candidate.pages }))
    throw new Error("Coordinated repair exceeded the short manuscript budget.");
  await assertActive();
  const changed = new Set(candidate.context.changes.map((change) => change.pageIndex));
  // Cheap required/local checks reject a doomed candidate before buying a
  // full-manuscript model call. Unslop runs on changed prose for each candidate.
  for (const page of candidate.pages) {
    const local = await reviewPageWithQualityGates({ strategy: options.strategy, quality: options.quality,
      decisions: options.providers.decisions, allowModelReview: false, allowSmartUnslop: changed.has(page.index),
      reviewOptions: { input: options.input, plan: options.plan, pageIndex: page.index,
        draft: { ...page, continuityNotes: [] }, previousPages: candidate.pages.filter((item) => item.index < page.index),
        nextPages: candidate.pages.filter((item) => item.index > page.index), continuityNotes: [], textModel: options.providers.text } });
    if (!local.approved) throw new RepairRejectedError("local_checks", [page.index],
      `Coordinated repair failed local checks: ${local.issues.join(" ")}`);
  }
  await assertActive();
  const reviewOptions = { input: options.input, plan: options.plan, pages: candidate.pages,
    chapterBriefs: [], repairContext: candidate.context, textModel, textAttemptBudget, projectId: options.projectId,
    ...(previous ? { previousReview: previous,
      reusableStoryExtracts: unchangedPrefixStoryExtracts(previous.pages, candidate.pages, previous.reviews) } : {}), checks };
  try { reviews = await reviewPictureBookSentenceRepair({ ...reviewOptions, baseline }) ?? await reviewPictureBookManuscript(reviewOptions); }
  catch (error) {
    const retained = error instanceof PictureBookReviewIncompleteError ? retainUnverifiedRepairPrefix(reviewOptions, error.checkpoint) : undefined;
    if (!retained) throw error;
    reviews = retained;
  }
  // Reuse grouped model assessments for the normal required/local/unslop
  // gates. Never fall back to one paid review or repair loop per page.
  for (const review of reviews) {
    const page = candidate.pages.find((item) => item.index === review.pageIndex)!;
    const previousPages = candidate.pages.filter((item) => item.index < page.index);
    const nextPages = candidate.pages.filter((item) => item.index > page.index);
    let report = await reviewPageWithQualityGates({ strategy: options.strategy, quality: options.quality,
      precomputedReport: review.report, allowSmartUnslop: false,
      reviewOptions: { input: options.input, plan: options.plan, pageIndex: page.index,
        draft: { ...page, continuityNotes: [] }, previousPages, nextPages, continuityNotes: [], textModel: options.providers.text } });
    if (review.storyExtract) {
      review.storyExtract = validateStoryExtractEvidence(review.storyExtract, page, candidate.pages);
      report = withStoryContradictions(report, review.storyExtract.contradictions);
    }
    if (review.styleAudit) {
      review.styleAudit = validateStyleAuditEvidence(review.styleAudit, page.markdown);
      report = withStyleAudit(report, review.styleAudit);
    }
    review.report = report;
  }

  return reviews;
}

export function shortBookRepairRejection(context: PictureBookRepairContext, reviews: PictureBookPageReview[]): RepairRejectedError | undefined {
  const failures: RepairRejectedError[] = [];
  const changed = new Set(context.changes.map((change) => change.pageIndex));
  const unresolvedRequirements = (context.requirementTargets ?? []).flatMap(target => {
    const assessment = reviews.find(review => review.pageIndex === target.pageIndex)?.requirementAssessments?.find(item => item.findingId === target.id);
    return !assessment?.resolved || !assessment.noNewRegressions ? [{ target, assessment }] : [];
  });
  if (unresolvedRequirements.length) failures.push(new RepairRejectedError(
    unresolvedRequirements.some(({ assessment }) => assessment?.noNewRegressions === false) ? "semantic_regression" : "target_unresolved",
    [...new Set(unresolvedRequirements.map(({ target }) => target.pageIndex))],
    unresolvedRequirements.map(({ target, assessment }) => `Requirement “${target.requirementQuote}”: ${assessment?.reason ?? target.acceptanceCriteria}`).join(" ")));
  const unsafe = reviews.filter((review) => changed.has(review.pageIndex) &&
    (!review.repairAssessment?.targetResolved || !review.repairAssessment.meaningPreserved || !review.repairAssessment.noNewRegressions));
  if (unsafe.length) failures.push(new RepairRejectedError(unsafe.some((review) =>
    !review.repairAssessment?.meaningPreserved || !review.repairAssessment.noNewRegressions) ? "semantic_regression" : "target_unresolved", unsafe.map((review) => review.pageIndex),
    unsafe.map((review) => `Page ${review.pageIndex}: ${review.repairAssessment?.reason ?? "Missing semantic comparison."}`).join(" ")));
  const rejected = reviews.filter((review) => !review.report.approved &&
    !hasOnlyInheritedEditorialFindings(review, context));
  if (rejected.length) failures.push(new RepairRejectedError("verification_failed", rejected.map((review) => review.pageIndex),
    rejected.map((review) => `Page ${review.pageIndex}: ${review.report.issues.join(" ")}`).join(" ")));
  if (!failures.length) return undefined;
  return new RepairRejectedError(failures.some(failure => failure.failureClass === "semantic_regression") ? "semantic_regression"
    : failures.some(failure => failure.failureClass === "target_unresolved") ? "target_unresolved" : "verification_failed",
    [...new Set(failures.flatMap(failure => failure.affectedPageIndexes))], failures.map(failure => failure.message).join(" "));
}

/** Only actionable, verified review failures can spend the remaining correction. */
export function shortBookRepairFeedback(reviews: PictureBookPageReview[], rejection: RepairRejectedError): PictureBookRepairFeedback["failures"] {
  return rejection.affectedPageIndexes.map(pageIndex => {
    const review = reviews.find(item => item.pageIndex === pageIndex)!;
    return { pageIndex, issues: [...new Set([
      ...review.report.issues, ...review.report.requiredRevisions,
      ...(review.repairAssessment ? [review.repairAssessment.reason] : []),
      // Grounded finding quotations and related-page evidence are already in report.issues.
      ...(review.requirementAssessments ?? []).filter(item => !item.resolved || !item.noNewRegressions).map(item => item.reason)
    ])] };
  });
}
