import { prisma } from "@book-maker/db";
import { z } from "zod";
import { pageQualityReportSchema, pageStyleAuditSchema, pictureBookReviewFingerprint, storyExtractResultSchema,
  type BookPlan, type CreateProjectInput, type PictureBookPageReview, type PictureBookReviewChecks, type PriorPageContext } from "@book-maker/core";
import type { QualityGateContext } from "./qualityEnrichment.js";

export function shortPictureBookChecks(quality: QualityGateContext): PictureBookReviewChecks {
  return { pageModelReview: quality.enabled("pageModelReview"), storyExtractAudit: quality.enabled("storyExtractAudit"),
    styleAuditor: quality.enabled("styleAuditor") && quality.enabled("styleExcerpts") };
}
export const savedPictureBookReviewSchema = z.object({
  pageIndex: z.number().int().positive(), draftMarkdown: z.string(), report: pageQualityReportSchema,
  storyExtract: storyExtractResultSchema.nullable(),
  styleAudit: pageStyleAuditSchema.extend({ styleOk: z.boolean(), styleIssues: z.array(z.string()) }).nullable(),
  completedChecks: z.object({ pageModelReview: z.boolean(), storyExtractAudit: z.boolean(), styleAuditor: z.boolean() })
});
type Context = { input: CreateProjectInput; plan: BookPlan; pages: readonly PriorPageContext[]; checks: PictureBookReviewChecks };
const snapshotSchema = z.object({ fingerprint: z.string(), reviews: z.array(savedPictureBookReviewSchema),
  unresolvedPageIndexes: z.array(z.number()).optional(), protocolIssues: z.array(z.string()).optional(),
  validationIssues: z.array(z.unknown()).optional() });

/** The hash binds the current contract, full prose, canon, settings and chapter partition. */
export function readPictureBookReviewSnapshot(value: unknown, options: Context): PictureBookPageReview[] | undefined {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const snapshot = parsed.data;
  if (snapshot.fingerprint !== pictureBookReviewFingerprint(options) || snapshot.unresolvedPageIndexes?.length || snapshot.protocolIssues?.length || snapshot.validationIssues?.length ||
    snapshot.reviews.length !== options.pages.length || new Set(snapshot.reviews.map((review) => review.pageIndex)).size !== options.pages.length) return undefined;
  const valid = snapshot.reviews.every((review) => options.pages.some((page) => page.index === review.pageIndex && page.markdown === review.draftMarkdown) &&
    Object.entries(options.checks).every(([key, enabled]) => review.completedChecks[key as keyof PictureBookReviewChecks] === enabled) &&
    options.checks.storyExtractAudit === (review.storyExtract !== null) && options.checks.styleAuditor === (review.styleAudit !== null));
  return valid ? snapshot.reviews : undefined;
}

/** The initial review belongs to GENERATE_BOOK, while a repair belongs to COMPILE_EXPORT.
 * Cross that job boundary only within the same project/plan and with an exact context hash.
 */
export async function loadPictureBookReviewSnapshot(options: Context & {
  projectId: string; planId?: string | undefined; generationJobId?: string | undefined;
}): Promise<PictureBookPageReview[] | undefined> {
  if (!options.generationJobId) return undefined;
  const row = await prisma.generationJob.findUnique({ where: { id: options.generationJobId }, select: { payload: true } });
  const payload = row?.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
  const current = readPictureBookReviewSnapshot(payload.pictureBookFinalReview, options) ?? readPictureBookReviewSnapshot(payload.pictureBookReview, options);
  if (current || !options.planId) return current;
  const generation = await prisma.generationJob.findFirst({ where: { projectId: options.projectId, type: "GENERATE_BOOK", status: "COMPLETED",
    payload: { path: ["planId"], equals: options.planId } }, orderBy: { createdAt: "desc" }, select: { payload: true } });
  const prior = generation?.payload && typeof generation.payload === "object" && !Array.isArray(generation.payload) ? generation.payload : {};
  return readPictureBookReviewSnapshot(prior.pictureBookReview, options);
}
