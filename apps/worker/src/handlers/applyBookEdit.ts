import { getProjectOrThrow, invalidateProjectExports, strategyForInput } from "../generation/bookHelpers.js";
import { storeEmbedding, strategyUsesSemanticMemory } from "../generation/embeddingWrites.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { applyImageInsertion, type ImageInsertionPayload } from "./applyImageInsertion.js";
import { applyImageLayout, type ImageLayoutPayload } from "./applyImageLayout.js";
import { restructurePages } from "./restructurePages.js";
import { locallyPatchedPage, rewritePageForUserRequest } from "./replanBook.js";
import { persistKeeperStoryDelta } from "../generation/qualityEnrichment.js";
import { loadProjectStoryState, rebuildProjectStoryState } from "../generation/storyStateStore.js";
import {
  bookPlanSchema,
  createProviders,
  hasExactMatch,
  jsonPayloadToRecord,
  type ExactReplacement,
  type StructuralPageEdit
} from "@book-maker/core";
import { pageScope, Prisma, prisma } from "@book-maker/db";
import { Job } from "bullmq";

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

export async function applyBookEdit(job: Job) {
  const {
    projectId,
    operationId,
    request,
    affectedPageIndexes,
    planId,
    exactReplacement,
    mode,
    perPageInstructions
  } = job.data as {
    projectId: string;
    operationId: string;
    request: string;
    affectedPageIndexes: number[];
    planId?: string;
    exactReplacement?: ExactReplacement;
    /**
     * `"exact"` means the API verified every page in scope contains the literal
     * text and quoted the edit at no charge on that basis. Falling back to a
     * model rewrite here would spend a book's worth of tokens on an edit nobody
     * paid for, so a page that no longer matches is skipped instead.
     */
    mode?: "exact";
    /**
     * A different instruction for particular pages, when the reader asked for
     * different things on each ("make page 3 funnier and page 7 shorter").
     * Absent — the ordinary case — every page gets the whole request, and a
     * page with no entry does too, so this can only ever narrow what one page
     * is told rather than drop an edit that was charged for.
     *
     * An entry *replaces* `request` for its page, so the API composes the
     * @-mentioned characters' sheets onto each instruction the same way it
     * composes them onto `request` — use the string as it arrives.
     */
    perPageInstructions?: { pageIndex: number; instruction: string }[];
    /**
     * Insert, delete or reorder pages. Read by `restructurePages` rather than
     * here — the fork below is decided by the operation's `kind`, because this
     * field is the copy that can go missing.
     */
    structuralEdit?: StructuralPageEdit;
    /**
     * Render one illustration. Read by `applyImageInsertion`, and optional for
     * the same reason `structuralEdit` is: the fork below is decided by the
     * operation's `kind`, so a payload rebuilt without this key still arrives
     * and the handler reads the request back off the classifier.
     */
    imageInsertion?: ImageInsertionPayload;
    /** Move or remove existing illustrations. Read by `applyImageLayout`, same rule. */
    imageLayout?: ImageLayoutPayload;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
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
  await prisma.bookEditOperation.update({ where: { id: operationId }, data: { status: "ACTIVE" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
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
  const snapshots = new Map<number, string>();
  for (const page of pages) {
    const snapshot = await prisma.pageEditSnapshot.create({
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
    snapshots.set(page.index, snapshot.id);
  }

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
            generationJobId,
            onPhase: (phase) => reportPage(page, offset, phase)
          });
      await reportPage(page, offset, "save");

      const saved = await prisma.page.update({
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
      const snapshotId = snapshots.get(page.index);
      if (snapshotId) {
        await prisma.pageEditSnapshot.update({
          where: { id: snapshotId },
          data: {
            titleAfter: saved.title,
            markdownAfter: saved.markdown,
            summaryAfter: saved.summary,
            revisionAfter: saved.revision
          }
        });
      }
      if (updated.continuityNotes.length > 0) {
        await prisma.continuityNote.createMany({
          data: updated.continuityNotes.map((body) => ({
            projectId,
            pageId: page.id,
            scope: `page:${page.index}:edit:${operationId}`,
            body,
            tags: ["page", String(page.index), "edit"]
          }))
        });
      }
      if (strategyUsesSemanticMemory(strategy)) {
        await storeEmbedding({ projectId, scope: pageScope(page.index), sourceId: page.id, text: saved.summary }, providers.embedding);
      }
      const nextState = await persistKeeperStoryDelta({
        projectId,
        pageIndex: page.index,
        draft: {
          title: updated.title,
          markdown: updated.markdown,
          summary: updated.summary,
          continuityNotes: updated.continuityNotes,
          ...(updated.imagePrompt ? { imagePrompt: updated.imagePrompt } : {})
        },
        textModel: providers.text,
        plan,
        input,
        previousExtract: null,
        keeperWasRevised: true,
        currentState
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
        await rebuildProjectStoryState(projectId, plan.promises ?? []);
        await invalidateProjectExports(projectId);
        await prisma.project.update({
          where: { id: projectId },
          data: { contentRevision: { increment: 1 } }
        });
        await maybeEnqueueCompile(projectId, effectivePlanVersion.id, { skipFinalReview: true, detached: true });
      } catch (cleanupError) {
        console.error(
          `Failed to queue the export rebuild for half-applied edit ${operationId} on project ${projectId}:`,
          cleanupError
        );
      }
    }
    // Rethrown as-is: a StopRequestedError must still reach markStopped.
    throw error;
  }

  if (skippedPageIndexes.length > 0) {
    // Undo restores every snapshot it finds and names those pages in its reply,
    // so a snapshot for a page that was never touched would report a page as
    // rolled back that never moved.
    await prisma.pageEditSnapshot.deleteMany({
      where: { operationId, pageIndex: { in: skippedPageIndexes } }
    });
  }

  await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
  await rebuildProjectStoryState(projectId, plan.promises ?? []);
  await invalidateProjectExports(projectId);
  await prisma.bookEditOperation.update({
    where: { id: operationId },
    data: {
      status: "APPLIED",
      affectedPageIndexes: updatedPageIndexes,
      // The queued reply already promised these pages, so a page skipped
      // because its text changed has to be named somewhere the reader sees —
      // the serializer reads this to say what was and wasn't touched.
      ...(skippedPageIndexes.length > 0
        ? { classifier: { ...jsonPayloadToRecord(operation.classifier), skippedPageIndexes } as Prisma.InputJsonValue }
        : {}),
      appliedAt: new Date()
    }
  });
  await prisma.project.update({
    where: { id: projectId },
    data: { contentRevision: { increment: 1 } }
  });
  // The recompile after an edit never runs the whole-book QA pass: an exact
  // patch changed only approved strings, and a model rewrite was reviewed per
  // page inside the edit — with the user's request in context, which the QA
  // repair pass would not have. Rewriting surrounding pages the user never
  // asked about is the same hazard the manual Edit Mode skip exists for, and
  // the per-page price never modeled a book-sized review.
  let dispatched: Awaited<ReturnType<typeof maybeEnqueueCompile>>;
  try {
    dispatched = await maybeEnqueueCompile(projectId, effectivePlanVersion.id, { skipFinalReview: true });
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
    // book unreadable and undownloadable for good: no sweep looks at EDITING,
    // and `ensureExportRepairQueued` refuses a project that is not COMPLETE or
    // REVIEW_REQUIRED. Handing it back to that repair lane is the recovery —
    // COMPLETE with missing files is precisely the state the app's status
    // stream already knows how to rebuild.
    await prisma.project
      .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: "COMPLETE" } })
      .catch(() => undefined);
  }
}
