import type { StructuralApplication } from "@book-maker/core";
import { Prisma } from "./client.ts";
import {
  applyPageOrder,
  deletePageContinuityNotes,
  deletePageEmbeddings,
  discardLegacyPageContinuityNotes,
  repointPageContinuityNotes,
  repointPageEmbeddings,
  repointedPageMapUpdate,
  type PageOrderEntry
} from "./pageOrdering.ts";

/**
 * Putting a book's shape back exactly as it was.
 *
 * Two callers need this and they live on opposite sides of the queue: the
 * worker rolls a half-applied structural edit back when drafting dies, and the
 * API runs the same steps when the reader taps Undo. A second copy of it is the
 * shape of bug this project already has a rule about — `stopProjectGenerationJobs`
 * is a parallel implementation of the worker's settlement, and the two have to
 * move together — so there is one implementation here instead.
 *
 * Everything it needs is on the `structuralApplication` stamp, which is written
 * in the same transaction as the change it reverses.
 *
 * It answers with the plan version the book is on afterwards, because that is
 * the one thing a caller may not carry across this call: it may restore P1 or
 * keep a reconciled later P3, depending on what is current.
 */

export async function revertStructuralPageChange(
  tx: Prisma.TransactionClient,
  projectId: string,
  application: StructuralApplication
): Promise<{ currentPlanId: string | null }> {
  // Both reads first, because everything below moves the rows they describe.
  // The page map is keyed on `Page.index`, and the stamp records ids, so the
  // one thing neither carries is where those pages sit *now* — which is the
  // half the map has to be re-pointed from.
  const [currentPages, project, archivedSnapshots] = await Promise.all([
    tx.page.findMany({ where: { projectId }, select: { id: true, index: true, chapterId: true } }),
    tx.project.findUnique({
      where: { id: projectId },
      select: { pdfPageMap: true, currentPlanId: true, targetPages: true }
    }),
    application.snapshotArchive
      ? tx.archivedPageEditSnapshot.findMany({
          where: { projectId, archiveKey: application.snapshotArchive.key },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        })
      : Promise.resolve([])
  ]);
  if (!project) {
    throw new Error(`Project ${projectId} not found while reverting structural page change`);
  }
  if (application.snapshotArchive && archivedSnapshots.length !== application.snapshotArchive.snapshotCount) {
    // Refuse while the transaction is still read-only. Replaying a partial
    // archive is worse than leaving the structural delete in place: it would
    // make an older multi-page edit look undoable while restoring only some of
    // what that Undo promised.
    throw new Error(
      `Structural snapshot archive ${application.snapshotArchive.key} expected ` +
        `${application.snapshotArchive.snapshotCount} rows, found ${archivedSnapshots.length}`
    );
  }
  const removedPageIds = new Set(application.removedPages.map((page) => page.id));
  if (archivedSnapshots.some((snapshot) => !removedPageIds.has(snapshot.pageId))) {
    throw new Error("Structural snapshot archive names a page this revert does not restore");
  }
  const currentIndexById = new Map(currentPages.map((page) => [page.id, page.index]));
  // Every page the stamp records, which is `pageOrderBefore` plus any removed
  // page it forgot to name there. See {@link recordedPageOrder}.
  const recordedOrder = recordedPageOrder(application);
  if (recordedOrder.length !== application.pageOrderBefore.length) {
    console.warn(
      `Structural revert for ${projectId} folded ${recordedOrder.length - application.pageOrderBefore.length} ` +
        `restored page(s) into a recorded order that does not name them`
    );
  }
  // The stamp records the shape the edit found, and nothing keeps the book in
  // that shape until the undo — so what is replayed is the recorded order held
  // to the pages the project will actually have. See {@link restoredPageOrder}.
  const restoredOrder = restoredPageOrder(recordedOrder, application, currentPages);
  const recordedPageIds = new Set(recordedOrder.map((entry) => entry.pageId));
  const drifted =
    restoredOrder.length !== recordedPageIds.size || restoredOrder.some((entry) => !recordedPageIds.has(entry.pageId));
  if (drifted) {
    console.warn(
      `Structural revert for ${projectId} reconciled a recorded page order the book no longer has: ` +
        `${recordedPageIds.size} recorded, ${restoredOrder.length} live`
    );
  }
  // Decide what happens to the plan *before* moving a page. A structural plan
  // can be deleted only while it is still the project's tip. A continuation
  // advances P2 to P3 and appends pages that the ordering above deliberately
  // retains; pointing that book back at P1 would orphan P3 and compile those
  // retained pages against a pre-continuation plan. A compatible later plan is
  // instead reconciled by removing the P1 -> P2 target deltas from P3. If its
  // lineage is not recognisable, this throws while the transaction is still
  // read-only rather than guessing after half an undo has landed.
  const planRevert = await planRevertFor({
    tx,
    projectId,
    application,
    currentPlanId: project.currentPlanId,
    currentTargetPages: project.targetPages,
    restoredTargetPages: restoredOrder.length,
    drifted
  });
  const moves = new Map<number, number>();
  for (const entry of restoredOrder) {
    const current = currentIndexById.get(entry.pageId);
    if (current !== undefined) {
      moves.set(current, entry.index);
    }
  }

  // A legacy page-scoped note has only the index that was current when it was
  // written. It may already name another page after an edit from an older
  // deployment, so never guess an owner during this reorder.
  await discardLegacyPageContinuityNotes(tx, projectId);

  if (application.removedPages.length > 0) {
    // Recreated with their **original ids**, so the `ImageAsset` rows that were
    // set to a null page when the row went can be pointed straight back — the
    // same mechanism the image undo already uses. Parked at negative indexes
    // because the pages still in the book hold the positive ones until the
    // ordering below runs.
    //
    // With their **original state**, too. This used to write `COMPLETED` flat
    // and record nothing else, so undoing the deletion of a `FAILED_QA` page
    // handed it back approved — an edit the reader never asked for, on the tap
    // that was supposed to undo one — and undoing the deletion of the only page
    // whose illustration had failed erased `imageFailureReason`, which is one of
    // the four things `projectAlreadyIllustrated` reads: the book stopped
    // counting as illustrated and could claim a second free-tier slot in the
    // same month. A stamp written before those fields existed carries none of
    // them and keeps exactly the old defaults. See `removedPageRecordSchema`.
    await tx.page.createMany({
      data: application.removedPages.map((page) => ({
        id: page.id,
        projectId,
        chapterId: page.chapterId,
        index: -page.index,
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        imagePrompt: page.imagePrompt,
        revision: page.revision,
        status: page.status ?? "COMPLETED",
        ...(page.qualityReport == null ? {} : { qualityReport: page.qualityReport as Prisma.InputJsonValue }),
        ...(page.imageFailureReason == null ? {} : { imageFailureReason: page.imageFailureReason }),
        ...(page.storyDelta === undefined ? {} : { storyDelta: page.storyDelta as Prisma.InputJsonValue })
      })),
      skipDuplicates: true
    });
    for (const page of application.removedPages) {
      if (page.imageAssetIds.length > 0) {
        await tx.imageAsset.updateMany({
          where: { id: { in: page.imageAssetIds }, projectId },
          data: { pageId: page.id }
        });
      }
    }
    if (archivedSnapshots.length > 0) {
      // Original ids are the idempotency key: a redelivery can encounter a
      // row restored by the same operation and `skipDuplicates` cannot create
      // a second snapshot. Every linkage and before/after field is replayed;
      // only archive ownership itself is discarded below.
      await tx.pageEditSnapshot.createMany({
        data: archivedSnapshots.map((snapshot) => ({
          id: snapshot.id,
          projectId: snapshot.projectId,
          pageId: snapshot.pageId,
          operationId: snapshot.operationId,
          pageIndex: snapshot.pageIndex,
          titleBefore: snapshot.titleBefore,
          markdownBefore: snapshot.markdownBefore,
          summaryBefore: snapshot.summaryBefore,
          revisionBefore: snapshot.revisionBefore,
          ...(snapshot.storyDeltaBefore === null
            ? {}
            : { storyDeltaBefore: snapshot.storyDeltaBefore as Prisma.InputJsonValue }),
          titleAfter: snapshot.titleAfter,
          markdownAfter: snapshot.markdownAfter,
          summaryAfter: snapshot.summaryAfter,
          revisionAfter: snapshot.revisionAfter,
          createdAt: snapshot.createdAt
        })),
        skipDuplicates: true
      });
      await tx.archivedPageEditSnapshot.deleteMany({
        where: { projectId, archiveKey: application.snapshotArchive!.key }
      });
    }
  }
  if (application.insertedPageIds.length > 0) {
    // Their `PageEditSnapshot` rows cascade away with them, which is correct:
    // a page that did not exist before has nothing to restore. Their embeddings
    // cascade off nothing at all, so they are taken explicitly — an inserted
    // page was drafted, so it has a `page:<index>` summary, and the ordering
    // below is about to move a surviving page onto that very index.
    await deletePageContinuityNotes(tx, projectId, application.insertedPageIds);
    await deletePageEmbeddings(tx, projectId, application.insertedPageIds);
    await tx.page.deleteMany({ where: { projectId, id: { in: application.insertedPageIds } } });
  }
  // Restores every page's index at once, including the ones just recreated —
  // which is why they had to come back before this and not after.
  await applyPageOrder(tx, projectId, restoredOrder);
  await repointPageContinuityNotes(tx, projectId, restoredOrder);
  await repointPageEmbeddings(tx, projectId, restoredOrder);

  // A cross-chapter move changes both a page's index and its chapterId. New
  // stamps retain the latter on the same pre-edit entry as the former, so put
  // both dimensions back. A legacy entry has no chapterId at all; skipping it
  // is the backward-compatible answer because defaulting it to null would
  // evict the page from whichever chapter it currently belongs to.
  const currentChapterById = new Map(currentPages.map((page) => [page.id, page.chapterId]));
  const pageIdsByChapter = new Map<string | null, string[]>();
  for (const entry of application.pageOrderBefore) {
    if (entry.chapterId === undefined || currentChapterById.get(entry.pageId) === entry.chapterId) {
      continue;
    }
    const pageIds = pageIdsByChapter.get(entry.chapterId);
    if (pageIds) {
      pageIds.push(entry.pageId);
    } else {
      pageIdsByChapter.set(entry.chapterId, [entry.pageId]);
    }
  }
  for (const [chapterId, pageIds] of pageIdsByChapter) {
    await tx.page.updateMany({ where: { projectId, id: { in: pageIds } }, data: { chapterId } });
  }

  for (const [chapterId, targetPages] of Object.entries(planRevert.chapterTargetPages)) {
    await tx.chapter.updateMany({ where: { id: chapterId, projectId }, data: { targetPages } });
  }
  if (planRevert.kind === "restore-base" && application.basePlanVersionId) {
    await tx.planVersion.update({
      where: { id: application.basePlanVersionId },
      data: { status: "APPROVED" }
    });
  }
  if (planRevert.kind === "preserve-later") {
    await tx.planVersion.update({
      where: { id: planRevert.currentPlanId },
      data: {
        planningPackage: planRevert.planningPackage as Prisma.InputJsonValue,
        inputSnapshot: planRevert.inputSnapshot as Prisma.InputJsonValue
      }
    });
  }
  await tx.project.update({
    where: { id: projectId },
    data: {
      currentPlanId: planRevert.currentPlanId,
      targetPages: planRevert.targetPages,
      // The map describes the pagination this revert just undid — but it
      // describes the *file* the reader is still looking at, which no undo
      // rebuilds instantly, and it is deliberately kept in force during
      // EDITING for exactly that reason. So its indexes go back with the
      // pages rather than the column being cleared; a map that would lose a
      // range keeps its cover numbering alone (see `repointedPageMapUpdate`).
      ...repointedPageMapUpdate(project.pdfPageMap, moves)
    }
  });
  if (planRevert.kind === "restore-base" && application.newPlanVersionId) {
    await tx.planVersion.deleteMany({ where: { id: application.newPlanVersionId } });
  }
  return { currentPlanId: planRevert.currentPlanId };
}

