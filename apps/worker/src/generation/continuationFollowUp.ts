import { invalidateProjectExports } from "./bookHelpers.js";
import {
  assertTextEditLeaseTx,
  completeTextEditLease,
  releaseTextEditTailLease,
  startTextEditLeaseHeartbeat,
  waitForTextEditLeaseCompletion
} from "./textEditLease.js";
import { maybeEnqueueCompile, type CompileDispatchOutcome } from "../runtime/dispatch.js";
import { UnownedTextEditDeliveryError, type JobCompletion } from "../runtime/jobTypes.js";
import {
  completeOrWaitPublicationTailLease,
  publicationTailCompletion
} from "./publicationTailCompletion.js";
import {
  CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY,
  compilePublicationPolicyFromPayload,
  jsonPayloadToRecord,
  type SettledProjectStatus
} from "@book-maker/core";
import { MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS, Prisma, prisma } from "@book-maker/db";

const CONTINUATION_FOLLOW_UP_STEPS = ["exports", "compile", "status"] as const;
type ContinuationFollowUpStep = (typeof CONTINUATION_FOLLOW_UP_STEPS)[number];

export type ContinuationFollowUpIdentity = {
  projectId: string;
  operationId: string;
  planVersionId: string;
  publicationRevision: number;
  fallbackStatus: SettledProjectStatus;
};

type ContinuationFollowUpState = Omit<ContinuationFollowUpIdentity, "projectId" | "operationId"> & {
  completedSteps: ContinuationFollowUpStep[];
  compileOutcome?: CompileDispatchOutcome | undefined;
  updatedAt: string;
};

/** Stamps the replay identity in the same transaction as the appended manuscript. */
export function continuationFollowUpClassifier(
  classifier: unknown,
  identity: ContinuationFollowUpIdentity
): Prisma.InputJsonObject {
  return {
    ...jsonPayloadToRecord(classifier),
    [CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]: {
      planVersionId: identity.planVersionId,
      publicationRevision: identity.publicationRevision,
      fallbackStatus: identity.fallbackStatus,
      completedSteps: [],
      updatedAt: new Date().toISOString()
    }
  } as Prisma.InputJsonObject;
}

/** Reconstructs the immutable tail identity from an APPLIED operation row. */
export function continuationFollowUpIdentityFromClassifier(
  classifier: unknown,
  scope: Pick<ContinuationFollowUpIdentity, "projectId" | "operationId">
): ContinuationFollowUpIdentity | null {
  const value = jsonPayloadToRecord(
    jsonPayloadToRecord(classifier)[CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]
  );
  if (
    typeof value.planVersionId !== "string" ||
    value.planVersionId.length === 0 ||
    typeof value.publicationRevision !== "number" ||
    !Number.isInteger(value.publicationRevision) ||
    (value.fallbackStatus !== "COMPLETE" && value.fallbackStatus !== "REVIEW_REQUIRED")
  ) {
    return null;
  }
  return {
    ...scope,
    planVersionId: value.planVersionId,
    publicationRevision: value.publicationRevision,
    fallbackStatus: value.fallbackStatus
  };
}

/**
 * Owns the only work allowed after continuation publication. The manuscript,
 * operation, job, and attempt are already terminal; a failure releases only
 * this APPLIED tail so Bull can replay the first missing checkpoint.
 *
 * `durableCompletionCommitted: false` is how a caller says the opposite of all
 * that. Only `publishContinuation` settles the durable job and its paid attempt
 * inside the manuscript transaction, so only a tail built from *its* checkpoint
 * may claim the lifecycle is already committed. A continuation published by the
 * pre-checkpoint worker marked the operation APPLIED and nothing else: claiming
 * its lifecycle skips `markCompleted`, which leaves the GenerationJob ACTIVE
 * (the project reads busy for good) and the paid GenerationAttempt ACTIVE — so
 * the next `stopProjectGenerationJobs` refunds a delivered, published
 * continuation. `applyBookEdit` passes `!legacy` here for the same reason.
 */
