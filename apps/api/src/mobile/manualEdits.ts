import { type BookEditIntent } from "../bookEditIntent.js";
import { enqueueGenerationJob } from "../queue.js";
import {
  type MobileBookEditOperationRecord,
  type MobileManualBookEditResponseDto,
  type MobileProjectChatMessageRecord
} from "./dto.js";
import {
  demotedImageAssetsFromClassifier,
  previousImageAssetsFromClassifier,
  type DemotedImageAssetRecord,
  type PreviousImageAssetRecord
} from "./imageEditRecords.js";
import {
  activeProjectChatLeafId,
  createAssistantChatMessage,
  loadActiveProjectChatMessages,
  loadProjectChatResponse,
  serializeBookEditOperation,
  serializeProjectChatMessage,
  type ProjectForChat
} from "./projectChat.js";
import { jsonInputValue, jsonRecord } from "./support.js";
import { rebuildStoryStateAfterUndo } from "./rebuildStoryState.js";
import {
  exportProvenancePaths,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS,
  bookPlanSchema,
  parseStructuralApplication,
  type StructuralApplication
} from "@book-maker/core";
import {
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS,
  Prisma,
  prisma,
  revertStructuralPageChange
} from "@book-maker/db";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Direct page edits made in the book editor, plus undo and export recompilation.
 */

export type ManualBookPageEdit = { id: string; title: string; markdown: string };

export type ManualBookPageRecord = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  revision: number;
  storyDelta?: unknown;
};

/** Reads the saved-export marker this feature stores on assistant messages. */
export function manualEditInfoFromMessage(message: MobileProjectChatMessageRecord): Record<string, unknown> | null {
  const manualEdit = jsonRecord(message.metadata).manualEdit;
  return manualEdit && typeof manualEdit === "object" && !Array.isArray(manualEdit)
    ? (manualEdit as Record<string, unknown>)
    : null;
}

/**
 * Removes compiled export files so downloads show "preparing" until the
 * re-compile lands.
 *
 * The provenance records go with them: they identify bytes rather than a
 * revision, so a surviving one could only ever describe a file that is no
 * longer there. Leaving them would be harmless — the next publication
 * overwrites its own, and a digest that matches nothing is reported as matching
 * nothing — but a record outliving its file has no reader and no meaning.
 */
export async function invalidateCompiledProjectExports(bookStorageDir: string, projectId: string): Promise<void> {
  const projectDir = join(bookStorageDir, projectId);
  await Promise.all(
    [
      ...["book.md", "README.md", "book.pdf", "book.epub"].map((filename) => join(projectDir, filename)),
      ...exportProvenancePaths(projectDir)
    ].map((path) => rm(path, { force: true }).catch(() => undefined))
  );
}

/**
 * Applies a user's Edit Mode changes: snapshots and updates the pages, records
 * a free APPLIED operation, and creates the saved-export chat message — or
 * updates the existing one in place when the user re-edited a saved export.
 */
