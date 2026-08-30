import { getProjectOrThrow, invalidateProjectExports, strategyForInput } from "../generation/bookHelpers.js";
import { claimEditOperationForDelivery } from "../generation/editOperationDelivery.js";
import { applyStructuralPageChange } from "../generation/pageRestructure.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { resolveEditPromptContext } from "../generation/editOperationContext.js";
import {
  rebuildProjectStoryState,
  rebuildRolledBackProjectStoryState
} from "../generation/storyStateStore.js";
import {
  completeStructuralPageLease,
  isStructuralPageLeaseLostError,
  markStructuralPageLeaseApplied,
  startStructuralPageLeaseHeartbeat,
  waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion,
  type StructuralPageLeaseWait
} from "../generation/structuralPageLease.js";
import {
  draftInsertedPages,
  publishDraftedInsertedPages,
  type DraftedInsertedPages
} from "./restructurePagesDrafting.js";
import { queueRestructureCompile, replayAppliedRestructure } from "./restructurePagesPublication.js";
import { redeliverUnrevertedStructuralEdit } from "./restructurePagesRedelivery.js";
import { settleSkippedRestructure } from "./restructurePagesSettlement.js";
import { guardCompoundStructuralDelivery } from "./restructurePagesCompoundGuard.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { failedEditOperationData } from "@book-maker/core/editFailure";
import { UnownedStructuralDeliveryError, type JobCompletion } from "../runtime/jobTypes.js";
import {
  bookPlanSchema,
  createProviders,
  jsonRecord,
  parseStructuralApplication,
  preEditProjectStatus,
  resolveStructuralPageEdit,
  structuralEditFromClassifier,
  type SettledProjectStatus,
  type StructuralApplication
} from "@book-maker/core";
import {
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS,
  compensateStructuralPageChangeTx,
  prisma,
  type StructuralCompensationResult
} from "@book-maker/db";
import type { ApplyBookEditJob } from "../runtime/jobPayloads.js";
import { randomUUID } from "node:crypto";

/**
 * The structural fork of `apply-book-edit`: insert, delete or reorder pages.
 *
 * It is a fork rather than a job type of its own because everything a new type
 * would buy — attempt settlement, the resume predicate, the progress step
 * labels, the failure message, the queue-name map — already covers
 * `APPLY_BOOK_EDIT`, while a new one would need an entry in eight
 * cross-workspace lists that do not typecheck against each other.
 *
 * Its own file for the reason the two image forks have theirs: this owns a
 * transaction, a redelivery fence and a rollback that the text path does not.
 */

