import { getProjectOrThrow, invalidateProjectExports, strategyForInput } from "../generation/bookHelpers.js";
import {
  prepareEmbedding,
  strategyUsesSemanticMemory,
  writePreparedEmbedding
} from "../generation/embeddingWrites.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { applyImageInsertion } from "./applyImageInsertion.js";
import { applyImageLayout } from "./applyImageLayout.js";
import { restructurePages } from "./restructurePages.js";
import { locallyPatchedPage, rewritePageForUserRequest } from "./replanBook.js";
import {
  settleSkippedExactTextEdit,
  textExactEditWasSkipped
} from "./applyBookEditNoop.js";
import { keeperStoryExtractForSave, persistStoryExtract } from "../generation/qualityEnrichment.js";
import { loadQualityContext } from "../generation/qualitySettings.js";
import { loadProjectStoryState, rebuildProjectStoryState } from "../generation/storyStateStore.js";
import {
  assertTextEditLeaseTx,
  completeTextEditLease,
  isTextEditLeaseLostError,
  startTextEditLeaseHeartbeat,
  waitForTextEditLease,
  waitForTextEditLeaseCompletion
} from "../generation/textEditLease.js";
import {
  claimAppliedEditPublication,
  restoreEditProjectStatus
} from "../generation/editProjectStatus.js";
import { runBestEffortPageMemoryWrite } from "../generation/bestEffortSavepoint.js";
import { UnownedTextEditDeliveryError } from "../runtime/jobTypes.js";
import {
  bookPlanSchema,
  compilePublicationPolicyFromPayload,
  createProviders,
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_REPAIR_FORMAT,
  hasExactMatch,
  jsonPayloadToRecord,
  preEditProjectStatus,
  type SettledProjectStatus
} from "@book-maker/core";
import { pageScope, Prisma, prisma } from "@book-maker/db";
import type { ApplyBookEditJob } from "../runtime/jobPayloads.js";
import { randomUUID } from "node:crypto";

/**
 * `apply-book-edit` job: apply a user-approved edit to saved pages.
 */

/** Where in the `apply` step's own band each page's phases sit. */
const PAGE_PHASE_SHARE = { draft: 0.05, review: 0.6, save: 0.9 } as const;

type EditPagePhase = keyof typeof PAGE_PHASE_SHARE;

/** The `apply` step owns 40–75 of the job's progress column. */
function applyStepProgress(pagesDone: number, total: number): number {
  return 40 + Math.round((pagesDone / Math.max(total, 1)) * 35);
}

