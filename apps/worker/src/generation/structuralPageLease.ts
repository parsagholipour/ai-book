import { jsonRecord, parseStructuralApplication, type StructuralApplication } from "@book-maker/core";
import { PAGE_RESTRUCTURE_TRANSACTION_OPTIONS, Prisma, prisma } from "@book-maker/db";
import {
  claimDurableEditCompletionTx,
  settleDurableEditAttemptTx,
  type DurableEditCompletionClaim
} from "../runtime/durableEditCompletion.js";

/** Long enough for a slow provider call; renewed in the background at one third. */
export const STRUCTURAL_PAGE_LEASE_MS = 3 * 60_000;
const STRUCTURAL_PAGE_LEASE_RENEW_MS = STRUCTURAL_PAGE_LEASE_MS / 3;
/**
 * A tick of both waits, and the ceiling on the sleep a `busy` claim asks for.
 * Fast because the acquire wait's tick **is** the CAS: an expiry frees the row
 * at an instant nothing announces, and one rival delivery is polling for it.
 * `characterReferenceRenderLease.ts` polls at half the rate for the mirror of
 * both reasons — its tick is two reads, and a book can have several waiters.
 */
const STRUCTURAL_PAGE_LEASE_POLL_MS = 1_000;

/**
 * The bound on both waits below, in the lease's own units — five renewals'
 * worth of another delivery being alive.
 *
 * Neither state a waiter polls for is guaranteed to arrive.
 * `structuralLeaseCompletedAt` is written by the *owner*, so a delivery that
 * lost its lease with nobody left to take it polls for a write nothing is going
 * to make — and nobody can take it, because that delivery is still awaiting
 * inside its BullMQ processor, so its job lock keeps being renewed and no
 * redelivery ever arrives to claim the expired lease. A `busy` claim clears
 * when the owner finishes or its lease expires, and an owner wedged on a call
 * that never returns does neither while its heartbeat keeps renewing. Both
 * loops used to poll forever on exactly those shapes, which costs a worker
 * concurrency slot until the process restarts. So every wait ends: generously,
 * because giving up on a live delivery is the expensive mistake, and with an
 * answer the caller settles rather than a silent return that would leave the
 * book EDITING with no compile behind it.
 *
 * **Fixed at entry, and deliberately not renewed the way
 * `characterReferenceRenderLease.ts` renews its own.** That lease has no
 * heartbeat, so one still live at the deadline *proves* it changed hands, and
 * its waiter is a consumer — an image or cover job that needs the winner's
 * sheets — so abandoning under a live render throws the answer away. Neither
 * half holds here. This lease is heartbeated, so an owner still holding at the
 * deadline is ordinarily the same one still working, which is the case the
 * suite pins ("a wedged one renews forever"); and this waiter is a *rival*, a
 * duplicate delivery of the same operation whose whole job in losing is to
 * write nothing — `processJob` neither completes nor fails on
 * `UnownedStructuralDeliveryError`. So giving up costs this delivery its turn
 * and the book nothing, while renewing on a relay would only hold the worker
 * slot, which is the failure this bound exists to stop.
 */
export const STRUCTURAL_PAGE_LEASE_WAIT_MS = 5 * STRUCTURAL_PAGE_LEASE_MS;

type StructuralLeaseRow = {
  status: string;
  classifier: unknown;
  structuralLeaseToken: string | null;
  structuralLeaseExpiresAt: Date | null;
  structuralLeaseCompletedAt: Date | null;
};

export type StructuralPageLeaseClaim =
  | {
      outcome: "acquired";
      phase: "draft" | "tail";
      application: StructuralApplication | null;
      expiresAt: Date;
    }
  | { outcome: "busy"; application: StructuralApplication | null; retryAt: Date }
  | { outcome: "completed" }
  | { outcome: "settled" };

/**
 * What a wait may answer: every claim except `busy`, which is what it waits
 * out, plus the one answer only the wait can give — `abandoned`, meaning the
 * owner outlasted the deadline and this delivery owns nothing at all.
 */
