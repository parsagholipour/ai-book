import { pageQualityReportSchema } from "@book-maker/core";

/** An unavailable assessment is not a prose defect that an automatic rewrite can fix. */
export function isUnavailablePageReview(value: unknown): boolean {
  const parsed = pageQualityReportSchema.safeParse(value);
  return parsed.success && !parsed.data.approved && parsed.data.scoreBasis === "screened_unscored" &&
    !parsed.data.issues.length && !parsed.data.requiredRevisions.length;
}