export async function restructurePages(
  job: ApplyBookEditJob,
  operation: {
    id: string;
    status: string;
    classifier: unknown;
    request?: string | null;
    editInstruction?: string | null;
    characterContext?: string | null;
  }
): Promise<JobCompletion> {
  const { projectId, operationId, request, planId, structuralEdit, generationJobId, attemptId } = job.data;
  // Never job.id/generationJobId: a stalled Bull delivery and its replacement
  // share both. This token identifies one invocation of this handler.
  const ownerToken = randomUUID();
  // What the two paths below that settle the book themselves put it back down
  // in. It is not readable from here at all: the Apply writes EDITING in the
  // same committed transaction as this job's row, so the project already says
  // EDITING before the first delivery starts — reading it "before the handler's
  // own EDITING write" only moved the dead code, and a book with open quality
  // findings still came out of a restructure looking finished. A redelivery has
  // it worse still, because the first delivery leaves EDITING on purpose.
  const fallbackStatus = preEditProjectStatus(job.data);
  // Whether the EDITING write below is what *moved* the project, which is the
  // only thing an abandoning path may put back. Declared up here so the two
  // stand-downs above it read `false` honestly: neither has written anything.
  let claimedEditing = false;

  // --- The other terminal row: an edit the reader has already taken back ----
  // Not a skipped edit — this one *did* shift the book, and the undo put it
  // back, keeping `structuralApplication` as the record of what it did. So the
  // stamp a redelivery reads still says "the shift landed" while the shape it
  // describes is gone, and every path that opens is wrong: the export tail
  // deletes the PDF the undo's own recompile just published and bumps
  // `contentRevision` past the revision that compile is waiting to claim,
  // drafting writes into page ids the undo deleted, and a settlement rewrites
  // the classifier `undoneAt` lives on. Nothing is owed — the undo did the
  // book's bookkeeping, recompile included — so this delivery stops here.
  if (structuralEditWasUndone(operation.classifier)) {
    return {};
  }

  if (operation.status === "APPLIED") {
    if (typeof jsonRecord(operation.classifier).structuralSkipped === "string") {
      return {};
    }
    // APPLIED is earlier than the export tail. Claim that tail or wait for the
    // live owner to finish it; returning while it is still live would let this
    // delivery mark the shared GenerationJob COMPLETED underneath it.
    await resumeClaimedStructuralDelivery(
      await waitForStructuralPageLease(operationId, ownerToken),
      projectId,
      operationId,
      ownerToken,
      fallbackStatus,
      claimedEditing
    );
    return {};
  }
  const delivery = await claimEditOperationForDelivery(operationId);
  const stored = delivery.stored;
  // The same question of the fresher row: the copy checked above was read
  // before the claim, and an undo runs only against APPLIED — the status the
  // claim skips — so this read is the first thing that can see one that landed
  // in between.
  if (structuralEditWasUndone(stored?.classifier)) {
    return {};
  }
  if (delivery.outcome === "replay") {
    if (typeof jsonRecord(delivery.stored.classifier).structuralSkipped !== "string") {
      await resumeClaimedStructuralDelivery(
        await waitForStructuralPageLease(operationId, ownerToken),
        projectId,
        operationId,
        ownerToken,
        fallbackStatus,
        claimedEditing
      );
    }
    return {};
  }
  if (delivery.outcome === "settled") return {};
  // Conditional, and the count is the question every abandoning path below has
  // to ask: did *this* delivery take the book out of a settled status? For an
  // ordinary delivery no — the Apply wrote EDITING in the same committed
  // transaction as the job row, so the project already says EDITING and this
  // claims nothing, which is what leaves the fork that owns the edit sitting in
  // EDITING for its recompile like every other apply fork. It answers yes only
  // in the window the ACTIVE claim above cannot fence: another delivery settled
  // this edit between that statement and this one and put the book back down as
  // it found it. An unconditional write there lifted a finished book into
  // EDITING and then returned — no shift, no drafting, no compile behind it —
  // and leaves EDITING with no immediate handoff. Delayed
  // `reconcileStrandedGeneration` now covers EDITING as well as GENERATING;
  // `ensureExportRepairQueued` covers settled COMPLETE/REVIEW_REQUIRED books.
  claimedEditing = await claimProjectEditing(projectId);
  await advanceJobStep(generationJobId, "prepare", 15, "Reading the book's pages");

  const project = await getProjectOrThrow(projectId);
  const planVersion = planId
    ? await prisma.planVersion.findUnique({ where: { id: planId } })
    : project.currentPlanId
      ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId } })
      : null;
  if (!planVersion) {
    throw new Error("Current plan not found");
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const bookPlan = bookPlanSchema.parse(planVersion.planningPackage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);

  // --- The redelivery fence, read side ---------------------------------------
  // The stamp is written in the same transaction as the index shift, so its
  // presence is proof the shift already landed — and its absence is proof it
  // did not. Neither the operation's status nor the payload can say that: the
  // window between "shift committed" and "operation settled" is exactly where a
  // stalled redelivery arrives, and shifting twice would scatter the book's
  // pages with nothing able to work out where they belonged.
  //
  // It also carries the *ids* of whatever it created, so a resumed delivery
  // drafts the same rows rather than re-deriving them from indexes that have
  // since moved.
  //
  // Which is why the rollback below takes the stamp down in the same
  // transaction that puts the book back: a stamp outliving the shape it
  // describes is a redelivery that skips the shift, drafts pages nothing holds,
  // and settles a paid insert the book never received.
  //
  // This read is the *fast* path only — a delivery arriving after the one that
  // shifted has finished with the row, which is what a crashed or stalled
  // redelivery is. It cannot decide the other case, where the shift is still in
  // flight and the stamp is not visible to anybody yet, so the same question is
  // asked again under a row lock inside `applyStructuralPageChange`, and that
  // answer is the one that governs.
  const alreadyApplied = parseStructuralApplication(stored?.classifier);
  const edit = structuralEdit ?? structuralEditFromClassifier(stored?.classifier);
  const promptContext = resolveEditPromptContext(
    {
      request: stored?.request ?? operation.request,
      editInstruction: stored?.editInstruction ?? operation.editInstruction,
      characterContext: stored?.characterContext ?? operation.characterContext
    },
    job.data
  );
  await guardCompoundStructuralDelivery({
    projectId,
    operationId,
    generationJobId,
    ownerToken,
    edit,
    editInstruction: promptContext.editInstruction,
    application: alreadyApplied
  });

  let application: StructuralApplication;
  if (alreadyApplied && (await stampDescribesBook(projectId, alreadyApplied))) {
    const claim = await waitForStructuralPageLease(operationId, ownerToken);
    const resumed = await resumeClaimedStructuralDelivery(
      claim,
      projectId,
      operationId,
      ownerToken,
      fallbackStatus,
      claimedEditing
    );
    if (!resumed) return {};
    application = resumed;
  } else {
    const pages = await prisma.page.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { id: true, index: true, chapterId: true }
    });
    // The payload's copy first, the classifier's second. `applyBookEdit` forks
    // here on the operation's `kind`, so a job whose payload was rebuilt without
    // `structuralEdit` still arrives — and the Apply wrote the request onto the
    // classifier for exactly that delivery.
    if (!edit) {
      // Neither copy survived, so there is no request to resolve and no retry
      // that could find one. It settles the way a resolver refusal does rather
      // than throwing: a throw fails a book that is otherwise finished, restores
      // it COMPLETE whatever it came in as, and leaves the row recoverable, so
      // `/resume` charges again for a request that is still not there.
      console.error(
        `Structural page edit ${operationId} on project ${projectId} carries no request on its payload or its classifier`
      );
    }
    // `null` is "there was nothing to resolve", `ok: false` is the resolver's own
    // refusal — the book changed between the card and the Apply. Both settle as
    // applied with nothing done rather than failing a paid job: nothing broke,
    // and failing here marks a finished book FAILED. Whether nothing *was* done
    // is not this read's to say — see `settleRefusedRestructure`.
    const resolved = edit ? resolveStructuralPageEdit(edit, pages) : null;
    if (!resolved?.ok) {
      const reason = resolved ? resolved.reason : "missing_request";
      const resumed = await settleRefusedRestructure({
        job, projectId, operationId, ownerToken, reason, fallbackStatus, claimedEditing
      });
      if (!resumed) return {};
      application = resumed;
    } else {
      await advanceJobStep(generationJobId, "snapshot", 30, "Making room in the book");
      const result = await applyStructuralPageChange({
        projectId,
        operationId,
        request,
        plan: resolved.plan,
        bookPlan,
        input,
        basePlanVersionId: planVersion.id,
        previousTargetPages: project.targetPages,
        ownerToken
      });
      if (result.outcome === "already-applied") {
        const resumed = await resumeClaimedStructuralDelivery(
          await waitForStructuralPageLease(operationId, ownerToken),
          projectId,
          operationId,
          ownerToken,
          fallbackStatus,
          claimedEditing
        );
        if (!resumed) return {};
        application = resumed;
      } else if (result.outcome === "resumed") {
        if (result.phase === "tail") {
          await finishOwnedStructuralTail(projectId, operationId, ownerToken, fallbackStatus);
          return {};
        }
        if (!result.application) {
          throw new Error("Stamped structural edit lost its application record");
        }
        application = result.application;
      } else if (result.outcome === "completed") {
        // The lease is finished, so nothing is coming to write the status either.
        await releaseProjectEditingClaim(claimedEditing, projectId, fallbackStatus);
        return {};
      } else if (result.outcome === "settled") {
        // Another delivery finished the whole operation while this one resolved
        // its plan. Same answer as the pre-flight above: the tail is idempotent
        // for a row that shifted and destructive for one that settled a no-op, so
        // it is the marker rather than the status that decides.
        const settled = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
        if (settled?.status === "APPLIED" && typeof jsonRecord(settled.classifier).structuralSkipped !== "string") {
          await resumeClaimedStructuralDelivery(
            await waitForStructuralPageLease(operationId, ownerToken),
            projectId,
            operationId,
            ownerToken,
            fallbackStatus,
            claimedEditing
          );
          return {};
        }
        // A delivered no-op, or a row that failed or was canceled: the winner has
        // already put the book down, so the only thing left in EDITING is this
        // delivery's own write.
        await releaseProjectEditingClaim(claimedEditing, projectId, fallbackStatus);
        return {};
      } else if (result.outcome === "stale") {
        // The resolver's refusal, asked a second time under the operation row's
        // lock and against the pages the shift would actually have moved. The read
        // above happens before the plan version reads, the provider construction
        // and the transaction's own start, so a book that changed in that window
        // resolved fine here and would have shifted onto an ordering that no
        // longer names every page — a `23505`, or a hole in `1..N` that only a
        // later compile refuses. Nothing was written, so this settles exactly as
        // the refusal above does: free, marked, and the charge handed back —
        // under the lease this transaction's own claim just left on the row, so
        // a settlement that outlives it writes nothing over its replacement.
        await settleSkippedRestructure({
          job, projectId, operationId, ownerToken, reason: result.reason, fallbackStatus
        });
        return {};
      } else {
        application = result.application;
      }
    }
  }

  const heartbeat = startStructuralPageLeaseHeartbeat(operationId, ownerToken);
  const activePlanVersionId = application.newPlanVersionId ?? planVersion.id;
  let publicationRevision: number | null = null;
  try {
    const activePlanVersion = await prisma.planVersion.findUnique({ where: { id: activePlanVersionId } });
    const activeInput = activePlanVersion
      ? inputForPlanVersion(project, activePlanVersion.inputSnapshot)
      : input;
    const activePlan = activePlanVersion ? bookPlanSchema.parse(activePlanVersion.planningPackage) : bookPlan;
    const { editInstruction, characterContext } = promptContext;

    // The recorded pages are one edit. `draftInsertedPages` throws if any id
    // is missing rather than settle the survivors; `affectedPageIndexes` come
    // from what it actually wrote, which is the whole set or nothing.
    const draftedPages: DraftedInsertedPages | null =
      application.insertedPageIds.length > 0
        ? await draftInsertedPages({
            projectId,
            operationId,
            ownerToken,
            planVersionId: activePlanVersionId,
            input: activeInput,
            plan: activePlan,
            strategy,
            providers,
            insertedPageIds: application.insertedPageIds,
            editInstruction,
            ...(characterContext ? { characterContext } : {}),
            generationJobId,
            assertLease: heartbeat.assertHeld
          })
        : null;

    await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
    await heartbeat.assertHeld();
    // No partial settlement to price. The recorded page set is indivisible —
    // `draftInsertedPages` throws rather than draft a subset of it, and
    // `publishDraftedInsertedPages` writes the whole set in one transaction —
    // so an insert either delivers every page it billed or delivers none.
    // A delivery that cannot is rolled back below and refunded *whole* by
    // `markFailed`, which is why nothing here hands back a difference:
    // `refundUnwrittenEditPages` priced a partial delivery this fork can no
    // longer produce, and calling it would only ever ask for zero.
    if (draftedPages) {
      publicationRevision = await publishDraftedInsertedPages(
        {
          projectId,
          operationId,
          ownerToken,
          editInstruction,
          strategy,
          plan: activePlan
        },
        draftedPages,
        { generationJobId, attemptId }
      );
    } else {
      publicationRevision = await markStructuralPageLeaseApplied({
        projectId,
        operationId,
        ownerToken,
        affectedPageIndexes: [],
        generationJobId,
        attemptId
      });
      if (publicationRevision === null) {
        throw new Error("Structural page edit lost ownership before settlement");
      }
    }
    // After the publication, never before it: an inserted page's `storyDelta`
    // is written by `publishDraftedInsertedPages`, so a rebuild taken ahead of
    // that folds the book *without* the new prose and then leaves the new
    // pages' deltas applied last — over the pages they were inserted in front
    // of — instead of at their own index. The shift renumbered every page, so
    // the fold has to be recomputed either way; this is the order that makes it
    // the whole book. It swallows everything but a stop, and a stop this side
    // of APPLIED stands down against a durable publication rather than failing.
    await rebuildProjectStoryState(projectId, activePlan.promises ?? []);
    // Left EDITING on purpose, the way the text and image forks leave it: the
    // recompile is what takes the project back out, and until it publishes the
    // reader is still looking at the pre-edit PDF. `bookPageMapForProject`
    // keeps a behind map in force for exactly that window, so retiring EDITING
    // here refused the `pdfPageMap` the shift had just re-pointed — the reader's
    // next "page 12" fell back to a model index while printed page 12 was still
    // on screen, which is the fallback the re-point exists to prevent.
  } catch (error) {
    if (isStructuralPageLeaseLostError(error)) {
      await heartbeat.stop();
      // A wait that gave up belongs to nobody, so `markFailed` settles the half-delivered shift.
      if ((await waitForStructuralPageLeaseCompletion(operationId)) === "abandoned") throw error;
      return {};
    }
    let rollback: StructuralCompensationResult;
    try {
      rollback = await rollbackStructuralChange(projectId, operationId, ownerToken, application);
    } catch (cleanupError) {
      console.error(`Structural page edit cleanup failed for project ${projectId}`, cleanupError);
      await heartbeat.stop();
      // The revert left the shift standing, so markFailed must not run.
      return await redeliverUnrevertedStructuralEdit(projectId, operationId, ownerToken, generationJobId);
    }
    if (rollback.outcome !== "compensated") {
      await heartbeat.stop();
      await settleUncompensatedStructuralFailure(rollback, {
        projectId,
        operationId,
        ownerToken,
        generationJobId,
        error
      });
      return {};
    }
    try {
      if (!(await rebuildRolledBackProjectStoryState(projectId, rollback.currentPlanId))) {
        console.error(`Failed to restore story state after rolling back structural edit ${operationId}`);
      }
    } catch (storyStateError) {
      console.error(`Failed to restore story state after rolling back structural edit ${operationId}`, storyStateError);
    }
    // Only the window this handler settles itself: a failure past the APPLIED
    // write above is nobody else's to flip, because `failEditOperation` claims
    // QUEUED/ACTIVE and would leave an APPLIED row claiming an edit that has
    // just been reverted. A drafting failure — the ordinary one — happens with
    // the operation still ACTIVE and deliberately falls through: `markFailed`
    // claims exactly that row, flips it FAILED *and refunds it*, and claiming
    // it here first would take it out from under the refund.
    await prisma.bookEditOperation
      .updateMany({
        where: { id: operationId, status: "APPLIED" },
        // Its own claim, the shared verdict: `error` is copied onto the mobile
        // DTO, so the sentence comes from `failedEditOperationData` like every
        // other write that fails one of these rows.
        data: { ...failedEditOperationData(error), affectedPageIndexes: [] }
      })
      .catch((flipError) => {
        console.error(`Failed to mark rolled-back restructure ${operationId} FAILED`, flipError);
      });
    await heartbeat.stop();
    throw error;
  }

  // Outside the rollback on purpose — see `queueRestructureCompile`.
  if (publicationRevision === null) {
    throw new Error("Applied structural edit lost its publication revision");
  }
  try {
    await invalidateProjectExports(projectId);
    await queueRestructureCompile(
      projectId,
      activePlanVersionId,
      operationId,
      publicationRevision,
      fallbackStatus
    );
    await heartbeat.assertHeld();
    if (!(await completeStructuralPageLease(operationId, ownerToken))) {
      await waitForStructuralPageLeaseCompletion(operationId);
    }
  } catch (error) {
    if (!isStructuralPageLeaseLostError(error)) throw error;
    await waitForStructuralPageLeaseCompletion(operationId);
  } finally {
    await heartbeat.stop();
  }
  return { durableCompletionCommitted: true, lifecycleCompletionCommitted: true };
}

