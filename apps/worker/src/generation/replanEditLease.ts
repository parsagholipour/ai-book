import {
  isStructuralPageLeaseLostError,
  renewStructuralPageLeaseTx,
  startStructuralPageLeaseHeartbeat,
  STRUCTURAL_PAGE_LEASE_MS,
  StructuralPageLeaseLostError,
  waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion
} from "./structuralPageLease.js";
import { prisma, type Prisma } from "@book-maker/db";

export type ReplanStagingLeaseOperation = {
  id: string;
  projectId: string;
  sourceProjectId: string | null;
  generationJobId: string | null;
  status: string;
  request: string;
  editInstruction: string | null;
  characterContext: string | null;
  classifier: unknown;
};

type ReplanStagingLeaseKey = {
  operationId: string;
  generationJobId: string;
  ownerToken: string;
};

const REPLAN_STAGING_RETURNING = `RETURNING "id", "projectId", "sourceProjectId", "generationJobId", "status",
           "request", "editInstruction", "characterContext", "classifier"`;

/**
 * Claims the provider-call/enqueue staging fork after its caller has locked
 * Project then predecessor GenerationJob. PostgreSQL time is the only clock in
 * the takeover decision and in the new expiry stamp.
 */
export async function acquireReplanStagingLeaseTx(
  tx: Prisma.TransactionClient,
  options: ReplanStagingLeaseKey
): Promise<ReplanStagingLeaseOperation | null> {
  const rows = await tx.$queryRawUnsafe<ReplanStagingLeaseOperation[]>(
    `UPDATE "BookEditOperation"
       SET "status" = 'ACTIVE'::"BookEditOperationStatus",
           "structuralLeaseToken" = $3,
           "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($4::double precision * INTERVAL '1 millisecond'),
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "generationJobId" = $2
       AND "kind" = 'BOOK_REPLAN'::"BookEditOperationKind"
       AND "status" IN ('QUEUED', 'ACTIVE')
       AND "structuralLeaseCompletedAt" IS NULL
       AND (
         "structuralLeaseToken" IS NULL
         OR "structuralLeaseExpiresAt" IS NULL
         OR "structuralLeaseExpiresAt" <= CURRENT_TIMESTAMP
         OR "structuralLeaseToken" = $3
       )
     ${REPLAN_STAGING_RETURNING}`,
    options.operationId,
    options.generationJobId,
    options.ownerToken,
    STRUCTURAL_PAGE_LEASE_MS
  );
  return rows[0] ?? null;
}

/** Renews and locks only the exact still-live staging owner. */
export async function renewReplanStagingLeaseTx(
  tx: Prisma.TransactionClient,
  options: ReplanStagingLeaseKey
): Promise<ReplanStagingLeaseOperation | null> {
  const rows = await tx.$queryRawUnsafe<ReplanStagingLeaseOperation[]>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($4::double precision * INTERVAL '1 millisecond'),
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "generationJobId" = $2
       AND "kind" = 'BOOK_REPLAN'::"BookEditOperationKind"
       AND "status" = 'ACTIVE'
       AND "structuralLeaseToken" = $3
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
     ${REPLAN_STAGING_RETURNING}`,
    options.operationId,
    options.generationJobId,
    options.ownerToken,
    STRUCTURAL_PAGE_LEASE_MS
  );
  return rows[0] ?? null;
}

/**
 * Releases only the exact, unexpired owner. Callers may change generationJobId
 * earlier in the same transaction, so they pass the durable value on the row
 * at the point of release.
 */
export async function releaseReplanStagingLeaseTx(
  tx: Prisma.TransactionClient,
  options: ReplanStagingLeaseKey
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseToken" = NULL,
           "structuralLeaseExpiresAt" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "generationJobId" = $2
       AND "kind" = 'BOOK_REPLAN'::"BookEditOperationKind"
       AND "status" = 'ACTIVE'
       AND "structuralLeaseToken" = $3
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
     RETURNING "id"`,
    options.operationId,
    options.generationJobId,
    options.ownerToken
  );
  return rows.length === 1;
}

/**
 * A replan's successor GENERATE_BOOK delivery owns the same operation-level
 * lease columns as the edit that staged it. The names on those columns are
 * historical: one BookEditOperation has only one manuscript-writing fork, so
 * a replan can safely use the durable database-time lease without adding a
 * second, independently claimable owner to the row.
 */