export async function applyManualBookEdit(options: {
  projectId: string;
  currentPlanId: string | null;
  fallbackProjectStatus: "COMPLETE" | "REVIEW_REQUIRED";
  edits: ManualBookPageEdit[];
  pagesById: Map<string, ManualBookPageRecord>;
  savedExportMessage: MobileProjectChatMessageRecord | null;
  requestId?: string | undefined;
  bookStorageDir: string;
}): Promise<{ message: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord }> {
  const { projectId, edits, pagesById, savedExportMessage } = options;
  const affectedPageIndexes = edits.map((edit) => pagesById.get(edit.id)!.index).sort((a, b) => a - b);
  const parentId = savedExportMessage
    ? null
    : activeProjectChatLeafId(await loadActiveProjectChatMessages(projectId));

  const { message, operation, contentRevision } = await prisma.$transaction(async (tx) => {
    // Take the same project-row lock publication takes *before* changing a
    // page. A detached repair that claimed the previous revision either lands
    // first (and is deleted below) or observes EDITING/the new revision and
    // publishes nothing; it can no longer reinstall stale bytes between the
    // page commit and this revision bump.
    const editRevision = options.currentPlanId
      ? await tx.project.update({
          where: { id: projectId },
          data: { status: "EDITING", contentRevision: { increment: 1 } },
          select: { contentRevision: true }
        })
      : null;
    const operation = await tx.bookEditOperation.create({
      data: {
        projectId,
        ...(options.requestId ? { requestId: options.requestId } : {}),
        kind: "MANUAL_EDIT",
        status: "APPLIED",
        request: "Manual edit in Edit Mode",
        classifier: jsonInputValue({ source: "manual_edit_mode" }),
        affectedPageIndexes,
        creditsCharged: 0,
        appliedAt: new Date()
      }
    });

    for (const edit of edits) {
      const before = pagesById.get(edit.id)!;
      const saved = await tx.page.update({
        where: { id: edit.id },
        data: {
          title: edit.title,
          markdown: edit.markdown,
          status: "COMPLETED",
          revision: { increment: 1 }
        }
      });
      await tx.pageEditSnapshot.create({
        data: {
          projectId,
          pageId: edit.id,
          operationId: operation.id,
          pageIndex: before.index,
          titleBefore: before.title,
          markdownBefore: before.markdown,
          summaryBefore: before.summary,
          revisionBefore: before.revision,
          ...(before.storyDelta != null ? { storyDeltaBefore: before.storyDelta as Prisma.InputJsonValue } : {}),
          titleAfter: saved.title,
          markdownAfter: saved.markdown,
          summaryAfter: saved.summary,
          revisionAfter: saved.revision
        }
      });
    }

    let message: MobileProjectChatMessageRecord;
    if (savedExportMessage) {
      const previousInfo = manualEditInfoFromMessage(savedExportMessage) ?? {};
      const previousIndexes = Array.isArray(previousInfo.pageIndexes)
        ? previousInfo.pageIndexes.filter((value): value is number => typeof value === "number")
        : [];
      const mergedIndexes = [...new Set([...previousIndexes, ...affectedPageIndexes])].sort((a, b) => a - b);
      const previousEditCount = typeof previousInfo.editCount === "number" ? previousInfo.editCount : 1;
      message = await tx.projectChatMessage.update({
        where: { id: savedExportMessage.id },
        data: {
          content: manualEditMessageContent(mergedIndexes),
          operationId: operation.id,
          metadata: jsonInputValue({
            ...jsonRecord(savedExportMessage.metadata),
            manualEdit: {
              operationId: operation.id,
              pageIndexes: mergedIndexes,
              editCount: previousEditCount + 1,
              savedAt: new Date().toISOString()
            }
          })
        }
      });
    } else {
      message = await tx.projectChatMessage.create({
        data: {
          projectId,
          parentId,
          role: "ASSISTANT",
          content: manualEditMessageContent(affectedPageIndexes),
          operationId: operation.id,
          metadata: jsonInputValue({
            charged: false,
            manualEdit: {
              operationId: operation.id,
              pageIndexes: affectedPageIndexes,
              editCount: 1,
              savedAt: new Date().toISOString()
            }
          })
        }
      });
    }
    await tx.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: message.id }
    });
    return {
      message,
      // The row was read before this message existed, so its anchor would put
      // the card above the reply announcing the save.
      operation: { ...operation, assistantMessageId: message.id },
      contentRevision: editRevision?.contentRevision ?? null
    };
  });

  await invalidateCompiledProjectExports(options.bookStorageDir, projectId);
  if (options.currentPlanId && contentRevision !== null) {
    await queueUserEditExportRecompile(projectId, options.currentPlanId, options.fallbackProjectStatus, {
      contentRevision
    });
  }

  return { message, operation };
}

export async function replayManualBookEdit(
  projectId: string,
  requestId: string
): Promise<MobileManualBookEditResponseDto | null> {
  const operation = (await prisma.bookEditOperation.findFirst({
    where: { projectId, requestId },
    include: { generationJob: { select: { id: true, status: true } } }
  })) as MobileBookEditOperationRecord | null;
  if (!operation) return null;
  const message = (await prisma.projectChatMessage.findFirst({
    where: { projectId, operationId: operation.id, role: "ASSISTANT" }
  })) as MobileProjectChatMessageRecord | null;
  if (!message) return null;
  return {
    ...(await loadProjectChatResponse(projectId)),
    savedExportMessage: serializeProjectChatMessage(message),
    operation: serializeBookEditOperation(operation)
  };
}

