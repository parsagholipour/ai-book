import { pictureBookChecklistReferencesSchema } from "./pictureBookChecklistSpans.js";
import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
import { z } from "zod";
import { pictureBookFindingSchema, pictureBookReviewRowSchema, type PictureBookReviewChecks } from "./pictureBookReviewValidation.js";

/** The wire contract includes only enabled work. Stored rows remain canonical,
 * including nulls for disabled checks, so checkpoints keep the same semantics. */
export function pictureBookReviewContract(checks: PictureBookReviewChecks, repair: boolean, requirementChecklist = false, reusableChecklist = false) {
  const row = pictureBookReviewRowSchema.omit({
    ...(!requirementChecklist ? { requirementChecks: true as const } : {}),
    ...(!repair ? { repairAssessment: true as const, requirementAssessments: true as const } : {}),
    ...(!checks.storyExtractAudit ? { storyExtract: true as const, continuityFindingLinks: true as const } : {}),
    ...(!checks.styleAuditor ? { styleAudit: true as const } : {}),
    ...(checks.pageModelReview ? { findings: true as const } : {})
  });
  return z.strictObject({
    // New model responses must declare scope; canonical rows still accept legacy checkpoints.
    ...(checks.pageModelReview ? { findings: z.array(pictureBookFindingSchema.extend({
      pageIndex: z.number().int().positive(), repairKind: pictureBookFindingSchema.shape.repairKind.unwrap()
    })).max(160) } : {}),
    pages: z.array(requirementChecklist ? row.extend({ requirementChecks: reusableChecklist
      ? z.union([pictureBookChecklistReferencesSchema, z.literal("reuse")]) : pictureBookChecklistReferencesSchema }) : row).min(1).max(MAX_PICTURE_BOOK_PAGES)
  });
}

/** Accept legacy explicit nulls too; never erase non-null disabled results, or
 * fabricate a result for an enabled check. Validation still rejects those. */
export function canonicalPictureBookChecks(value: unknown, checks: PictureBookReviewChecks): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value,
    ...("findings" in value && Array.isArray(value.findings) ? { findings: value.findings.map(finding => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding) ||
        !["page_prose", "missing_requirement"].includes(finding.basis) ||
        !Array.isArray(finding.repairPageIndexes) || finding.repairPageIndexes.length) return finding;
      // An empty LOCAL scope asserts no connected edit. It is equivalent to
      // omission, never permission to infer an interval from supporting quotes.
      const { repairPageIndexes: _empty, ...local } = finding;
      return local;
    }) } : {}),
    ...(!checks.storyExtractAudit && !("storyExtract" in value) ? { storyExtract: null } : {}),
    ...(!checks.styleAuditor && !("styleAudit" in value) ? { styleAudit: null } : {})
  };
}
