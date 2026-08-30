import { jsonPayloadToRecord, type SettledProjectStatus } from "@book-maker/core";
import {
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS,
  Prisma,
  prisma
} from "@book-maker/db";
import { randomUUID } from "node:crypto";
import { invalidateProjectExports } from "./bookHelpers.js";
import { runBestEffortPageMemoryWrite } from "./bestEffortSavepoint.js";
import { restoreEditProjectStatus } from "./editProjectStatus.js";
import {
  assertTextEditLeaseTx,
  completeTextEditLease,
  releaseTextEditTailLease,
  startTextEditLeaseHeartbeat,
  waitForTextEditLeaseCompletion
} from "./textEditLease.js";
import { maybeEnqueueCompile, type CompileDispatchOutcome } from "../runtime/dispatch.js";
import { UnownedTextEditDeliveryError, type JobCompletion } from "../runtime/jobTypes.js";
import type { PreparedEmbedding } from "./embeddingWrites.js";
import {
  completeOrWaitPublicationTailLease,
  publicationTailCompletion
} from "./publicationTailCompletion.js";

/**
 * The replayable work an applied text edit still owes after its manuscript
 * transaction commits: retiring the old exports, publishing the page memory,
 * queueing the recompile and settling the project status. Each step is
 * checkpointed on the operation's classifier, so a redelivery resumes rather
 * than repeats — the sibling of `replanFollowUp.ts` and `continuationFollowUp.ts`
 * for the text-edit fork. It left `textEditPublication.ts` when that file
 * reached its size budget; its suite is still the `text edit publication
 * follow-up` block in `textEditPublication.test.ts`.
 */
const FOLLOW_UP_KEY = "textEditFollowUp";
const FOLLOW_UP_STEPS = ["exports", "memory", "compile", "status"] as const;
type FollowUpStep = (typeof FOLLOW_UP_STEPS)[number];

export type TextEditPublicationIdentity = {
  projectId: string;
  operationId: string;
  planVersionId: string;
  publicationRevision: number;
  fallbackStatus: SettledProjectStatus;
};

type FollowUpState = Omit<TextEditPublicationIdentity, "projectId" | "operationId"> & {
  completedSteps: FollowUpStep[];
  compileOutcome?: CompileDispatchOutcome | undefined;
  updatedAt: string;
};

export type TextEditMemoryEntry = {
  pageId: string;
  pageIndex: number;
  pageRevision: number;
  summary: string;
  preparedEmbedding: PreparedEmbedding;
};

/** Whether a replay must re-prepare embeddings before constructing its tail. */
export function textEditTailNeedsMemory(classifier: unknown): boolean {
  const value = jsonPayloadToRecord(jsonPayloadToRecord(classifier)[FOLLOW_UP_KEY]);
  const completed = Array.isArray(value.completedSteps) ? value.completedSteps : [];
  return !completed.includes("memory");
}

