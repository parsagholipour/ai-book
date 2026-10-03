import { usesQuickDraftReview } from "./quickDraftReviewPolicy.js";
import { savedPictureBookReviewSchema, shortPictureBookChecks } from "./shortPictureBookReviewCache.js";
import { prisma, type Prisma } from "@book-maker/db";
import { z } from "zod";
import {
  requestedGenerationPages, hasResearchIntent, isAuthorManuscript, pictureBookReviewFingerprint,
  reviewPictureBookManuscript, PictureBookReviewIncompleteError,
  pictureBookCitationRowsSchema, pictureBookEditorialRowsSchema, pictureBookMetadataRowsSchema,
  type PictureBookReviewCheckpoint,
  type BookGenerationStrategy, type BookPlan, type ChapterBrief, type CreateProjectInput,
  type PictureBookPageReview, type PictureBookReviewChecks, type PriorPageContext, type TextModelAdapter
} from "@book-maker/core";
import { assertJobNotStopped } from "../runtime/jobLifecycle.js";
import type { QualityGateContext } from "./qualityEnrichment.js";
import { pictureBookDeliveryReviews, type PictureBookDeliveryReview } from "./shortPictureBookReviewDelivery.js";

/** Artwork is optional; explicit polish/research strategies keep their requested workflow. */
export function usesShortPictureBookReview(options: {
  input: CreateProjectInput; plan: BookPlan; strategy: BookGenerationStrategy; pages: readonly PriorPageContext[];
}): boolean {
  const { input, pages, strategy } = options;
  return input.category === "KIDS" && input.mediaSettings.finalReview === true && !isAuthorManuscript(input.mediaSettings) &&
    (!input.mediaSettings.generationStrategy || input.mediaSettings.generationStrategy === "auto") &&
    !strategy.researchDepth && !hasResearchIntent(input) && requestedGenerationPages(input) >= 5 && requestedGenerationPages(input) <= 40 &&
    pages.length === input.targetPages && pages.every((page, position) => page.index === position + 1 && page.markdown.trim().length > 0) &&
    pages.reduce((sum, page) => sum + page.markdown.length, 0) <= 48_000 &&
    pages.reduce((sum, page) => sum + page.markdown.trim().split(/\s+/u).length, 0) <= 6_000;
}
const progressSchema = z.object({
  version: z.literal(2), roundsStarted: z.number().int().min(0).max(2), attemptsUsed: z.number().int().min(0).max(5), outputWidened: z.boolean(),
  validationIssues: z.array(z.object({ pageIndex: z.number().int().positive(), message: z.string() })), protocolIssues: z.array(z.string()),
  citationRows: pictureBookCitationRowsSchema.default([]), editorialRows: pictureBookEditorialRowsSchema.default([]),
  metadataRows: pictureBookMetadataRowsSchema.default([])
});
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Checkpoint the group once; no page is published or mutated until its normal ownership claim. */
export async function prepareShortPictureBookReview(options: {
  projectId: string; generationJobId?: string; input: CreateProjectInput; plan: BookPlan;
  pages: readonly PriorPageContext[]; chapterBriefs: readonly ChapterBrief[];
  quality: QualityGateContext; textModel: TextModelAdapter;
}): Promise<Map<number, PictureBookDeliveryReview>> {
  if (usesQuickDraftReview(options.input)) return new Map();
  const checks = shortPictureBookChecks(options.quality);
  if (!Object.values(checks).some(Boolean)) return new Map();
  await assertJobNotStopped(options.generationJobId);
  const fingerprint = pictureBookReviewFingerprint({ ...options, checks });
  const row = options.generationJobId ? await prisma.generationJob.findUnique({
    where: { id: options.generationJobId }, select: { payload: true }
  }) : null;
  const cached = record(record(row?.payload).pictureBookReview);
  const matches = (review: PictureBookPageReview) => Object.entries(checks).every(([key, enabled]) => review.completedChecks[key as keyof PictureBookReviewChecks] === enabled) &&
    (checks.storyExtractAudit === (review.storyExtract !== null)) && (checks.styleAuditor === (review.styleAudit !== null)) &&
    options.pages.some((page) => page.index === review.pageIndex && page.markdown === review.draftMarkdown);
  let resume: PictureBookReviewCheckpoint | undefined;
  if (cached.fingerprint === fingerprint) {
    // Preserve valid rows when one cached row is incomplete, without resetting
    // durable spend or allowing duplicate verdicts to choose their own winner.
    const rawReviews = Array.isArray(cached.reviews) ? cached.reviews : [];
    const parsed = rawReviews.map((review) => savedPictureBookReviewSchema.safeParse(review));
    const counts = new Map<number, number>();
    for (const raw of rawReviews) {
      const index = record(raw).pageIndex;
      if (typeof index === "number") counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    const valid = parsed.flatMap((result) => result.success && counts.get(result.data.pageIndex) === 1 && matches(result.data) ? [result.data] : []);
    const progress = progressSchema.safeParse(cached);
    // A matching but corrupt progress stamp is unknown spend, never a new budget.
    resume = { ...(progress.success ? progress.data : { version: 2 as const, roundsStarted: 2, attemptsUsed: 5, outputWidened: true,
      validationIssues: [], protocolIssues: ["Stored picture-book review progress is invalid."] }), reviews: valid,
      unresolvedPageIndexes: options.pages.filter((page) => !valid.some((review) => review.pageIndex === page.index)).map((page) => page.index) };
    if (!resume.unresolvedPageIndexes.length && !resume.protocolIssues.length && !resume.citationRows?.length && !resume.editorialRows?.length && !resume.metadataRows?.length) return new Map(valid.map((review) => [review.pageIndex, review]));
  }
  let latest = resume;
  const save = async (checkpoint: PictureBookReviewCheckpoint, deliveryFallback = false) => {
    await assertJobNotStopped(options.generationJobId);
    latest = checkpoint;
    if (!options.generationJobId) return;
    const jobId = options.generationJobId;
    await prisma.$transaction(async (tx) => {
      const current = await tx.generationJob.findUnique({ where: { id: jobId }, select: { payload: true } });
      await tx.generationJob.update({ where: { id: jobId }, data: { payload: {
        ...record(current?.payload), pictureBookReview: { fingerprint, ...checkpoint, ...(deliveryFallback ? { deliveryFallback: true } : {}) }
      } as Prisma.InputJsonValue } });
    });
  };
  const deliverIncomplete = async (checkpoint: PictureBookReviewCheckpoint) => {
    // Persist the exhausted review, not synthesized approvals. Stop/storage errors still escape.
    await save(checkpoint, true);
    return new Map(pictureBookDeliveryReviews({ ...options, checks, checkpoint }).map(review => [review.pageIndex, review]));
  };
  let reviews: PictureBookPageReview[];
  try {
    reviews = await reviewPictureBookManuscript({ ...options, checks, ...(resume ? { resume } : {}), onCheckpoint: save });
  } catch (error) {
    if (!(error instanceof PictureBookReviewIncompleteError)) throw error;
    return deliverIncomplete(error.checkpoint);
  }
  await assertJobNotStopped(options.generationJobId);
  // Every page needs a delivery entry, including explicit unavailable assessments,
  // so a partial group never cascades into thirty individual review/rewrite chains.
  const complete = reviews.length === options.pages.length && new Set(reviews.map((review) => review.pageIndex)).size === options.pages.length && reviews.every(matches);
  const checkpoint: PictureBookReviewCheckpoint = { version: 2, reviews, unresolvedPageIndexes: options.pages.filter((page) => !reviews.some((review) => review.pageIndex === page.index && matches(review))).map((page) => page.index),
    validationIssues: latest?.validationIssues ?? [], protocolIssues: latest?.protocolIssues ?? [],
    roundsStarted: latest?.roundsStarted ?? 1, attemptsUsed: latest?.attemptsUsed ?? 1, outputWidened: latest?.outputWidened ?? false,
    citationRows: latest?.citationRows ?? [], editorialRows: latest?.editorialRows ?? [], metadataRows: latest?.metadataRows ?? [] };
  if (!complete || checkpoint.protocolIssues.length) return deliverIncomplete(checkpoint);
  await save(checkpoint);
  return new Map(reviews.map((review) => [review.pageIndex, review]));
}
