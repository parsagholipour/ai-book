import {
  EDIT_ADHERENCE_FAILED,
  EDIT_RUN_FAILED,
  EDIT_START_FAILED,
  EDIT_START_NEEDS_CREDITS,
  NEW_PAGES_ADHERENCE_FAILED
} from "@book-maker/core/editFailure";
import { prisma } from "@book-maker/db";
import { type GenerationJobType } from "../queue.js";

/**
 * What a failed book's status may say about the failure.
 *
 * `GenerationJob.error` is the worker's `errorMessage(error)` — a provider's
 * HTTP body, a Prisma code, a stack-shaped sentence — and it used to reach the
 * reader verbatim as `We hit a problem while writing a page: 429 Too Many
 * Requests {"error":…}` (launch review H4, 2026-10-13). The column stays as it
 * is, because the operator console and the logs read it; the mobile DTO gets
 * the phase sentence, and the raw text only when it is one of the sentences
 * below, written for the reader on purpose.
 *
 * An allowlist rather than a denylist of provider shapes: a sentence that is
 * reworded where it is thrown simply falls back to the phase sentence, which is
 * the safe direction to fail in.
 */

/** Sentences a job may fail with that were written for the reader. */
const READER_FAILURE_SENTENCES: ReadonlySet<string> = new Set([
  EDIT_ADHERENCE_FAILED,
  NEW_PAGES_ADHERENCE_FAILED,
  EDIT_RUN_FAILED,
  EDIT_START_FAILED,
  EDIT_START_NEEDS_CREDITS,
  // apps/worker/src/handlers/importBook.ts
  "The uploaded manuscript file is no longer available. Import the book again.",
  "No readable pages were found in that manuscript."
]);

/** Appended only when the ledger shows the attempt's whole charge came back. */
export const FAILURE_CREDITS_RETURNED = "Credits for this attempt were returned.";

const FAILURE_PHASE = {
  PLAN_BOOK: "creating your plan",
  REVISE_PLAN: "revising your plan",
  GENERATE_BOOK: "starting book generation",
  GENERATE_PAGE: "writing a page",
  GENERATE_IMAGE: "creating a visual",
  COMPILE_EXPORT: "preparing downloads",
  APPLY_BOOK_EDIT: "editing your book",
  REPLAN_BOOK: "rebuilding your book plan",
  PREPARE_CHARACTER_CANDIDATES: "preparing voice characters",
  BUILD_CHARACTER_PERSONA: "building a voice character",
  IMPORT_BOOK: "importing your book",
  CONTINUE_BOOK: "writing new chapters",
  GENERATE_AUDIOBOOK: "narrating your book",
  GENERATE_CHARACTER_PORTRAIT: "drawing a character portrait",
  WRITING_ASSIST: "working on your writing request"
} satisfies Record<GenerationJobType, string>;

/** The raw error when it is reader copy, otherwise nothing. */
export function readerFacingJobError(rawError: string | null | undefined): string | null {
  const detail = rawError?.replace(/\s+/g, " ").trim();
  return detail && READER_FAILURE_SENTENCES.has(detail) ? detail : null;
}

export function failureMessageForJob(
  type: GenerationJobType,
  rawError: string | null,
  options: { creditsReturned?: boolean } = {}
): string {
  const curated = readerFacingJobError(rawError);
  const lead = curated ? `We hit a problem while ${FAILURE_PHASE[type]}: ${curated}` : `We hit a problem while ${FAILURE_PHASE[type]}.`;
  // A curated sentence that already talks about credits (the adherence
  // refusals say "your credits were returned") is not told twice.
  if (!options.creditsReturned || (curated && /\bcredits?\b/i.test(curated))) {
    return lead;
  }
  return `${lead} ${FAILURE_CREDITS_RETURNED}`;
}

type AttemptRefundRecord = {
  status: string;
  refundPending: boolean;
  ledgerEntry: {
    status: string;
    amountCredits: number;
    reversedByEntry: { amountCredits: number } | null;
  } | null;
} | null;

/**
 * Whether the attempt's charge is back in the reader's balance — the whole of
 * it. A release (`REFUNDED`) or a reversal that covers the charge; a partial
 * reversal, a refund still pending, or an attempt with no charge says nothing,
 * because "returned" is a promise about money and a partial one is not it.
 */
export function attemptChargeReturned(attempt: AttemptRefundRecord): boolean {
  if (!attempt || (attempt.status !== "FAILED" && attempt.status !== "CANCELED") || attempt.refundPending) {
    return false;
  }
  const entry = attempt.ledgerEntry;
  if (!entry || entry.amountCredits >= 0) {
    return false;
  }
  if (entry.status === "REFUNDED") {
    return true;
  }
  return (entry.reversedByEntry?.amountCredits ?? 0) >= Math.abs(entry.amountCredits);
}

/**
 * Reads `attemptChargeReturned` for a failed job's attempt. Attempt-less
 * (legacy) rows and a read that fails both answer false: the clause is left
 * out rather than guessed.
 */
export async function failedAttemptCreditsReturned(attemptId: string | null | undefined): Promise<boolean> {
  if (!attemptId) {
    return false;
  }
  try {
    const attempt = await prisma.generationAttempt.findUnique({
      where: { id: attemptId },
      select: {
        status: true,
        refundPending: true,
        ledgerEntry: {
          select: { status: true, amountCredits: true, reversedByEntry: { select: { amountCredits: true } } }
        }
      }
    });
    return attemptChargeReturned((attempt ?? null) as AttemptRefundRecord);
  } catch {
    return false;
  }
}