/** Turns a waited claim into either the drafting pointer or a finished return. */
async function resumeClaimedStructuralDelivery(
  claim: StructuralPageLeaseWait,
  projectId: string,
  operationId: string,
  ownerToken: string,
  fallbackStatus: SettledProjectStatus,
  claimedEditing: boolean
): Promise<StructuralApplication | null> {
  // Owns nothing — and must not return: that is `markCompleted` under a live owner.
  if (claim.outcome === "abandoned") throw new UnownedStructuralDeliveryError();
  if (claim.outcome === "completed" || claim.outcome === "settled") {
    // Nothing owed and nothing in flight — the tail below is the only branch
    // that goes on to write the project, so this is where an EDITING write this
    // delivery made over a settled book has to come back off.
    await releaseProjectEditingClaim(claimedEditing, projectId, fallbackStatus);
    return null;
  }
  if (claim.phase === "tail") {
    await finishOwnedStructuralTail(projectId, operationId, ownerToken, fallbackStatus);
    return null;
  }
  if (!claim.application) {
    throw new Error("Stamped structural edit lost its application record");
  }
  return claim.application;
}

/**
 * Settles a refusal the pre-flight read produced — but only once the claim
 * agrees there is nothing left to refuse.
 *
 * `resolveStructuralPageEdit` answers against a page read taken outside every
 * claim, and "the pages this request names are not in the book" is exactly what
 * a *winning* delivery leaves behind: it deleted them, or moved the indexes the
 * request was written against. Settling on that read unfenced is a second
 * delivery undoing a first one's work with three writes it has no right to — the
 * charge handed back, the row marked APPLIED with `structuralSkipped`, the book
 * put down in its pre-edit status — after which the winner's own APPLIED write
 * (`markStructuralPageLeaseApplied` claims `status = 'ACTIVE'`) fails and its
 * rollback cannot run either, because that begins by renewing the lease this
 * settlement just cleared. What is left is a shifted manuscript, the pre-edit
 * PDF with no recompile coming, a refund, and a row claiming the edit was
 * delivered as a no-op — which `operationCanUndo` refuses an Undo.
 *
 * So the lease that fences the shift, the page saves, the APPLIED write and the
 * rollback fences this too, taken *before* the refund for the reason the refund
 * comes before the APPLIED claim: neither may be spent on a door this delivery
 * might not be allowed through. Acquiring it is only half of holding it, so
 * `settleSkippedRestructure` heartbeats through the refund and swaps on the same
 * token and expiry when it writes — a lease that ran out mid-refund is a
 * replacement already shifting, and this settlement's three writes land on its
 * live edit. Owning an unstamped, unfinished row is the one
 * answer meaning "nothing has been done here"; every other is the shift's own
 * vocabulary and goes where its losers go, through
 * `resumeClaimedStructuralDelivery`. An Undo since the re-read is not a skip:
 * the winner's shift is already back, and skip-settling would refund a still-
 * ACTIVE attempt (Undo is allowed as soon as the row is APPLIED, before the
 * winner returns and `markCompleted` succeeds it) and overwrite the Undo's
 * EDITING + `contentRevision` bump with the pre-edit COMPLETE. That path
 * writes nothing, the same as the early `undoneAt` branches.
 */
