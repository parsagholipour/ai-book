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
import type { PictureBookPreviousReview } from "./pictureBookEditorialContext.js";
import { distributePictureBookFindings } from "./pictureBookReviewFindings.js";
import { canonicalPictureBookChecks, pictureBookReviewContract } from "./pictureBookReviewContract.js";
import { requirementAssessmentErrors } from "./pictureBookRequirementTargets.js";
import { pictureBookEditorialRow, pictureBookEditorialRowsSchema, pictureBookReviewRecoveryMessages,
  retainPictureBookEditorialRow, type PictureBookEditorialRow } from "./pictureBookReviewRecovery.js";
import { pictureBookCitationCorrectionsSchema, pictureBookCitationRecovery, pictureBookCitationRecoveryMessages,
  pictureBookCitationRowsSchema, type PictureBookCitationRow } from "./pictureBookReviewCitations.js";
import { pictureBookPageReview, validatedPictureBookReviewRow,
  pictureBookRepairAssessmentSchema, pictureBookReviewRowSchema, PICTURE_BOOK_CITATION_ERROR,
  type PictureBookPageReview, type PictureBookReviewChecks } from "./pictureBookReviewValidation.js";
export type { PictureBookPageReview, PictureBookReviewChecks } from "./pictureBookReviewValidation.js";