export type StructuralPageLeaseWait =
  | Exclude<StructuralPageLeaseClaim, { outcome: "busy" }>
  | { outcome: "abandoned" };

/**
 * Claims one structural delivery with database time, inside the caller's
 * transaction when the shift itself is about to run.
 *
 * The UPDATE is deliberately a single compare-and-set. It both takes the row
 * lock and installs the owner, so a second delivery can observe only the old
 * owner or this one — never an unowned stamp between those two facts.
 */
export async function acquireStructuralPageLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<StructuralPageLeaseClaim> {
  const rows = await tx.$queryRawUnsafe<StructuralLeaseRow[]>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseToken" = $2,
           "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 millisecond'),
           "status" = CASE WHEN "status" = 'APPLIED' THEN "status" ELSE 'ACTIVE'::"BookEditOperationStatus" END,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "status" IN ('QUEUED', 'ACTIVE', 'APPLIED')
       AND "structuralLeaseCompletedAt" IS NULL
       AND (
         "structuralLeaseToken" IS NULL
         OR "structuralLeaseExpiresAt" IS NULL
         OR "structuralLeaseExpiresAt" <= CURRENT_TIMESTAMP
         OR "structuralLeaseToken" = $2
       )
     RETURNING "status", "classifier", "structuralLeaseToken",
               "structuralLeaseExpiresAt", "structuralLeaseCompletedAt"`,
    operationId,
    ownerToken,
    STRUCTURAL_PAGE_LEASE_MS
  );
  const acquired = rows[0];
  if (acquired?.structuralLeaseExpiresAt) {
    if (
      acquired.status === "APPLIED" &&
      typeof jsonRecord(acquired.classifier).structuralSkipped === "string"
    ) {
      await tx.bookEditOperation.update({
        where: { id: operationId },
        data: {
          structuralLeaseToken: null,
          structuralLeaseExpiresAt: null,
          structuralLeaseCompletedAt: new Date()
        }
      });
      return { outcome: "completed" };
    }
    return {
      outcome: "acquired",
      phase: acquired.status === "APPLIED" ? "tail" : "draft",
      application: parseStructuralApplication(acquired.classifier),
      expiresAt: acquired.structuralLeaseExpiresAt
    };
  }

  const held = await tx.bookEditOperation.findUnique({
    where: { id: operationId },
    select: {
      status: true,
      classifier: true,
      structuralLeaseToken: true,
      structuralLeaseExpiresAt: true,
      structuralLeaseCompletedAt: true
    }
  });
  if (!held || held.status === "FAILED" || held.status === "CANCELED") {
    return { outcome: "settled" };
  }
  if (
    held.structuralLeaseCompletedAt ||
    (held.status === "APPLIED" && typeof jsonRecord(held.classifier).structuralSkipped === "string")
  ) {
    return { outcome: "completed" };
  }
  if (held.structuralLeaseToken && held.structuralLeaseExpiresAt) {
    return {
      outcome: "busy",
      application: parseStructuralApplication(held.classifier),
      retryAt: held.structuralLeaseExpiresAt
    };
  }
  // The failed CAS and this read are separate statements. An owner can finish
  // between them, but the next poll answers that new state; never pretend this
  // delivery owns a row the UPDATE did not return.
  return {
    outcome: "busy",
    application: parseStructuralApplication(held.classifier),
    retryAt: new Date(Date.now() + STRUCTURAL_PAGE_LEASE_POLL_MS)
  };
}

export async function acquireStructuralPageLease(
  operationId: string,
  ownerToken: string
): Promise<StructuralPageLeaseClaim> {
  return prisma.$transaction(
    (tx) => acquireStructuralPageLeaseTx(tx, operationId, ownerToken),
    PAGE_RESTRUCTURE_TRANSACTION_OPTIONS
  );
}

/** A busy delivery stays alive so it cannot complete the shared durable job early. */
export async function waitForStructuralPageLease(
  operationId: string,
  ownerToken: string
): Promise<StructuralPageLeaseWait> {
  const deadline = Date.now() + STRUCTURAL_PAGE_LEASE_WAIT_MS;
  for (;;) {
    const claim = await acquireStructuralPageLease(operationId, ownerToken);
    if (claim.outcome !== "busy") {
      return claim;
    }
    if (Date.now() >= deadline) {
      console.error(`Gave up waiting for the owner of structural edit ${operationId}`, {
        event: "generation.structural_lease_wait_abandoned",
        operationId,
        waitedMs: STRUCTURAL_PAGE_LEASE_WAIT_MS
      });
      return { outcome: "abandoned" };
    }
    const remaining = Math.max(1, claim.retryAt.getTime() - Date.now());
    await delay(Math.min(STRUCTURAL_PAGE_LEASE_POLL_MS, remaining));
  }
}

/** A stale former owner observes the winner; it never tries to steal back. */
export async function waitForStructuralPageLeaseCompletion(
  operationId: string
): Promise<"completed" | "abandoned"> {
  const deadline = Date.now() + STRUCTURAL_PAGE_LEASE_WAIT_MS;
  for (;;) {
    const operation = await prisma.bookEditOperation.findUnique({
      where: { id: operationId },
      select: { status: true, classifier: true, structuralLeaseCompletedAt: true }
    });
    if (
      !operation ||
      operation.status === "FAILED" ||
      operation.status === "CANCELED" ||
      operation.structuralLeaseCompletedAt ||
      (operation.status === "APPLIED" &&
        typeof jsonRecord(operation.classifier).structuralSkipped === "string")
    ) {
      return "completed";
    }
    if (Date.now() >= deadline) {
      console.error(`Gave up waiting for structural edit ${operationId} to be finished by anybody`, {
        event: "generation.structural_lease_completion_abandoned",
        operationId,
        waitedMs: STRUCTURAL_PAGE_LEASE_WAIT_MS
      });
      return "abandoned";
    }
    await delay(STRUCTURAL_PAGE_LEASE_POLL_MS);
  }
}

/** Renews only a still-unexpired owner; an expired zombie cannot revive itself. */
export async function renewStructuralPageLease(operationId: string, ownerToken: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ structuralLeaseExpiresAt: Date }[]>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 millisecond'),
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" IN ('ACTIVE', 'APPLIED')
     RETURNING "structuralLeaseExpiresAt"`,
    operationId,
    ownerToken,
    STRUCTURAL_PAGE_LEASE_MS
  );
  return rows.length === 1;
}

