import type { BillingOperation } from "@book-maker/core";
import { Prisma, prisma } from "./client.ts";
import { grantProjectEntitlementTx } from "./billingEntitlements.ts";
import { type BillingTx, type CreditLedgerEntryRecord, runSerializable } from "./billingInternals.ts";
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
  operation: string;
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
  operation: BillingOperation;
  quotedCredits: number;
  projectId?: string | null | undefined;
  retryOfAttemptId?: string | null | undefined;
  description: string;
  metadata?: Record<string, unknown> | undefined;
  imageQuotaLimit?: number | null | undefined;
  grantExportEntitlement?: boolean | undefined;
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

        await tx.generationJob.update({
          where: { id: domain.primaryJobId },
          data: { attemptId: claimed.id }
        });
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
