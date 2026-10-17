import { pictureBookRequirementChecksSchema } from "./pictureBookPreRepairChecklist.js";
import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
import { z } from "zod";
import type { PageQualityReport } from "../schemas/book.js";
import { storyExtractResultSchema, type StoryExtractResult } from "./storyState.js";
import { pageStyleAuditSchema, type PageStyleAudit } from "./styleAuditor.js";
import { pictureBookRequirementAssessmentSchema, type PictureBookRequirementAssessment } from "./pictureBookRequirementTargets.js";

export const pictureBookRepairAssessmentSchema = z.strictObject({
  targetResolved: z.boolean(), meaningPreserved: z.boolean(), noNewRegressions: z.boolean(),
  reason: z.string().trim().min(1).max(700)
});

export type PictureBookReviewChecks = { pageModelReview: boolean; storyExtractAudit: boolean; styleAuditor: boolean };
export type PictureBookPageReview = {
  pageIndex: number;
  draftMarkdown: string;
  report: PageQualityReport;
  storyExtract: StoryExtractResult | null;
  styleAudit: PageStyleAudit | null;
  completedChecks: PictureBookReviewChecks;
  /** Optional for legacy checkpoints. Current reviews preserve structured findings. */
  findings?: z.infer<typeof findingSchema>[] | undefined;
  /** Uncorrected citations on an unchanged pre-edit prefix remain warnings, never approval. */
  unverifiedFindings?: z.infer<typeof findingSchema>[] | undefined;
  repairAssessment?: z.infer<typeof pictureBookRepairAssessmentSchema> | undefined;
  requirementAssessments?: PictureBookRequirementAssessment[] | undefined;
  requirementChecks?: z.infer<typeof pictureBookRequirementChecksSchema> | undefined;
};
export const pictureBookFindingSchema = z.strictObject({
  domain: z.enum(["prose", "deferred_media"]),
  basis: z.enum(["page_prose", "cross_page", "missing_requirement"]),
  requirementQuote: z.string().min(1).max(700).nullable(),
  category: z.enum(["repetition", "progression", "continuity", "brief", "language", "arc", "plot", "style", "prompt_leak"]),
  repairKind: z.enum(["sentence_length", "semantic"]).optional(),
  message: z.string().trim().min(1).max(500),
  guidance: z.string().trim().min(1).max(500),
  repairPageIndexes: z.array(z.number().int().positive()).min(2).max(MAX_PICTURE_BOOK_PAGES).optional(),
  quote: z.string().min(12).max(700),
  relatedEvidence: z.array(z.strictObject({ pageIndex: z.number().int().positive(), quote: z.string().min(12).max(700) })).max(3).default([])
});
const findingSchema = pictureBookFindingSchema;
// Explicit clean/no-change verdicts keep thirty page results compact; omitted
// results remain invalid. Sparse deltas are expanded only after validation.
const deltaFields = storyExtractResultSchema.shape.storyDelta.shape;
const sparseDeltaSchema = z.strictObject({
  promisesOpened: deltaFields.promisesOpened.removeDefault().optional(), promisesPaid: deltaFields.promisesPaid.removeDefault().optional(),
  promisesBroken: deltaFields.promisesBroken.removeDefault().optional(), factsAdded: deltaFields.factsAdded.removeDefault().optional(),
  entities: deltaFields.entities.removeDefault().optional(), unansweredAdded: deltaFields.unansweredAdded.removeDefault().optional(),
  unansweredResolved: deltaFields.unansweredResolved.removeDefault().optional()
});
const compactExtractSchema = storyExtractResultSchema.extend({ storyDelta: sparseDeltaSchema,
  unansweredAdded: z.array(z.string().min(1)).optional(), unansweredResolved: z.array(z.string().min(1)).optional()
}).superRefine((extract, context) => {
  for (const key of ["unansweredAdded", "unansweredResolved"] as const) {
    if (extract[key] !== undefined && extract.storyDelta[key] !== undefined && JSON.stringify(extract[key]) !== JSON.stringify(extract.storyDelta[key]))
      context.addIssue({ code: "custom", message: `Conflicting ${key} at extraction root and storyDelta.` });
  }
});
export const pictureBookReviewRowSchema = z.strictObject({
  pageIndex: z.number().int().positive(), score: z.number().int().min(0).max(100),
  findings: z.array(findingSchema).max(8),
  continuityFindingLinks: z.unknown().optional(),
  requirementChecks: pictureBookRequirementChecksSchema.optional(),
  repairAssessment: pictureBookRepairAssessmentSchema.optional(),
  requirementAssessments: z.array(pictureBookRequirementAssessmentSchema).max(8).optional(),
  storyExtract: z.union([z.literal("no_changes"), z.literal("reuse"), compactExtractSchema]).nullable(),
  styleAudit: z.union([z.literal("clean"), pageStyleAuditSchema.extend({ styleOk: z.boolean(), styleIssues: z.array(z.string()) })]).nullable()
});