export type ReplanEditLeaseClaim =
  | { outcome: "acquired"; phase: "draft" | "tail" }
  | { outcome: "completed" }
  | { outcome: "settled" }
  | { outcome: "abandoned" };

export async function waitForReplanEditLease(
  operationId: string,
  ownerToken: string,
  tailIdentity?: ReplanTailLeaseIdentity | null
): Promise<ReplanEditLeaseClaim> {
  const claim = await waitForStructuralPageLease(operationId, ownerToken);
  if (claim.outcome !== "acquired") return { outcome: claim.outcome };
  if (claim.phase === "tail" && tailIdentity) {
    const exact = await prisma.$transaction(async (tx) => {
      const project = await tx.project.update({
        where: { id: tailIdentity.projectId },
        data: { contentRevision: { increment: 0 } },
        select: { currentPlanId: true, contentRevision: true, status: true }
      });
      const owned = await assertReplanEditLeaseTx(tx, operationId, ownerToken);
      if (
        owned.status === "APPLIED" &&
        project.currentPlanId === tailIdentity.planVersionId &&
        project.contentRevision === tailIdentity.publicationRevision &&
        project.status === "EDITING"
      ) {
        return true;
      }
      // The ordinary answer here is supersession: the project has moved past
      // this publication, so the tail is stamped complete and no redelivery
      // replays it. A zero-row CAS is not that verdict — the row this delivery
      // holds is not the APPLIED publication the identity names — and claiming
      // it anyway would say "somebody finished this tail" about a marker that
      // was never written, which is what every stand-down then polls for.
      const completed = await tx.bookEditOperation.updateMany({
        where: {
          id: operationId,
          publicationRevision: tailIdentity.publicationRevision,
          status: "APPLIED",
          structuralLeaseToken: ownerToken,
          structuralLeaseCompletedAt: null
        },
        data: {
          structuralLeaseToken: null,
          structuralLeaseExpiresAt: null,
          structuralLeaseCompletedAt: new Date()
        }
      });
      if (completed.count === 0) {
        // Hand the lease back instead. `assertReplanEditLeaseTx` above renewed
        // it to a fresh expiry and nothing heartbeats it once this returns, so
        // a held token would make every rival delivery of this operation wait
        // out three minutes for an owner that has already gone home — and a
        // row that is not APPLIED becomes claimable for drafting again.
        await tx.bookEditOperation.updateMany({
          where: { id: operationId, structuralLeaseToken: ownerToken, structuralLeaseCompletedAt: null },
          data: { structuralLeaseToken: null, structuralLeaseExpiresAt: null }
        });
        console.error("Replan tail lease released without a completion marker", {
          event: "generation.replan_tail_completion_missed",
          operationId,
          operationStatus: owned.status,
          publicationRevision: tailIdentity.publicationRevision
        });
      }
      return false;
    });
    if (!exact) return { outcome: "completed" };
  }
  return { outcome: "acquired", phase: claim.phase };
}

export const startReplanEditLeaseHeartbeat = startStructuralPageLeaseHeartbeat;
export const waitForReplanEditLeaseCompletion = waitForStructuralPageLeaseCompletion;
export const isReplanEditLeaseLostError = isStructuralPageLeaseLostError;
export { StructuralPageLeaseLostError as ReplanEditLeaseLostError };

type ReplanTailLeaseIdentity = {
  projectId: string;
  operationId: string;
  planVersionId: string;
  publicationRevision: number;
};

/**
 * Renews only while this operation still owns the publication it named.
 *
 * The plan version and the revision are that ownership: a later edit takes both
 * away, and neither moves under the tail's own feet. `Project.status` is
 * deliberately **not** part of it, even though the tail may only *work* while
 * the project is EDITING — because the tail's last step is what takes EDITING
 * away. `checkpointReplanFollowUp(..., "compile", "not-ready")` moves the
 * project to REVIEW_REQUIRED inside that step, so a fence on EDITING made every
 * heartbeat tick after it report a lease that was never lost, and left the tail
 * unrenewed for the whole of the publication-tail complete-or-wait — including
 * the fifteen-minute `waitForReplanEditLeaseCompletion` it can enter. The steps
 * themselves still hold that status: `lockAndAssertReplanFollowUp` re-reads it
 * under a Project lock and answers `superseded`, which is a clean early return
 * rather than a lease-lost throw.
 */
