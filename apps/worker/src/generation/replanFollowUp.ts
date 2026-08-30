import { invalidateProjectExports } from "./bookHelpers.js";
import { ensureCharacterReferenceAssets } from "./characterReferences.js";
import {
  assertReplanEditLeaseTx,
  completeReplanEditLease,
  releaseReplanEditTailLease,
  ReplanEditLeaseLostError,
  startReplanEditTailLeaseHeartbeat,
  waitForReplanEditLeaseCompletion
} from "./replanEditLease.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { maybeEnqueueRevisionOwnedReplanCover } from "./replanCoverDispatch.js";
import { UnownedReplanDeliveryError, type JobCompletion } from "../runtime/jobTypes.js";
import {
  compilePublicationPolicyFromPayload,
  jsonPayloadToRecord,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ProviderSet
} from "@book-maker/core";
import { MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS, Prisma, prisma } from "@book-maker/db";
import {
  completeOrWaitPublicationTailLease,
  publicationTailCompletion
} from "./publicationTailCompletion.js";

const REPLAN_FOLLOW_UP_STEPS = ["exports", "characters", "cover", "compile"] as const;
type ReplanFollowUpStep = (typeof REPLAN_FOLLOW_UP_STEPS)[number];
const REPLAN_FOLLOW_UP_CLASSIFIER_KEY = "replanFollowUp";

export type ReplanFollowUpIdentity = {
  projectId: string;
  operationId: string;
  planVersionId: string;
  publicationRevision: number;
};

type ReplanFollowUpState = Omit<ReplanFollowUpIdentity, "projectId" | "operationId"> & {
  completedSteps: ReplanFollowUpStep[];
  updatedAt: string;
};

type ReplanFollowUpOptions = {
  projectId: string;
  planId: string;
  operationId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
};

/** Stamps the immutable tail identity in the manuscript publication transaction. */
export function replanFollowUpClassifier(
  classifier: unknown,
  identity: ReplanFollowUpIdentity
): Prisma.InputJsonObject {
  return {
    ...jsonPayloadToRecord(classifier),
    [REPLAN_FOLLOW_UP_CLASSIFIER_KEY]: {
      planVersionId: identity.planVersionId,
      publicationRevision: identity.publicationRevision,
      completedSteps: [],
      updatedAt: new Date().toISOString()
    }
  } as Prisma.InputJsonObject;
}

export function replanFollowUpIdentityFromClassifier(
  classifier: unknown,
  scope: Pick<ReplanFollowUpIdentity, "projectId" | "operationId">
): ReplanFollowUpIdentity | null {
  const state = jsonPayloadToRecord(jsonPayloadToRecord(classifier)[REPLAN_FOLLOW_UP_CLASSIFIER_KEY]);
  if (
    typeof state.planVersionId !== "string" ||
    !state.planVersionId ||
    typeof state.publicationRevision !== "number" ||
    !Number.isInteger(state.publicationRevision)
  ) {
    return null;
  }
  return { ...scope, planVersionId: state.planVersionId, publicationRevision: state.publicationRevision };
}

export function replannedBookFollowUpCompletion(
  options: ReplanFollowUpOptions,
  identity: ReplanFollowUpIdentity,
  ownerToken: string
): JobCompletion {
  return publicationTailCompletion({
    startHeartbeat: () => startReplanEditTailLeaseHeartbeat(identity, ownerToken),
    run: (assertHeld) => replannedBookFollowUp(options, identity, ownerToken, assertHeld),
    completeLease: () =>
      completeOrWaitPublicationTailLease({
        complete: () => completeReplanEditLease(identity, ownerToken),
        wait: () => waitForReplanEditLeaseCompletion(identity.operationId),
        unowned: new UnownedReplanDeliveryError()
      }),
    invalidateExports: () =>
      invalidateOwnedReplanExports(identity, ownerToken).then(() => undefined),
    releaseLease: () => releaseReplanEditTailLease(identity, ownerToken),
    abandonExportBarrier: () => abandonReplanExportBarrier(identity),
    reportFailure: (phase, error) => {
      if (phase === "follow-up") {
        console.error("Replan post-publication follow-up failed", {
          event: "generation.replan_follow_up_failed",
          operationId: options.operationId,
          projectId: options.projectId,
          error
        });
        return;
      }
      console.error("Could not release failed replan follow-up lease", {
        event: "generation.replan_follow_up_release_failed",
        operationId: options.operationId,
        error
      });
    }
  });
}