export function textEditPublicationIdentity(
  classifier: unknown,
  scope: Pick<TextEditPublicationIdentity, "projectId" | "operationId">
): TextEditPublicationIdentity | null {
  const value = jsonPayloadToRecord(jsonPayloadToRecord(classifier)[FOLLOW_UP_KEY]);
  if (
    typeof value.planVersionId !== "string" ||
    !value.planVersionId ||
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

/** Builds the replayable work run after the durable job/manuscript commit. */
export function textEditPublicationCompletion(options: {
  identity: TextEditPublicationIdentity;
  ownerToken: string;
  memory: readonly TextEditMemoryEntry[] | (() => Promise<readonly TextEditMemoryEntry[]>);
  durableCompletionCommitted?: boolean | undefined;
}): JobCompletion {
  return publicationTailCompletion(
    {
      startHeartbeat: () =>
        startTextEditLeaseHeartbeat(options.identity.operationId, options.ownerToken),
      run: (assertHeld) =>
        runFollowUp(options.identity, options.ownerToken, options.memory, assertHeld),
      completeLease: () =>
        completeOrWaitPublicationTailLease({
          complete: () => completeTextEditLease(options.identity.operationId, options.ownerToken),
          wait: () => waitForTextEditLeaseCompletion(options.identity.operationId),
          unowned: new UnownedTextEditDeliveryError()
        }),
      invalidateExports: () =>
        invalidateRevisionOwnedExports(options.identity, options.ownerToken).then(() => undefined),
      releaseLease: () =>
        releaseTextEditTailLease(options.identity.operationId, options.ownerToken),
      abandonExportBarrier: () => abandonRevisionExportBarrier(options.identity)
    },
    { durableCompletionCommitted: options.durableCompletionCommitted }
  );
}

async function runFollowUp(
  identity: TextEditPublicationIdentity,
  ownerToken: string,
  memory: readonly TextEditMemoryEntry[] | (() => Promise<readonly TextEditMemoryEntry[]>),
  assertLease: () => Promise<void>
): Promise<void> {
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: identity.operationId },
    select: { classifier: true }
  });
  let state = followUpState(operation?.classifier, identity);
  const completed = new Set(state.completedSteps);

  if (!completed.has("exports")) {
    await assertLease();
    await invalidateRevisionOwnedExports(identity, ownerToken);
    completed.add("exports");
    state = { ...state, completedSteps: orderedSteps(completed) };
  }
  if (!(await followUpStillCurrent(identity, ownerToken))) return;

  if (!completed.has("memory")) {
    await assertLease();
    const preparedMemory = typeof memory === "function" ? await memory() : memory;
    // Only supersession stands the tail down here. The optional memory write
    // declining is not that, and the compile behind it is not optional.
    if (!(await publishRevisionOwnedMemory(identity, ownerToken, preparedMemory))) return;
    completed.add("memory");
    state = { ...state, completedSteps: orderedSteps(completed) };
  }

  if (!completed.has("compile")) {
    await assertLease();
    let compileOutcome: CompileDispatchOutcome;
    try {
      compileOutcome = await maybeEnqueueCompile(
        identity.projectId,
        identity.planVersionId,
        { skipFinalReview: true },
        { contentRevision: identity.publicationRevision, requireContentRevisionMatch: true }
      );
    } catch (error) {
      // The manuscript is committed and the old exports are already retired.
      // Throwing here only retries a delivered edit until Bull gives up, and
      // the job stays COMPLETED after that — leaving the book EDITING with no
      // compile behind it and no repair lane, because that lane only runs for
      // settled projects. An enqueue outage is the same answer a fan-in that
      // declines to queue gives, so settle it the same way.
      console.error(`Failed to enqueue the export refresh for edited project ${identity.projectId}:`, error);
      compileOutcome = "not-ready";
    }
    if (!(await checkpointCurrentFollowUp(identity, ownerToken, "compile", compileOutcome))) return;
    completed.add("compile");
    state = { ...state, completedSteps: orderedSteps(completed), compileOutcome };
  }

  if (!completed.has("status")) {
    await settleTailStatus(identity, ownerToken, state.compileOutcome);
  }
}

/**
 * One ask, three facts: this delivery still holds the lease, the row it holds
 * is still the APPLIED publication this is the tail of, and the checkpoint on
 * that row still describes this identity.
 *
 * The status half is not decoration. `assertTextEditLeaseTx` delegates to the
 * lease CAS the drafting fork shares, which deliberately admits
 * `status IN ('ACTIVE','APPLIED')` — so a tail asking only "is the lease mine"
 * would keep writing checkpoints over an operation that is no longer the one it
 * published. Both siblings name the status for the same reason
 * (`continuationFollowUp.ts`, `replanFollowUp.ts`).
 */
async function assertAppliedTailTx(
  tx: Prisma.TransactionClient,
  identity: TextEditPublicationIdentity,
  ownerToken: string
): Promise<unknown> {
  const owned = await assertTextEditLeaseTx(tx, identity.operationId, ownerToken);
  if (owned.status !== "APPLIED") {
    throw new Error("Text edit follow-up no longer owns an APPLIED edit");
  }
  followUpState(owned.classifier, identity);
  return owned.classifier;
}

/**
 * The half of publishing that is not the revision bump.
 *
 * Every publication that commits a manuscript and only *then* unlinks the
 * shared `book.md`/`book.pdf`/`book.epub` owes the gap between those two facts
 * a barrier, or a compile claiming the revision that was just published
 * installs a book this tail then deletes. It is one statement rather than a
 * fused `UPDATE` so that a publication cannot express the bump without having
 * something to call for the stamp: only the text-edit fork stamps one today,
 * while `continuationFollowUp.ts`, `replanFollowUp.ts` and the structural fork
 * all unlink post-commit with nothing holding that window shut. A caller runs
 * it inside the same transaction as its own `contentRevision` bump — that
 * statement already holds the Project row's write lock, so the two are atomic
 * together and no reader sees a revision without its barrier.
 */