/**
 * Queues the export recompile for a user-driven edit (manual edit or undo).
 * The project goes to EDITING while the compile runs so the mobile status
 * stream stays live and flips the export buttons once the files are rebuilt;
 * the compile job restores COMPLETE when it finishes. skipFinalReview keeps
 * the compile QA pass from rewriting text the user chose deliberately.
 *
 * `presentationOnly` says the manuscript itself did not move — a Sources toggle
 * or a chapter-heading restyle, never an edit to `Page.markdown`. Only the
 * verdict cares: with no final review this compile's report is the
 * deterministic checks alone, and for a reprint of unchanged prose that is a
 * *worse* statement than the one the last real QA pass made, not a newer one.
 * A manual edit or an undo leaves it off, because those do rewrite pages and
 * their fresh report has to replace findings about text that is gone.
 */
export async function queueUserEditExportRecompile(
  projectId: string,
  planId: string,
  fallbackStatus: "COMPLETE" | "REVIEW_REQUIRED" = "COMPLETE",
  options: { presentationOnly?: boolean; contentRevision?: number } = {}
): Promise<void> {
  const project = options.contentRevision === undefined
    ? await prisma.project.update({
        where: { id: projectId },
        data: { status: "EDITING", contentRevision: { increment: 1 } },
        select: { contentRevision: true }
      })
    : { contentRevision: options.contentRevision };
  try {
    await enqueueGenerationJob({
      projectId,
      type: "COMPILE_EXPORT",
      dedupeKey: `compile-export:${projectId}:${planId}:content-${project.contentRevision}`,
      contentRevision: project.contentRevision,
      payload: {
        planId,
        skipFinalReview: true,
        contentRevision: project.contentRevision,
        [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING",
        ...(options.presentationOnly
          ? {
              [PRESENTATION_ONLY_RECOMPILE]: true,
              [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: fallbackStatus
            }
          : {})
      }
    });
  } catch {
    // Without a queued compile nothing will restore COMPLETE, so put the
    // project back instead of stranding it in EDITING.
    await prisma.project
      .updateMany({
        where: { id: projectId, status: "EDITING", contentRevision: project.contentRevision },
        data: { status: fallbackStatus }
      })
      .catch(() => undefined);
  }
}

export function manualEditMessageContent(pageIndexes: number[]): string {
  const pageText =
    pageIndexes.length === 1 ? `page ${pageIndexes[0]}` : `pages ${pageIndexes.join(", ")}`;
  return `You edited ${pageText} yourself in Edit Mode. The exports are refreshing with your changes.`;
}

/**
 * Restores the before-snapshots of the most recent applied text edit, then
 * queues an export refresh. Free: nothing is regenerated.
 */
export async function undoLastBookEdit(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const recentOperations = await prisma.bookEditOperation.findMany({
    where: {
      projectId: project.id,
      status: "APPLIED",
      kind: { in: [...UNDOABLE_EDIT_KINDS] }
    },
    orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }],
    take: 10,
    include: {
      snapshots: true,
      _count: { select: { archivedSnapshots: true } }
    }
  });
  // A pure insert or reorder writes no snapshots — nothing existed before to
  // snapshot — so a snapshots-only filter skipped it and silently undid the
  // *previous, older* edit instead. The button the reader tapped is drawn from
  // `canUndoBookEdit` too, so the two cannot disagree about which row this is.
  // The status and kind are already filtered above; asking again is free and
  // keeps the whole rule in one place.
  const operation = recentOperations.find((candidate) =>
    canUndoBookEdit({
      status: candidate.status,
      kind: candidate.kind,
      classifier: candidate.classifier,
      snapshotCount: candidate.snapshots.length,
      archivedSnapshotCount: candidate._count?.archivedSnapshots ?? 0
    })
  );
  if (!operation) {
    return nothingToUndoReply(project.id, parentId, intent);
  }

  const fallbackStatus = project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
  // The same 30 s ceiling the apply side runs under, for the same reason: an
  // undo of a structural edit replays that edit's work backwards — raw index
  // shifts across every page after the anchor, two `PlanVersion` writes
  // carrying the whole plan JSON, the project and chapter rows — and then
  // restores every snapshot on top. Prisma's 5 s default aborts that midway on
  // a long book, which is a *worse* outcome than the apply timing out: the
  // reader tapped Undo on a book that is already theirs, and the recompile
  // queued after this block names the plan the revert reported restoring.
  // Nothing here is charged, so the ceiling costs a plain text undo nothing —
  // it is a limit, not a duration.
  const undone = await prisma.$transaction(async (tx) => {
    // First statement, the way `settleSkippedRestructure` opens with its APPLIED
    // claim: this conditional UPDATE takes the operation row's write lock, so
    // everything read after it — and the classifier merged at the end — is what
    // this transaction actually found rather than the copy the picker carried
    // in. The window is real and the row moves inside it: the worker's
    // `rollbackStructuralChange` reverts a half-applied shift, deletes
    // `structuralApplication` and adds `structuralRolledBackAt`, and the
    // `updateMany` that flips the row APPLIED -> FAILED afterwards is
    // `.catch()`ed, so both shapes have to be caught. A `count` of 0 is the
    // status half; the re-read below is the rest, asked with the same predicate
    // the button and the picker use rather than a second copy of it.
    const claimed = await tx.bookEditOperation.updateMany({
      where: { id: operation.id, status: "APPLIED" },
      data: { status: "APPLIED" }
    });
    const held =
      claimed.count === 0
        ? null
        : await tx.bookEditOperation.findUnique({
            where: { id: operation.id },
            select: { classifier: true }
          });
    if (
      !held ||
      !canUndoBookEdit({
        status: "APPLIED",
        kind: operation.kind,
        classifier: held.classifier,
        snapshotCount: operation.snapshots.length,
        archivedSnapshotCount: operation._count?.archivedSnapshots ?? 0
      })
    ) {
      // Nothing this Undo would revert, and refusing is the whole answer: the
      // picker takes the newest row *with* a record, so falling through to the
      // next one reverts the edit before this one under this one's
      // confirmation. Written before any other statement, so the project row is
      // never bumped into EDITING for a revert that does not happen.
      return null;
    }
    const previousAssets = previousImageAssetsFromClassifier(held.classifier);
    const demotedAssets = demotedImageAssetsFromClassifier(held.classifier);
    const structural = parseStructuralApplication(held.classifier);
    const restoredPageIndexes: number[] = [];
    const editRevision = project.currentPlanId
      ? await tx.project.update({
          where: { id: project.id },
          data: { status: "EDITING", contentRevision: { increment: 1 } },
          select: { contentRevision: true }
        })
      : null;
    // The plan the recompile below names, which is *not* the one this function
    // was handed once a structural edit is involved: that edit approved a plan
    // version of its own, and the revert deletes it. See `planIdAfterRevert`.
    let planId = project.currentPlanId;
    if (structural) {
      // Before the snapshot replay, not after: the replay keys on `pageId` and
      // is index-independent, but a combined insert-and-rewrite reports which
      // pages it restored, and those numbers only mean anything once the pages
      // are back where they were. Without this arm the replay would restore the
      // rewritten pages and leave the inserted ones in place — a half-undo,
      // and a book whose length no longer matches its plan version.
      ({ currentPlanId: planId } = await revertStructuralPageChange(tx, project.id, structural));
    }
    for (const snapshot of operation.snapshots) {
      const imagePrompt = imagePromptToRestore(snapshot.pageId, previousAssets, demotedAssets);
      await tx.page.update({
        where: { id: snapshot.pageId },
        data: {
          title: snapshot.titleBefore,
          markdown: snapshot.markdownBefore,
          summary: snapshot.summaryBefore,
          status: "COMPLETED",
          revision: { increment: 1 },
          storyDelta: storyDeltaToRestore(snapshot.storyDeltaBefore),
          ...(imagePrompt !== undefined ? { imagePrompt } : {})
        }
      });
      restoredPageIndexes.push(snapshot.pageIndex);
    }
    // Every picture the edit touched goes back where it was — a bulk remove
    // unlinked as many as the book had.
    for (const asset of [...previousAssets, ...demotedAssets]) {
      await tx.imageAsset.updateMany({
        where: { id: asset.id, projectId: project.id },
        data: { path: asset.path, prompt: asset.prompt, pageId: asset.pageId }
      });
    }
    await tx.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        classifier: jsonInputValue({
          // The copy read under the claim above, never the picker's: a whole
          // document merge writes back everything it was read with, and a
          // concurrent rollback's `structuralRolledBackAt` — or the stamp it
          // deleted — is exactly what that would reinstate.
          ...jsonRecord(held.classifier),
          undoneAt: new Date().toISOString()
        })
      }
    });
    return { contentRevision: editRevision?.contentRevision ?? null, planId, structural, restoredPageIndexes };
  }, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
  if (!undone) {
    return nothingToUndoReply(project.id, parentId, intent);
  }
  const { contentRevision, planId, structural, restoredPageIndexes } = undone;
  restoredPageIndexes.sort((a, b) => a - b);
  try {
    const parsed = bookPlanSchema.safeParse(project.currentPlan?.planningPackage);
    await rebuildStoryStateAfterUndo(project.id, parsed.success ? parsed.data.promises ?? [] : []);
  } catch (error) {
    console.warn(`Story state rebuild after undo skipped for project ${project.id}`, error);
  }

  if (contentRevision !== null) {
    if (planId) {
      await queueUserEditExportRecompile(project.id, planId, fallbackStatus, { contentRevision });
    } else {
      // A stamp that named the version it created but not the one it superseded
      // leaves the book with no plan to compile. Nothing can be queued, so put
      // the project back rather than stranding it in EDITING behind a compile
      // that is never coming — the same repair the enqueue failure path makes.
      await prisma.project
        .updateMany({
          where: { id: project.id, status: "EDITING", contentRevision },
          data: { status: fallbackStatus }
        })
        .catch(() => undefined);
    }
  }

  return createAssistantChatMessage({
    projectId: project.id,
    parentId,
    content: undoConfirmation(operation.request, structural, restoredPageIndexes),
    metadata: {
      intent,
      charged: false,
      undo: { operationId: operation.id, restoredPageIndexes }
    }
  });
}