async function replannedBookFollowUp(
  options: ReplanFollowUpOptions,
  identity: ReplanFollowUpIdentity,
  ownerToken: string,
  assertLease: () => Promise<void>
): Promise<void> {
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: options.operationId },
    select: { classifier: true }
  });
  const completed = new Set(replanFollowUpState(operation?.classifier, identity).completedSteps);

  if (!completed.has("exports")) {
    if ((await invalidateOwnedReplanExports(identity, ownerToken)) === "superseded") return;
    completed.add("exports");
  }

  if (!completed.has("characters")) {
    if (!(await replanFollowUpStillOwned(identity, ownerToken))) return;
    await assertLease();
    await ensureCharacterReferenceAssets(options);
    if ((await checkpointReplanFollowUp(identity, ownerToken, "characters")) === "superseded") return;
    completed.add("characters");
  }

  if (!completed.has("cover")) {
    if (!(await replanFollowUpStillOwned(identity, ownerToken))) return;
    await assertLease();
    await maybeEnqueueRevisionOwnedReplanCover(options.projectId, identity.planVersionId, options.input, {
      contentRevision: identity.publicationRevision,
      expectedProjectStatus: "EDITING",
      requireContentRevisionMatch: true
    });
    if ((await checkpointReplanFollowUp(identity, ownerToken, "cover")) === "superseded") return;
    completed.add("cover");
  }

  if (!completed.has("compile")) {
    if (!(await replanFollowUpStillOwned(identity, ownerToken))) return;
    await assertLease();
    let compileOutcome: "compile" | "waiting" | "not-ready" | "settled";
    try {
      compileOutcome = await maybeEnqueueCompile(
        options.projectId,
        identity.planVersionId,
        compilePublicationPolicyFromPayload({ exportPublicationProjectStatus: "EDITING" }),
        {
          contentRevision: identity.publicationRevision,
          requireContentRevisionMatch: true
        }
      );
    } catch (error) {
      // The replanned manuscript is committed and the old exports are already
      // unlinked. Throwing only retries a delivered replan until Bull's two
      // tail attempts are spent, and the status restore inside this step's own
      // checkpoint never runs — leaving the book EDITING with its exports gone
      // and no COMPILE_EXPORT row. An enqueue outage is the same answer a
      // fan-in that declines to queue gives, so settle it the same way, as
      // `textEditFollowUp.ts` does.
      console.error(`Failed to enqueue the export refresh for replanned project ${options.projectId}:`, error);
      compileOutcome = "not-ready";
    }
    await checkpointReplanFollowUp(identity, ownerToken, "compile", compileOutcome);
  }
}

function replanFollowUpState(classifier: unknown, identity: ReplanFollowUpIdentity): ReplanFollowUpState {
  const state = jsonPayloadToRecord(jsonPayloadToRecord(classifier)[REPLAN_FOLLOW_UP_CLASSIFIER_KEY]);
  const completed = Array.isArray(state.completedSteps) ? state.completedSteps : [];
  if (state.planVersionId !== identity.planVersionId || state.publicationRevision !== identity.publicationRevision) {
    throw new ReplanEditLeaseLostError();
  }
  return {
    planVersionId: identity.planVersionId,
    publicationRevision: identity.publicationRevision,
    completedSteps: completed.filter((step): step is ReplanFollowUpStep =>
      typeof step === "string" && REPLAN_FOLLOW_UP_STEPS.includes(step as ReplanFollowUpStep)
    ),
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date(0).toISOString()
  };
}

async function invalidateOwnedReplanExports(
  identity: ReplanFollowUpIdentity,
  ownerToken: string
): Promise<"invalidated" | "superseded"> {
  // `publishReplannedBook` stamps the barrier with the revision it created, in
  // the manuscript transaction, so a compile claiming that revision stands down
  // for the whole gap between the commit and the unlink below. It is read here
  // under the same lock that proves this tail still owns the publication.
  const claim = await prisma.$transaction(async (tx) => {
    const ownership = await lockAndAssertReplanFollowUp(tx, identity, ownerToken);
    return ownership === "superseded" ? "superseded" : ownership.exportInvalidationRevision;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
  if (claim === "superseded") return "superseded";
  if (claim !== identity.publicationRevision) {
    // Null means this tail's unlink already committed and only its checkpoint
    // was lost, or an attempt that gave up retired the barrier early. Either
    // way a compile may have installed files under those names since, and they
    // are not this tail's to delete. A different revision belongs to a newer
    // tail and may not be touched at all.
    if (claim === null && (await checkpointReplanFollowUp(identity, ownerToken, "exports")) === "superseded") {
      return "superseded";
    }
    return "invalidated";
  }
  // Filesystem work deliberately runs after the transaction commits, the rule
  // `textEditFollowUp.ts` states. Project is the root of the edit lock order,
  // so unlinking five files under it holds Stop and every concurrent
  // publication for as long as the storage mount takes — and an unlink that
  // outruns the 30 s budget raises P2028, rolling the checkpoint back after
  // the files are already gone. The barrier claimed above is what holds the
  // window shut instead.
  await invalidateProjectExports(identity.projectId);
  return (await checkpointReplanFollowUp(identity, ownerToken, "exports")) === "superseded"
    ? "superseded"
    : "invalidated";
}

/**
 * Retire the barrier with neither the lease nor a finished unlink behind it.
 *
 * A value left standing is the one revision every later reader of this book
 * claims, so it refuses `publishCompiledExports`, `publishRebuiltExport` and
 * the on-demand provenance repair for this project until this operation's lease
 * expires and the delayed stranded-generation sweep may retire it. Clearing
 * early costs a stale export standing until the recompile replaces it; a
 * stranded one costs the book.
 */
async function abandonReplanExportBarrier(identity: ReplanFollowUpIdentity): Promise<void> {
  await prisma.project.updateMany({
    where: {
      id: identity.projectId,
      exportInvalidationRevision: identity.publicationRevision
    },
    data: { exportInvalidationRevision: null }
  });
}

async function replanFollowUpStillOwned(identity: ReplanFollowUpIdentity, ownerToken: string): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => (await lockAndAssertReplanFollowUp(tx, identity, ownerToken)) !== "superseded",
    MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS
  );
}

