import { Prisma, prisma } from "./client.ts";
import { grantProjectEntitlementTx } from "./billingEntitlements.ts";
import {
  type BillingTx,
  type CreditLedgerEntryRecord,
  type CreditOperationName,
  runSerializable
} from "./billingInternals.ts";
import {
  commitReservedCreditsTx,
  refundCreditLedgerEntryTx,
  reserveCreditsTx
} from "./billingLedger.ts";
import { consumeIllustratedBookUseTx, type ConsumeUsageResult } from "./planPeriods.ts";

export type GenerationAttemptRecord = {
  id: string;
  userId: string;
  commandKey: string;
  requestFingerprint: string;
  status: "QUEUED" | "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELED";
  operation: CreditOperationName;
  quotedCredits: number;
  projectId: string | null;
  editOperationId: string | null;
  ledgerEntryId: string | null;
  primaryJobId: string | null;
  retryOfAttemptId: string | null;
  error: string | null;
  refundPending: boolean;
};

export class GenerationAttemptConflictError extends Error {
  readonly code = "GENERATION_COMMAND_CONFLICT";

  constructor(message = "This generation command was already used with different settings.") {
    super(message);
    this.name = "GenerationAttemptConflictError";
  }
}

/**
 * The job a `create` callback named is not this attempt's to charge against.
 *
 * Deliberately **not** a `GenerationAttemptConflictError`: that one means "this
 * command was already used with different settings" and the mobile routes
 * answer it 409 with its message. This one means the paid start was wired onto
 * work it does not own — a caller that reached `enqueueGenerationJob` without
 * an `attemptId`, or a `dedupeKey` another path had already spent. Both are
 * faults nothing above this function can act on, so it stays loud — a 500,
 * never a conflict the reader is invited to resolve.
 *
 * Loud is not the same as verbatim, and the message below is why: it names the
 * attempt, the job and the key they collided on, which is the debugging
 * artifact and not a sentence to ship. Left to Fastify's default handler that
 * is exactly where it went, so `sendGenerationAttemptError`
 * (`apps/api/src/mobile/httpErrors.ts`) keeps the 500 and answers with reader
 * copy, logging this. `classifyEditFailure` does the same for the
 * `BookEditOperation.error` column.
 */
export class GenerationAttemptJobClaimError extends Error {
  readonly code = "GENERATION_JOB_NOT_CLAIMED";

  constructor(message: string) {
    super(message);
    this.name = "GenerationAttemptJobClaimError";
  }
}

export class GenerationQuotaExceededError extends Error {
  readonly code = "IMAGE_LIMIT_REACHED";
  readonly claim: ConsumeUsageResult;

  constructor(claim: ConsumeUsageResult) {
    super("The illustrated-book limit has been reached for this period.");
    this.name = "GenerationQuotaExceededError";
    this.claim = claim;
  }
}

export type GenerationAttemptDomainResult = {
  /** Null for account-level work (a library-character portrait) with no book. */
  projectId: string | null;
  primaryJobId: string;
  editOperationId?: string | null | undefined;
};

export type StartGenerationAttemptOptions = {
  userId: string;
  commandKey: string;
  requestFingerprint: string;
  operation: CreditOperationName;
  quotedCredits: number;
  projectId?: string | null | undefined;
  retryOfAttemptId?: string | null | undefined;
  description: string;
  metadata?: Record<string, unknown> | undefined;
  imageQuotaLimit?: number | null | undefined;
  grantExportEntitlement?: boolean | undefined;
  /**
   * Writes the domain state and **creates** the durable job this attempt pays
   * for — *every* job it enqueues stamped with the `attemptId` it is handed, not
   * only the one it names as `primaryJobId`. Returning a job row it merely found
   * — what `enqueueGenerationJob` does for a `dedupeKey` already spent by some
   * other path — is refused with a `GenerationAttemptJobClaimError` rather than
   * re-parented, at the enqueue for `apps/api` callers and again at
   * `assertPrimaryJobBelongsToAttempt` for this function's own contract.
   */
  create: (
    tx: BillingTx,
    context: { attemptId: string; ledgerEntry: CreditLedgerEntryRecord | null }
  ) => Promise<GenerationAttemptDomainResult>;
};

export type StartGenerationAttemptResult = {
  attempt: GenerationAttemptRecord;
  replayed: boolean;
};

const attemptSelect = {
  id: true,
  userId: true,
  commandKey: true,
  requestFingerprint: true,
  status: true,
  operation: true,
  quotedCredits: true,
  projectId: true,
  editOperationId: true,
  ledgerEntryId: true,
  primaryJobId: true,
  retryOfAttemptId: true,
  error: true,
  refundPending: true
} as const;

