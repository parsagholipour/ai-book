import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { bindTextModelCall } from "../adapters/types.js";
import { isCancellationError } from "../adapters/retry.js";
import { MAX_TEXT_PROVIDER_ATTEMPTS, type TextAttemptBudget } from "../adapters/textAttemptBudget.js";
import type { BookPlan, ChapterBrief, CreateProjectInput } from "../schemas/book.js";
import { generateJsonWithRetry, jsonSchemaMessages } from "./generateJsonWithRetry.js";
import type { PriorPageContext } from "./pagesShared.js";
import { pictureBookReviewMessages } from "./pictureBookReviewPrompt.js";
import type { PictureBookRepairContext } from "./pictureBookRepair.js";
import type { StoryExtractResult } from "./storyState.js";
import { pictureBookPageReview, pictureBookReviewResponseSchema, validatedPictureBookReviewRow,
  pictureBookRepairAssessmentSchema, pictureBookSentenceRepairReviewResponseSchema,
  type PictureBookPageReview, type PictureBookReviewChecks } from "./pictureBookReviewValidation.js";
export type { PictureBookPageReview, PictureBookReviewChecks } from "./pictureBookReviewValidation.js";

export type PictureBookReviewCheckpoint = {
  version: 2; reviews: PictureBookPageReview[]; unresolvedPageIndexes: number[];
  validationIssues: { pageIndex: number; message: string }[]; protocolIssues: string[];
  roundsStarted: number; attemptsUsed: number; outputWidened: boolean;
};
export class PictureBookReviewIncompleteError extends Error {
  constructor(readonly checkpoint: PictureBookReviewCheckpoint, cause?: unknown) {
    super(`Picture-book review incomplete; unverified pages: ${checkpoint.unresolvedPageIndexes.join(", ") || "none"}.${checkpoint.protocolIssues.length ? ` ${checkpoint.protocolIssues.join(" ")}` : ""}`, { cause });
    this.name = "PictureBookReviewIncompleteError";
  }
}
export type PictureBookReviewOptions = {
  input: CreateProjectInput; plan: BookPlan; pages: readonly PriorPageContext[];
  chapterBriefs: readonly ChapterBrief[]; checks: PictureBookReviewChecks;
  textModel: TextModelAdapter; projectId?: string; signal?: AbortSignal;
  /** The worker binds durable checkpoints to the exact input/manuscript/check fingerprint. */
  resume?: PictureBookReviewCheckpoint;
  onCheckpoint?: (checkpoint: PictureBookReviewCheckpoint) => Promise<void>;
  /** A repair is judged against the complete candidate, including untouched dependencies. */
  repairContext?: PictureBookRepairContext;
  /** Only deltas whose complete chronological prefix and frozen review context are unchanged. */
  reusableStoryExtracts?: ReadonlyMap<number, StoryExtractResult>;
};
const envelopeSchema = z.strictObject({ pages: z.array(z.unknown()).max(80) });
function indexOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("pageIndex" in value)) return undefined;
  return typeof value.pageIndex === "number" && Number.isInteger(value.pageIndex) ? value.pageIndex : undefined;
}

