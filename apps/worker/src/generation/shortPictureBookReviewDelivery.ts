import { pageQualityReportSchema, pictureBookPageReview, validatedPictureBookReviewRow,
  type CreateProjectInput, type PictureBookPageReview, type PictureBookReviewCheckpoint,
  type PictureBookReviewChecks, type PriorPageContext } from "@book-maker/core";

/** Delivery may preserve an unreviewed keeper; repair acceptance still requires a complete review. */
export type PictureBookDeliveryReview = PictureBookPageReview & { reviewUnavailable?: true };

export function pictureBookDeliveryReviews(options: {
  input: CreateProjectInput; pages: readonly PriorPageContext[]; checks: PictureBookReviewChecks;
  checkpoint: PictureBookReviewCheckpoint;
}): PictureBookDeliveryReview[] {
  const { checkpoint, checks } = options;
  const pages = new Map(options.pages.map(page => [page.index, page]));
  const editorialChecks = { ...checks, storyExtractAudit: false, styleAuditor: false };
  const editorialSchema = validatedPictureBookReviewRow({ input: options.input, pages, checks: editorialChecks });
  return options.pages.map(page => {
    const candidates = checkpoint.reviews.filter(review => review.pageIndex === page.index);
    const accepted = candidates.length === 1 ? candidates[0] : undefined;
    const valid = accepted && accepted.draftMarkdown === page.markdown &&
      Object.entries(checks).every(([key, enabled]) => accepted.completedChecks[key as keyof PictureBookReviewChecks] === enabled) &&
      checks.storyExtractAudit === (accepted.storyExtract !== null) && checks.styleAuditor === (accepted.styleAudit !== null) &&
      (!accepted.unverifiedFindings?.length || !accepted.report.approved) ? accepted : undefined;
    if (valid && !checkpoint.protocolIssues.length) return valid;
    const retained = checkpoint.editorialRows?.find(row => row.pageIndex === page.index);
    const editorial = retained ? editorialSchema.safeParse({ ...retained, storyExtract: null, styleAudit: null }) : undefined;
    const review = valid ?? (editorial?.success ? pictureBookPageReview(editorial.data, page, editorialChecks, options.input.prompt) : {
      pageIndex: page.index, draftMarkdown: page.markdown,
      report: pageQualityReportSchema.parse({ approved: false, score: 100, scoreBasis: "screened_unscored" }),
      storyExtract: null, styleAudit: null,
      completedChecks: { pageModelReview: false, storyExtractAudit: false, styleAuditor: false },
      ...(checkpoint.citationRows?.find(row => row.pageIndex === page.index)?.findings.length
        ? { unverifiedFindings: checkpoint.citationRows.find(row => row.pageIndex === page.index)!.findings } : {})
    });
    return { ...review, reviewUnavailable: true,
      report: { ...review.report, approved: false,
        // No actionable finding means there is no measured quality score or rewrite target.
        ...(!review.report.issues.length && !review.report.requiredRevisions.length ? { scoreBasis: "screened_unscored" as const } : {}),
        notes: [review.report.notes, "Manuscript review incomplete after bounded attempts; the saved draft remains unverified.",
          ...checkpoint.validationIssues.filter(issue => issue.pageIndex === page.index).map(issue => issue.message),
          ...checkpoint.protocolIssues].filter(Boolean).join("\n") }
    };
  });
}

/** An unavailable assessment is not a prose defect that an automatic rewrite can fix. */
export function isUnavailablePageReview(value: unknown): boolean {
  const parsed = pageQualityReportSchema.safeParse(value);
  return parsed.success && !parsed.data.approved && parsed.data.scoreBasis === "screened_unscored" &&
    !parsed.data.issues.length && !parsed.data.requiredRevisions.length;
}
