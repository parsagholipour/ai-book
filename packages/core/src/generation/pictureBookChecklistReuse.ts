import type { PictureBookReviewOptions } from "./pictureBookReview.js";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";
import { pictureBookReviewFingerprint } from "./pictureBookReviewContext.js";
import { pictureBookChecklistErrors, pictureBookPageRequirements, pictureBookRequirementChecksSchema } from "./pictureBookPreRepairChecklist.js";

/** Reuse witnesses, never verdicts. The model still checks each obligation in
 * current context and must explicitly confirm reuse. Changed dependencies can
 * produce fresh findings even though this page's evidence text did not change. */
export function reusablePictureBookChecklists(options: PictureBookReviewOptions) {
  const reusable = new Map<number, NonNullable<PictureBookPageReview["requirementChecks"]>>();
  const previous = options.previousReview;
  if (!previous || !options.checks.pageModelReview || !pictureBookPageRequirements(options.input, options.plan).length ||
    previous.fingerprint !== pictureBookReviewFingerprint({ ...options, pages: previous.pages })) return reusable;
  for (const page of options.pages) {
    const originals = previous.pages.filter(original => original.index === page.index);
    const reviews = previous.reviews.filter(review => review.pageIndex === page.index);
    const review = reviews[0];
    if (originals.length !== 1 || reviews.length !== 1 || !review || originals[0]!.markdown !== page.markdown ||
      originals[0]!.title !== page.title || review.draftMarkdown !== page.markdown || !review.report.approved ||
      !review.findings || review.findings.length || review.unverifiedFindings?.length ||
      review.report.issues.length || review.report.requiredRevisions.length || review.report.unsupportedClaims.length ||
      Object.values(review.report.checks).some(passed => passed === false) ||
      Object.entries(options.checks).some(([key, enabled]) => review.completedChecks[key as keyof typeof options.checks] !== enabled)) continue;
    const checks = pictureBookRequirementChecksSchema.safeParse(review.requirementChecks);
    if (!checks.success || checks.data.some(check => check.evidence === null) ||
      pictureBookChecklistErrors({ ...options, enabled: true }, page.markdown, checks.data, []).length) continue;
    reusable.set(page.index, checks.data);
  }
  return reusable;
}

export function resolveReusedPictureBookChecklist(value: unknown, reusable: ReturnType<typeof reusablePictureBookChecklists>): unknown {
  if (!value || typeof value !== "object" || !("pageIndex" in value) || typeof value.pageIndex !== "number" ||
    !("requirementChecks" in value) || value.requirementChecks !== "reuse") return value;
  const checks = reusable.get(value.pageIndex);
  // An unoffered/stale reuse marker remains invalid and takes bounded recovery.
  return checks ? { ...value, requirementChecks: checks.map(check => ({ ...check })) } : value;
}

export const PICTURE_BOOK_CHECKLIST_REUSE_GUIDANCE = "For reusableRequirementCheckPageIndexes only, you may return requirementChecks=\"reuse\" AFTER checking that every pageRequirements obligation still holds in the current story. This retains verified exact witnesses for unchanged prose under the same brief and review context. It does not reuse the previous verdict: assess all current prose and dependencies, return fresh scores and report any overlooked or introduced defect. If any obligation no longer holds, return a fresh span-ID/null array and grounded findings instead. All other pages require fresh witnesses.";