export async function stampExportInvalidationBarrierTx(
  tx: Prisma.TransactionClient,
  projectId: string,
  publicationRevision: number
): Promise<void> {
  await tx.project.update({
    where: { id: projectId },
    data: { exportInvalidationRevision: publicationRevision }
  });
}

/**
 * Retire this publication's barrier with neither the lease, a transaction, nor
 * a finished unlink behind it.
 *
 * The barrier is stamped as the revision the publication *created*, which is
 * the revision every later reader of this book claims — so a value left
 * standing is not the older-revision case the readers deliberately tolerate.
 * It is the one value that refuses `publishCompiledExports`,
 * `publishRebuiltExport` and the on-demand provenance repair for this project,
 * and the ordinary retry window can end before the database accepts a clear.
 * `status` is sequenced after `exports`, so the project also never leaves
 * EDITING, which puts it out of reach of `ensureExportRepairQueued` as well.
 * The delayed stranded-generation sweep is the final recovery, after this
 * operation's lease is no longer live.
 *
 * Clearing it early is the cheap direction. The barrier only has to hold until
 * this tail's unlink is done, and a tail that has given up will not unlink
 * again — `invalidateRevisionOwnedExports` reads the column first and reads a
 * null as "already retired", so every later delivery checkpoints the step
 * rather than deleting files a compile may since have installed. A premature
 * clear costs a stale export standing until the recompile replaces it; a
 * stranded one costs the book. What makes it safe against a live successor is
 * the caller's ordering: only a delivery whose own lease release just succeeded
 * abandons the barrier.
 */
async function abandonRevisionExportBarrier(
  identity: TextEditPublicationIdentity
): Promise<void> {
  await prisma.project.updateMany({
    where: {
      id: identity.projectId,
      exportInvalidationRevision: identity.publicationRevision
    },
    data: { exportInvalidationRevision: null }
  });
}

/**
 * Filesystem work deliberately runs after the first transaction commits. The
 * Project barrier blocks all compilers meanwhile, so a newer edit can replace
 * the barrier but no newer artifact set can appear under the shared filenames
 * before this unlink finishes.
 */
