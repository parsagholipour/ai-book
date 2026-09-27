import { z } from "zod";
import { pictureBookFindingSchema, pictureBookReviewRowSchema, type PictureBookReviewChecks } from "./pictureBookReviewValidation.js";

/** The wire contract includes only enabled work. Stored rows remain canonical,
 * including nulls for disabled checks, so checkpoints keep the same semantics. */
export function pictureBookReviewContract(checks: PictureBookReviewChecks, repair: boolean) {
  const row = pictureBookReviewRowSchema.omit({
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
    pages: z.array(row).min(1).max(40)
  });
}

/** Accept legacy explicit nulls too; never erase non-null disabled results, or
 * fabricate a result for an enabled check. Validation still rejects those. */
export function canonicalPictureBookChecks(value: unknown, checks: PictureBookReviewChecks): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value,
    ...(!checks.storyExtractAudit && !("storyExtract" in value) ? { storyExtract: null } : {}),
    ...(!checks.styleAuditor && !("styleAudit" in value) ? { styleAudit: null } : {})
  };
}