async function checkpointReplanFollowUp(
  identity: ReplanFollowUpIdentity,
  ownerToken: string,
  step: ReplanFollowUpStep,
  compileOutcome?: "compile" | "waiting" | "not-ready" | "settled"
): Promise<"checkpointed" | "superseded"> {
  return prisma.$transaction(async (tx) => {
    const ownership = await lockAndAssertReplanFollowUp(tx, identity, ownerToken);
    if (ownership === "superseded") return "superseded";
    if (
      step === "compile" &&
      compileOutcome === "not-ready" &&
      !(await newerEditOwnsTheProject(tx, identity))
    ) {
      await tx.project.updateMany({
        where: {
          id: identity.projectId,
          currentPlanId: identity.planVersionId,
          contentRevision: identity.publicationRevision,
          status: "EDITING"
        },
        data: { status: "REVIEW_REQUIRED" }
      });
    }
    if (step === "exports") {
      // Only this publication's own barrier, and only once its unlink is done.
      await tx.project.updateMany({
        where: {
          id: identity.projectId,
          exportInvalidationRevision: identity.publicationRevision
        },
        data: { exportInvalidationRevision: null }
      });
    }
    await writeReplanFollowUpCheckpoint(tx, ownership.classifier, identity, step);
    return "checkpointed";
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
  identity: ReplanFollowUpIdentity
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

async function lockAndAssertReplanFollowUp(
  tx: Prisma.TransactionClient,
  identity: ReplanFollowUpIdentity,
  ownerToken: string
): Promise<{ classifier: unknown; exportInvalidationRevision: number | null } | "superseded"> {
  const project = await tx.project.update({
    where: { id: identity.projectId },
    data: { contentRevision: { increment: 0 } },
    select: {
      currentPlanId: true,
      contentRevision: true,
      status: true,
      exportInvalidationRevision: true
    }
  });
  const owned = await assertReplanEditLeaseTx(tx, identity.operationId, ownerToken);
  if (owned.status !== "APPLIED") throw new ReplanEditLeaseLostError();
  replanFollowUpState(owned.classifier, identity);
  if (
    project.currentPlanId !== identity.planVersionId ||
    project.contentRevision !== identity.publicationRevision ||
    project.status !== "EDITING"
  ) {
    return "superseded";
  }
  return { classifier: owned.classifier, exportInvalidationRevision: project.exportInvalidationRevision };
}

async function writeReplanFollowUpCheckpoint(
  tx: Prisma.TransactionClient,
  classifier: unknown,
  identity: ReplanFollowUpIdentity,
  step: ReplanFollowUpStep
): Promise<void> {
  const root = jsonPayloadToRecord(classifier);
  const state = replanFollowUpState(classifier, identity);
  const completed = new Set(state.completedSteps);
  completed.add(step);
  await tx.bookEditOperation.update({
    where: { id: identity.operationId },
    data: {
      classifier: {
        ...root,
        [REPLAN_FOLLOW_UP_CLASSIFIER_KEY]: {
          planVersionId: identity.planVersionId,
          publicationRevision: identity.publicationRevision,
          completedSteps: REPLAN_FOLLOW_UP_STEPS.filter((candidate) => completed.has(candidate)),
          updatedAt: new Date().toISOString()
        }
      } as Prisma.InputJsonValue
    }
  });
}