export async function applyBookEdit(job: ApplyBookEditJob) {
  const {
    projectId,
    operationId,
    request,
    affectedPageIndexes,
    planId,
    exactReplacement,
    mode,
    perPageInstructions,
    generationJobId
  } = job.data;
  const operation = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (!operation) {
    throw new Error("Book edit operation not found");
  }
  if (operation.kind === "RESTRUCTURE_PAGES") {
    // Forked on the operation's own column, not on the payload's
    // `structuralEdit`. The payload is JSON a hand-requeue or a reconciler can
    // rebuild without that field, and everything downstream of this line reads
    // a structural job as a text one: `affectedPageIndexes` is always empty for
    // this kind, so the rewrite loop below claims the operation ACTIVE and the
    // project EDITING *outside* the structural fence and then dies on "No
    // matching pages found for this edit" — a paid insert failed for a reason
    // that is not what went wrong, with the shift never attempted. `kind` is
    // written once, when the operation is created, and no later write touches
    // it; `restructurePages` finds the edit itself, on the payload or on the
    // classifier the same enqueue wrote it to.
    //
    // Forked *first* for the strongest version of the reason the image forks
    // are: this one commits an index shift, and its fence is a stamp written in
    // the same transaction as that shift. Reaching the unconditional ACTIVE
    // write below before the fence runs would put a redelivery on the far side
    // of it.
    await restructurePages(job, operation);
    return;
  }
  if (operation.kind === "MOVE_IMAGE" || operation.kind === "REMOVE_IMAGE") {
    // On the column, for the same reason as above and with a worse failure
    // behind it. These two gated on `job.data.imageLayout`, so a job whose
    // payload was rebuilt without that key fell through to the rewrite loop —
    // and a layout payload's `affectedPageIndexes` is *not* empty, it names the
    // pages the pictures sit on. So "remove the illustration on page 3" was
    // handed to the prose rewriter as an instruction about page 3: two model
    // calls on an edit priced at zero, a page of prose replaced, snapshots and
    // an APPLIED operation claiming a text edit nobody asked for — all of it
    // outside the layout handler's own redelivery fence, because the
    // unconditional ACTIVE and EDITING writes below run before it. The
    // classifier carries the resolved intent the Apply wrote in the same
    // transaction as the operation row, so the handler finds the edit on either
    // copy; a job carrying neither settles as a delivered no-op, which is the
    // path a vanished picture already takes.
    await applyImageLayout(job, operation);
    return;
  }
  if (operation.kind === "ADD_IMAGE") {
    // A paid one-off illustration, not a text rewrite. Forked before the
    // unconditional ACTIVE/EDITING writes below so the insertion can run its
    // own redelivery fence against the operation's pre-write status, and forked
    // on the column rather than on `job.data.imageInsertion` for the reason
    // above: the reader bought a picture, and the rewrite loop would have spent
    // the charge rewriting the page it was going on.
    await applyImageInsertion(job, operation);
    return;
  }
  // Unlike an ordinary APPLIED text edit, this row changed no manuscript
  // revision and owns no publication tail. Its settlement completed the lease,
  // but the classifier marker is the durable fast-path for every sequential
  // redelivery and keeps this door safe even if lease bookkeeping is repaired.
  if (operation.status === "APPLIED" && textExactEditWasSkipped(operation.classifier)) {
    return;
  }
  // The enqueue transaction already moved the project to EDITING. This stamp
  // is the only record of which settled status a text edit may restore when
  // its compile handoff cannot be queued; legacy jobs decode as COMPLETE.
  const fallbackStatus = preEditProjectStatus(job.data);
  // Paid/operator retry paths intentionally replay the payload against the
  // FAILED operation row. Re-open only the status this delivery actually read;
  // an ordinary stalled ACTIVE delivery may never resurrect a winner's later
  // failure merely because it reached this line late.
  if (operation.status === "FAILED") {
    await prisma.bookEditOperation.updateMany({
      where: { id: operationId, status: "FAILED" },
      data: { status: "ACTIVE" }
    });
  }
  // A stalled Bull delivery and its replacement share both job ids. This token
  // identifies one invocation, and the database-time lease decides which one
  // may write the manuscript after a long provider call.
  const ownerToken = randomUUID();
  const claim = await waitForTextEditLease(operationId, ownerToken);
  if (claim.outcome === "completed" || claim.outcome === "settled") {
    return;
  }
  if (claim.outcome === "abandoned") {
    throw new UnownedTextEditDeliveryError();
  }
  const heartbeat = startTextEditLeaseHeartbeat(operationId, ownerToken);
  if (claim.phase === "tail") {
    try {
      await replayAppliedTextEdit(
        projectId,
        planId,
        fallbackStatus,
        operationId,
        ownerToken
      );
      // A superseded publication generation is terminal for this already-
      // delivered edit, not evidence of a competing lease owner. It must not
      // touch the newer project/exports, but this delivery still owns and owes
      // the APPLIED-tail lease completion below so processJob can terminalize
      // its durable GenerationJob. A live-owner race throws from the lease
      // assertion inside replayAppliedTextEdit and retains the stand-down path.
      await completeDeliveredTextEditLease({
        projectId,
        operationId,
        ownerToken,
        generationJobId,
        phase: "applied-tail"
      });
    } catch (error) {
      if (!isTextEditLeaseLostError(error)) throw error;
      if ((await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
        throw new UnownedTextEditDeliveryError();
      }
    } finally {
      await heartbeat.stop();
    }
    return;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
      await assertTextEditLeaseTx(tx, operationId, ownerToken);
    });
    await advanceJobStep(generationJobId, "prepare", 20, "Preparing page edit");

    const [project, planVersion] = await Promise.all([
      getProjectOrThrow(projectId),
      planId ? prisma.planVersion.findUnique({ where: { id: planId } }) : null
    ]);
    if (!project.currentPlanId && !planId) {
      throw new Error("Cannot edit a book without a current plan");
    }
    const effectivePlanVersion =
      planVersion ?? (project.currentPlanId ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId } }) : null);
    if (!effectivePlanVersion) {
      throw new Error("Current plan not found");
    }
    const input = inputForPlanVersion(project, effectivePlanVersion.inputSnapshot);
    const plan = bookPlanSchema.parse(effectivePlanVersion.planningPackage);
    const strategy = strategyForInput(input);
    const providers = createLoggedProviders(job, createProviders(config, input), input);
    // One read of the operator's gates for the whole edit, the way a compile
    // reads them once for all of its passes. `rewritePageForUserRequest` used to
    // load its own per page and `persistKeeperStoryDelta` loaded another behind
    // it, so a ten-page edit spent twenty reads — and a Quality-tab save landing
    // between two of them ran the first pages of one edit under one gate
    // configuration and the rest under another.
    const quality = await loadQualityContext(input);
    const pages = await prisma.page.findMany({
      where: { projectId, index: { in: affectedPageIndexes } },
      orderBy: { index: "asc" },
      include: { chapter: true }
    });
    if (pages.length === 0) {
      throw new Error("No matching pages found for this edit");
    }

    await advanceJobStep(generationJobId, "snapshot", 35, `Snapshotting ${pages.length} page edit target(s)`, {
      done: 0,
      total: pages.length
    });
    const snapshotRows = await prisma.$transaction(async (tx) => {
      await assertTextEditLeaseTx(tx, operationId, ownerToken);
      const existing = await tx.pageEditSnapshot.findMany({
        where: { operationId, pageId: { in: pages.map((page) => page.id) } }
      });
      const byPageId = new Map(existing.map((snapshot) => [snapshot.pageId, snapshot]));
      for (const page of pages) {
        if (byPageId.has(page.id)) continue;
        const snapshot = await tx.pageEditSnapshot.create({
          data: {
            projectId,
            pageId: page.id,
            operationId,
            pageIndex: page.index,
            titleBefore: page.title,
            markdownBefore: page.markdown,
            summaryBefore: page.summary,
            revisionBefore: page.revision,
            ...(page.storyDelta != null ? { storyDeltaBefore: page.storyDelta as Prisma.InputJsonValue } : {})
          }
        });
        byPageId.set(page.id, snapshot);
      }
      return [...byPageId.values()];
    });
    const snapshots = new Map(snapshotRows.map((snapshot) => [snapshot.pageId, snapshot]));

    const updatedPageIndexes: number[] = [];
    // Rewriting is the long step, and one flat "applying" for the whole of it is
    // what made a multi-page edit look stalled. Each page reports itself three
    // times so both the bar and the phrase above it keep moving; the API turns
    // these counters into the words, this file never does.
    const reportPage = (page: { index: number }, offset: number, phase: EditPagePhase) =>
      advanceJobStep(
        generationJobId,
        "apply",
        applyStepProgress(offset + PAGE_PHASE_SHARE[phase], pages.length),
        `Applying edit to page ${page.index}`,
        { done: offset, total: pages.length, phase, pageIndex: page.index }
      );

    const skippedPageIndexes: number[] = [];
    // A page named by the reader gets its own instruction; every other page in
    // the edit gets the request, which is what this loop has always done. Both
    // strings already carry the mentioned characters' sheets — neither may be
    // rebuilt from the operation's classifier, whose entries are the bare ones.
    const instructionForPage = new Map((perPageInstructions ?? []).map((entry) => [entry.pageIndex, entry.instruction]));
    const seedPromises = plan.promises ?? [];
    let currentState = await loadProjectStoryState(projectId, seedPromises);
    try {
      for (const [offset, page] of pages.entries()) {
        const snapshot = snapshots.get(page.id);
        if (!snapshot) {
          throw new Error(`Snapshot missing for text edit page ${page.id}`);
        }
        // The page save and this marker commit in one fenced transaction below.
        // A crash replacement resumes after the pages that transaction already
        // delivered instead of applying the reader's instruction to them twice.
        if (snapshot.revisionAfter != null) {
          updatedPageIndexes.push(page.index);
          continue;
        }
        await reportPage(page, offset, "draft");
        // Through the shared matcher, not `includes`: the pages were chosen with a
        // case-insensitive search, so a literal check here disagreed with the search
        // that selected them and sent those pages to the model instead. The title
        // counts too — the preview prices title-only pages, and `locallyPatchedPage`
        // patches the title, so a markdown-only gate skipped a promised rename.
        const patchable = Boolean(
          exactReplacement &&
            (hasExactMatch(page.markdown, exactReplacement) || hasExactMatch(page.title, exactReplacement))
        );
        if (mode === "exact" && !patchable) {
          // The page changed between the quote and the apply. Nothing to replace,
          // and rewriting it is not what was approved.
          skippedPageIndexes.push(page.index);
          continue;
        }
        const updated = exactReplacement && patchable
          ? locallyPatchedPage(page, exactReplacement)
          : await rewritePageForUserRequest({
              projectId,
              page,
              input,
              plan,
              strategy,
              providers,
              request: instructionForPage.get(page.index) ?? request,
              quality,
              generationJobId,
              onPhase: (phase) => reportPage(page, offset, phase)
            });
        await reportPage(page, offset, "save");
        // Spend every provider call before taking the publication lock. The
        // transaction below then begins by proving this delivery still owns the
        // lease and publishes the page, snapshot, notes and memory as one unit.
        const preparedEmbedding = strategyUsesSemanticMemory(strategy)
          ? await prepareEmbedding(updated.summary, providers.embedding)
          : null;
        const draft = {
          title: updated.title,
          markdown: updated.markdown,
          summary: updated.summary,
          continuityNotes: updated.continuityNotes,
          ...(updated.imagePrompt ? { imagePrompt: updated.imagePrompt } : {})
        };
        const storyExtract = await keeperStoryExtractForSave({
          projectId,
          pageIndex: page.index,
          draft,
          textModel: providers.text,
          plan,
          input,
          previousExtract: null,
          keeperWasRevised: true,
          currentState,
          quality
        });
        const { nextState } = await prisma.$transaction(async (tx) => {
          await assertTextEditLeaseTx(tx, operationId, ownerToken);
          const saved = await tx.page.update({
            where: { id: page.id },
            data: {
              title: updated.title,
              markdown: updated.markdown,
              summary: updated.summary,
              imagePrompt: updated.imagePrompt ?? page.imagePrompt,
              // The rewrite loop's verdict is saved honestly: a page whose best
              // candidate still failed review stays flagged, so a later full
              // compile's repair pass can target it instead of it passing silently.
              status: updated.qualityReport.approved ? "COMPLETED" : "FAILED_QA",
              revision: { increment: 1 },
              qualityReport: updated.qualityReport as Prisma.InputJsonValue
            }
          });
          await tx.pageEditSnapshot.update({
            where: { id: snapshot.id },
            data: {
              titleAfter: saved.title,
              markdownAfter: saved.markdown,
              summaryAfter: saved.summary,
              revisionAfter: saved.revision
            }
          });
          if (updated.continuityNotes.length > 0) {
            await tx.continuityNote.createMany({
              data: updated.continuityNotes.map((body) => ({
                projectId,
                pageId: page.id,
                scope: `page:${page.index}:edit:${operationId}`,
                body,
                tags: ["page", String(page.index), "edit"]
              }))
            });
          }
          if (preparedEmbedding) {
            await runBestEffortPageMemoryWrite(tx, () =>
              writePreparedEmbedding(
                { projectId, scope: pageScope(page.index), sourceId: page.id, text: saved.summary },
                preparedEmbedding,
                tx
              )
            );
          }
          const nextState = storyExtract
            ? await runBestEffortPageMemoryWrite(tx, () =>
                persistStoryExtract({ projectId, pageIndex: page.index, plan, extract: storyExtract, client: tx })
              )
            : null;
          return { nextState };
        });
        if (nextState) {
          currentState = nextState;
        }
        updatedPageIndexes.push(page.index);
      }
    } catch (error) {
      // Pages are saved per iteration, but the export invalidation and the
      // contentRevision bump live on the success path below — so a mid-loop
      // failure or stop used to hand back a "COMPLETE" book whose Page.markdown
      // held a half-applied edit while book.pdf still held the pre-edit text.
      // If anything was saved, rebuild the exports from what the pages actually
      // say before letting the failure settle. Detached, because the settlement
      // for this failed edit (markFailed/markStopped, and the attempt it stops
      // siblings for) must not cancel the rebuild — and the rebuild's own
      // failure must not flip the restored book to FAILED or refund its
      // generation charge. Every contentRevision bump queues its own compile;
      // if this one cannot (`not-ready`, enqueue outage), the restored COMPLETE
      // status with missing files is exactly the state the on-demand export
      // repair lane rebuilds.
      if (updatedPageIndexes.length > 0) {
        try {
          await heartbeat.assertHeld();
          await rebuildProjectStoryState(projectId, plan.promises ?? []);
          await prisma.$transaction(async (tx) => {
            // Stop locks Project before revoking this operation lease. Match
            // that order so cancellation cannot deadlock with half-apply repair.
            await tx.project.update({
              where: { id: projectId },
              data: { contentRevision: { increment: 0 } }
            });
            await assertTextEditLeaseTx(tx, operationId, ownerToken);
            await invalidateProjectExports(projectId);
            await tx.project.update({
              where: { id: projectId },
              data: { contentRevision: { increment: 1 } }
            });
          });
          await maybeEnqueueCompile(
            projectId,
            effectivePlanVersion.id,
            compilePublicationPolicyFromPayload({
              skipFinalReview: true,
              [DETACHED_FROM_PROJECT_LIFECYCLE]: true,
              [EXPORT_REPAIR_FORMAT]: "pdf"
            })
          );
        } catch (cleanupError) {
          if (isTextEditLeaseLostError(cleanupError)) {
            throw cleanupError;
          }
          console.error(
            `Failed to queue the export rebuild for half-applied edit ${operationId} on project ${projectId}:`,
            cleanupError
          );
        }
      }
      // Rethrown as-is: a StopRequestedError must still reach markStopped.
      throw error;
    }

    if (updatedPageIndexes.length === 0 && skippedPageIndexes.length > 0) {
      const settled = await settleSkippedExactTextEdit({
        job,
        projectId,
        operationId,
        ownerToken,
        skippedPageIndexes,
        fallbackStatus,
        assertLease: heartbeat.assertHeld
      });
      if (!settled && (await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
        throw new UnownedTextEditDeliveryError();
      }
      return;
    }

    if (skippedPageIndexes.length > 0) {
      // Undo restores every snapshot it finds and names those pages in its reply,
      // so a snapshot for a page that was never touched would report a page as
      // rolled back that never moved.
      await prisma.$transaction(async (tx) => {
        await assertTextEditLeaseTx(tx, operationId, ownerToken);
        await tx.pageEditSnapshot.deleteMany({
          where: { operationId, pageIndex: { in: skippedPageIndexes } }
        });
      });
    }

    await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
    await heartbeat.assertHeld();
    await rebuildProjectStoryState(projectId, plan.promises ?? []);
    // APPLIED is the redelivery fence, so it must prove the manuscript revision
    // moved with it. Written separately, a crash after the operation update sent
    // the next delivery to the idempotent compile tail without ever advancing
    // contentRevision, allowing that compile to publish under the old revision.
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: { contentRevision: { increment: 0 } }
      });
      const owned = await assertTextEditLeaseTx(tx, operationId, ownerToken);
      // Keep deletion ordered with the lease claim. A zombie paused after a
      // barrier cannot wake after a replacement compile and remove its exports.
      await invalidateProjectExports(projectId);
      const published = await tx.project.update({
        where: { id: projectId },
        data: { contentRevision: { increment: 1 } },
        select: { contentRevision: true }
      });
      await tx.bookEditOperation.update({
        where: { id: operationId },
        data: {
          status: "APPLIED",
          publicationRevision: published.contentRevision,
          affectedPageIndexes: updatedPageIndexes,
          // The queued reply already promised these pages, so a page skipped
          // because its text changed has to be named somewhere the reader sees —
          // the serializer reads this to say what was and wasn't touched.
          ...(skippedPageIndexes.length > 0
            ? { classifier: { ...jsonPayloadToRecord(owned.classifier), skippedPageIndexes } as Prisma.InputJsonValue }
            : {}),
          appliedAt: new Date()
        }
      });
    });
    // The recompile after an edit never runs the whole-book QA pass: an exact
    // patch changed only approved strings, and a model rewrite was reviewed per
    // page inside the edit — with the user's request in context, which the QA
    // repair pass would not have. Rewriting surrounding pages the user never
    // asked about is the same hazard the manual Edit Mode skip exists for, and
    // the per-page price never modeled a book-sized review.
    await queueTextEditCompile(projectId, effectivePlanVersion.id, fallbackStatus, operationId, ownerToken);
    await completeDeliveredTextEditLease({
      projectId,
      operationId,
      ownerToken,
      generationJobId,
      phase: "draft-success"
    });
  } catch (error) {
    if (!isTextEditLeaseLostError(error)) {
      throw error;
    }
    // The replacement owns every remaining write. Wait through its export
    // handoff so this invocation cannot mark the shared durable job complete
    // while the winner is still applying the edit.
    if ((await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
      throw new UnownedTextEditDeliveryError();
    }
  } finally {
    await heartbeat.stop();
  }
}

