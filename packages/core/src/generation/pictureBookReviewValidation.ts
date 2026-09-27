import { z } from "zod";
import type { CreateProjectInput, PageQualityReport } from "../schemas/book.js";
import type { PriorPageContext } from "./pagesShared.js";
import { storyExtractResultSchema, type StoryExtractResult } from "./storyState.js";
import { pageStyleAuditSchema, type PageStyleAudit } from "./styleAuditor.js";
import { pageGetsInteriorIllustration } from "./illustrationSlots.js";
import type { PictureBookRepairContext } from "./pictureBookRepair.js";
import { pictureBookRequirementAssessmentSchema, requirementAssessmentErrors, type PictureBookRequirementAssessment } from "./pictureBookRequirementTargets.js";
import { linkContinuityFindings, pictureBookFindingDiagnosis } from "./pictureBookFindingIdentity.js";
import { pictureBookExactQuote } from "./pictureBookExactQuote.js";
import { pictureBookMeasurementErrors } from "./pictureBookReviewMeasurements.js";
import { pictureBookSceneRepairScopeErrors } from "./pictureBookSceneRepairTargets.js";
import { isPictureBookSentenceLengthFinding } from "./pictureBookSentenceFindings.js";

export const PICTURE_BOOK_CITATION_ERROR = "Each finding needs exact quotes from its actual page and any related page.";

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
};
export const pictureBookFindingSchema = z.strictObject({
  domain: z.enum(["prose", "deferred_media"]),
  basis: z.enum(["page_prose", "cross_page", "missing_requirement"]),
  requirementQuote: z.string().min(1).max(700).nullable(),
  category: z.enum(["repetition", "progression", "continuity", "brief", "language", "arc", "plot", "style", "prompt_leak"]),
  repairKind: z.enum(["sentence_length", "semantic"]).optional(),
  message: z.string().trim().min(1).max(500),
  guidance: z.string().trim().min(1).max(500),
  repairPageIndexes: z.array(z.number().int().positive()).min(2).max(40).optional(),
  quote: z.string().min(12).max(700),
  relatedEvidence: z.array(z.strictObject({ pageIndex: z.number().int().positive(), quote: z.string().min(12).max(700) })).max(3).default([])
});
const findingSchema = pictureBookFindingSchema;
const reusedExtractSchema = storyExtractResultSchema.extend({ unverifiedContradictions: z.array(z.string()).optional(),
  findingIdsByContradiction: z.record(z.string(), z.string()).optional() })
  .transform(({ unverifiedContradictions, ...extract }) => ({ ...extract, ...(unverifiedContradictions ? { unverifiedContradictions } : {}) }));
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
function canonicalExtract(extract: z.infer<typeof compactExtractSchema>): StoryExtractResult {
  const { unansweredAdded, unansweredResolved, ...rest } = extract;
  return storyExtractResultSchema.parse({ ...rest, storyDelta: { ...rest.storyDelta,
    ...(unansweredAdded === undefined ? {} : { unansweredAdded }), ...(unansweredResolved === undefined ? {} : { unansweredResolved }) } });
}
export const pictureBookReviewRowSchema = z.strictObject({
  pageIndex: z.number().int().positive(), score: z.number().int().min(0).max(100),
  findings: z.array(findingSchema).max(8),
  continuityFindingLinks: z.unknown().optional(),
  repairAssessment: pictureBookRepairAssessmentSchema.optional(),
  requirementAssessments: z.array(pictureBookRequirementAssessmentSchema).max(8).optional(),
  storyExtract: z.union([z.literal("no_changes"), z.literal("reuse"), compactExtractSchema]).nullable(),
  styleAudit: z.union([z.literal("clean"), pageStyleAuditSchema.extend({ styleOk: z.boolean(), styleIssues: z.array(z.string()) })]).nullable()
});
export const pictureBookReviewResponseSchema = z.strictObject({ pages: z.array(pictureBookReviewRowSchema.omit({ repairAssessment: true, requirementAssessments: true })).min(1).max(40) });
export const pictureBookRepairReviewResponseSchema = z.strictObject({ pages: z.array(pictureBookReviewRowSchema).min(1).max(40) });