/**
 * The one answer for "this Undo has nothing to revert", said in both places
 * that can reach it: no candidate at all, and a candidate the row lock found
 * had already been reverted — by the worker's rollback, or by an undo that
 * landed first.
 */
function nothingToUndoReply(
  projectId: string,
  parentId: string,
  intent: BookEditIntent
): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId,
    parentId,
    content: "There’s no recent text edit I can undo on this book.",
    metadata: { intent, charged: false }
  });
}

/**
 * What the undo reply says it put back.
 *
 * A pure insert, delete or move restores no page *text* — an inserted page had
 * nothing before it existed, and a delete or a move only changed which pages the
 * book has and in what order — so `PageEditSnapshot` rows are the wrong record
 * for it and it writes none. The sentence used to be built from those rows
 * alone, so undoing one of the three produced "I restored pages  to how they
 * were", an empty list rendered as an empty phrase. The structural stamp is the
 * undo record for those, so the *shape* it put back is what the sentence names
 * instead — and it names it without page numbers, because the numbers a
 * structural undo just moved are exactly the ones the reader would misread.
 *
 * A combined insert-and-rewrite reports both halves, since it undid both. The
 * final fallback cannot be reached — `undoLastBookEdit` only picks an operation
 * that has snapshots or a stamp — but the sentence has to say something rather
 * than trail off if that predicate and this one ever drift apart.
 */