class StructuralPageLeaseSettlementMissError extends Error {
  constructor() {
    super("Structural page edit lost its lease before publication settlement");
    this.name = "StructuralPageLeaseSettlementMissError";
  }
}

/**
 * Atomically fences the delivered verdict and the exact manuscript revision
 * it owns with the current lease.
 *
 * Project is locked first, matching export publication and stop. If the lease
 * CAS then misses, throwing rolls the revision bump back too: an APPLIED
 * operation without a revision cannot be recovered as a compile owner, while a
 * revision bump without its owner would leave the same publication generation
 * permanently anonymous.
 *
 * The job predicate is NULL-tolerant, like the insert publisher's
 * (`publishDraftedInsertedPages`): `BookEditOperation.generationJobId` is
 * nullable and Stop still walks the legacy shape by payload id, so a row that
 * predates the relation would otherwise be fenced out of its own publication
 * for good — rolled back and refunded on every delivery of a book whose pages
 * are already shifted. It rejects only a row that names a *different* job.
 */
export async function markStructuralPageLeaseApplied(options: {
  projectId: string;
  operationId: string;
  ownerToken: string;
  affectedPageIndexes: number[];
  generationJobId: string;
  attemptId?: string | undefined;
}): Promise<number | null> {
  const pgIndexes = `{${options.affectedPageIndexes.join(",")}}`;
  let publicationRevision: number | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const published = await tx.project.update({
        where: { id: options.projectId },
        data: { contentRevision: { increment: 1 } },
        select: { contentRevision: true }
      });
      const durableCompletion: DurableEditCompletionClaim = {
        generationJobId: options.generationJobId,
        projectId: options.projectId,
        operationId: options.operationId,
        attemptId: options.attemptId,
        type: "APPLY_BOOK_EDIT",
        message: "Page structure updated"
      };
      if (!(await claimDurableEditCompletionTx(tx, durableCompletion))) {
        throw new StructuralPageLeaseSettlementMissError();
      }
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "BookEditOperation"
           SET "status" = 'APPLIED',
               "publicationRevision" = $5,
               "affectedPageIndexes" = $4::integer[],
               "appliedAt" = CURRENT_TIMESTAMP,
               "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 millisecond'),
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1
           AND "projectId" = $6
           AND "structuralLeaseToken" = $2
           AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
           AND "structuralLeaseCompletedAt" IS NULL
           AND "status" = 'ACTIVE'
           AND ("generationJobId" IS NULL OR "generationJobId" = $7)
         RETURNING "id"`,
        options.operationId,
        options.ownerToken,
        STRUCTURAL_PAGE_LEASE_MS,
        pgIndexes,
        published.contentRevision,
        options.projectId,
        options.generationJobId
      );
      if (rows.length !== 1) {
        throw new StructuralPageLeaseSettlementMissError();
      }
      if (!(await settleDurableEditAttemptTx(tx, durableCompletion))) {
        throw new StructuralPageLeaseSettlementMissError();
      }
      publicationRevision = published.contentRevision;
    }, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
    return publicationRevision;
  } catch (error) {
    if (error instanceof StructuralPageLeaseSettlementMissError) return null;
    throw error;
  }
}

/**
 * The same fence for the verdict that applies *nothing*: skipped, refunded and
 * finished, in one statement a stale delivery cannot win.
 *
 * A refusal settles the whole edit — APPLIED with `structuralSkipped`, the lease
 * completed, the book put back down — off a page read taken outside every claim,
 * and the refund it makes first is not instant. So the delivery that decided to
 * settle may no longer own the row by the time it writes: its lease can expire
 * while the ledger is slow or the process is paused, and a replacement is then
 * free to acquire and start shifting. An unconditional `update` there marked the
 * replacement's live edit skipped, cleared the token out from under it and put
 * the project back as if nothing were running — the same three writes the
 * pre-flight fence exists to stop, arriving one lease later.
 *
 * Hence the identical `WHERE` to `markStructuralPageLeaseApplied`, in Postgres
 * time rather than the caller's: this delivery's own unexpired token on a row it
 * still holds ACTIVE. Zero rows means a replacement owns the edit, and the
 * caller must write nothing at all — not the marker, not the project's status.
 *
 * The classifier comes back from the same statement because it is what the
 * caller merges the marker onto, and this UPDATE is what takes the row's write
 * lock: reading it separately is reading a copy the lock does not cover.
 */
export async function settleSkippedStructuralPageLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<{ classifier: unknown } | null> {
  const rows = await tx.$queryRawUnsafe<Array<{ classifier: unknown }>>(
    `UPDATE "BookEditOperation"
       SET "status" = 'APPLIED',
           "affectedPageIndexes" = '{}'::integer[],
           "appliedAt" = CURRENT_TIMESTAMP,
           "structuralLeaseToken" = NULL,
           "structuralLeaseExpiresAt" = NULL,
           "structuralLeaseCompletedAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" = 'ACTIVE'
     RETURNING "classifier"`,
    operationId,
    ownerToken
  );
  return rows[0] ?? null;
}

/**
 * Drops this delivery's token without completing the lease, so a redelivery can
 * take over the still-shifted stamp immediately instead of waiting out expiry.
 *
 * Completing would tell waiters there is nothing left to draft. Failing the
 * row would let `markFailed` refund it. Neither is true when rollback threw:
 * the pages are still moved, and drafting has to resume against them.
 */
export async function releaseStructuralPageLease(operationId: string, ownerToken: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseToken" = NULL,
           "structuralLeaseExpiresAt" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" = 'ACTIVE'
     RETURNING "id"`,
    operationId,
    ownerToken
  );
  return rows.length === 1;
}