async function invalidateRevisionOwnedExports(
  identity: TextEditPublicationIdentity,
  ownerToken: string
): Promise<void> {
  const claim = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { exportInvalidationRevision: true }
    });
    await assertAppliedTailTx(tx, identity, ownerToken);
    return project.exportInvalidationRevision;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
  if (claim !== identity.publicationRevision) {
    // Null means the unlink committed and only its checkpoint was lost. A
    // different revision belongs to a newer tail and may not be touched.
    if (claim === null) {
      await checkpointFollowUp(identity, ownerToken, "exports");
    }
    return;
  }

  await invalidateProjectExports(identity.projectId);
  await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } }
    });
    const classifier = await assertAppliedTailTx(tx, identity, ownerToken);
    await tx.project.updateMany({
      where: {
        id: identity.projectId,
        exportInvalidationRevision: identity.publicationRevision
      },
      data: { exportInvalidationRevision: null }
    });
    await writeCheckpoint(tx, classifier, identity, "exports");
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function publishRevisionOwnedMemory(
  identity: TextEditPublicationIdentity,
  ownerToken: string,
  memory: readonly TextEditMemoryEntry[]
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { contentRevision: true, currentPlanId: true, status: true }
    });
    const classifier = await assertAppliedTailTx(tx, identity, ownerToken);
    if (
      project.contentRevision !== identity.publicationRevision ||
      project.currentPlanId !== identity.planVersionId ||
      project.status !== "EDITING"
    ) {
      return false;
    }
    if (memory.length > 0) {
      const exact = await tx.page.count({
        where: {
          projectId: identity.projectId,
          OR: memory.map((entry) => ({
            id: entry.pageId,
            index: entry.pageIndex,
            revision: entry.pageRevision,
            summary: entry.summary
          }))
        }
      });
      // A page that no longer reads as the one these embeddings were prepared
      // from must not be described by them. It may not stop the tail either:
      // `false` is the caller's word for "a newer edit owns this project", and
      // spelling a fingerprint miss that way skipped the compile and the status
      // restore behind it while the tail lease still completed — exports
      // already unlinked, the book left EDITING at the published revision with
      // no compile behind it and every redelivery standing down. Skipping the
      // write leaves an ordinary embedding hole, which `repairPageEmbeddings`
      // backfills.
      if (exact === memory.length) {
        await writeBulkEmbeddings(tx, identity.projectId, memory);
      } else {
        console.warn("Text edit tail skipped semantic memory for pages that no longer match it", {
          event: "generation.text_edit_tail_memory_unverified",
          projectId: identity.projectId,
          operationId: identity.operationId,
          expected: memory.length,
          matched: exact
        });
      }
    }
    await writeCheckpoint(tx, classifier, identity, "memory");
    return true;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function writeBulkEmbeddings(
  tx: Prisma.TransactionClient,
  projectId: string,
  memory: readonly TextEditMemoryEntry[]
): Promise<void> {
  const rows = memory.map((entry) => ({
    id: randomUUID(),
    page_id: entry.pageId,
    scope: `page:${entry.pageIndex}`,
    summary: entry.summary,
    vector_literal: entry.preparedEmbedding.vectorLiteral,
    error: entry.preparedEmbedding.error
  }));
  const vectorRows = rows.filter((row) => row.vector_literal !== null);
  let vectorStored = true;
  if (vectorRows.length > 0) {
    vectorStored = (await runBestEffortPageMemoryWrite(tx, async () => {
      const stored = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
             id text, page_id text, scope text, summary text, vector_literal text
           )
         ), written AS (
           INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "vector", "metadata")
           SELECT id, $1, scope, page_id, summary, vector_literal::vector,
                  jsonb_build_object('provider', 'text-edit-tail')
             FROM input
           ON CONFLICT ("projectId", "scope") DO UPDATE SET
             "sourceId" = EXCLUDED."sourceId", "text" = EXCLUDED."text",
             "vector" = EXCLUDED."vector", "metadata" = EXCLUDED."metadata"
           RETURNING "id"
         ) SELECT count(*)::integer AS count FROM written`,
        projectId,
        JSON.stringify(vectorRows)
      );
      if (stored[0]?.count !== vectorRows.length) {
        throw new Error("Text edit embedding tail did not store every vector");
      }
      return true;
    })) === true;
  }

  const degradedRows = rows
    .filter((row) => row.vector_literal === null || !vectorStored)
    .map((row) => ({
      ...row,
      error: row.error ?? "Bulk vector persistence unavailable"
    }));
  if (degradedRows.length === 0) return;
  await runBestEffortPageMemoryWrite(tx, () =>
    tx.$executeRawUnsafe(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
           id text, page_id text, scope text, summary text, error text
         )
       )
       INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "metadata")
       SELECT id, $1, scope, page_id, summary,
              jsonb_build_object('vectorStored', false, 'error', error)
         FROM input
       ON CONFLICT ("projectId", "scope") DO UPDATE SET
         "sourceId" = EXCLUDED."sourceId", "text" = EXCLUDED."text",
         "metadata" = EXCLUDED."metadata"
       WHERE "Embedding"."vector" IS NULL`,
      projectId,
      JSON.stringify(degradedRows)
    )
  );
}

async function followUpStillCurrent(
  identity: TextEditPublicationIdentity,
  ownerToken: string
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { contentRevision: true, currentPlanId: true, status: true }
    });
    await assertAppliedTailTx(tx, identity, ownerToken);
    return project.contentRevision === identity.publicationRevision &&
      project.currentPlanId === identity.planVersionId &&
      project.status === "EDITING";
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function checkpointCurrentFollowUp(
  identity: TextEditPublicationIdentity,
  ownerToken: string,
  step: FollowUpStep,
  compileOutcome?: CompileDispatchOutcome
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: identity.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { contentRevision: true, currentPlanId: true, status: true }
    });
    const classifier = await assertAppliedTailTx(tx, identity, ownerToken);
    if (
      project.contentRevision !== identity.publicationRevision ||
      project.currentPlanId !== identity.planVersionId ||
      project.status !== "EDITING"
    ) return false;
    await writeCheckpoint(tx, classifier, identity, step, compileOutcome);
    return true;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function checkpointFollowUp(
  identity: TextEditPublicationIdentity,
  ownerToken: string,
  step: FollowUpStep
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const classifier = await assertAppliedTailTx(tx, identity, ownerToken);
    await writeCheckpoint(tx, classifier, identity, step);
  });
}