function undoConfirmation(
  request: string,
  structural: StructuralApplication | null,
  restoredPageIndexes: number[]
): string {
  const restored =
    restoredPageIndexes.length === 0
      ? null
      : restoredPageIndexes.length === 1
        ? `restored page ${restoredPageIndexes[0]} to how it was`
        : `restored pages ${restoredPageIndexes.join(", ")} to how they were`;
  const shape =
    structural === null
      ? null
      : structural.action === "insert"
        ? "took the new pages back out"
        : structural.action === "delete"
          ? "put the deleted pages back"
          : "put the pages back in their original order";
  const undone =
    shape && restored ? `${shape} and ${restored}` : (shape ?? restored ?? "put the book back to how it was");
  return `Done - I ${undone} to undo “${request.slice(0, 120)}”, and I’m refreshing the exports. Undo is free.`;
}

/**
 * The `imagePrompt` a page had before the edit, or undefined to leave it alone.
 *
 * Three ways a page can appear in an image edit, in precedence order: it held
 * the picture that moved or was removed, it held a hero that a move demoted, or
 * it received the picture. A page can be more than one of those in a single
 * batch — the picture leaving page 3 while another arrives — and the *source*
 * reading wins, because that is the value the page had before anything ran.
 */
function imagePromptToRestore(
  pageId: string,
  previousAssets: PreviousImageAssetRecord[],
  demotedAssets: DemotedImageAssetRecord[]
): string | null | undefined {
  const source = previousAssets.find(
    (asset) => asset.pageId === pageId && (typeof asset.imagePrompt === "string" || asset.imagePrompt === null)
  );
  if (source) {
    return source.imagePrompt;
  }
  const demoted = demotedAssets.find(
    (asset) => asset.pageId === pageId && (typeof asset.imagePrompt === "string" || asset.imagePrompt === null)
  );
  if (demoted) {
    return demoted.imagePrompt;
  }
  const dest = previousAssets.find(
    (asset) =>
      asset.destPageId === pageId &&
      (typeof asset.destImagePrompt === "string" || asset.destImagePrompt === null)
  );
  return dest ? dest.destImagePrompt : undefined;
}