/** Last durable handler write: after this, a loser has no tail to replay. */
export async function completeStructuralPageLease(operationId: string, ownerToken: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseToken" = NULL,
           "structuralLeaseExpiresAt" = NULL,
           "structuralLeaseCompletedAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "status" = 'APPLIED'
     RETURNING "id"`,
    operationId,
    ownerToken
  );
  return rows.length === 1;
}

/**
 * The rollback transaction calls this immediately after its Project root lock.
 * Its returned row proves the lease is both this delivery's and still live,
 * and the UPDATE holds that proof locked until the whole revert commits.
 */
export async function renewStructuralPageLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<{ classifier: unknown; status: string; generationJobId: string | null } | null> {
  const rows = await tx.$queryRawUnsafe<Array<{
    classifier: unknown;
    status: string;
    generationJobId: string | null;
  }>>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 millisecond'),
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" IN ('ACTIVE', 'APPLIED')
     RETURNING "classifier", "status", "generationJobId"`,
    operationId,
    ownerToken,
    STRUCTURAL_PAGE_LEASE_MS
  );
  return rows[0] ?? null;
}

export class StructuralPageLeaseLostError extends Error {
  constructor() {
    super("Structural page edit delivery lost its durable lease");
    this.name = "StructuralPageLeaseLostError";
  }
}

