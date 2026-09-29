import { isImageContentRefusalError } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { refundCreditLedgerEntry } from "@book-maker/db/billing";
import { STOPPED_JOB_ERROR } from "./jobTypes.js";

/**
 * The failure half of a `writing-assist` job's settlement: the `ManuscriptAssist`
 * row it ran for goes FAILED with a sentence the author can read.
 *
 * The *money* is not here. A priced assist is charged by the API through
 * `startGenerationAttempt` (reserve and commit in one transaction), and the
 * attempt boundary in `markFailed`/`markStopped` refunds it — the free-tier
 * illustrated-book slot riding the reservation's metadata comes back with it —
 * before this runs. What this owns is the row, and the only claim it makes is
 * the conditional one: a row already READY, APPLIED, DISMISSED or FAILED keeps
 * the verdict it has, so a late failure can never overwrite a delivered
 * suggestion or a dismissal.
 *
 * `WRITING_ASSIST` is in `DERIVATIVE_GENERATION_JOBS`, so the project is never
 * touched on this path: the book may be COMPLETE, mid-publish, or a DRAFT the
 * author is still writing, and none of that is this job's to change.
 */

/** Every kind a `ManuscriptAssist` row may carry, as the API writes it. */
export const WRITING_ASSIST_KINDS = [
  "ILLUSTRATE",
  "DRAFT_CHAPTER",
  "CHAPTER_FEEDBACK",
  "CONSISTENCY",
  "OUTLINE",
  "STYLE_PROFILE",
  "REEMBED"
] as const;
export type WritingAssistKind = (typeof WRITING_ASSIST_KINDS)[number];

export function isWritingAssistKind(value: string): value is WritingAssistKind {
  return (WRITING_ASSIST_KINDS as readonly string[]).includes(value);
}

/** The assist statuses a running job may still settle; the rest are verdicts. */
export const OPEN_WRITING_ASSIST_STATUSES = ["QUEUED", "RUNNING"] as const;

/**
 * A failure whose message was written for the author on purpose — "That
 * chapter has been deleted" — so the sentence below passes it through rather
 * than replacing it with the generic one.
 */
export class WritingAssistFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WritingAssistFailure";
  }
}

const GENERIC_FAILURE: Record<WritingAssistKind, string> = {
  ILLUSTRATE: "That picture couldn’t be drawn.",
  DRAFT_CHAPTER: "The chapter draft couldn’t be written.",
  CHAPTER_FEEDBACK: "The notes on this chapter couldn’t be written.",
  CONSISTENCY: "The consistency check couldn’t be finished.",
  OUTLINE: "The outline couldn’t be written.",
  STYLE_PROFILE: "Learning your writing style didn’t finish.",
  REEMBED: "Refreshing your book’s memory didn’t finish."
};

/**
 * What the author reads on the failed card.
 *
 * `charged` is whether the assist took credits; its refund has already run
 * through the attempt by the time this is written, so the sentence may say so.
 * A refusal is told apart from an outage only where it changes what the author
 * should do next: a picture both providers declined will be declined again
 * from the same words, so it asks for different ones.
 */
export function writingAssistFailureSentence(
  kind: string,
  error: unknown,
  options: { charged: boolean }
): string {
  const refund = options.charged ? " Your credits were returned." : "";
  if (error instanceof Error && error.message === STOPPED_JOB_ERROR) {
    return `Stopped before it finished.${refund}`;
  }
  if (error instanceof WritingAssistFailure) {
    return `${error.message}${refund}`;
  }
  if (kind === "ILLUSTRATE" && isImageContentRefusalError(error)) {
    return `The picture service wouldn’t draw that description. Try describing the scene differently.${refund}`;
  }
  // The runners' own refusals (`AuthorAssistInputError`) are written for the
  // author — "Give the chapter a title or some notes to draft from." — and
  // raised before any model call, so they pass through like ours.
  const inputMessage = assistInputErrorMessage(error);
  if (inputMessage) {
    return `${inputMessage}${refund}`;
  }
  const generic = isWritingAssistKind(kind) ? GENERIC_FAILURE[kind] : "That request couldn’t be finished.";
  return `${generic}${refund} Try again in a moment.`;
}

/** An `AuthorAssistInputError`'s sentence, read by name so a mocked core still answers. */
function assistInputErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "AuthorAssistInputError") {
    return null;
  }
  const message = error.message.trim();
  return message ? (/[.!?…]$/u.test(message) ? message : `${message}.`) : null;
}

/**
 * Fail the assist row a `writing-assist` delivery ran for. Best-effort: this
 * runs inside `markFailed`/`markStopped`, whose own verdict has already been
 * written, and a second failure here must not escape them.
 *
 * `attemptSettled` says the attempt boundary above already refunded the
 * charge. A priced assist always rides an attempt; the row's own
 * `ledgerEntryId` is the fallback for one that somehow does not, the same
 * belt the audiobook and portrait paths wear. The refund is idempotent, and
 * it runs only for the delivery whose FAILED write actually landed.
 */
export async function failWritingAssistForJob(
  job: { data: { assistId?: string | undefined; projectId?: string | undefined } },
  error: unknown,
  options: { attemptSettled: boolean }
): Promise<void> {
  const { assistId, projectId } = job.data;
  if (!assistId) return;
  try {
    const assist = await prisma.manuscriptAssist.findUnique({
      where: { id: assistId },
      select: { kind: true, creditsCharged: true, projectId: true, ledgerEntryId: true }
    });
    if (!assist || (projectId && assist.projectId !== projectId)) return;
    if (!options.attemptSettled && assist.ledgerEntryId) {
      await refundCreditLedgerEntry(assist.ledgerEntryId, "Writing assist failed").catch((refundError: unknown) => {
        console.error(`Failed to refund writing assist ${assistId}`, refundError);
      });
    }
    await prisma.manuscriptAssist.updateMany({
      where: { id: assistId, status: { in: [...OPEN_WRITING_ASSIST_STATUSES] } },
      data: {
        status: "FAILED",
        error: writingAssistFailureSentence(assist.kind, error, { charged: assist.creditsCharged > 0 })
      }
    });
  } catch (settlementError) {
    console.error(`Failed to settle writing assist ${assistId}`, settlementError);
  }
}