async function settleRefusedRestructure(options: {
  job: ApplyBookEditJob;
  projectId: string;
  operationId: string;
  ownerToken: string;
  reason: string;
  fallbackStatus: SettledProjectStatus;
  claimedEditing: boolean;
}): Promise<StructuralApplication | null> {
  const { projectId, operationId, ownerToken, fallbackStatus, claimedEditing } = options;
  const claim = await waitForStructuralPageLease(operationId, ownerToken);
  const held = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (structuralEditWasUndone(held?.classifier)) return null;
  if (claim.outcome === "acquired" && claim.phase === "draft" && !claim.application) {
    await settleSkippedRestructure(options);
    return null;
  }
  return resumeClaimedStructuralDelivery(claim, projectId, operationId, ownerToken, fallbackStatus, claimedEditing);
}

/** Replays only the post-APPLIED work under the same durable ownership rule. */
async function finishOwnedStructuralTail(
  projectId: string,
  operationId: string,
  ownerToken: string,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  const heartbeat = startStructuralPageLeaseHeartbeat(operationId, ownerToken);
  let publicationTailFinished = false;
  try {
    await replayAppliedRestructure(projectId, operationId, ownerToken, fallbackStatus);
    publicationTailFinished = true;
    await heartbeat.assertHeld();
    if (!(await completeStructuralPageLease(operationId, ownerToken))) {
      await waitForStructuralPageLeaseCompletion(operationId);
    }
  } catch (error) {
    if (!isStructuralPageLeaseLostError(error)) throw error;
    const completed = await waitForStructuralPageLeaseCompletion(operationId);
    if (!publicationTailFinished && completed === "abandoned") throw error;
  } finally {
    await heartbeat.stop();
  }
}

