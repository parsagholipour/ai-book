/**
 * What a failed book edit is allowed to say to the reader.
 *
 * `BookEditOperation.error` is not a log line. `serializeBookEditOperation`
 * copies it onto `MobileBookEditOperationDto.error`, which the app parses into
 * `MobileBookEditOperation.error` — so whatever lands in that column is shipped
 * to the device and is one widget away from being drawn on the failed card.
 * Six different writers fill it: three API catch sites for a paid start that
 * never committed, and — the dominant producer — the worker, through
 * `failEditOperation`, the plan-revision retry write and the structural
 * rollback's own APPLIED → FAILED flip. Every one of them used to store
 * `errorMessage(error)`, so a Prisma `P2024`, a null-deref `TypeError` inside a
 * structural apply, or `GenerationAttemptJobClaimError`'s debugging sentence
 * ("…may not claim generation job <uuid>: it is already attempt <uuid>'s work.
 * A create() callback must enqueue its own job with this attemptId, never
 * return one it found under a spent dedupeKey.") reached the reader verbatim.
 *
 * Classifying at three of the six catch sites left the next one wrong by
 * default, so the rule lives here instead — at the leaf both apps can reach,
 * because `packages/core` is the only package below `apps/api` *and*
 * `apps/worker`.
 *
 * **It dispatches on the wire `code`, not on `instanceof`, and the dependency
 * direction is what forces that.** The three refusals are `packages/db`'s
 * classes and core may not import `packages/db`, so the thing both sides can
 * agree on is the code each class already declares — `IMAGE_LIMIT_REACHED`,
 * `INSUFFICIENT_CREDITS`, `GENERATION_COMMAND_CONFLICT`. That is the same rule
 * the character surface states as "a wire code owns one sentence, and it lives
 * with the code rather than at the call site", read literally: the sentence is
 * a function of the code. It also survives the module mocks — both suites
 * replace `@book-maker/db/billing` wholesale, and the worker's factory omits
 * the error classes entirely, so an `instanceof` ladder there would compare
 * against `undefined`.
 *
 * The ladder is `sendGenerationAttemptError`'s, one rung for one rung: the
 * three refusals a reader can act on keep the sentence their HTTP twin ships —
 * a column that said something else would tell one reader two things about one
 * state — and everything below is a fault nothing above this can act on, so it
 * gets the sentence that belongs to *this* failure and the cause goes to the
 * server log instead.
 *
 * This module imports nothing, which is deliberate: it is reached through the
 * narrow `@book-maker/core/editFailure` specifier so a suite mocking the core
 * barrel with a bare factory (`apps/api/src/mobile/editOperations.test.ts`)
 * cannot replace it — the same reason `./libraryMentions` and `./modelTiers`
 * have entries of their own.
 */

/** Reader copy for one failed edit, plus whether the cause is worth logging. */
export type EditFailureCopy = {
  /** Safe to store on the operation row and ship to the device. */
  message: string;
  /**
   * True when the cause is a fault the reader cannot act on, so the call site
   * logs it. False for the refusals that are ordinary outcomes: a reader out of
   * credits, a spent free-tier image slot, a replayed command and a stop are
   * not incidents, and logging them at error level would bury the ones that
   * are.
   */
  internal: boolean;
};

/**
 * Where in an edit's life the failure happened, which is the only thing the
 * generic sentence differs on.
 *
 * `start` is a paid start that never committed — no charge, no job, no page
 * touched — so re-sending really is the whole recovery and the sentence may say
 * nothing was charged. `settlement` is the worker failing or stopping work that
 * *was* charged; the credits come back through the attempt or the ledger entry
 * and the card reports that separately as `creditsRefunded`, so this sentence
 * makes no claim about money it cannot see.
 */
export type EditFailureStage = "start" | "settlement";

/** Nothing committed, so re-sending is the whole recovery. */
export const EDIT_START_FAILED =
  "That change couldn’t be started, so nothing was charged. Send it again to try once more.";

/** Something broke mid-flight. The card reports the refund; this says what to do. */
export const EDIT_RUN_FAILED = "That change couldn’t be finished. Send it again to try once more.";