/** SQL NULL when the page had no extract; otherwise the snapshotted JSON. */
function storyDeltaToRestore(storyDeltaBefore: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return storyDeltaBefore == null ? Prisma.DbNull : (storyDeltaBefore as Prisma.InputJsonValue);
}

export const UNDOABLE_EDIT_KINDS = [
  "LOCAL_PATCH",
  "PAGE_REWRITE",
  "CHAPTER_REGENERATE",
  "MANUAL_EDIT",
  "ADD_IMAGE",
  "MOVE_IMAGE",
  "REMOVE_IMAGE",
  "RESTRUCTURE_PAGES"
] as const;

/**
 * What an undo has to put back — the record an applied edit leaves behind.
 *
 * Two shapes, because an edit either rewrote pages or moved them. Everything
 * that rewrites text or touches an illustration is restored from its
 * `PageEditSnapshot` rows, so it needs at least one; a structural edit
 * snapshots nothing — it changes *which* pages the book has, and a removed
 * page's snapshot would cascade away with the page it describes — and is
 * restored from the `structuralApplication` stamp instead, written in the
 * transaction that shifted the indexes and erased by the rollback.
 *
 * This is also what "See changes" opens, which is why it is one function:
 * an operation with no record has nothing to review and nothing to undo.
 */
export function hasBookEditUndoRecord(operation: {
  classifier?: unknown;
  snapshotCount: number;
  archivedSnapshotCount?: number;
}): boolean {
  if (parseStructuralApplication(operation.classifier) !== null) {
    return true;
  }
  // One archived row means a multi-page snapshot set may be incomplete. The
  // live rows cannot safely advertise a partial diff or Undo while any page it
  // originally covered is absent.
  return operation.snapshotCount > 0 && (operation.archivedSnapshotCount ?? 0) === 0;
}

/**
 * The one rule the Undo button and the undo itself both have to express: an
 * edit is undoable only when undoing would revert *that* edit.
 *
 * `undoLastBookEdit` takes the newest operation with a record (above) that has
 * not already been undone, so an APPLIED row without one is not "an undo that
 * does nothing" — it is an undo of whatever edit came *before* it, on a button
 * the reader tapped expecting this one. `operationCanUndo` used to name the
 * ways a record can be missing instead of asking for the record: a layout edit
 * that found nothing (`classifier.layoutMissing`) and a structural one the
 * worker declined (`classifier.structuralSkipped`). Enumerating them is how
 * the other two shapes were missed — a rolled-back structural apply, where
 * `rollbackStructuralChange` erases the stamp inside the revert's transaction
 * and the `updateMany` that flips the row FAILED afterwards is `.catch()`ed,
 * and an exact-mode edit whose pages all stopped matching, where
 * `applyBookEdit` deletes the snapshots of the pages it skipped. Both leave an
 * APPLIED row with neither marker.
 *
 * The count has to come from the caller because the two sides read it
 * differently — a `_count` on the chat query, the included rows in the picker —
 * and a caller that cannot supply one must pass 0: a missing Undo button is a
 * degraded state, an Undo that reverts someone else's edit is a lost edit.
 */
export function canUndoBookEdit(operation: {
  status: string;
  kind: string;
  classifier?: unknown;
  snapshotCount: number;
  archivedSnapshotCount?: number;
}): boolean {
  if (operation.status !== "APPLIED") {
    return false;
  }
  if (!(UNDOABLE_EDIT_KINDS as readonly string[]).includes(operation.kind)) {
    return false;
  }
  if (!hasBookEditUndoRecord(operation)) {
    return false;
  }
  return jsonRecord(operation.classifier).undoneAt === undefined;
}