/**
 * Takes the book into EDITING and says whether this delivery is what moved it.
 *
 * One statement, because that answer is the whole point: an unconditional
 * `update` cannot tell the ordinary delivery — the Apply already wrote EDITING
 * in the same committed transaction as the job row, and the recompile is what
 * takes it out again — from the one shape where this write changes anything at
 * all, which is another delivery settling this edit in the window between the
 * ACTIVE claim and here and putting the book back down as it found it. A
 * `false` answer means there is nothing here to restore, and it is what keeps
 * the fork that owns the edit leaving EDITING exactly where the text and image
 * forks leave it.
 */
async function claimProjectEditing(projectId: string): Promise<boolean> {
  const claimed = await prisma.project.updateMany({
    where: { id: projectId, status: { not: "EDITING" } },
    data: { status: "EDITING" }
  });
  return claimed.count > 0;
}

/**
 * Puts back what that claim lifted, on the paths that then do nothing at all.
 *
 * A delivery that finds the edit already owned and already finished — the lease
 * completed, the operation settled — writes no pages, invalidates no exports
 * and queues no compile, so its own EDITING write is the last thing standing
 * between the book and the status the winner had just restored. The delayed
 * stranded-generation sweep can recover EDITING once every job is terminal,
 * but that grace-period fallback is not this no-op delivery's immediate
 * handoff; `queueRestructureCompile` closes the same window on `not-ready`, and
 * this closes it here.
 *
 * Conditional on the project still being EDITING, and swallowed on failure for
 * the reason that dispatch swallows its own: this runs for an edit another
 * delivery has already delivered and paid for, and throwing would hand a
 * finished book to `markFailed` over a status write nobody is waiting on.
 */