/**
 * Claims a semantic command before money moves, then commits the complete paid
 * start in one serializable transaction. No queue/network call belongs in the
 * callback; dispatch happens after this function returns.
 *
 * The callback owes it a job of its own: the id it returns is verified to carry
 * this attempt's `attemptId` before the charge is parented onto it, so a row
 * found under a spent `dedupeKey` is refused instead of adopted.
 */
export async function startGenerationAttempt(
  options: StartGenerationAttemptOptions
): Promise<StartGenerationAttemptResult> {
  validateStartOptions(options);

  for (let serializableRetry = 0; serializableRetry < 3; serializableRetry += 1) {
    try {
      return await runSerializable(async (tx) => {
        const existing = await tx.generationAttempt.findUnique({
          where: { commandKey: options.commandKey },
          select: attemptSelect
        });
        if (existing) {
          assertMatchingCommand(existing, options);
          return { attempt: existing as GenerationAttemptRecord, replayed: true };
        }

        if (options.retryOfAttemptId) {
          const source = await tx.generationAttempt.findUnique({
            where: { id: options.retryOfAttemptId },
            select: {
              id: true,
              userId: true,
              status: true,
              quotedCredits: true,
              refundPending: true,
              retryAttempt: { select: attemptSelect }
            }
          });
          if (
            !source ||
            source.userId !== options.userId ||
            !["FAILED", "CANCELED"].includes(source.status) ||
            source.refundPending
          ) {
            throw new GenerationAttemptConflictError("That generation attempt is not eligible for a paid retry.");
          }
          if (source.quotedCredits !== options.quotedCredits) {
            throw new GenerationAttemptConflictError("The retry price no longer matches the refunded attempt.");
          }
          if (source.retryAttempt) {
            assertMatchingRetry(source.retryAttempt, options);
            return { attempt: source.retryAttempt as GenerationAttemptRecord, replayed: true };
          }
        }

        const claimed = await tx.generationAttempt.create({
          data: {
            userId: options.userId,
            commandKey: options.commandKey,
            requestFingerprint: options.requestFingerprint,
            operation: options.operation,
            quotedCredits: options.quotedCredits,
            ...(options.projectId ? { projectId: options.projectId } : {}),
            ...(options.retryOfAttemptId ? { retryOfAttemptId: options.retryOfAttemptId } : {})
          },
          select: { id: true }
        });

        let quotaClaim: ConsumeUsageResult | null = null;
        if (options.imageQuotaLimit !== null && options.imageQuotaLimit !== undefined) {
          quotaClaim = await consumeIllustratedBookUseTx(tx, {
            userId: options.userId,
            limit: options.imageQuotaLimit
          });
          if (!quotaClaim.allowed) {
            throw new GenerationQuotaExceededError(quotaClaim);
          }
        }

        const reservation = await reserveCreditsTx(tx, {
          userId: options.userId,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          operation: options.operation,
          amountCredits: options.quotedCredits,
          idempotencyKey: `generation-attempt:${claimed.id}`,
          description: options.description,
          metadata: {
            ...options.metadata,
            generationAttemptId: claimed.id,
            ...(quotaClaim ? { imageQuota: { periodKey: quotaClaim.periodKey } } : {})
          }
        });
        const spend = reservation ? await commitReservedCreditsTx(tx, reservation.id) : null;
        const domain = await options.create(tx, { attemptId: claimed.id, ledgerEntry: spend });

        await assertPrimaryJobBelongsToAttempt(tx, domain.primaryJobId, claimed.id);
        if (spend) {
          await tx.creditLedgerEntry.update({
            where: { id: spend.id },
            data: { projectId: domain.projectId, generationJobId: domain.primaryJobId }
          });
        }
        if (options.grantExportEntitlement && domain.projectId) {
          await grantProjectEntitlementTx(tx, {
            userId: options.userId,
            projectId: domain.projectId,
            type: "EXPORT_UNLOCK",
            source: "full_generation_credits",
            creditsCost: options.quotedCredits,
            relatedLedgerEntryId: spend?.id ?? null,
            metadata: { generationAttemptId: claimed.id, includedInFullGenerationPackage: true }
          });
        }

        const attempt = await tx.generationAttempt.update({
          where: { id: claimed.id },
          data: {
            projectId: domain.projectId,
            primaryJobId: domain.primaryJobId,
            ledgerEntryId: spend?.id ?? null,
            ...(domain.editOperationId ? { editOperationId: domain.editOperationId } : {})
          },
          select: attemptSelect
        });
        return { attempt: attempt as GenerationAttemptRecord, replayed: false };
      });
    } catch (error) {
      if (isSerializableConflict(error) && serializableRetry < 2) {
        continue;
      }
      if (isUniqueConflict(error)) {
        const winner = await findWinningAttempt(options);
        if (winner) {
          return { attempt: winner, replayed: true };
        }
      }
      throw error;
    }
  }
  throw new Error("Generation attempt transaction could not be serialized.");
}