async function settleTailStatus(
  identity: TextEditPublicationIdentity,
  ownerToken: string,
  compileOutcome: CompileDispatchOutcome | undefined
): Promise<void> {
  await prisma.$transaction(async (tx) => {
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
    const classifier = await assertAppliedTailTx(tx, identity, ownerToken);
    // The exact publication values exclude a completed or superseded tail. The
    // shared restore then supplies the other half of ownership: a successor may
    // have taken EDITING before advancing the revision, and presentation work
    // may own the lifecycle without creating a BookEditOperation at all.
    if (
      compileOutcome === "not-ready" &&
      project.status === "EDITING" &&
      project.contentRevision === identity.publicationRevision &&
      project.currentPlanId === identity.planVersionId &&
      project.exportInvalidationRevision === null
    ) {
      await restoreEditProjectStatus(
        tx,
        identity.projectId,
        identity.operationId,
        identity.fallbackStatus
      );
    }
    await writeCheckpoint(tx, classifier, identity, "status");
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function writeCheckpoint(
  tx: Prisma.TransactionClient,
  classifier: unknown,
  identity: TextEditPublicationIdentity,
  step: FollowUpStep,
  compileOutcome?: CompileDispatchOutcome
): Promise<void> {
  const state = followUpState(classifier, identity);
  const completed = new Set(state.completedSteps);
  completed.add(step);
  await tx.bookEditOperation.update({
    where: { id: identity.operationId },
    data: {
      classifier: followUpClassifier(
        classifier,
        identity,
        orderedSteps(completed),
        compileOutcome ?? state.compileOutcome
      ) as Prisma.InputJsonValue
    }
  });
}

/** Also the publication's own first classifier write, and the legacy adoption's. */
export function followUpClassifier(
  classifier: unknown,
  identity: TextEditPublicationIdentity,
  completedSteps: FollowUpStep[],
  compileOutcome?: CompileDispatchOutcome
): Prisma.InputJsonObject {
  return {
    ...jsonPayloadToRecord(classifier),
    [FOLLOW_UP_KEY]: {
      planVersionId: identity.planVersionId,
      publicationRevision: identity.publicationRevision,
      fallbackStatus: identity.fallbackStatus,
      completedSteps,
      ...(compileOutcome ? { compileOutcome } : {}),
      updatedAt: new Date().toISOString()
    }
  } as Prisma.InputJsonObject;
}

function followUpState(classifier: unknown, identity: TextEditPublicationIdentity): FollowUpState {
  const value = jsonPayloadToRecord(jsonPayloadToRecord(classifier)[FOLLOW_UP_KEY]);
  const completed = Array.isArray(value.completedSteps) ? value.completedSteps : [];
  const state: FollowUpState = {
    planVersionId: String(value.planVersionId ?? ""),
    publicationRevision: Number(value.publicationRevision),
    fallbackStatus: value.fallbackStatus === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE",
    completedSteps: completed.filter(
      (step): step is FollowUpStep =>
        typeof step === "string" && FOLLOW_UP_STEPS.includes(step as FollowUpStep)
    ),
    ...(isCompileOutcome(value.compileOutcome) ? { compileOutcome: value.compileOutcome } : {}),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
  if (
    state.planVersionId !== identity.planVersionId ||
    state.publicationRevision !== identity.publicationRevision ||
    state.fallbackStatus !== identity.fallbackStatus
  ) {
    throw new Error("Text edit follow-up identity does not match its APPLIED publication");
  }
  return state;
}

function orderedSteps(completed: ReadonlySet<FollowUpStep>): FollowUpStep[] {
  return FOLLOW_UP_STEPS.filter((step) => completed.has(step));
}

function isCompileOutcome(value: unknown): value is CompileDispatchOutcome {
  return value === "compile" || value === "waiting" || value === "not-ready" || value === "settled";
}