export function validatedPictureBookReviewRow(options: {
  input: CreateProjectInput; checks: PictureBookReviewChecks; pages: ReadonlyMap<number, PriorPageContext>;
  repairContext?: PictureBookRepairContext;
  reusableStoryExtracts?: ReadonlyMap<number, StoryExtractResult>;
}) {
  return pictureBookReviewRowSchema.transform((review) => {
    const quote = (index: number, original: string) => {
      const page = options.pages.get(index);
      return page ? pictureBookExactQuote(page.markdown, original) ?? original : original;
    };
    return { ...review, findings: review.findings.map(finding => ({ ...finding,
      quote: quote(review.pageIndex, finding.quote), relatedEvidence: finding.relatedEvidence.map(evidence => ({
        ...evidence, quote: quote(evidence.pageIndex, evidence.quote)
      })) })), styleAudit: review.styleAudit && typeof review.styleAudit === "object"
        ? { ...review.styleAudit, ...(review.styleAudit.evidence ? { evidence: review.styleAudit.evidence.map(evidence => ({
          ...evidence, quote: quote(review.pageIndex, evidence.quote)
        })) } : {}) } : review.styleAudit };
  }).superRefine((review, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    const page = options.pages.get(review.pageIndex);
    if (!page) { fail("Invented page index."); return; }
    for (const error of pictureBookMeasurementErrors(page.markdown, [
      ...review.findings.flatMap(finding => [finding.message, finding.guidance]),
      ...(review.repairAssessment ? [review.repairAssessment.reason] : []),
      ...(review.requirementAssessments ?? []).map(assessment => assessment.reason),
      ...(review.styleAudit && typeof review.styleAudit === "object" ? review.styleAudit.styleIssues : [])
    ])) fail(error);
    for (const error of requirementAssessmentErrors(options.repairContext?.requirementTargets ?? [], review.pageIndex, review.requirementAssessments, options.pages)) fail(error);
    if (review.storyExtract === "reuse" && !options.reusableStoryExtracts?.has(review.pageIndex))
      fail("storyExtract=reuse requires a verified unchanged chronological prefix for this page.");
    if (options.repairContext?.changes.some((change) => change.pageIndex === review.pageIndex) && !review.repairAssessment)
      fail("Every changed repair page needs an explicit repairAssessment against its original prose and all downstream dependencies.");
    if (options.checks.storyExtractAudit !== (review.storyExtract !== null) || options.checks.styleAuditor !== (review.styleAudit !== null))
      fail("Enabled checks require results; disabled checks must be null.");
    if (!options.checks.pageModelReview && review.findings.length) fail("Page model review is disabled; return no page findings.");
    for (const finding of review.findings) {
      // An inexact quotation takes the existing citation-only recovery path first.
      if (finding.repairKind === "sentence_length" && page.markdown.includes(finding.quote) && !isPictureBookSentenceLengthFinding(options.input, page, finding))
        fail("A sentence_length finding requires a measured sentence-length violation and local language evidence in an eligible original sentence, without semantic or cross-page scope.");
      for (const error of pictureBookSceneRepairScopeErrors(review.pageIndex, finding, options.pages)) fail(error);
      if (finding.basis === "cross_page" && finding.relatedEvidence.length === 0) fail("Cross-page defects need related prose evidence.");
      if (finding.basis === "missing_requirement" && (!finding.requirementQuote || !options.input.prompt.includes(finding.requirementQuote)))
        fail("A missing deliverable must quote the exact user requirement, never an inferred chapter beat.");
      if (!page.markdown.includes(finding.quote) || finding.relatedEvidence.some((evidence) => !options.pages.get(evidence.pageIndex)?.markdown.includes(evidence.quote)))
        fail(PICTURE_BOOK_CITATION_ERROR);
      if (finding.domain === "deferred_media" && (finding.basis !== "missing_requirement" || !pageGetsInteriorIllustration(options.input, page.index)))
        fail("Only a requested interior illustration on a selected illustration slot can be deferred to the artwork stage.");
    }
  });
}

export function pictureBookPageReview(review: z.infer<typeof pictureBookReviewRowSchema>, page: PriorPageContext, checks: PictureBookReviewChecks, brief: string, reusedExtract?: StoryExtractResult): PictureBookPageReview {
    const proseFindings = review.findings.filter((finding) => finding.domain === "prose");
    const deferred = review.findings.filter((finding) => finding.domain === "deferred_media");
    const categories = new Set(proseFindings.map((finding) => finding.category));
    return {
      pageIndex: review.pageIndex, draftMarkdown: page.markdown,
      findings: review.findings,
      ...(review.repairAssessment ? { repairAssessment: review.repairAssessment } : {}),
      ...(review.requirementAssessments ? { requirementAssessments: review.requirementAssessments } : {}),
      report: {
        approved: proseFindings.length === 0, score: review.score, issues: proseFindings.map(finding => pictureBookFindingDiagnosis(review.pageIndex, finding)),
        requiredRevisions: proseFindings.map((finding) => finding.guidance), notes: "Reviewed against the complete frozen picture-book manuscript.",
        ...(deferred.length ? { deferredMedia: { stage: "before_illustrations" as const, brief, pageIndex: page.index, draftMarkdown: page.markdown,
          requirements: deferred.map((finding) => ({ kind: "interior_illustration" as const, pageIndex: page.index, requirementQuote: finding.requirementQuote!, quote: finding.quote })) } } : {}),
        groundedOk: true, groundingStatus: "not_applicable", unsupportedClaims: [],
        checks: { placeholderFree: true, promptLeakFree: !categories.has("prompt_leak"), titleClean: true,
          repetitionOk: !categories.has("repetition"), progressionOk: !["progression", "continuity", "brief", "arc", "plot"].some((category) => categories.has(category as z.infer<typeof findingSchema>["category"])),
          styleNatural: !categories.has("style") }
      },
      storyExtract: linkContinuityFindings(review.storyExtract === null ? null : review.storyExtract === "reuse" ? reusedExtractSchema.parse(reusedExtract)
        : review.storyExtract === "no_changes" ? storyExtractResultSchema.parse({ storyDelta: {} }) : canonicalExtract(review.storyExtract),
        review.pageIndex, review.findings, review.continuityFindingLinks),
      styleAudit: review.styleAudit === null ? null : pageStyleAuditSchema.parse(review.styleAudit === "clean" ? { styleOk: true, styleIssues: [] } : review.styleAudit), completedChecks: { ...checks }
    };
}
