import { getProjectOrThrow, invalidateProjectExports, strategyForInput } from "../generation/bookHelpers.js";
import { storeEmbedding, strategyUsesSemanticMemory } from "../generation/semanticMemory.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { locallyPatchedPage, rewritePageForUserRequest } from "./replanBook.js";
import { bookPlanSchema, createProviders, hasExactMatch, jsonPayloadToRecord, type ExactReplacement } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
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
    mode
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
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  const operation = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (!operation) {
    throw new Error("Book edit operation not found");
  }
  await prisma.bookEditOperation.update({ where: { id: operationId }, data: { status: "ACTIVE" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "prepare", 20, "Preparing page edit");

  const [project, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.planVersion.findUnique({ where: { id: planId ?? "" } })
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
        revisionBefore: page.revision
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
          request,
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
          scope: `page:${page.index}:edit:${operationId}`,
          body,
          tags: ["page", String(page.index), "edit"]
        }))
      });
    }
    if (strategyUsesSemanticMemory(strategy)) {
      await storeEmbedding(projectId, `page:${page.index}`, page.id, saved.summary, providers.embedding);
    }
    updatedPageIndexes.push(page.index);
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