async function releaseProjectEditingClaim(
  claimedEditing: boolean,
  projectId: string,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  if (!claimedEditing) return;
  await prisma.project
    .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: fallbackStatus } })
    .catch((error: unknown) => {
      console.error(`Failed to hand project ${projectId} back after an abandoned structural delivery`, error);
    });
}

/**
 * Puts the book back exactly as it was, so a retry starts from the original
 * shape rather than compounding a half-applied one — and takes the redelivery
 * fence down with it.
 *
 * Both halves, one transaction. The stamp says "the shift landed"; once this
 * runs it has not, so a stamp that survived the revert would send the next
 * delivery straight past the shift into drafting page ids that no longer
 * exist — every `findUnique` a miss, every miss a `continue` — and out the far
 * side marking the operation APPLIED and recompiling an unchanged book. The
 * reader pays a retry for a book that gains nothing.
 *
 * If the revert fails the stamp survives on purpose: nothing was put back, so
 * the half-applied shape is still there and resuming into drafting is exactly
 * right. The catch that reaches here requeues rather than throwing into
 * `markFailed`, which would refund the ACTIVE row and restore COMPLETE over
 * pages that are still moved.
 *
 * Ownership, revert, stamp clear, and durable completion live in one
 * `packages/db` primitive shared with API Stop. That is what serializes a Stop
 * racing this catch: both take Project first and the operation second; only the
 * exact lease token and `appliedAt` stamp this delivery received can win. Undo
 * deliberately uses the lower-level revert and keeps the stamp as its history.
 */