type ReconciledPlanDocument = {
  value: Record<string, unknown>;
  chapters: Array<Record<string, unknown> & { index: number; targetPages: number }>;
};

type PlanRevert =
  | {
      kind: "restore-base";
      currentPlanId: string | null;
      targetPages: number;
      chapterTargetPages: Record<string, number>;
    }
  | {
      kind: "preserve-later";
      currentPlanId: string;
      targetPages: number;
      chapterTargetPages: Record<string, number>;
      planningPackage: Record<string, unknown>;
      inputSnapshot: Record<string, unknown>;
    }
  | {
      kind: "no-version";
      currentPlanId: null;
      targetPages: number;
      chapterTargetPages: Record<string, number>;
    }
  | {
      kind: "keep-current";
      currentPlanId: string;
      targetPages: number;
      chapterTargetPages: Record<string, number>;
    };

/** The safe plan outcomes for a structural compensation. */
async function planRevertFor(options: {
  tx: Prisma.TransactionClient;
  projectId: string;
  application: StructuralApplication;
  currentPlanId: string | null;
  currentTargetPages: number;
  restoredTargetPages: number;
  drifted: boolean;
}): Promise<PlanRevert> {
  const { application } = options;
  const structuralPlanIsCurrent =
    application.newPlanVersionId !== null && options.currentPlanId === application.newPlanVersionId;
  const structuralPlanAlreadyRestored =
    application.basePlanVersionId !== null && options.currentPlanId === application.basePlanVersionId;

  if (structuralPlanIsCurrent || structuralPlanAlreadyRestored || options.currentPlanId === null) {
    // P1 describes exactly `pageOrderBefore`; a page gained or lost since that
    // stamp makes restoring P1 just as inconsistent as preserving P2. A later
    // compatible plan is the only branch allowed to carry drift.
    if (options.drifted && (options.currentPlanId !== null || application.basePlanVersionId !== null)) {
      throw new Error("Cannot restore a structural plan after the book changed without a later plan version");
    }
    if (application.basePlanVersionId === null) {
      return {
        kind: "no-version",
        currentPlanId: null,
        targetPages: options.restoredTargetPages,
        chapterTargetPages: application.previousChapterTargetPages
      };
    }
    return {
      kind: "restore-base",
      currentPlanId: application.basePlanVersionId,
      targetPages: application.previousTargetPages,
      chapterTargetPages: application.previousChapterTargetPages
    };
  }

  // Legacy reorder stamps could predate plan-version recording. They are safe
  // only when neither the whole-book nor per-chapter targets changed; then the
  // current plan already describes the same set of pages and merely stays put.
  if (
    application.basePlanVersionId === null &&
    application.newPlanVersionId === null &&
    application.action === "move" &&
    Object.keys(application.previousChapterTargetPages).length === 0 &&
    options.currentTargetPages === options.restoredTargetPages
  ) {
    return {
      kind: "keep-current",
      currentPlanId: options.currentPlanId,
      targetPages: options.currentTargetPages,
      chapterTargetPages: {}
    };
  }

  if (application.basePlanVersionId === null || application.newPlanVersionId === null) {
    throw new Error("Cannot reconcile a later plan from a structural stamp with incomplete plan lineage");
  }
  return reconcileLaterPlan({
    ...options,
    currentPlanId: options.currentPlanId,
    application: application as StructuralApplication & {
      basePlanVersionId: string;
      newPlanVersionId: string;
    }
  });
}