export function continuationFollowUpCompletion(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string,
  options?: { durableCompletionCommitted?: boolean | undefined }
): JobCompletion {
  return publicationTailCompletion(
    {
      startHeartbeat: () => startTextEditLeaseHeartbeat(identity.operationId, ownerToken),
      run: (assertHeld) => runContinuationFollowUp(identity, ownerToken, assertHeld),
      completeLease: () =>
        completeOrWaitPublicationTailLease({
          complete: () => completeTextEditLease(identity.operationId, ownerToken),
          wait: () => waitForTextEditLeaseCompletion(identity.operationId),
          unowned: new UnownedTextEditDeliveryError()
        }),
      invalidateExports: () =>
        invalidateOwnedContinuationExports(identity, ownerToken).then(() => undefined),
      releaseLease: () => releaseTextEditTailLease(identity.operationId, ownerToken),
      abandonExportBarrier: () => abandonContinuationExportBarrier(identity),
      reportFailure: (phase, error) => {
        if (phase === "follow-up") {
          console.error("Continuation post-publication follow-up failed", {
            event: "generation.continuation_follow_up_failed",
            projectId: identity.projectId,
            operationId: identity.operationId,
            error
          });
          return;
        }
        console.error("Could not release failed continuation follow-up lease", {
          event: "generation.continuation_follow_up_release_failed",
          operationId: identity.operationId,
          error
        });
      }
    },
    { durableCompletionCommitted: options?.durableCompletionCommitted }
  );
}

async function runContinuationFollowUp(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string,
  assertLease: () => Promise<void>
): Promise<void> {
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: identity.operationId },
    select: { classifier: true }
  });
  let state = continuationFollowUpState(operation?.classifier, identity);
  const completed = new Set(state.completedSteps);

  if (!completed.has("exports")) {
    await assertLease();
    const outcome = await invalidateOwnedContinuationExports(identity, ownerToken);
    if (outcome === "superseded") return;
    completed.add("exports");
    state = { ...state, completedSteps: orderedSteps(completed) };
  }

  if (!completed.has("compile")) {
    // Every step re-asks, because a replay may resume here: the exports step's
    // own check said nothing about a project that moved while this tail was
    // being redelivered. `replanFollowUp.ts` asks before each of its four.
    if (!(await continuationFollowUpStillCurrent(identity, ownerToken))) return;
    await assertLease();
    let compileOutcome: CompileDispatchOutcome;
    try {
      compileOutcome = await maybeEnqueueCompile(
        identity.projectId,
        identity.planVersionId,
        compilePublicationPolicyFromPayload({ exportPublicationProjectStatus: "EDITING" }),
        { contentRevision: identity.publicationRevision, requireContentRevisionMatch: true }
      );
    } catch (error) {
      // The chapters are committed and the old exports are already unlinked.
      // Throwing only retries a delivered continuation until Bull's two tail
      // attempts are spent, and the `status` step behind this one never runs —
      // so the book keeps its published chapters, loses its exports and sits
      // EDITING with no COMPILE_EXPORT row, waiting on the delayed stranded
      // sweep. An enqueue outage is the same answer a fan-in that declines to
      // queue gives, so settle it the same way. `textEditFollowUp.ts` degrades
      // here for this incident.
      console.error(`Failed to enqueue the export refresh for continued project ${identity.projectId}:`, error);
      compileOutcome = "not-ready";
    }
    await checkpointContinuationFollowUp(identity, ownerToken, "compile", compileOutcome);
    completed.add("compile");
    state = { ...state, completedSteps: orderedSteps(completed), compileOutcome };
  }

  if (!completed.has("status")) {
    if (!(await continuationFollowUpStillCurrent(identity, ownerToken))) return;
    await assertLease();
    await settleContinuationHandoffStatus(identity, ownerToken, state.compileOutcome);
  }
}

/** Delete only exports belonging to the exact revision this APPLIED tail owns. */
async function invalidateOwnedContinuationExports(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string
): Promise<"invalidated" | "superseded"> {
  const claim = await claimContinuationExportBarrier(identity, ownerToken);
  if (claim === "superseded") return "superseded";
  if (claim !== identity.publicationRevision) {
    // Null means this tail's unlink already committed and only its checkpoint
    // was lost, or an attempt that gave up retired the barrier early. Either
    // way a compile may have installed files under those names since, and they
    // are not this tail's to delete. A different revision belongs to a newer
    // tail and may not be touched at all.
    if (claim === null) await checkpointContinuationFollowUp(identity, ownerToken, "exports");
    return "invalidated";
  }
  // Filesystem work deliberately runs after the transaction commits, the rule
  // `textEditFollowUp.ts` states. Project is the root of the edit lock order,
  // so unlinking five files under it holds Stop and every concurrent
  // publication for as long as the storage mount takes — and an unlink that
  // outruns the 30 s budget raises P2028, rolling the checkpoint back after
  // the files are already gone. The barrier claimed above is what holds the
  // window shut instead: every export publisher stands down against it.
  await invalidateProjectExports(identity.projectId);
  await retireContinuationExportBarrier(identity, ownerToken);
  return "invalidated";
}

