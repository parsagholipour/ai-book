import { prisma } from "@book-maker/db";
import { z } from "zod";
import { pageQualityReportSchema, pageStyleAuditSchema, pictureBookReviewFingerprint, storyExtractResultSchema,
  pictureBookRequirementTargets, pictureBookFindingSchema, pictureBookRepairAssessmentSchema, pictureBookRequirementAssessmentSchema,
  pictureBookCitationRowsSchema, pictureBookEditorialRowsSchema,
  type BookPlan, type CreateProjectInput, type PictureBookPageReview, type PictureBookReviewChecks, type PriorPageContext } from "@book-maker/core";
import type { QualityGateContext } from "./qualityEnrichment.js";
import { pictureBookDeliveryReviews, type PictureBookDeliveryReview } from "./shortPictureBookReviewDelivery.js";

export function shortPictureBookChecks(quality: QualityGateContext): PictureBookReviewChecks {
  return { pageModelReview: quality.enabled("pageModelReview"), storyExtractAudit: quality.enabled("storyExtractAudit"),
    styleAuditor: quality.enabled("styleAuditor") && quality.enabled("styleExcerpts") };
}
export const savedPictureBookReviewSchema = z.object({
  pageIndex: z.number().int().positive(), draftMarkdown: z.string(), report: pageQualityReportSchema,
  storyExtract: storyExtractResultSchema.extend({ unverifiedContradictions: z.array(z.string()).optional(),
    findingIdsByContradiction: z.record(z.string(), z.string()).optional() })
    .transform(({ unverifiedContradictions, ...extract }) => ({ ...extract, ...(unverifiedContradictions ? { unverifiedContradictions } : {}) })).nullable(),
  findings: z.array(pictureBookFindingSchema).optional(), repairAssessment: pictureBookRepairAssessmentSchema.optional(),
  unverifiedFindings: z.array(pictureBookFindingSchema).optional(),
  requirementAssessments: z.array(pictureBookRequirementAssessmentSchema).optional(),
  styleAudit: pageStyleAuditSchema.extend({ styleOk: z.boolean(), styleIssues: z.array(z.string()), unverifiedStyleIssues: z.array(z.string()).optional() })
    .transform(({ unverifiedStyleIssues, ...audit }) => ({ ...audit, ...(unverifiedStyleIssues ? { unverifiedStyleIssues } : {}) })).nullable(),
  completedChecks: z.object({ pageModelReview: z.boolean(), storyExtractAudit: z.boolean(), styleAuditor: z.boolean() })
});
type Context = { input: CreateProjectInput; plan: BookPlan; pages: readonly PriorPageContext[]; checks: PictureBookReviewChecks };
const snapshotSchema = z.object({ fingerprint: z.string(), reviews: z.array(savedPictureBookReviewSchema),
  unresolvedPageIndexes: z.array(z.number()).optional(), protocolIssues: z.array(z.string()).optional(),
  validationIssues: z.array(z.unknown()).optional(), citationRows: z.array(z.unknown()).optional(), editorialRows: z.array(z.unknown()).optional() });

/** The hash binds the current contract, full prose, canon, settings and chapter partition. */
export function readPictureBookReviewSnapshot(value: unknown, options: Context): PictureBookPageReview[] | undefined {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const snapshot = parsed.data;
  if (snapshot.fingerprint !== pictureBookReviewFingerprint(options) || snapshot.unresolvedPageIndexes?.length || snapshot.protocolIssues?.length || snapshot.validationIssues?.length || snapshot.citationRows?.length || snapshot.editorialRows?.length ||
    snapshot.reviews.length !== options.pages.length || new Set(snapshot.reviews.map((review) => review.pageIndex)).size !== options.pages.length) return undefined;
  const valid = snapshot.reviews.every((review) => (!review.unverifiedFindings?.length || !review.report.approved) &&
    options.pages.some((page) => page.index === review.pageIndex && page.markdown === review.draftMarkdown) &&
    Object.entries(options.checks).every(([key, enabled]) => review.completedChecks[key as keyof PictureBookReviewChecks] === enabled) &&
    options.checks.storyExtractAudit === (review.storyExtract !== null) && options.checks.styleAuditor === (review.styleAudit !== null));
  return valid ? snapshot.reviews : undefined;
}

const deliverySnapshotSchema = snapshotSchema.extend({ deliveryFallback: z.literal(true), version: z.literal(2),
  roundsStarted: z.number().int().min(0).max(2), attemptsUsed: z.number().int().min(0).max(5), outputWidened: z.boolean(),
  unresolvedPageIndexes: z.array(z.number().int().positive()), protocolIssues: z.array(z.string()),
  validationIssues: z.array(z.object({ pageIndex: z.number().int().positive(), message: z.string() })),
  citationRows: pictureBookCitationRowsSchema.default([]), editorialRows: pictureBookEditorialRowsSchema.default([])
});
/** Explicit delivery fallback is reusable for export, never as repair-acceptance evidence. */
export function readPictureBookDeliverySnapshot(value: unknown, options: Context): PictureBookDeliveryReview[] | undefined {
  const complete = readPictureBookReviewSnapshot(value, options);
  if (complete) return complete;
  const parsed = deliverySnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.fingerprint !== pictureBookReviewFingerprint(options) ||
    (parsed.data.roundsStarted < 2 && parsed.data.attemptsUsed < 5)) return undefined;
  return pictureBookDeliveryReviews({ ...options, checkpoint: parsed.data });
}

/** The initial review belongs to GENERATE_BOOK, while a repair belongs to COMPILE_EXPORT.
 * Cross that job boundary only within the same project/plan and with an exact context hash.
 */
export async function loadPictureBookReviewSnapshot(options: Context & {
  projectId: string; planId?: string | undefined; generationJobId?: string | undefined;
}): Promise<PictureBookPageReview[] | undefined> {
  return loadSnapshot(options, readPictureBookReviewSnapshot);
}

export async function loadPictureBookDeliverySnapshot(options: Parameters<typeof loadPictureBookReviewSnapshot>[0]): Promise<PictureBookDeliveryReview[] | undefined> {
  return loadSnapshot(options, readPictureBookDeliverySnapshot);
}

async function loadSnapshot<T>(options: Parameters<typeof loadPictureBookReviewSnapshot>[0], read: (value: unknown, context: Context) => T | undefined): Promise<T | undefined> {
  if (!options.generationJobId) return undefined;
  const row = await prisma.generationJob.findUnique({ where: { id: options.generationJobId }, select: { payload: true } });
  const payload = row?.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
  const current = read(payload.pictureBookFinalReview, options) ?? read(payload.pictureBookReview, options);
  if (current || !options.planId) return current;
  const generation = await prisma.generationJob.findFirst({ where: { projectId: options.projectId, type: "GENERATE_BOOK", status: "COMPLETED",
    payload: { path: ["planId"], equals: options.planId } }, orderBy: { createdAt: "desc" }, select: { payload: true } });
  const prior = generation?.payload && typeof generation.payload === "object" && !Array.isArray(generation.payload) ? generation.payload : {};
  return read(prior.pictureBookReview, options);
}

/** Reuse only current full-manuscript evidence when reconciling coverage reviewers. */
export async function loadPictureBookRequirementTargets(options: Parameters<typeof loadPictureBookReviewSnapshot>[0]) {
  const reviews = await loadPictureBookReviewSnapshot(options);
  return pictureBookRequirementTargets(options.input.prompt, options.pages, reviews ?? []);
}