/**
 * Keeps P3 current while removing only the target changes P2 introduced over
 * P1. Continuation is the canonical shape: P3 keeps P2's chapters as a prefix
 * and appends its own. Comparing everything except `targetPages` makes this a
 * mechanical reconciliation, not a guess about an unrelated later replan.
 */
async function reconcileLaterPlan(options: {
  tx: Prisma.TransactionClient;
  projectId: string;
  application: StructuralApplication & { basePlanVersionId: string; newPlanVersionId: string };
  currentPlanId: string;
  restoredTargetPages: number;
}): Promise<Extract<PlanRevert, { kind: "preserve-later" }>> {
  const ids = [
    options.application.basePlanVersionId,
    options.application.newPlanVersionId,
    options.currentPlanId
  ];
  const [versions, chapters] = await Promise.all([
    options.tx.planVersion.findMany({
      where: { id: { in: ids }, projectId: options.projectId },
      select: { id: true, planningPackage: true, inputSnapshot: true }
    }),
    options.tx.chapter.findMany({
      where: { projectId: options.projectId },
      select: { id: true, index: true, targetPages: true }
    })
  ]);
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const base = planDocument(versionsById.get(options.application.basePlanVersionId)?.planningPackage, "base");
  const structural = planDocument(
    versionsById.get(options.application.newPlanVersionId)?.planningPackage,
    "structural"
  );
  const laterVersion = versionsById.get(options.currentPlanId);
  const later = planDocument(laterVersion?.planningPackage, "later");
  const laterInput = jsonObject(laterVersion?.inputSnapshot);
  if (!laterInput) {
    throw new Error("Cannot reconcile a later structural plan without a complete input snapshot");
  }
  if (!sameJson(planWithoutChapters(base), planWithoutChapters(structural))) {
    throw new Error("Structural plan changed more than page targets; refusing to reconcile a later plan");
  }
  if (!sameJson(planWithoutChapters(structural), planWithoutChapters(later))) {
    throw new Error("Later plan is not a compatible continuation of the structural plan");
  }

  const baseByIndex = new Map(base.chapters.map((chapter) => [chapter.index, chapter]));
  const structuralByIndex = new Map(structural.chapters.map((chapter) => [chapter.index, chapter]));
  const laterByIndex = new Map(later.chapters.map((chapter) => [chapter.index, chapter]));
  if (baseByIndex.size !== structuralByIndex.size) {
    throw new Error("Structural plan changed the chapter set; refusing to reconcile a later plan");
  }

  const targetDeltaByIndex = new Map<number, number>();
  for (const [index, structuralChapter] of structuralByIndex) {
    const baseChapter = baseByIndex.get(index);
    const laterChapter = laterByIndex.get(index);
    if (
      !baseChapter ||
      !laterChapter ||
      !sameJson(chapterWithoutTarget(baseChapter), chapterWithoutTarget(structuralChapter)) ||
      !sameJson(chapterWithoutTarget(structuralChapter), chapterWithoutTarget(laterChapter))
    ) {
      throw new Error("Later plan does not retain the structural plan's chapter prefix");
    }
    targetDeltaByIndex.set(index, structuralChapter.targetPages - baseChapter.targetPages);
  }

  const reconciledChapters = later.chapters.map((chapter) => {
    const targetPages = chapter.targetPages - (targetDeltaByIndex.get(chapter.index) ?? 0);
    if (targetPages < 1) {
      throw new Error("Structural plan reconciliation would leave an empty chapter");
    }
    return { ...chapter, targetPages };
  });
  const reconciledTotal = reconciledChapters.reduce((sum, chapter) => sum + chapter.targetPages, 0);
  if (reconciledTotal !== options.restoredTargetPages) {
    throw new Error(
      `Later plan would target ${reconciledTotal} pages after structural undo, not ${options.restoredTargetPages}`
    );
  }

  const chapterTargetPages: Record<string, number> = {};
  for (const chapter of chapters) {
    const delta = targetDeltaByIndex.get(chapter.index);
    if (delta === undefined) continue;
    const targetPages = chapter.targetPages - delta;
    if (targetPages !== reconciledChapters.find((entry) => entry.index === chapter.index)?.targetPages) {
      throw new Error("Stored chapter targets do not match the later plan being reconciled");
    }
    chapterTargetPages[chapter.id] = targetPages;
  }
  if ([...targetDeltaByIndex.keys()].some((index) => !chapters.some((chapter) => chapter.index === index))) {
    throw new Error("Later plan names a chapter the project no longer has");
  }

  return {
    kind: "preserve-later",
    currentPlanId: options.currentPlanId,
    targetPages: options.restoredTargetPages,
    chapterTargetPages,
    planningPackage: { ...later.value, chapters: reconciledChapters },
    inputSnapshot: { ...laterInput, targetPages: options.restoredTargetPages }
  };
}