/**
 * This tail's own barrier, read under the same lock that proves it still owns
 * the publication. `publishContinuation` stamps it with the revision it created
 * in the manuscript transaction, so a compile claiming that revision stands
 * down for the whole gap between the commit and the unlink below.
 */
async function claimContinuationExportBarrier(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string
): Promise<number | null | "superseded"> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } },
      select: {
        contentRevision: true,
        currentPlanId: true,
        status: true,
        exportInvalidationRevision: true
      }
    });
    const owned = await assertTextEditLeaseTx(tx, identity.operationId, ownerToken);
    if (owned.status !== "APPLIED") throw new Error("Continuation follow-up no longer owns an APPLIED edit");
    if (
      project.contentRevision !== identity.publicationRevision ||
      project.currentPlanId !== identity.planVersionId ||
      project.status !== "EDITING"
    ) {
      return "superseded";
    }
    return project.exportInvalidationRevision;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

/** Clears only this publication's barrier, in the transaction that checkpoints the unlink. */
async function retireContinuationExportBarrier(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } }
    });
    const owned = await assertTextEditLeaseTx(tx, identity.operationId, ownerToken);
    if (owned.status !== "APPLIED") throw new Error("Continuation follow-up no longer owns an APPLIED edit");
    await tx.project.updateMany({
      where: {
        id: identity.projectId,
        exportInvalidationRevision: identity.publicationRevision
      },
      data: { exportInvalidationRevision: null }
    });
    await writeContinuationCheckpoint(tx, owned.classifier, identity, "exports");
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

/**
 * Retire the barrier with neither the lease nor a finished unlink behind it.
 *
 * A value left standing is the one revision every later reader of this book
 * claims, so it refuses `publishCompiledExports`, `publishRebuiltExport` and
 * the on-demand provenance repair for this project until this operation's lease
 * expires and the delayed stranded-generation sweep may retire it. `status` is
 * sequenced after `exports`, so the project never leaves EDITING either, which
 * puts it out of reach of `ensureExportRepairQueued` as well. Clearing early is
 * the cheap direction: it costs a stale export standing
 * until the recompile replaces it, where a stranded one costs the book.
 */
async function abandonContinuationExportBarrier(
  identity: ContinuationFollowUpIdentity
): Promise<void> {
  await prisma.project.updateMany({
    where: {
      id: identity.projectId,
      exportInvalidationRevision: identity.publicationRevision
    },
    data: { exportInvalidationRevision: null }
  });
}

/** Whether this exact APPLIED tail still owns the project's publication window. */
async function continuationFollowUpStillCurrent(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { contentRevision: true, currentPlanId: true, status: true }
    });
    const owned = await assertTextEditLeaseTx(tx, identity.operationId, ownerToken);
    if (owned.status !== "APPLIED") throw new Error("Continuation follow-up no longer owns an APPLIED edit");
    return (
      project.contentRevision === identity.publicationRevision &&
      project.currentPlanId === identity.planVersionId &&
      project.status === "EDITING"
    );
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function checkpointContinuationFollowUp(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string,
  step: ContinuationFollowUpStep,
  compileOutcome?: CompileDispatchOutcome
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const owned = await assertTextEditLeaseTx(tx, identity.operationId, ownerToken);
    if (owned.status !== "APPLIED") throw new Error("Continuation follow-up no longer owns an APPLIED edit");
    await writeContinuationCheckpoint(tx, owned.classifier, identity, step, compileOutcome);
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function settleContinuationHandoffStatus(
  identity: ContinuationFollowUpIdentity,
  ownerToken: string,
  compileOutcome: CompileDispatchOutcome | undefined
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Project -> operation is the same root lock order used by publication,
    // stop, and export publication. A not-ready handoff exposes the settled
    // book only after its stale files are gone, so on-demand repair owns it.
    await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { contentRevision: true }
    });
    const owned = await assertTextEditLeaseTx(tx, identity.operationId, ownerToken);
    if (owned.status !== "APPLIED") throw new Error("Continuation follow-up no longer owns an APPLIED edit");
    if (compileOutcome === "not-ready" && !(await newerEditOwnsTheProject(tx, identity))) {
      await tx.project.updateMany({
        where: {
          id: identity.projectId,
          // The revision alone does not name this publication: a structural
          // shift installs its own plan version before the transaction that
          // bumps the revision, and this handler's own legacy cleanup restores
          // the base plan without bumping at all. Both siblings scope on the
          // plan for that reason, so a stale tail cannot take a project it no
          // longer owns out of EDITING into its remembered status.
          currentPlanId: identity.planVersionId,
          status: "EDITING",
          contentRevision: identity.publicationRevision
        },
        data: { status: identity.fallbackStatus }
      });
    }
    await writeContinuationCheckpoint(tx, owned.classifier, identity, "status");
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

