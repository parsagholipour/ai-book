import { type BookEditIntent } from "../bookEditIntent.js";
import { enqueueGenerationJob } from "../queue.js";
import {
  type MobileBookEditOperationRecord,
  type MobileManualBookEditResponseDto,
  type MobileProjectChatMessageRecord
} from "./dto.js";
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
import {
  exportProvenancePaths,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
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
    return { message, operation, contentRevision: editRevision?.contentRevision ?? null };
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
    include: { snapshots: true }
  });
  const operation = recentOperations.find(
    (candidate) => candidate.snapshots.length > 0 && jsonRecord(candidate.classifier).undoneAt === undefined
  );
  if (!operation) {
    return createAssistantChatMessage({
      projectId: project.id,
      parentId,
      content: "There’s no recent text edit I can undo on this book.",
      metadata: { intent, charged: false }
    });
  }

  const restoredPageIndexes: number[] = [];
  const previousAsset = previousAssetFromClassifier(operation.classifier);
  const demotedAsset = demotedAssetFromClassifier(operation.classifier);
  const contentRevision = await prisma.$transaction(async (tx) => {
    const editRevision = project.currentPlanId
      ? await tx.project.update({
          where: { id: project.id },
          data: { status: "EDITING", contentRevision: { increment: 1 } },
          select: { contentRevision: true }
        })
      : null;
    for (const snapshot of operation.snapshots) {
      const imagePrompt = imagePromptToRestore(snapshot.pageId, previousAsset, demotedAsset);
      await tx.page.update({
        where: { id: snapshot.pageId },
        data: {
          title: snapshot.titleBefore,
          markdown: snapshot.markdownBefore,
          summary: snapshot.summaryBefore,
          status: "COMPLETED",
          revision: { increment: 1 },
          ...(imagePrompt !== undefined ? { imagePrompt } : {})
        }
      });
      restoredPageIndexes.push(snapshot.pageIndex);
    }
    if (previousAsset) {
      await tx.imageAsset.updateMany({
        where: { id: previousAsset.id, projectId: project.id },
        data: { path: previousAsset.path, prompt: previousAsset.prompt, pageId: previousAsset.pageId }
      });
    }
    if (demotedAsset) {
      await tx.imageAsset.updateMany({
        where: { id: demotedAsset.id, projectId: project.id },
        data: { path: demotedAsset.path, prompt: demotedAsset.prompt, pageId: demotedAsset.pageId }
      });
    }
    await tx.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        classifier: jsonInputValue({
          ...jsonRecord(operation.classifier),
          undoneAt: new Date().toISOString()
        })
      }
    });
    return editRevision?.contentRevision ?? null;
  });
  restoredPageIndexes.sort((a, b) => a - b);

  if (project.currentPlanId && contentRevision !== null) {
    await queueUserEditExportRecompile(
      project.id,
      project.currentPlanId,
      project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE",
      { contentRevision }
    );
  }

  const pageText =
    restoredPageIndexes.length === 1
      ? `page ${restoredPageIndexes[0]}`
      : `pages ${restoredPageIndexes.join(", ")}`;
  return createAssistantChatMessage({
    projectId: project.id,
    parentId,
    content: `Done - I restored ${pageText} to how they were before “${operation.request.slice(0, 120)}” and I’m refreshing the exports. Undo is free.`,
    metadata: {
      intent,
      charged: false,
      undo: { operationId: operation.id, restoredPageIndexes }
    }
  });
}

function previousAssetFromClassifier(classifier: unknown): {
  id: string;
  pageId: string;
  path: string;
  prompt: string;
  imagePrompt?: string | null;
  destPageId?: string;
  destImagePrompt?: string | null;
} | null {
  const stored = jsonRecord(jsonRecord(classifier).previousAsset);
  if (
    typeof stored.id !== "string" ||
    !stored.id ||
    typeof stored.pageId !== "string" ||
    !stored.pageId ||
    typeof stored.path !== "string" ||
    !stored.path ||
    typeof stored.prompt !== "string"
  ) {
    return null;
  }
  return {
    id: stored.id,
    pageId: stored.pageId,
    path: stored.path,
    prompt: stored.prompt,
    ...(typeof stored.imagePrompt === "string" || stored.imagePrompt === null
      ? { imagePrompt: stored.imagePrompt }
      : {}),
    ...(typeof stored.destPageId === "string" && stored.destPageId ? { destPageId: stored.destPageId } : {}),
    ...(typeof stored.destImagePrompt === "string" || stored.destImagePrompt === null
      ? { destImagePrompt: stored.destImagePrompt }
      : {})
  };
}

function demotedAssetFromClassifier(classifier: unknown): {
  id: string;
  pageId: string;
  path: string;
  prompt: string;
  imagePrompt?: string | null;
} | null {
  const stored = jsonRecord(jsonRecord(classifier).demotedAsset);
  if (
    typeof stored.id !== "string" ||
    !stored.id ||
    typeof stored.pageId !== "string" ||
    !stored.pageId ||
    typeof stored.path !== "string" ||
    !stored.path ||
    typeof stored.prompt !== "string"
  ) {
    return null;
  }
  return {
    id: stored.id,
    pageId: stored.pageId,
    path: stored.path,
    prompt: stored.prompt,
    ...(typeof stored.imagePrompt === "string" || stored.imagePrompt === null
      ? { imagePrompt: stored.imagePrompt }
      : {})
  };
}

function imagePromptToRestore(
  pageId: string,
  previousAsset: ReturnType<typeof previousAssetFromClassifier>,
  demotedAsset: ReturnType<typeof demotedAssetFromClassifier>
): string | null | undefined {
  if (
    previousAsset &&
    previousAsset.pageId === pageId &&
    (typeof previousAsset.imagePrompt === "string" || previousAsset.imagePrompt === null)
  ) {
    return previousAsset.imagePrompt;
  }
  if (
    demotedAsset &&
    demotedAsset.pageId === pageId &&
    (typeof demotedAsset.imagePrompt === "string" || demotedAsset.imagePrompt === null)
  ) {
    return demotedAsset.imagePrompt;
  }
  if (
    previousAsset &&
    previousAsset.destPageId === pageId &&
    (typeof previousAsset.destImagePrompt === "string" || previousAsset.destImagePrompt === null)
  ) {
    return previousAsset.destImagePrompt;
  }
  return undefined;
}

export const UNDOABLE_EDIT_KINDS = [
  "LOCAL_PATCH",
  "PAGE_REWRITE",
  "CHAPTER_REGENERATE",
  "MANUAL_EDIT",
  "ADD_IMAGE",
  "MOVE_IMAGE",
  "REMOVE_IMAGE"
] as const;