/**
 * Complete only the delivery marker after the edit and compile handoff are
 * durable. A false compare-and-set is ownership evidence, so it keeps the
 * existing wait/stand-down protocol. A thrown write has an unknown outcome:
 * failing the delivered job would refund it and can stop its queued compile,
 * while leaving the APPLIED row untouched lets an overlapping or future
 * delivery replay the idempotent publication tail and reconcile the marker.
 */
async function completeDeliveredTextEditLease(options: {
  projectId: string;
  operationId: string;
  ownerToken: string;
  generationJobId: string | undefined;
  phase: "draft-success" | "applied-tail";
}): Promise<void> {
  let completed: boolean;
  try {
    completed = await completeTextEditLease(options.operationId, options.ownerToken);
  } catch (error) {
    console.error("Text edit lease completion failed after durable compile handoff", {
      event: "generation.text_edit_lease_completion_failed",
      projectId: options.projectId,
      operationId: options.operationId,
      generationJobId: options.generationJobId ?? null,
      phase: options.phase,
      recovery: "applied-tail-replay",
      error
    });
    return;
  }
  if (completed) return;
  if ((await waitForTextEditLeaseCompletion(options.operationId)) === "abandoned") {
    throw new UnownedTextEditDeliveryError();
  }
}

/**
 * An APPLIED row proves the rewrite, snapshots, invalidation and revision bump
 * already landed. A redelivery therefore owns only the export handoff: it may
 * invalidate the same files again, but it must never snapshot or rewrite the
 * pages a second time, nor advance the manuscript revision again.
 */