export function isStructuralPageLeaseLostError(error: unknown): error is StructuralPageLeaseLostError {
  return error instanceof StructuralPageLeaseLostError;
}

/**
 * Heartbeats through provider waits and offers explicit barriers before writes.
 *
 * The shared chain only ever *resolves*. A renewal that threw is handed to the
 * caller that asked for it and left off the chain, because a rejected link runs
 * none of the `then`s queued behind it: one database blip used to mean no later
 * renewal was even attempted, every barrier re-threw that one stale error, and
 * `stop()` re-threw it from inside the `catch`/`finally` that called it —
 * replacing the drafting failure the handler was actually settling. So an
 * explicit barrier really does attempt a fresh renewal and may succeed;
 * database expiry remains the ownership authority, and only `lost` — a renewal
 * the database itself refused — is permanent, because that is real takeover.
 * Background ticks keep swallowing and logging, and `stop()` is teardown: it
 * never throws, so awaiting it can never mask the caller's own error.
 */
export function startStructuralPageLeaseHeartbeat(operationId: string, ownerToken: string): {
  assertHeld: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();
  const renew = (background: boolean): Promise<void> => {
    // Per attempt, so one failure belongs to the barrier that asked for it and
    // not to the chain every later renewal is queued behind.
    let failure: { error: unknown } | null = null;
    renewal = renewal.then(async () => {
      if (stopped || lost) return;
      lost = !(await renewStructuralPageLease(operationId, ownerToken));
    }).catch((error: unknown) => {
      failure = { error };
      // A timer outage is not proof of takeover, so the tick only says so.
      if (background) console.error(`Failed to heartbeat structural edit ${operationId}`, error);
    });
    const attempt = renewal;
    if (background) return attempt;
    return attempt.then(() => {
      const failed: { error: unknown } | null = failure;
      if (failed) throw failed.error;
    });
  };
  const timer = setInterval(() => void renew(true), STRUCTURAL_PAGE_LEASE_RENEW_MS);
  timer.unref();
  return {
    assertHeld: async () => {
      await renew(false);
      if (lost) throw new StructuralPageLeaseLostError();
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // Teardown is total: the chain above cannot reject, and this keeps that
      // guarantee local to the caller awaiting it from a failure path.
      await renewal.catch((error: unknown) => {
        console.error(`Failed to settle structural edit heartbeat ${operationId}`, error);
      });
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
