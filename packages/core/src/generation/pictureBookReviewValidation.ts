import { z } from "zod";
import type { CreateProjectInput, PageQualityReport } from "../schemas/book.js";
import type { PriorPageContext } from "./pagesShared.js";
import { storyExtractResultSchema, type StoryExtractResult } from "./storyState.js";
import { pageStyleAuditSchema, type PageStyleAudit } from "./styleAuditor.js";
import { pageGetsInteriorIllustration } from "./illustrationSlots.js";
import type { PictureBookRepairContext } from "./pictureBookRepair.js";

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
  /** Optional only for old checkpoints and reviews outside sentence repair. */
  findings?: z.infer<typeof findingSchema>[];
  repairAssessment?: z.infer<typeof pictureBookRepairAssessmentSchema>;
};
const findingSchema = z.strictObject({
  domain: z.enum(["prose", "deferred_media"]),
  basis: z.enum(["page_prose", "cross_page", "missing_requirement"]),
  requirementQuote: z.string().min(1).max(700).nullable(),
  category: z.enum(["repetition", "progression", "continuity", "brief", "language", "arc", "plot", "style", "prompt_leak"]),
  message: z.string().trim().min(1).max(500),
  guidance: z.string().trim().min(1).max(500),
  quote: z.string().min(12).max(700),
  relatedEvidence: z.array(z.strictObject({ pageIndex: z.number().int().positive(), quote: z.string().min(12).max(700) })).max(3).default([])
});
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
  repairAssessment: pictureBookRepairAssessmentSchema.optional(),
  storyExtract: z.union([z.literal("no_changes"), z.literal("reuse"), compactExtractSchema]).nullable(),
  styleAudit: z.union([z.literal("clean"), pageStyleAuditSchema.extend({ styleOk: z.boolean(), styleIssues: z.array(z.string()) })]).nullable()
});
export const pictureBookReviewResponseSchema = z.strictObject({ pages: z.array(pictureBookReviewRowSchema.omit({ repairAssessment: true })).min(1).max(40) });
export const pictureBookSentenceRepairReviewResponseSchema = z.strictObject({ pages: z.array(pictureBookReviewRowSchema).min(1).max(40) });


export function validatedPictureBookReviewRow(options: {
  input: CreateProjectInput; checks: PictureBookReviewChecks; pages: ReadonlyMap<number, PriorPageContext>;
  repairContext?: PictureBookRepairContext;
  reusableStoryExtracts?: ReadonlyMap<number, StoryExtractResult>;
}) {
  return pictureBookReviewRowSchema.superRefine((review, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    const page = options.pages.get(review.pageIndex);
    if (!page) { fail("Invented page index."); return; }
    if (review.storyExtract === "reuse" && !options.reusableStoryExtracts?.has(review.pageIndex))
      fail("storyExtract=reuse requires a verified unchanged chronological prefix for this page.");
    if (options.repairContext?.sentenceOnly && options.repairContext.changes.some((change) => change.pageIndex === review.pageIndex) && !review.repairAssessment)
      fail("Every changed sentence-repair page needs an explicit repairAssessment against its original prose and all downstream dependencies.");
    if (options.checks.storyExtractAudit !== (review.storyExtract !== null) || options.checks.styleAuditor !== (review.styleAudit !== null))
      fail("Enabled checks require results; disabled checks must be null.");
    if (!options.checks.pageModelReview && review.findings.length) fail("Page model review is disabled; return no page findings.");
    for (const finding of review.findings) {
      if (finding.basis === "cross_page" && finding.relatedEvidence.length === 0) fail("Cross-page defects need related prose evidence.");
      if (finding.basis === "missing_requirement" && (!finding.requirementQuote || !options.input.prompt.includes(finding.requirementQuote)))
        fail("A missing deliverable must quote the exact user requirement, never an inferred chapter beat.");
      if (!page.markdown.includes(finding.quote) || finding.relatedEvidence.some((evidence) => !options.pages.get(evidence.pageIndex)?.markdown.includes(evidence.quote)))
        fail("Each finding needs exact quotes from its actual page and any related page.");
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
      report: {
        approved: proseFindings.length === 0, score: review.score, issues: proseFindings.map((finding) => [finding.message,
          `Evidence on page ${review.pageIndex}: “${finding.quote}”`,
          ...finding.relatedEvidence.map((evidence) => `Related page ${evidence.pageIndex}: “${evidence.quote}”`),
          ...(finding.requirementQuote ? [`Requested requirement: “${finding.requirementQuote}”`] : [])].join(" ")),
        requiredRevisions: proseFindings.map((finding) => finding.guidance), notes: "Reviewed against the complete frozen picture-book manuscript.",
        ...(deferred.length ? { deferredMedia: { stage: "before_illustrations" as const, brief, pageIndex: page.index, draftMarkdown: page.markdown,
          requirements: deferred.map((finding) => ({ kind: "interior_illustration" as const, pageIndex: page.index, requirementQuote: finding.requirementQuote!, quote: finding.quote })) } } : {}),
        groundedOk: true, groundingStatus: "not_applicable", unsupportedClaims: [],
        checks: { placeholderFree: true, promptLeakFree: !categories.has("prompt_leak"), titleClean: true,
          repetitionOk: !categories.has("repetition"), progressionOk: !["progression", "continuity", "brief", "arc", "plot"].some((category) => categories.has(category as z.infer<typeof findingSchema>["category"])),
          styleNatural: !categories.has("style") }
      },
      storyExtract: review.storyExtract === null ? null : review.storyExtract === "reuse" ? storyExtractResultSchema.parse(reusedExtract)
        : review.storyExtract === "no_changes" ? storyExtractResultSchema.parse({ storyDelta: {} }) : canonicalExtract(review.storyExtract),
      styleAudit: review.styleAudit === null ? null : pageStyleAuditSchema.parse(review.styleAudit === "clean" ? { styleOk: true, styleIssues: [] } : review.styleAudit), completedChecks: { ...checks }
    };
}