async function replayAppliedTextEdit(
  projectId: string,
  planId: string | undefined,
  fallbackStatus: SettledProjectStatus,
  operationId: string,
  ownerToken: string
): Promise<"publication" | "noop" | "lifecycle-superseded"> {
  const project = await getProjectOrThrow(projectId);
  const compilePlanId = planId ?? project.currentPlanId;
  let publicationClaimed = false;
  let deliveredNoop = false;
  await prisma.$transaction(async (tx) => {
    publicationClaimed = await claimAppliedEditPublication(
      tx,
      projectId,
      operationId,
      fallbackStatus
    );
    if (!publicationClaimed) {
      return;
    }
    const owned = await assertTextEditLeaseTx(tx, operationId, ownerToken);
    // The entry read may predate a racing no-op settlement. Re-read under the
    // lease row lock before claiming publication so that door also recognizes
    // the text-only marker and leaves exports and revision untouched.
    if (textExactEditWasSkipped(owned.classifier)) {
      deliveredNoop = true;
      return;
    }
    if (!compilePlanId) {
      // There is no compile this delivery can hand the project to. The
      // operation is already delivered, so expose the settled book to the
      // on-demand repair lane under its queue-time status.
      await restoreEditProjectStatus(tx, projectId, operationId, fallbackStatus);
      return;
    }
    // Keep the operation row locked across the short filesystem delete. An
    // expired zombie cannot resume after a replacement publishes and remove
    // that replacement's files.
    await invalidateProjectExports(projectId);
  });
  // The marker branch above claims no project publication window and has no
  // compile to enqueue. It can only be reached by a repaired/legacy lease whose
  // completion stamp was absent.
  if (deliveredNoop) {
    return "noop";
  }
  if (!publicationClaimed) {
    return "lifecycle-superseded";
  }
  if (!compilePlanId) {
    return "publication";
  }
  await queueTextEditCompile(projectId, compilePlanId, fallbackStatus, operationId, ownerToken);
  return "publication";
}

