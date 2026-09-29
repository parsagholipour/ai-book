import { resolvePictureBookChecklist } from "./pictureBookChecklistSpans.js";
import { reusablePictureBookChecklists, resolveReusedPictureBookChecklist } from "./pictureBookChecklistReuse.js";
import { pictureBookCounterevidenceErrors } from "./pictureBookChecklistCounterevidence.js";
import { pictureBookPageRequirements, pictureBookChecklistErrors } from "./pictureBookPreRepairChecklist.js";
import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
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
import { distributePictureBookFindings, unresolvedPictureBookFinding, UNRESOLVED_PICTURE_BOOK_FINDING } from "./pictureBookReviewFindings.js";
import { canonicalPictureBookChecks, pictureBookReviewContract } from "./pictureBookReviewContract.js";
import { needsPictureBookContinuity, reviewPictureBookContinuity, mergePictureBookContinuity } from "./pictureBookContinuity.js";
import { requirementAssessmentErrors } from "./pictureBookRequirementTargets.js";
import { pictureBookEditorialRow, pictureBookEditorialRowsSchema, pictureBookReviewRecoveryMessages, parsePictureBookCorrections,
  type PictureBookEditorialRow } from "./pictureBookReviewRecovery.js";
import { pictureBookAuxiliaryRecovery } from "./pictureBookReviewAuxiliary.js";
import { pictureBookCitationCorrectionsSchema, pictureBookCitationRecovery, pictureBookCitationRecoveryMessages,
  pictureBookCitationRowsSchema, hasUnverifiedPictureBookCitations, type PictureBookCitationRow } from "./pictureBookReviewCitations.js";
import { pictureBookMetadataRow, pictureBookMetadataRowsSchema, pictureBookMetadataRecovery,
  pictureBookMetadataRecoveryMessages, pictureBookMetadataCorrectionsSchema, type PictureBookMetadataRow } from "./pictureBookReviewMetadata.js";
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
  /** Grounded diagnoses survive invalid repair scope or excess supporting citations. */
  metadataRows?: PictureBookMetadataRow[];
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
  /** Previous judgments guide consistent review. Fingerprinted unchanged pages
   * may reuse checklist witnesses after explicit confirmation, never verdicts. */
  previousReview?: PictureBookPreviousReview;
  /** Only deltas whose complete chronological prefix and frozen review context are unchanged. */
  reusableStoryExtracts?: ReadonlyMap<number, StoryExtractResult>;
  /** A repair's candidate reviews share one physical allowance, including recovery. */
  textAttemptBudget?: TextAttemptBudget;
  /** A caller with a pinned grouped-review route supplies the independently
   * pinned continuity route here, so it cannot inherit the grouped model. */
  continuityTextModel?: TextModelAdapter;
  /** Production callers collect continuity defects before repair, and recheck
   * candidates before acceptance. False isolates grouped assessment for tests. */
  continuityReview?: boolean;
};
const envelopeSchema = z.strictObject({ findings: z.array(z.unknown()).max(160).optional(), pages: z.array(z.unknown()).max(80) });
function indexOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("pageIndex" in value)) return undefined;
  return typeof value.pageIndex === "number" && Number.isInteger(value.pageIndex) ? value.pageIndex : undefined;
}