export async function getGenerationAttempt(id: string): Promise<GenerationAttemptRecord | null> {
  return prisma.generationAttempt.findUnique({ where: { id }, select: attemptSelect }) as Promise<GenerationAttemptRecord | null>;
}

/**
 * The ids among `attemptIds` whose attempts are terminal (FAILED/CANCELED) —
 * settled and refunded. Work behind them must never be re-run for free; a paid
 * retry starts a fresh attempt instead.
 */
export async function settledGenerationAttemptIds(attemptIds: string[]): Promise<Set<string>> {
  if (attemptIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.generationAttempt.findMany({
    where: { id: { in: attemptIds }, status: { in: ["FAILED", "CANCELED"] } },
    select: { id: true }
  });
  return new Set(rows.map((row) => row.id));
}

export async function markGenerationAttemptActive(attemptId: string): Promise<void> {
  await prisma.generationAttempt.updateMany({
    where: { id: attemptId, status: "QUEUED" },
    data: { status: "ACTIVE", startedAt: new Date(), error: null }
  });
}

export async function markGenerationAttemptSucceeded(attemptId: string): Promise<void> {
  await prisma.generationAttempt.updateMany({
    where: { id: attemptId, status: { in: ["QUEUED", "ACTIVE"] } },
    data: { status: "SUCCEEDED", finishedAt: new Date(), error: null, refundPending: false }
  });
}

export async function failGenerationAttempt(
  attemptId: string,
  reason: string,
  status: "FAILED" | "CANCELED" = "FAILED"
): Promise<void> {
  try {
    await runSerializable(async (tx) => {
      const attempt = await tx.generationAttempt.findUnique({
        where: { id: attemptId },
        select: { ledgerEntryId: true, status: true, refundPending: true }
      });
      if (
        !attempt ||
        attempt.status === "SUCCEEDED" ||
        (["FAILED", "CANCELED"].includes(attempt.status) && !attempt.refundPending)
      ) {
        return;
      }
      const terminalStatus = ["FAILED", "CANCELED"].includes(attempt.status) ? attempt.status : status;
      if (attempt.ledgerEntryId) {
        await refundCreditLedgerEntryTx(tx, attempt.ledgerEntryId, reason);
      }
      await tx.generationAttempt.update({
        where: { id: attemptId },
        data: { status: terminalStatus, error: reason, finishedAt: new Date(), refundPending: false }
      });
    });
  } catch (error) {
    const finishedAt = new Date();
    await prisma.generationAttempt
      .updateMany({
        where: { id: attemptId, status: { in: ["QUEUED", "ACTIVE"] } },
        data: { status, error: reason, finishedAt, refundPending: true }
      })
      .catch(() => ({ count: 0 }));
    // A reconciliation failure must preserve an existing terminal decision,
    // and a late failure must never demote SUCCEEDED to refundable FAILED.
    await prisma.generationAttempt
      .updateMany({
        where: { id: attemptId, status: { in: ["FAILED", "CANCELED"] }, refundPending: true },
        data: { error: reason, finishedAt, refundPending: true }
      })
      .catch(() => ({ count: 0 }));
    throw error;
  }
}

export async function reconcileGenerationAttemptRefunds(limit = 50): Promise<number> {
  const attempts = await prisma.generationAttempt.findMany({
    where: { refundPending: true, status: { in: ["FAILED", "CANCELED"] } },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, status: true, error: true }
  });
  await Promise.allSettled(
    attempts.map((attempt) =>
      failGenerationAttempt(attempt.id, attempt.error ?? "Generation failed.", attempt.status as "FAILED" | "CANCELED")
    )
  );
  return attempts.length;
}

async function findWinningAttempt(options: StartGenerationAttemptOptions): Promise<GenerationAttemptRecord | null> {
  const winner = await prisma.generationAttempt.findFirst({
    where: {
      OR: [
        { commandKey: options.commandKey },
        ...(options.retryOfAttemptId ? [{ retryOfAttemptId: options.retryOfAttemptId }] : [])
      ]
    },
    select: attemptSelect
  });
  if (!winner) {
    return null;
  }
  if (options.retryOfAttemptId && winner.retryOfAttemptId === options.retryOfAttemptId) {
    assertMatchingRetry(winner, options);
  } else {
    assertMatchingCommand(winner, options);
  }
  return winner as GenerationAttemptRecord;
}