async function rollbackStructuralChange(
  projectId: string,
  operationId: string,
  ownerToken: string,
  application: StructuralApplication
): Promise<StructuralCompensationResult> {
  return prisma.$transaction(
    (tx) =>
      compensateStructuralPageChangeTx(tx, {
        projectId,
        operationId,
        expectedLeaseToken: ownerToken,
        expectedAppliedAt: application.appliedAt
      }),
    PAGE_RESTRUCTURE_TRANSACTION_OPTIONS
  );
}

/**
 * Where a failed delivery goes when its own rollback did not put the book back.
 *
 * One arm per outcome the compensation can hand a caller that is *not* the
 * winner, spelled as an exhaustive `switch` rather than a ladder of `if`s: a
 * sixth outcome added to `StructuralCompensationResult` has to stop compiling
 * here, because the branch it would otherwise inherit is the requeue — and
 * `redeliverWorkerGenerationJob` carries no attempt cap, so inheriting it means
 * a verdict that never changes being re-delivered forever, the charge never
 * handed back and the book never leaving EDITING.
 *
 * The requeue is therefore conditional on there being something to resume. Only
 * a compensation ever clears a stamp, and it reverts the pages in the same
 * transaction, so a row with no readable stamp is a book that is *not* shifted:
 * nothing for a redelivery to do, and `markFailed` — which this settles into by
 * rethrowing the delivery's own error — is what hands the charge back and puts
 * the project down. A stamp that is still there is the opposite fact, and the
 * one case where refunding would be a lie about a book whose pages have moved.
 * That is also the API's answer to the same shape: Stop cancels and refunds an
 * unrevertable shift rather than retrying it, loudly (`apps/api/src/queue.ts`).
 */