async function renewReplanEditTailLease(
  identity: ReplanTailLeaseIdentity,
  ownerToken: string
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($6::double precision * INTERVAL '1 millisecond'),
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "publicationRevision" = $4
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" = 'APPLIED'
       AND EXISTS (
         SELECT 1 FROM "Project"
          WHERE "Project"."id" = $3
            AND "Project"."currentPlanId" = $5
            AND "Project"."contentRevision" = $4
       )
     RETURNING "id"`,
    identity.operationId,
    ownerToken,
    identity.projectId,
    identity.publicationRevision,
    identity.planVersionId,
    STRUCTURAL_PAGE_LEASE_MS
  );
  return rows.length === 1;
}

/** Heartbeats only while the operation still owns its exact published project revision. */
export function startReplanEditTailLeaseHeartbeat(
  identity: ReplanTailLeaseIdentity,
  ownerToken: string
): { assertHeld: () => Promise<void>; stop: () => Promise<void> } {
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();
  const renew = (background: boolean): Promise<void> => {
    let failure: { error: unknown } | null = null;
    renewal = renewal.then(async () => {
      if (stopped || lost) return;
      lost = !(await renewReplanEditTailLease(identity, ownerToken));
    }).catch((error: unknown) => {
      failure = { error };
      if (background) console.error(`Failed to heartbeat replan tail ${identity.operationId}`, error);
    });
    if (background) return renewal;
    return renewal.then(() => {
      const failed: { error: unknown } | null = failure;
      if (failed) throw failed.error;
    });
  };
  const timer = setInterval(() => void renew(true), STRUCTURAL_PAGE_LEASE_MS / 3);
  timer.unref();
  return {
    assertHeld: async () => {
      await renew(false);
      if (lost) throw new StructuralPageLeaseLostError();
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await renewal.catch((error: unknown) => {
        console.error(`Failed to settle replan tail heartbeat ${identity.operationId}`, error);
      });
    }
  };
}

/**
 * Releases an APPLIED replan tail after a checkpointed follow-up fails. The
 * manuscript verdict is immutable; clearing only this exact owner's token lets
 * Bull redelivery retry the first missing tail step immediately.
 *
 * Fenced exactly like `completeReplanEditLease` and for its reason, because the
 * two are the same sentence with opposite verbs: this delivery is done with the
 * tail, and the current project may already be newer. A release is a *giving
 * up*, so it must succeed on precisely the rows a completion would — the
 * operation's own `publicationRevision`, its APPLIED status and this token pin
 * the publication by themselves, and a project predicate on top of them only
 * decides which failures leave a dead token behind. It left one on every path
 * out of the publication-tail complete-or-wait that reaches the caller's catch after
 * the compile step has already put the project in REVIEW_REQUIRED: zero rows
 * matched, the token stayed pinned for the rest of its three-minute TTL, and
 * every rival delivery waited that out for an owner that had gone home.
 */
export async function releaseReplanEditTailLease(
  identity: ReplanTailLeaseIdentity,
  ownerToken: string
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseToken" = NULL,
           "structuralLeaseExpiresAt" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "publicationRevision" = $3
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" = 'APPLIED'
     RETURNING "id"`,
    identity.operationId,
    ownerToken,
    identity.publicationRevision
  );
  return rows.length === 1;
}

/**
 * Completes only the exact APPLIED publication tail. The current project may
 * already be newer: in that case this write is the durable superseded marker,
 * and deliberately touches neither that manuscript nor its exports.
 */
export async function completeReplanEditLease(
  identity: ReplanTailLeaseIdentity,
  ownerToken: string
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "BookEditOperation"
       SET "structuralLeaseToken" = NULL,
           "structuralLeaseExpiresAt" = NULL,
           "structuralLeaseCompletedAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "publicationRevision" = $3
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" = 'APPLIED'
     RETURNING "id"`,
    identity.operationId,
    ownerToken,
    identity.publicationRevision
  );
  return rows.length === 1;
}

/**
 * Renew and lock the exact still-live owner before a replan transaction writes.
 * A publication transaction locks Project first; operation-only audit writes
 * may begin here because they never wait on Project while holding this row.
 */
export async function assertReplanEditLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<{ classifier: unknown; status: string }> {
  const owned = await renewStructuralPageLeaseTx(tx, operationId, ownerToken);
  if (!owned) throw new StructuralPageLeaseLostError();
  return owned;
}