export type PictureBookReviewCheckpoint = {
  version: 2; reviews: PictureBookPageReview[]; unresolvedPageIndexes: number[];
  validationIssues: { pageIndex: number; message: string }[]; protocolIssues: string[];
  roundsStarted: number; attemptsUsed: number; outputWidened: boolean;
  /** Original unverified judgments survive recovery, exhaustion and worker restarts. */
  citationRows?: PictureBookCitationRow[];
  /** Grounded prose assessments survive malformed auxiliary story/style checks. */
  editorialRows?: PictureBookEditorialRow[];
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
  /** Exact previous draft/verdict pair, used for consistent judgment, never reuse. */
  previousReview?: PictureBookPreviousReview;
  /** Only deltas whose complete chronological prefix and frozen review context are unchanged. */
  reusableStoryExtracts?: ReadonlyMap<number, StoryExtractResult>;
  /** A repair's candidate reviews share one physical allowance, including recovery. */
  textAttemptBudget?: TextAttemptBudget;
};
const envelopeSchema = z.strictObject({ findings: z.array(z.unknown()).max(160).optional(), pages: z.array(z.unknown()).max(80) });
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
    if (requirementAssessmentErrors(options.repairContext?.requirementTargets ?? [], review.pageIndex, review.requirementAssessments, pages).length)
      throw new Error("Picture-book partial review is missing valid requirement resolution assessments.");
    if (pages.get(review.pageIndex)?.markdown !== review.draftMarkdown || reviews.has(review.pageIndex) ||
      Object.entries(options.checks).some(([key, enabled]) => review.completedChecks[key as keyof PictureBookReviewChecks] !== enabled) ||
      (options.checks.storyExtractAudit && !review.storyExtract) || (options.checks.styleAuditor && !review.styleAudit) ||
      (options.repairContext?.changes.some((change) => change.pageIndex === review.pageIndex) &&
        !pictureBookRepairAssessmentSchema.safeParse(review.repairAssessment).success))
      throw new Error("Picture-book partial review does not match the frozen manuscript and enabled checks.");
    reviews.set(review.pageIndex, review);
  }
  const budget: TextAttemptBudget = options.textAttemptBudget ?? { limit: MAX_TEXT_PROVIDER_ATTEMPTS, used: 0, outputWidened: false };
  budget.used = Math.max(budget.used, options.resume?.attemptsUsed ?? 0);
  budget.outputWidened ||= options.resume?.outputWidened ?? false;
  let roundsStarted = options.resume?.roundsStarted ?? 0;
  let validationIssues = options.resume?.validationIssues ?? [];
  let protocolIssues = options.resume?.protocolIssues ?? [];
  const citationRows = new Map<number, PictureBookCitationRow>();
  const editorialRows = new Map<number, PictureBookEditorialRow>();
  const rowSchema = validatedPictureBookReviewRow({ ...options, pages });
  const citationsOnly = (result: ReturnType<typeof rowSchema.safeParse>) => !result.success &&
    result.error.issues.every((issue) => issue.code === "custom" && issue.message === PICTURE_BOOK_CITATION_ERROR);
  for (const row of pictureBookCitationRowsSchema.parse(options.resume?.citationRows ?? [])) {
    if (!pages.has(row.pageIndex) || reviews.has(row.pageIndex) || citationRows.has(row.pageIndex) || !citationsOnly(rowSchema.safeParse(row)))
      throw new Error("Pending citation review does not match the frozen manuscript and enabled checks.");
    citationRows.set(row.pageIndex, row);
  }
  for (const row of pictureBookEditorialRowsSchema.parse(options.resume?.editorialRows ?? [])) {
    if (reviews.has(row.pageIndex) || citationRows.has(row.pageIndex) || editorialRows.has(row.pageIndex) || !pictureBookEditorialRow(row, { ...options, pages }))
      throw new Error("Retained editorial assessment does not match the frozen manuscript and enabled checks.");
    editorialRows.set(row.pageIndex, row);
  }
  const checkpoint = (reserve = false): PictureBookReviewCheckpoint => ({ version: 2,
    reviews: [...reviews.values()].sort((a, b) => a.pageIndex - b.pageIndex), unresolvedPageIndexes: [...pages.keys()].filter((index) => !reviews.has(index)),
    validationIssues, protocolIssues, roundsStarted, attemptsUsed: reserve ? budget.limit : budget.used, outputWidened: budget.outputWidened,
    citationRows: [...citationRows.values()], editorialRows: [...editorialRows.values()] });
  const persist = async (reserve = false) => { options.signal?.throwIfAborted(); await options.onCheckpoint?.(checkpoint(reserve)); };
  // One route is pinned for the original review and its targeted recovery.
  let adapter: TextModelAdapter | undefined;
  while (reviews.size < pages.size || protocolIssues.length) {
    options.signal?.throwIfAborted();
    // A malformed tail must reach the same bounded recovery as a missing row.
    // With no unresolved pages, an unexplained extra row still fails closed.
    if (roundsStarted >= 2 || budget.used >= budget.limit || (protocolIssues.length && reviews.size === pages.size)) throw new PictureBookReviewIncompleteError(checkpoint());
    const requested = [...pages.keys()].filter((index) => !reviews.has(index));
    const reviewRequested = requested.filter((index) => !citationRows.has(index));
    const recovery = citationRows.size ? pictureBookCitationRecovery([...citationRows.values()], pages) : undefined;
    if (recovery && !recovery.withinBudget) throw new PictureBookReviewIncompleteError(checkpoint());
    roundsStarted += 1;
    // Reserve the remaining physical allowance BEFORE dispatch. A crash has
    // unknown spend, so its successor cannot replay that allowance. Successful
    // settlement records actual spend and leaves the rest for one local recheck.
    await persist(true);
    const before = budget.used;
    let raw: z.infer<typeof envelopeSchema> & { corrections?: z.infer<typeof pictureBookCitationCorrectionsSchema> };
    try {
      const purpose = options.checks.pageModelReview ? "review-page" : options.checks.storyExtractAudit ? "extract-story-state" : "audit-page-style";
      adapter ??= (await bindTextModelCall(options.textModel, purpose)).adapter;
      const contract = pictureBookReviewContract(options.checks, Boolean(options.repairContext));
      const messages = pictureBookReviewRecoveryMessages(
        pictureBookReviewMessages(options, reviewRequested, validationIssues.filter((issue) => !citationRows.has(issue.pageIndex))),
        protocolIssues, [...editorialRows.values()]);
      const correctionSchema = envelopeSchema.extend({ pages: reviewRequested.length ? envelopeSchema.shape.pages : z.array(z.unknown()).max(0),
        corrections: pictureBookCitationCorrectionsSchema });
      const responseSchema = recovery ? correctionSchema : envelopeSchema;
      const result = await generateJsonWithRetry(adapter, {
        purpose, schema: responseSchema, textAttemptBudget: budget, repairAttempts: roundsStarted === 1 ? 1 : 0, jsonContractInMessages: true,
        temperature: 0.1, maxTokens: reviewRequested.length && options.checks.storyExtractAudit ? 24_000 : 8_000,
        ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.signal ? { signal: options.signal } : {}),
        messages: jsonSchemaMessages<unknown>(recovery ? pictureBookCitationRecoveryMessages(recovery, reviewRequested.length ? messages : undefined) : messages,
          recovery ? reviewRequested.length ? contract.extend({ pages: contract.shape.pages.min(0), corrections: pictureBookCitationCorrectionsSchema }) : correctionSchema : contract)
      });
      raw = responseSchema.parse(result.data);
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
    // Earlier protocol errors are settled only by a complete, valid recovery.
    // New anomalies below remain blocking, even if every requested row is present.
    const distributed = distributePictureBookFindings(raw);
    raw.pages = distributed.pages.map(row => canonicalPictureBookChecks(row, options.checks));
    protocolIssues = distributed.protocolIssues;
    const expected = new Set(reviewRequested);
    const corrections = raw.corrections ?? [];
    if (recovery) protocolIssues.push(...recovery.validateProtocol(corrections));
    const counts = new Map<number, number>();
    for (const row of raw.pages) {
      const index = indexOf(row);
      if (index === undefined || !expected.has(index)) {
        protocolIssues.push(index === undefined ? "Response contains a row without a valid page index." : `Response contains unexpected page ${index}.`);
      } else counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    for (const index of requested) {
      const pending = citationRows.get(index);
      if (pending && recovery) {
        const corrected = recovery.correctedRow(pending, corrections);
        const result = corrected && rowSchema.safeParse(corrected);
        if (!result?.success) {
          validationIssues.push({ pageIndex: index, message: `Editorial finding remains unverified because its evidence quotation could not be corrected: ${pending.findings.map((finding) => finding.message).join(" ")}`.slice(0, 2_000) });
          continue;
        }
        reviews.set(index, pictureBookPageReview(result.data, pages.get(index)!, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(index)));
        citationRows.delete(index);
        continue;
      }
      const count = counts.get(index) ?? 0;
      if (count !== 1) { validationIssues.push({ pageIndex: index, message: count ? "Duplicate verdicts; provide exactly one assessment." : "Missing verdict; complete every enabled assessment." }); continue; }
      const rawRow = retainPictureBookEditorialRow(raw.pages.find((row) => indexOf(row) === index), editorialRows.get(index));
      const result = rowSchema.safeParse(rawRow);
      if (!result.success) {
        if (citationsOnly(result)) citationRows.set(index, pictureBookReviewRowSchema.parse(rawRow));
        else {
          const editorial = pictureBookEditorialRow(rawRow, { ...options, pages });
          if (editorial) editorialRows.set(index, editorial);
        }
        validationIssues.push({ pageIndex: index, message: result.error.issues.map((issue) => issue.message).join(" ").slice(0, 2_000) }); continue;
      }
      reviews.set(index, pictureBookPageReview(result.data, pages.get(index)!, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(index)));
      editorialRows.delete(index);
    }
    await persist();
  }
  return checkpoint().reviews;
}

export { pictureBookReviewFingerprint, pictureBookReviewChapters } from "./pictureBookReviewContext.js";
export { unchangedPrefixStoryExtracts } from "./pictureBookStoryReuse.js";
export { pictureBookCitationRowsSchema } from "./pictureBookReviewCitations.js";
export { pictureBookEditorialRowsSchema } from "./pictureBookReviewRecovery.js";