/**
 * Whether a *newer* edit already owns the project's EDITING.
 *
 * The revision and the plan version are still this publication's values while a
 * successor is drafting: an edit takes the project EDITING before it rewrites a
 * page and bumps the revision only once it publishes. And the successor can be
 * there — this tail's durable job was marked COMPLETED inside the publication
 * transaction, so `hasOpenProjectWork` already answers "no open work" and the
 * reader may start the next edit while this tail is still running. A
 * `not-ready` restore then tells the app the book is settled over a rewrite in
 * flight, and `ensureExportRepairQueued` — which takes exactly the two statuses
 * this write installs — can compile the manuscript the successor is halfway
 * through replacing.
 *
 * `BookEditOperation_one_open_per_project` is what makes the test exact rather
 * than a recency guess: at most one QUEUED/ACTIVE operation exists per project,
 * and this tail's own row is APPLIED, so an open row is somebody else's live
 * edit and the EDITING on the project is theirs. Leaving it alone strands
 * nothing — the successor settles the project when it publishes, and one that
 * fails restores it through the same fallback. Deliberately not
 * `restoreEditProjectStatus`: its `laterLifecycle` clause refuses when any
 * GenerationJob is newer than `appliedAt`, which a compile queued by an earlier
 * attempt of this very tail is, and that would strand the project EDITING.
 */
async function newerEditOwnsTheProject(
  tx: Prisma.TransactionClient,
  identity: ContinuationFollowUpIdentity
): Promise<boolean> {
  return (
    (await tx.bookEditOperation.count({
      where: {
        projectId: identity.projectId,
        id: { not: identity.operationId },
        status: { in: ["QUEUED", "ACTIVE"] }
      }
    })) > 0
  );
}

async function writeContinuationCheckpoint(
  tx: Prisma.TransactionClient,
  classifier: unknown,
  identity: ContinuationFollowUpIdentity,
  step: ContinuationFollowUpStep,
  compileOutcome?: CompileDispatchOutcome
): Promise<void> {
  const root = jsonPayloadToRecord(classifier);
  const state = continuationFollowUpState(classifier, identity);
  const completed = new Set(state.completedSteps);
  completed.add(step);
  await tx.bookEditOperation.update({
    where: { id: identity.operationId },
    data: {
      classifier: {
        ...root,
        [CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]: {
          ...state,
          completedSteps: orderedSteps(completed),
          ...(compileOutcome ? { compileOutcome } : {}),
          updatedAt: new Date().toISOString()
        }
      } as Prisma.InputJsonValue
    }
  });
}

function continuationFollowUpState(
  classifier: unknown,
  identity: ContinuationFollowUpIdentity
): ContinuationFollowUpState {
  const value = jsonPayloadToRecord(
    jsonPayloadToRecord(classifier)[CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]
  );
  const completed = Array.isArray(value.completedSteps) ? value.completedSteps : [];
  const state: ContinuationFollowUpState = {
    planVersionId: String(value.planVersionId ?? ""),
    publicationRevision: Number(value.publicationRevision),
    fallbackStatus: value.fallbackStatus === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE",
    completedSteps: completed.filter(
      (step): step is ContinuationFollowUpStep =>
        typeof step === "string" && CONTINUATION_FOLLOW_UP_STEPS.includes(step as ContinuationFollowUpStep)
    ),
    ...(isCompileDispatchOutcome(value.compileOutcome) ? { compileOutcome: value.compileOutcome } : {}),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
  if (
    state.planVersionId !== identity.planVersionId ||
    state.publicationRevision !== identity.publicationRevision ||
    state.fallbackStatus !== identity.fallbackStatus
  ) {
    throw new Error("Continuation follow-up identity is missing or does not match its publication");
  }
  return state;
}

function orderedSteps(completed: ReadonlySet<ContinuationFollowUpStep>): ContinuationFollowUpStep[] {
  return CONTINUATION_FOLLOW_UP_STEPS.filter((step) => completed.has(step));
}

function isCompileDispatchOutcome(value: unknown): value is CompileDispatchOutcome {
  return value === "compile" || value === "waiting" || value === "not-ready" || value === "settled";
}