/**
 * The one thing a paid start cannot take its caller's word for: that the job it
 * is about to hang a committed charge on is *this* attempt's job.
 *
 * Every caller gets that id from `enqueueGenerationJob`, which returns whatever
 * row already stands under its `dedupeKey` rather than creating one. So a key
 * some other path already spent hands back a job this attempt never made —
 * `plan-book:<projectId>`, written by the creation flow and asked for again by
 * `POST /api/mobile/projects/:id/plan`; `generate-book:<projectId>:<planId>`,
 * written for free by the operator approval route — and the writes that follow
 * would re-parent the attempt and its ledger entry onto it. Where that row is
 * already some attempt's `primaryJobId` the unique index on that column catches
 * it, but as a raw `P2002` several statements later; where it is not — an
 * unbilled row — nothing catches it at all. The charge then commits against
 * work that was already queued, and if that work has already finished nothing
 * will ever mark this attempt succeeded or failed: a committed spend with no
 * settlement is the one shape the reserve → commit → refund loop has no answer
 * for.
 *
 * **This is the backstop, not the whole guard, and it is kept on purpose.**
 * `enqueueGenerationJob` (`apps/api/src/queue.ts`) now refuses the same
 * disagreement at the enqueue itself — which is the only place that can cover a
 * callback enqueueing *several* jobs, since this check can only ever see the one
 * the callback named. It cannot make this one redundant, for two reasons that
 * are properties of where the code lives rather than of how careful a caller is.
 * `packages/core` ← `packages/db` ← `apps/*` is one-way, so this package can
 * neither call that helper nor assume a callback went through it: `create` takes
 * a job *id*, and an id can come from a hand-written `tx.generationJob.create`
 * that forgot the stamp, or off some other row entirely. And this is the only
 * check that answers "no such job" — the enqueue is looking at a row it just
 * read, while a callback can name an id nothing wrote.
 *
 * The test is exact rather than defensive because the stamp is part of the
 * documented pattern: every caller passes `attemptId` to `enqueueGenerationJob`,
 * so a job this attempt's own `create` wrote already carries it, and one the
 * callback merely *found* carries null or somebody else's. That leaves no
 * tolerated middle — `attemptId: null` is exactly the unbilled row this refuses
 * — which is why forgetting the stamp is a loud failure here rather than a
 * silent re-parent. It is also why nothing re-writes the column: the claim the
 * update used to make is the claim this now verifies, and stamping it here
 * would only make the check true by writing it.
 *
 * Refusing inside the attempt transaction is what makes the refusal free: the
 * reservation, the spend, the quota slot and every domain write roll back with
 * it, so nobody is charged for the request that raised this.
 */
async function assertPrimaryJobBelongsToAttempt(
  tx: BillingTx,
  primaryJobId: string,
  attemptId: string
): Promise<void> {
  const job = await tx.generationJob.findUnique({
    where: { id: primaryJobId },
    select: { attemptId: true }
  });
  if (!job) {
    throw new GenerationAttemptJobClaimError(
      `Generation attempt ${attemptId} named generation job ${primaryJobId}, which does not exist.`
    );
  }
  if (job.attemptId !== attemptId) {
    throw new GenerationAttemptJobClaimError(
      `Generation attempt ${attemptId} may not claim generation job ${primaryJobId}: it is ${
        job.attemptId ? `already attempt ${job.attemptId}'s work` : "not stamped with any attempt"
      }. A create() callback must enqueue its own job with this attemptId, never return one it found under a spent dedupeKey.`
    );
  }
}

function assertMatchingRetry(
  existing: Pick<GenerationAttemptRecord, "userId" | "requestFingerprint" | "operation" | "quotedCredits">,
  options: StartGenerationAttemptOptions
): void {
  if (
    existing.userId !== options.userId ||
    existing.requestFingerprint !== options.requestFingerprint ||
    existing.operation !== options.operation ||
    existing.quotedCredits !== options.quotedCredits
  ) {
    throw new GenerationAttemptConflictError("That failed attempt already has a retry with different settings.");
  }
}

function assertMatchingCommand(
  existing: Pick<GenerationAttemptRecord, "userId" | "commandKey" | "requestFingerprint" | "operation" | "quotedCredits">,
  options: StartGenerationAttemptOptions
): void {
  if (
    existing.userId !== options.userId ||
    existing.commandKey !== options.commandKey ||
    existing.requestFingerprint !== options.requestFingerprint ||
    existing.operation !== options.operation ||
    existing.quotedCredits !== options.quotedCredits
  ) {
    throw new GenerationAttemptConflictError();
  }
}

function validateStartOptions(options: StartGenerationAttemptOptions): void {
  if (!options.commandKey.trim() || !options.requestFingerprint.trim()) {
    throw new Error("Generation attempts require a command key and request fingerprint.");
  }
  if (!Number.isInteger(options.quotedCredits) || options.quotedCredits < 0) {
    throw new Error("Generation attempt quotes must be non-negative whole-credit amounts.");
  }
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isSerializableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}