/** The adherence gate kept the published manuscript unchanged. */
export const EDIT_ADHERENCE_FAILED =
  "That change couldn’t be applied as requested, so the original book was kept and your credits were returned. Try describing the change differently.";

/**
 * Mirrors `insufficientCreditsChatMessage`'s way forward without repeating its
 * numbers: the reply that failure also writes already names the shortfall, and
 * the card sits directly under it.
 */
export const EDIT_START_NEEDS_CREDITS =
  "There weren’t enough credits for that change. Add credits, then send it again.";

/**
 * The one sentence `IMAGE_LIMIT_REACHED` owns.
 *
 * The free tier's illustrated-book limit has two claiming doors — plan approval
 * and the chat `add_image` Apply — and they used to answer differently: the
 * HTTP door composed this through `sendImageLimitReached`, while the chat door
 * stored `GenerationQuotaExceededError.message`, an internal sentence with no
 * count in it and no way forward. Same reader, same slot, two answers. The
 * count comes off the error's own `claim`; a claim that carries none still gets
 * the way forward, because a card that only says "limit reached" is a dead end.
 */
export function imageLimitReachedMessage(limit: number | null): string {
  return limit === null
    ? "Your plan’s monthly illustrated books are used up. Upgrade for unlimited, or turn visuals off."
    : `Free plans include ${limit} illustrated books a month. Upgrade for unlimited, or turn visuals off.`;
}

/**
 * A sentence that was written for the reader on purpose, so the classifier
 * passes it through instead of replacing it.
 *
 * The alternative — letting a plain `string` cause mean "already reader copy" —
 * is the trap this whole module exists to close: the next call site to hand
 * `failEditOperation` an `errorMessage(error)` would leak it. A stop is the one
 * settlement today with copy of its own.
 */
export class ReaderEditFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaderEditFailure";
  }
}

/** The `code` an error declares, when it declares one at all. */
function failureCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** `GenerationQuotaExceededError.claim.limit`, read off an untyped cause. */
function imageLimitFromClaim(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  const claim = (cause as { claim?: unknown }).claim;
  if (typeof claim !== "object" || claim === null) {
    return null;
  }
  const limit = (claim as { limit?: unknown }).limit;
  return typeof limit === "number" && Number.isFinite(limit) ? limit : null;
}

/** A conflict's own message, which the 409 body already ships verbatim. */
function refusalMessage(cause: unknown): string | null {
  const message = cause instanceof Error ? cause.message : null;
  return message && message.trim() ? message : null;
}

export function classifyEditFailure(cause: unknown, stage: EditFailureStage): EditFailureCopy {
  if (cause instanceof ReaderEditFailure) {
    return { message: cause.message, internal: false };
  }
  const generic = stage === "start" ? EDIT_START_FAILED : EDIT_RUN_FAILED;
  switch (failureCode(cause)) {
    case "IMAGE_LIMIT_REACHED":
      return { message: imageLimitReachedMessage(imageLimitFromClaim(cause)), internal: false };
    case "INSUFFICIENT_CREDITS":
      return { message: EDIT_START_NEEDS_CREDITS, internal: false };
    case "GENERATION_COMMAND_CONFLICT":
      return { message: refusalMessage(cause) ?? generic, internal: false };
    default:
      return { message: generic, internal: true };
  }
}

/**
 * The `data` every write that fails a `BookEditOperation` row shares.
 *
 * It lives beside the copy rule rather than beside any one writer because
 * there are six of them — three API catch sites, `failEditOperation`, the
 * plan-revision retry write and the structural rollback's own APPLIED → FAILED
 * flip — and classifying at three left the next one wrong by default. A caller
 * that needs a different claim still writes its own `where` and takes the
 * verdict from here.
 *
 * The lease clears with the terminal verdict, not before it.
 */
export function failedEditOperationData(cause: unknown): {
  status: "FAILED";
  error: string;
  structuralLeaseToken: null;
  structuralLeaseExpiresAt: null;
} {
  return {
    status: "FAILED",
    error: classifyEditFailure(cause, "settlement").message,
    structuralLeaseToken: null,
    structuralLeaseExpiresAt: null
  };
}