function planDocument(value: unknown, label: string): ReconciledPlanDocument {
  const record = jsonObject(value);
  if (!record || !Array.isArray(record.chapters)) {
    throw new Error(`Cannot read ${label} plan while reconciling structural undo`);
  }
  const chapters = record.chapters.map((chapter) => {
    const entry = jsonObject(chapter);
    if (!entry || !Number.isInteger(entry.index) || !Number.isInteger(entry.targetPages)) {
      throw new Error(`Cannot read ${label} plan chapters while reconciling structural undo`);
    }
    return entry as Record<string, unknown> & { index: number; targetPages: number };
  });
  return { value: record, chapters };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function planWithoutChapters(plan: ReconciledPlanDocument): Record<string, unknown> {
  const { chapters: _chapters, ...rest } = plan.value;
  return rest;
}

function chapterWithoutTarget(chapter: Record<string, unknown>): Record<string, unknown> {
  const { targetPages: _targetPages, ...rest } = chapter;
  return rest;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = jsonObject(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Every page the stamp records, in the sequence it recorded them.
 *
 * The stamp keeps the pre-edit book in two lists that have to describe the same
 * rows: `pageOrderBefore` is the whole of it, and `removedPages` is the subset
 * the edit took out, carried whole because a deleted `Page` takes its own undo
 * record with it. The writer reads both out of **one** `findMany` inside the
 * shift's own transaction, and `reconcileStructuralPagePlan` has already dropped
 * every removed id that read does not hold — so they agree by construction, and
 * this fold is a no-op on every stamp this project writes.
 *
 * It is here because the disagreement would not be, and the two halves of the
 * revert read a different list. The rows come back from `removedPages`, parked
 * at `-index` exactly as `pageOrderStatements` parks the rows it moves; the
 * ordering that un-parks them is built from `pageOrderBefore`. A removed page
 * missing from the latter is therefore created at a negative index no ordering
 * entry names — and `pageOrderStatements` parks **by name** while it un-parks
 * **by sign**. So pass one drives whichever restored page was headed for that
 * same number onto the slot the recreated row is already sitting in: `23505` on
 * `@@unique([projectId, index])`, the whole Undo rolls back, and the reader can
 * never undo that edit. That is every case but one — the removed page was the
 * book's last and nothing has been appended since — where pass two instead
 * flips it back onto its pre-edit index, one past the end of the list just
 * renumbered without it, leaving a book a page longer than the `targetPages`
 * this revert writes beside it: `PAGE_COUNT_MISMATCH` at the next compile.
 *
 * Folding is the answer rather than an assertion because the revert **already**
 * recreates every `removedPages` row unconditionally, a few statements below.
 * Refusing would abandon a page whose prose the stamp is still holding, on a tap
 * that promised to put it back; numbering the rows it is going to create anyway
 * is what keeps the two halves describing one book. Position is not a guess: a
 * removed record carries the same pre-edit `index` its `pageOrderBefore` twin
 * would have, so it slots into the recorded sequence where it was.
 */
function recordedPageOrder(application: StructuralApplication): PageOrderEntry[] {
  const recorded = application.pageOrderBefore.map((entry) => ({ pageId: entry.pageId, index: entry.index }));
  const namedPageIds = new Set(recorded.map((entry) => entry.pageId));
  return [
    ...recorded,
    ...application.removedPages
      .filter((page) => !namedPageIds.has(page.id))
      .map((page) => ({ pageId: page.id, index: page.index }))
  ];
}

/**
 * The ordering to replay: the recorded one, held to exactly the pages the
 * project will have once the inserted rows are gone and the removed ones back.
 *
 * `pageOrderStatements` requires a list naming **every** page of the project.
 * Pass two brings every parked row back at once, so a page the list leaves out
 * keeps a positive index a parked row may be about to land on — `23505` when
 * they collide, and a silent hole in the numbering when they do not, which
 * nothing notices until a compile refuses the book for not being contiguous
 * from 1.
 *
 * The stamp cannot promise that on its own, because it describes the book as
 * the edit found it and the reader's Undo can arrive much later:
 * `undoLastBookEdit` picks the newest *undoable* operation, and `CONTINUE_BOOK`
 * is not one of those kinds — so a continuation appended on top of a structural
 * edit is still in the book when that edit is undone, and its pages appear in no
 * `pageOrderBefore`. A page the recorded order names may equally have gone, that
 * continuation's own crash compensation being one way.
 *
 * So the recorded pages go back in their recorded sequence, whatever the book
 * has gained keeps its order behind them — appending is the only way a page
 * arrives without a stamp, and the tail is where it arrived — and the whole list
 * is renumbered from 1. A book that never drifted lands on exactly the recorded
 * indexes, because those already run `1..n`.
 *
 * `recordedOrder` is {@link recordedPageOrder}'s answer rather than
 * `pageOrderBefore` itself, so that "recorded" means every page the stamp holds
 * and not just the list one of them lives in.
 */
function restoredPageOrder(
  recordedOrder: readonly PageOrderEntry[],
  application: StructuralApplication,
  currentPages: readonly { id: string; index: number; chapterId?: string | null }[]
): PageOrderEntry[] {
  const insertedPageIds = new Set(application.insertedPageIds);
  const survivors = currentPages
    .filter((page) => !insertedPageIds.has(page.id))
    .sort((left, right) => left.index - right.index);
  const livePageIds = new Set([
    ...survivors.map((page) => page.id),
    ...application.removedPages.map((page) => page.id)
  ]);
  const restored = [...recordedOrder]
    .filter((entry) => livePageIds.has(entry.pageId))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.pageId);
  const restoredPageIds = new Set(restored);
  const gained = survivors.filter((page) => !restoredPageIds.has(page.id)).map((page) => page.id);
  return [...restored, ...gained].map((pageId, offset) => ({ pageId, index: offset + 1 }));
}