/** Queue the idempotent publication tail without failing an already-delivered edit. */
async function queueTextEditCompile(
  projectId: string,
  planVersionId: string,
  fallbackStatus: SettledProjectStatus,
  operationId: string,
  ownerToken: string
): Promise<void> {
  let dispatched: Awaited<ReturnType<typeof maybeEnqueueCompile>>;
  try {
    dispatched = await maybeEnqueueCompile(projectId, planVersionId, { skipFinalReview: true });
  } catch (error) {
    // The edit and its snapshots are already committed and the old exports are
    // intentionally gone. Failing the delivered edit here only leaves its Bull
    // row disagreeing with an APPLIED operation; restoring a settled project
    // hands the missing files to the same on-demand repair lane as `not-ready`.
    console.error(`Failed to enqueue the export refresh for edited project ${projectId}:`, error);
    dispatched = "not-ready";
  }
  if (dispatched === "not-ready") {
    // The compile is the only thing that takes this project back out of
    // EDITING, and the exports are already deleted — so a fan-in that declines
    // to queue one, with nothing in flight to call it again, would leave the
    // book unreadable until delayed EDITING reconciliation. Handing it back to
    // `ensureExportRepairQueued` immediately avoids that grace-period delay —
    // a settled project with missing files is precisely the state the app's
    // status stream already knows how to rebuild.
    await restoreTextEditStatus(projectId, fallbackStatus, operationId, ownerToken);
  }
}

async function restoreTextEditStatus(
  projectId: string,
  fallbackStatus: SettledProjectStatus,
  operationId: string,
  ownerToken: string
): Promise<void> {
  await prisma
    .$transaction(async (tx) => {
      const restored = await restoreEditProjectStatus(
        tx,
        projectId,
        operationId,
        fallbackStatus
      );
      if (restored) {
        await assertTextEditLeaseTx(tx, operationId, ownerToken);
      }
    })
    .catch((error: unknown) => {
      if (isTextEditLeaseLostError(error)) throw error;
    });
}