async function settleUncompensatedStructuralFailure(
  rollback: Exclude<StructuralCompensationResult, { outcome: "compensated" }>,
  options: {
    projectId: string;
    operationId: string;
    ownerToken: string;
    generationJobId: string | undefined;
    error: unknown;
  }
): Promise<void> {
  const { projectId, operationId, ownerToken, generationJobId } = options;
  switch (rollback.outcome) {
    case "published":
      // An APPLIED publication is already durable, and its owner runs the tail.
      return;
    case "superseded":
      // A newer manuscript revision is a winner too, but unlike APPLIED it may
      // leave this shared job open; the unowned exit is what stops processJob
      // either completing or refunding it.
      throw new UnownedStructuralDeliveryError();
    case "not-needed":
      // No stamp under the operation's own lock, so the shift this delivery is
      // still holding in memory has already been taken off the book by whoever
      // cleared it. Requeuing would re-apply an edit the reader no longer has.
      throw options.error;
    case "lost": {
      // Somebody else's row — another lease owner, a settled status, a stamp
      // this delivery does not match, or its own lease run out. Only a winner
      // may settle it, and Stop or that winner normally makes this wait
      // terminal.
      if ((await waitForStructuralPageLeaseCompletion(operationId)) !== "abandoned") return;
      if (await unrevertedStructuralShiftStands(operationId)) {
        return await redeliverUnrevertedStructuralEdit(projectId, operationId, ownerToken, generationJobId);
      }
      console.error(
        `Structural page edit ${operationId} on project ${projectId} lost its rollback with no shift left to resume; failing and refunding it`
      );
      throw options.error;
    }
    default: {
      const unhandled: never = rollback;
      throw new Error(`Unhandled structural compensation outcome ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Whether a redelivery would find a shift to resume rather than this same verdict. */
async function unrevertedStructuralShiftStands(operationId: string): Promise<boolean> {
  try {
    const held = await prisma.bookEditOperation.findUnique({
      where: { id: operationId },
      select: { classifier: true }
    });
    return parseStructuralApplication(held?.classifier) !== null;
  } catch (error) {
    // A read that could not answer is not evidence the shift is gone, and a
    // redelivery writes nothing a later delivery would have to take back.
    console.error(`Failed to re-read structural edit ${operationId} before deciding its redelivery`, error);
    return true;
  }
}

/**
 * Whether the reader has already undone this edit, which ends every delivery.
 *
 * `undoneAt` is written in the same transaction as the shared structural revert,
 * so it is the one marker meaning "the stamp on this row describes a shape the
 * book no longer has, on purpose". The test is the Undo button's own
 * (`canUndoBookEdit`, `apps/api/src/mobile/manualEdits.ts`), for the reason the
 * button and the picker share theirs: a handler that reads an undone edit as
 * live work can write the classifier out from under `undoneAt` and offer a
 * second Undo of an edit that is already back.
 */
function structuralEditWasUndone(classifier: unknown): boolean {
  return jsonRecord(classifier).undoneAt !== undefined;
}

/**
 * Whether the stamp still describes the book in front of us.
 *
 * The fence is only as good as the fact that a stamp and the shape it records
 * are written and erased together, and this is that assumption asked out loud
 * rather than trusted. A rollback that put an insert's pages back but left its
 * stamp behind has exactly one signature — recorded ids the book no longer
 * holds — and resuming on it settles a paid insert that wrote nothing. A delete
 * or a move records no ids, so there is nothing to ask and the stamp stands.
 *
 * **The recorded insert is the whole set.** `draftInsertedPages` throws if any
 * recorded id is missing, so a surviving subset is not a live stamp: it is the
 * same answer as none remaining. Resuming it would only send drafting into
 * that throw.
 *
 * **A `false` answer does not re-apply anything by itself, and never did.** It
 * hands the delivery back to `applyStructuralPageChange`, whose lease CAS asks
 * the same question under the operation row's own lock — and answers `resumed`
 * while `structuralApplication` is still on the row, because the stamp is proof
 * the shift landed however few of its pages survived. The shift is re-run only
 * once the stamp is gone from the row too, which is what a completed rollback
 * leaves behind. Read this as "stop trusting the stamp without the lock", not
 * as "apply the edit again".
 */
async function stampDescribesBook(projectId: string, application: StructuralApplication): Promise<boolean> {
  if (application.insertedPageIds.length === 0) {
    return true;
  }
  const remaining = await prisma.page.count({
    where: { projectId, id: { in: application.insertedPageIds } }
  });
  return remaining === application.insertedPageIds.length;
}