/** Validate rows independently; one unsupported finding never discards other completed checks. */
export async function reviewPictureBookManuscript(options: PictureBookReviewOptions): Promise<PictureBookPageReview[]> {
  const pages = new Map(options.pages.map((page) => [page.index, page]));
  if (pages.size !== options.pages.length || pages.size > MAX_PICTURE_BOOK_PAGES || pages.size < 1) throw new Error("Picture-book review requires a unique, bounded page inventory.");
  const reusableChecklists = reusablePictureBookChecklists(options);
  const reviews = new Map<number, PictureBookPageReview>();
  for (const review of options.resume?.reviews ?? []) {
    if (pictureBookCounterevidenceErrors({ index: review.pageIndex, markdown: review.draftMarkdown }, review.findings ?? []).length ||
      pictureBookChecklistErrors({ ...options, enabled: options.checks.pageModelReview }, review.draftMarkdown, review.requirementChecks, review.findings ?? []).length)
      throw new Error("Picture-book partial review is missing the per-page requirement checklist.");
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
  const metadataRows = new Map<number, PictureBookMetadataRow>();
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
  for (const row of pictureBookMetadataRowsSchema.parse(options.resume?.metadataRows ?? [])) {
    if (reviews.has(row.pageIndex) || citationRows.has(row.pageIndex) || editorialRows.has(row.pageIndex) || metadataRows.has(row.pageIndex) ||
      !pictureBookMetadataRow(row, { ...options, pages }))
      throw new Error("Pending metadata review does not match the frozen manuscript and enabled checks.");
    metadataRows.set(row.pageIndex, row);
  }
  const checkpoint = (reserve = false): PictureBookReviewCheckpoint => ({ version: 2,
    reviews: [...reviews.values()].sort((a, b) => a.pageIndex - b.pageIndex), unresolvedPageIndexes: [...pages.keys()].filter((index) => !reviews.has(index)),
    validationIssues, protocolIssues, roundsStarted, attemptsUsed: reserve ? budget.limit : budget.used, outputWidened: budget.outputWidened,
    citationRows: [...citationRows.values()], editorialRows: [...editorialRows.values()], metadataRows: [...metadataRows.values()] });
  const persist = async (reserve = false) => { options.signal?.throwIfAborted(); await options.onCheckpoint?.(checkpoint(reserve)); };
  // One route is pinned for the original review and its targeted recovery.
  let adapter: TextModelAdapter | undefined;
  while (reviews.size < pages.size || protocolIssues.length) {
    options.signal?.throwIfAborted();
    // A malformed tail must reach the same bounded recovery as a missing row.
    // With no unresolved pages, an unexplained extra row still fails closed.
    if (roundsStarted >= 2 || budget.used >= budget.limit || (protocolIssues.length && reviews.size === pages.size)) throw new PictureBookReviewIncompleteError(checkpoint());
    const requested = [...pages.keys()].filter((index) => !reviews.has(index));
    const reviewRequested = requested.filter((index) => !citationRows.has(index) && !metadataRows.has(index) && !editorialRows.has(index));
    const recovery = citationRows.size ? pictureBookCitationRecovery([...citationRows.values()], pages) : undefined;
    const metadataRecovery = metadataRows.size ? pictureBookMetadataRecovery([...metadataRows.values()], pages) : undefined;
    const auxiliaryRecovery = editorialRows.size ? pictureBookAuxiliaryRecovery([...editorialRows.values()], options) : undefined;
    if ((recovery && !recovery.withinBudget) || (metadataRecovery && !metadataRecovery.withinBudget)) throw new PictureBookReviewIncompleteError(checkpoint());
    roundsStarted += 1;
    // Reserve the remaining physical allowance BEFORE dispatch. A crash has
    // unknown spend, so its successor cannot replay that allowance. Successful
    // settlement records actual spend and leaves the rest for one local recheck.
    await persist(true);
    const before = budget.used;
    let raw: z.infer<typeof envelopeSchema> & { corrections?: unknown[] | undefined; metadataCorrections?: unknown[] | undefined; auxiliaryCorrections?: unknown[] | undefined };
    let continuityFailure: unknown;
    let continuityProtocolIssues: string[] = [];
    try {
      const purpose = options.checks.pageModelReview ? "review-page" : options.checks.storyExtractAudit ? "extract-story-state" : "audit-page-style";
      adapter ??= (await bindTextModelCall(options.textModel, purpose)).adapter;
      const contract = pictureBookReviewContract(options.checks, Boolean(options.repairContext),
        options.checks.pageModelReview && pictureBookPageRequirements(options.input, options.plan).length > 0, reusableChecklists.size > 0);
      let messages = reviewRequested.length ? pictureBookReviewMessages(options, reviewRequested,
        validationIssues.filter(issue => reviewRequested.includes(issue.pageIndex))) : undefined;
      if (auxiliaryRecovery) messages = auxiliaryRecovery.messages(messages);
      if (recovery) messages = pictureBookCitationRecoveryMessages(recovery, messages);
      if (metadataRecovery) messages = pictureBookMetadataRecoveryMessages(metadataRecovery, messages);
      if (!messages) throw new Error("Recovery has no unresolved assessment or correction.");
      const correctionFields = {
        ...(recovery ? { corrections: pictureBookCitationCorrectionsSchema } : {}),
        ...(metadataRecovery ? { metadataCorrections: pictureBookMetadataCorrectionsSchema } : {}),
        ...(auxiliaryRecovery ? { auxiliaryCorrections: auxiliaryRecovery.schema } : {})
      };
      // Parse unexpected rows/findings as diagnostic data even though the wire
      // contract forbids new judgments during correction-only recovery.
      const responseSchema = envelopeSchema.extend({
        corrections: recovery ? z.array(z.unknown()).max(32).optional() : z.never().optional(),
        metadataCorrections: metadataRecovery ? z.array(z.unknown()).max(32).optional() : z.never().optional(),
        auxiliaryCorrections: auxiliaryRecovery ? z.array(z.unknown()).max(MAX_PICTURE_BOOK_PAGES).optional() : z.never().optional()
      });
      const wireContract = reviewRequested.length ? contract.extend(correctionFields)
        : z.strictObject({ pages: z.array(z.unknown()).max(0), ...correctionFields });
      const result = await generateJsonWithRetry(adapter, {
        purpose, schema: responseSchema, textAttemptBudget: budget, repairAttempts: roundsStarted === 1 ? 1 : 0, jsonContractInMessages: true,
        temperature: 0.1, maxTokens: options.checks.storyExtractAudit && (reviewRequested.length || editorialRows.size > 8) ? 24_000 : 8_000,
        ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.signal ? { signal: options.signal } : {}),
        messages: jsonSchemaMessages<unknown>(pictureBookReviewRecoveryMessages(messages, protocolIssues), wireContract)
      });
      raw = responseSchema.parse(result.data);
      budget.used = Math.max(budget.used, before + 1);
      if (roundsStarted === 1 && needsPictureBookContinuity(options, raw)) {
        try {
          const extra = await reviewPictureBookContinuity(options, budget);
          const merged = mergePictureBookContinuity(raw, extra);
          raw.pages = merged.pages;
          delete raw.findings;
          continuityProtocolIssues = merged.protocolIssues;
          if (merged.unowned) continuityFailure = new Error("Continuity findings require unique page verdicts.");
        } catch (error) {
          if (isCancellationError(error) || options.signal?.aborted) throw error;
          // Keep the primary response and its diagnoses; unavailable continuity
          // is an incomplete review, never permission to publish a clean verdict.
          continuityFailure = error;
          continuityProtocolIssues.push("Required picture-book continuity verification is unavailable after bounded attempts.");
        }
      }
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
    raw.pages = distributed.pages.map(row => resolvePictureBookChecklist(
      resolveReusedPictureBookChecklist(canonicalPictureBookChecks(row, options.checks), reusableChecklists), pages));
    protocolIssues = [...new Set([...protocolIssues.filter(issue => issue.startsWith(UNRESOLVED_PICTURE_BOOK_FINDING)),
      ...distributed.protocolIssues, ...continuityProtocolIssues])];
    const expected = new Set(reviewRequested);
    const citationResult = parsePictureBookCorrections(pictureBookCitationCorrectionsSchema.element, raw.corrections ?? [], "Citation");
    const corrections = citationResult.corrections;
    if (recovery) protocolIssues.push(...recovery.validateProtocol(corrections));
    const metadataResult = parsePictureBookCorrections(pictureBookMetadataCorrectionsSchema.element, raw.metadataCorrections ?? [], "Metadata");
    const metadataCorrections = metadataResult.corrections;
    if (metadataRecovery) protocolIssues.push(...metadataRecovery.validateProtocol(metadataCorrections));
    const auxiliaryResult = auxiliaryRecovery && parsePictureBookCorrections(auxiliaryRecovery.schema.element, raw.auxiliaryCorrections ?? [], "Auxiliary");
    const auxiliaryCorrections = auxiliaryResult?.corrections ?? [];
    if (auxiliaryRecovery) protocolIssues.push(...auxiliaryRecovery.validateProtocol(auxiliaryCorrections));
    protocolIssues.push(...citationResult.protocolIssues, ...metadataResult.protocolIssues, ...(auxiliaryResult?.protocolIssues ?? []));
    const counts = new Map<number, number>();
    const conflictingCorrectionPages = new Set<number>();
    for (const row of raw.pages) {
      const index = indexOf(row);
      if (index === undefined || !expected.has(index)) {
        if (index !== undefined) conflictingCorrectionPages.add(index);
        protocolIssues.push(index === undefined ? "Response contains a row without a valid page index." : `Response contains unexpected page ${index}.`);
        if (row && typeof row === "object" && "findings" in row && Array.isArray(row.findings) && row.findings.length)
          protocolIssues.push(unresolvedPictureBookFinding({ pageIndex: index, findings: row.findings }));
      } else counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    for (const index of requested) {
      if (conflictingCorrectionPages.has(index)) {
        validationIssues.push({ pageIndex: index, message: "Recovery cannot replace a retained verdict with a new page assessment." });
        continue;
      }
      const editorial = editorialRows.get(index);
      if (editorial && auxiliaryRecovery) {
        const corrected = auxiliaryRecovery.correctedRow(editorial, auxiliaryCorrections);
        const result = corrected === undefined ? undefined : rowSchema.safeParse(corrected);
        if (!result?.success) {
          const retained = pictureBookEditorialRow(auxiliaryRecovery.retainedRow(editorial, auxiliaryCorrections), { ...options, pages });
          if (retained) editorialRows.set(index, retained);
          validationIssues.push({ pageIndex: index, message: "Required auxiliary correction remains incomplete; the original editorial assessment is retained." });
          continue;
        }
        reviews.set(index, pictureBookPageReview(result.data, pages.get(index)!, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(index)));
        editorialRows.delete(index);
        continue;
      }
      const metadata = metadataRows.get(index);
      if (metadata && metadataRecovery) {
        const corrected = metadataRecovery.correctedRow(metadata, metadataCorrections);
        const result = corrected === undefined ? undefined : rowSchema.safeParse(corrected);
        if (!result?.success) {
          validationIssues.push({ pageIndex: index, message: `Editorial finding remains unresolved because its repair metadata could not be corrected: ${metadata.findings.map(finding => finding.message).join(" ")}`.slice(0, 2_000) });
          continue;
        }
        reviews.set(index, pictureBookPageReview(result.data, pages.get(index)!, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(index)));
        metadataRows.delete(index);
        continue;
      }
      const pending = citationRows.get(index);
      if (pending && recovery) {
        const corrected = recovery.correctedRow(pending, corrections);
        const result = corrected === undefined ? undefined : rowSchema.safeParse(corrected);
        if (!result?.success) {
          const reason = result ? result.error.issues.map(issue => issue.message).join(" ") : "Its evidence quotation could not be corrected.";
          validationIssues.push({ pageIndex: index, message: `Editorial finding remains unverified after citation recovery: ${reason} ${pending.findings.map((finding) => finding.message).join(" ")}`.slice(0, 2_000) });
          continue;
        }
        reviews.set(index, pictureBookPageReview(result.data, pages.get(index)!, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(index)));
        citationRows.delete(index);
        continue;
      }
      const count = counts.get(index) ?? 0;
      if (count !== 1) { validationIssues.push({ pageIndex: index, message: count ? "Duplicate verdicts; provide exactly one assessment." : "Missing verdict; complete every enabled assessment." }); continue; }
      const rawRow = raw.pages.find((row) => indexOf(row) === index);
      const result = rowSchema.safeParse(rawRow);
      if (!result.success) {
        if (citationsOnly(result)) citationRows.set(index, pictureBookReviewRowSchema.parse(rawRow));
        else {
          const metadata = pictureBookMetadataRow(rawRow, { ...options, pages });
          if (metadata) metadataRows.set(index, metadata);
          else {
            const editorial = pictureBookEditorialRow(rawRow, { ...options, pages });
            if (editorial) editorialRows.set(index, editorial);
            // Citation failures combined with unsupported errors still own a
            // diagnosis. Preserve it across recovery/checkpoints as unverified
            // diagnostic data; a fresh clean row cannot resolve it or grant scope.
            else if (rawRow && typeof rawRow === "object" && "findings" in rawRow && Array.isArray(rawRow.findings) &&
              hasUnverifiedPictureBookCitations(index, rawRow.findings, pages))
              protocolIssues.push(unresolvedPictureBookFinding({ pageIndex: index, findings: rawRow.findings }));
          }
        }
        validationIssues.push({ pageIndex: index, message: result.error.issues.map((issue) => issue.message).join(" ").slice(0, 2_000) }); continue;
      }
      reviews.set(index, pictureBookPageReview(result.data, pages.get(index)!, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(index)));
      editorialRows.delete(index);
    }
    if (continuityFailure) roundsStarted = 2;
    await persist();
    if (continuityFailure) throw new PictureBookReviewIncompleteError(checkpoint(), continuityFailure);
  }
  return checkpoint().reviews;
}

export { pictureBookReviewFingerprint, pictureBookReviewChapters } from "./pictureBookReviewContext.js";
export { unchangedPrefixStoryExtracts } from "./pictureBookStoryReuse.js";
export { pictureBookCitationRowsSchema } from "./pictureBookReviewCitations.js";
export { pictureBookEditorialRowsSchema } from "./pictureBookReviewRecovery.js";
export { pictureBookMetadataRowsSchema } from "./pictureBookReviewMetadata.js";