/** Validate rows independently; one unsupported finding never discards other completed checks. */
export async function reviewPictureBookManuscript(options: PictureBookReviewOptions): Promise<PictureBookPageReview[]> {
  const pages = new Map(options.pages.map((page) => [page.index, page]));
  if (pages.size !== options.pages.length || pages.size > 40 || pages.size < 1) throw new Error("Picture-book review requires a unique, bounded page inventory.");
  const reviews = new Map<number, PictureBookPageReview>();
  for (const review of options.resume?.reviews ?? []) {
    if (pages.get(review.pageIndex)?.markdown !== review.draftMarkdown || reviews.has(review.pageIndex) ||
      Object.entries(options.checks).some(([key, enabled]) => review.completedChecks[key as keyof PictureBookReviewChecks] !== enabled) ||
      (options.checks.storyExtractAudit && !review.storyExtract) || (options.checks.styleAuditor && !review.styleAudit) ||
      (options.repairContext?.sentenceOnly && options.repairContext.changes.some((change) => change.pageIndex === review.pageIndex) &&
        !pictureBookRepairAssessmentSchema.safeParse(review.repairAssessment).success))
      throw new Error("Picture-book partial review does not match the frozen manuscript and enabled checks.");
    reviews.set(review.pageIndex, review);
  }
  const budget: TextAttemptBudget = { limit: MAX_TEXT_PROVIDER_ATTEMPTS, used: options.resume?.attemptsUsed ?? 0, outputWidened: options.resume?.outputWidened ?? false };
  let roundsStarted = options.resume?.roundsStarted ?? 0;
  let validationIssues = options.resume?.validationIssues ?? [];
  let protocolIssues = options.resume?.protocolIssues ?? [];
  const checkpoint = (reserve = false): PictureBookReviewCheckpoint => ({ version: 2,
    reviews: [...reviews.values()].sort((a, b) => a.pageIndex - b.pageIndex), unresolvedPageIndexes: [...pages.keys()].filter((index) => !reviews.has(index)),
    validationIssues, protocolIssues, roundsStarted, attemptsUsed: reserve ? budget.limit : budget.used, outputWidened: budget.outputWidened });
  const persist = async (reserve = false) => { options.signal?.throwIfAborted(); await options.onCheckpoint?.(checkpoint(reserve)); };
  const rowSchema = validatedPictureBookReviewRow({ ...options, pages });
  // One route is pinned for the original review and its targeted recovery.
  let adapter: TextModelAdapter | undefined;
  while (reviews.size < pages.size || protocolIssues.length) {
    options.signal?.throwIfAborted();
    if (roundsStarted >= 2 || budget.used >= budget.limit || protocolIssues.length) throw new PictureBookReviewIncompleteError(checkpoint());
    const requested = [...pages.keys()].filter((index) => !reviews.has(index));
    roundsStarted += 1;
    // Reserve the remaining physical allowance BEFORE dispatch. A crash has
    // unknown spend, so its successor cannot replay that allowance. Successful
    // settlement records actual spend and leaves the rest for one local recheck.
    await persist(true);
    const before = budget.used;
    let raw: z.infer<typeof envelopeSchema>;
    try {
      const purpose = options.checks.pageModelReview ? "review-page" : options.checks.storyExtractAudit ? "extract-story-state" : "audit-page-style";
      adapter ??= (await bindTextModelCall(options.textModel, purpose)).adapter;
      const result = await generateJsonWithRetry(adapter, {
        purpose, schema: envelopeSchema, textAttemptBudget: budget, repairAttempts: 0, jsonContractInMessages: true,
        temperature: 0.1, maxTokens: options.checks.storyExtractAudit ? 24_000 : 8_000,
        ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.signal ? { signal: options.signal } : {}),
        messages: jsonSchemaMessages(pictureBookReviewMessages(options, requested, validationIssues),
          options.repairContext?.sentenceOnly ? pictureBookSentenceRepairReviewResponseSchema : pictureBookReviewResponseSchema)
      });
      raw = envelopeSchema.parse(result.data);
    } catch (error) {
      // Test/custom adapters may not account at the wire; never grant a free call.
      budget.used = Math.max(budget.used, before + 1);
      if (isCancellationError(error) || options.signal?.aborted) throw error;
      roundsStarted = 2;
      validationIssues = requested.map((pageIndex) => ({ pageIndex, message: "Required grouped assessment unavailable after the bounded provider operation." }));
      await persist();
      throw new PictureBookReviewIncompleteError(checkpoint(), error);
    }
    budget.used = Math.max(budget.used, before + 1);
    options.signal?.throwIfAborted();
    validationIssues = [];
    const expected = new Set(requested);
    const counts = new Map<number, number>();
    for (const row of raw.pages) {
      const index = indexOf(row);
      if (index === undefined || !expected.has(index)) {
        protocolIssues.push(index === undefined ? "Response contains a row without a valid page index." : `Response contains unexpected page ${index}.`);
      } else counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    for (const index of requested) {
      const count = counts.get(index) ?? 0;
      if (count !== 1) { validationIssues.push({ pageIndex: index, message: count ? "Duplicate verdicts; provide exactly one assessment." : "Missing verdict; complete every enabled assessment." }); continue; }
      const result = rowSchema.safeParse(raw.pages.find((row) => indexOf(row) === index));
      if (!result.success) { validationIssues.push({ pageIndex: index, message: result.error.issues.map((issue) => issue.message).join(" ").slice(0, 2_000) }); continue; }
      reviews.set(index, pictureBookPageReview(result.data, pages.get(index)!, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(index)));
    }
    await persist();
  }
  return checkpoint().reviews;
}

export { pictureBookReviewFingerprint, pictureBookReviewChapters } from "./pictureBookReviewContext.js";
export { unchangedPrefixStoryExtracts } from "./pictureBookStoryReuse.js";
