import {
  compilePolicyPayload,
  compilePublicationDedupeKey,
  compilePublicationPolicyFromPayload,
  createProjectSchema,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  jsonRecord,
  libraryCharactersFromMediaSettings,
  manuscriptWordCount,
  readerChaptersFromPublishedMarkdown,
  shortKidsStoryPageLayout,
  type CreateProjectInput
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { isRetryableTransactionConflict } from "../characterWriteBudget.js";
import { hasOpenProjectWork } from "../editOperations.js";
import { invalidateCompiledProjectExports } from "../manualEdits.js";
import { activeProjectChatLeafId, loadActiveProjectChatMessages } from "../projectChat.js";
import { inputSnapshotFromProject } from "../projectSummarySerializers.js";
import { jsonInputValue } from "../support.js";
import { chapterTextFromPages, loadBookSnapshot, newRowId, pageRefsOf, type BookSnapshot } from "./manuscriptBook.js";
import { bookChapterGroups, MANUSCRIPT_PROJECT_SELECT, type ManuscriptProject } from "./manuscriptDerivation.js";
import { PUBLISH_TRANSACTION_OPTIONS, sealEarlierOperations } from "./manuscriptPublish.js";
import { dispatchPublishAssists, enqueuePublishAssists, styleProfileDue } from "./manuscriptPublishAssists.js";
import {
  currentPublishedMeta,
  MANUSCRIPT_CAST_LIMIT,
  manuscriptSource,
  settingsJson,
  studioSettingsRecord,
  type ManuscriptDb,
  type ManuscriptSettings
} from "./manuscriptStore.js";
import {
  planTakeoverBook,
  planWithTakeoverChapters,
  takeoverArtStyle,
  takeoverStudioShape,
  type TakeoverBookPlan
} from "./manuscriptTakeoverPlan.js";

/**
 * Take over a generated book (`.scratch/writing-studio/takeover.md`): its owner
 * continues it as their own manuscript in the Writing Studio.
 *
 * Free, synchronous and idempotent by `requestId`. One transaction, under the
 * project lock, turns the finished generated book into what a Studio book looks
 * like after its first publish — provenance on the row *and* the plan's
 * snapshot (the worker compiles from the snapshot), the chapters the reader saw,
 * every hero illustration an inline line with its row detached, the generator's
 * page verdicts and image slots cleared, earlier edits sealed, a published
 * working copy — and queues the free recompile under the author rules.
 */

export class ManuscriptTakeoverRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const REFUSALS = {
  notReady: () =>
    new ManuscriptTakeoverRefusal(409, "BOOK_NOT_READY", "Only a finished book can move into the Writing Studio. Try again once it's done."),
  busy: () =>
    new ManuscriptTakeoverRefusal(
      409,
      "PROJECT_BUSY",
      "Your book is still being worked on. Try again once the current change finishes."
    ),
  narrating: () =>
    new ManuscriptTakeoverRefusal(409, "PROJECT_BUSY", "Your book is being narrated. Try again once the audiobook is ready."),
  retry: () =>
    new ManuscriptTakeoverRefusal(409, "TAKEOVER_RETRY", "Another change to this book landed at the same moment. Try again.")
} as const;

const SETTLED_STATUSES = new Set(["COMPLETE", "REVIEW_REQUIRED"]);

export type TakeoverOutcome = "taken_over" | "replayed" | "already_author";

function takenOverBy(mediaSettings: unknown, requestId: string): boolean {
  return studioSettingsRecord(mediaSettings).takeoverRequestId === requestId;
}

/** An unsettled book: EDITING is a change being applied right now; anything else is not finished. */
function statusRefusal(status: string): ManuscriptTakeoverRefusal | null {
  if (SETTLED_STATUSES.has(status)) return null;
  return status === "EDITING" ? REFUSALS.busy() : REFUSALS.notReady();
}

/** Why this book cannot be taken over right now, before any lock — the transaction asks again. */
async function refusalBeforeLock(project: ManuscriptProject): Promise<ManuscriptTakeoverRefusal | null> {
  const unsettled = statusRefusal(project.status);
  if (unsettled) return unsettled;
  if (!project.currentPlanId) return REFUSALS.notReady();
  return (await openWorkRefusal(prisma, project.id)) ?? null;
}

async function openWorkRefusal(db: ManuscriptDb, projectId: string): Promise<ManuscriptTakeoverRefusal | null> {
  // `hasOpenProjectWork` is the one definition of "a job owns this book"; the
  // operation re-count covers a chat Apply, which inserts its QUEUED operation
  // before the transaction that creates its job.
  const openOperations = await db.bookEditOperation.count({ where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } } });
  if (openOperations === 0 && !(await hasOpenProjectWork(projectId))) {
    return null;
  }
  const narrating = await db.generationJob.count({
    where: { projectId, type: "GENERATE_AUDIOBOOK", status: { in: ["QUEUED", "ACTIVE"] } }
  });
  return narrating > 0 ? REFUSALS.narrating() : REFUSALS.busy();
}

/** The published book's own markdown, for the chapters its reader saw. A missing file is no Contents. */
async function publishedBookMarkdown(projectId: string): Promise<string | undefined> {
  const bytes = await objectStore().get(objectKey("books", projectId, "book.md"));
  return bytes ? bytes.toString("utf8") : undefined;
}

type CommittedTakeover = { contentRevision: number; jobIds: string[]; assistJobIds: string[] };

function inputFromStoredSnapshot(snapshot: unknown, project: ManuscriptProject): CreateProjectInput {
  const parsed = createProjectSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : createProjectSchema.parse(inputSnapshotFromProject(project));
}

/**
 * The plan's snapshot with the Studio record and the real page count, every
 * other key kept: the compile reads provenance and `targetPages` off it, and
 * nothing else about how the book was made changes.
 */
function takenOverSnapshot(snapshot: unknown, project: ManuscriptProject, pageCount: number, nextMediaSettings: Record<string, unknown>) {
  if (!createProjectSchema.safeParse(snapshot).success) {
    return jsonInputValue(inputSnapshotFromProject({ ...project, targetPages: pageCount, mediaSettings: nextMediaSettings }));
  }
  const raw = jsonRecord(snapshot);
  const rawMedia = jsonRecord(raw.mediaSettings);
  const nextMobile = jsonRecord(nextMediaSettings.mobile);
  return jsonInputValue({
    ...raw,
    targetPages: pageCount,
    mediaSettings: {
      ...rawMedia,
      mobile: { ...jsonRecord(rawMedia.mobile), targetPages: pageCount, studio: nextMobile.studio }
    }
  });
}

/** Chapters and pages, in the order the unique indexes allow: slots, pages, detaches, then the surplus chapters. */
async function writeTakeoverRows(tx: ManuscriptDb, projectId: string, plan: TakeoverBookPlan): Promise<void> {
  for (const slot of plan.chapterSlots ?? []) {
    const data = { title: slot.title, summary: slot.summary, targetPages: slot.targetPages, status: "COMPLETED" as const };
    if (slot.create) {
      await tx.chapter.create({ data: { id: slot.id, projectId, index: slot.index, ...data } });
    } else if (plan.repartitioned) {
      // The row now holds other pages: what it knew about its old ones goes.
      await tx.chapter.update({ where: { id: slot.id }, data: { ...data, productionBrief: Prisma.DbNull } });
    } else {
      await tx.chapter.update({ where: { id: slot.id }, data: { title: slot.title } });
    }
  }
  if (plan.pageWrites.length > 0) {
    const rows = plan.pageWrites;
    await tx.$executeRaw`/* studio:takeover-pages */
      UPDATE "Page" AS p
         SET "markdown" = v."markdown", "chapterId" = v."chapterId", "revision" = p."revision" + 1, "updatedAt" = NOW()
        FROM unnest(${rows.map((row) => row.id)}::text[], ${rows.map((row) => row.markdown)}::text[],
                    ${rows.map((row) => row.chapterId)}::text[])
             AS v("id", "markdown", "chapterId")
       WHERE p."id" = v."id" AND p."projectId" = ${projectId}`;
  }
  // The generator's image slots and page verdicts no longer speak for the
  // author's book — and the author compile still reads `qualityReport` into its
  // verdict, so a stale one would flag a book nobody's pipeline wrote.
  await tx.page.updateMany({
    where: { projectId },
    data: { status: "COMPLETED", qualityReport: Prisma.DbNull, imagePrompt: null, imageFailureReason: null }
  });
  if (plan.detachImageIds.length > 0) {
    await tx.imageAsset.updateMany({ where: { projectId, id: { in: plan.detachImageIds } }, data: { pageId: null } });
  }
  if (plan.chapterDeleteIds.length > 0) {
    await tx.chapter.deleteMany({ where: { projectId, id: { in: plan.chapterDeleteIds } } });
  }
}

/** The working copy of the book as it now stands: every chapter published, nothing unpublished. */
async function createPublishedWorkingCopy(
  tx: ManuscriptDb,
  project: ManuscriptProject,
  book: BookSnapshot,
  settings: ManuscriptSettings,
  publishedAt: Date,
  requestId: string
): Promise<number> {
  const manuscriptId = newRowId("ms");
  const chapters = bookChapterGroups(book, project.title).map((group, offset) => {
    const markdown = chapterTextFromPages(group.pages, settings.layout);
    return {
      id: newRowId("mc"),
      manuscriptId,
      position: offset + 1,
      title: group.title,
      markdown,
      wordCount: manuscriptWordCount(markdown),
      revision: 1,
      publishedRevision: 1,
      publishedChapterId: group.chapterId,
      publishedPages: pageRefsOf(group.pages)
    };
  });
  await tx.manuscript.create({
    data: {
      id: manuscriptId,
      projectId: project.id,
      settings: settingsJson({ ...settings, published: currentPublishedMeta(project, settings) }),
      publishedOrder: chapters.map((chapter) => chapter.id),
      firstPublishedAt: publishedAt,
      lastPublishedAt: publishedAt,
      lastPublishRequestId: `takeover:${requestId}`
    }
  });
  await tx.manuscriptChapter.createMany({ data: chapters });
  return chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
}

async function takeOverInTransaction(
  tx: ManuscriptDb,
  options: { projectId: string; requestId: string; publishedMarkdown: string | undefined; chatParentId: string | null }
): Promise<CommittedTakeover | Exclude<TakeoverOutcome, "taken_over">> {
  const { projectId, requestId } = options;
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  const project = (await tx.project.findUnique({ where: { id: projectId }, select: MANUSCRIPT_PROJECT_SELECT })) as ManuscriptProject | null;
  if (!project) throw REFUSALS.notReady();
  if (manuscriptSource(project.mediaSettings) !== null) {
    return takenOverBy(project.mediaSettings, requestId) ? "replayed" : "already_author";
  }
  const plan = project.currentPlanId
    ? await tx.planVersion.findUnique({
        where: { id: project.currentPlanId },
        select: { id: true, status: true, planningPackage: true, inputSnapshot: true }
      })
    : null;
  const unsettled = statusRefusal(project.status);
  if (unsettled) throw unsettled;
  if (!plan || plan.status !== "APPROVED") throw REFUSALS.notReady();
  const busy = await openWorkRefusal(tx, projectId);
  if (busy) throw busy;
  const book = await loadBookSnapshot(tx, projectId);
  if (book.pages.length === 0) throw REFUSALS.notReady();

  // 1. What the book becomes: its Studio shape, the chapters its reader saw, each page's text.
  const input = inputFromStoredSnapshot(plan.inputSnapshot, project);
  const printsSeparateStoryPages =
    shortKidsStoryPageLayout(input, book.pages.map((page) => ({ index: page.index, markdown: page.markdown }))) === "separate";
  const { kind, layout } = takeoverStudioShape({ category: project.category, printsSeparateStoryPages });
  const readerChapters = options.publishedMarkdown
    ? readerChaptersFromPublishedMarkdown(options.publishedMarkdown, book.pages)
    : undefined;
  const rows = planTakeoverBook({ chapters: book.chapters, pages: book.pages, readerChapters, language: project.language });
  const hasPictures = book.pages.some((page) => page.heroPath !== null);
  const artStyle = takeoverArtStyle({
    plan: plan.planningPackage,
    imageStyle: jsonRecord(project.mediaSettings).imageStyle,
    hasPictures
  });
  const now = new Date();
  const studio = {
    layout,
    kind,
    createdAt: now.toISOString(),
    origin: "takeover",
    takeoverRequestId: requestId,
    ...(artStyle ? { artStyle } : {})
  };
  const mediaSettings = jsonRecord(project.mediaSettings);
  const pageCount = book.pages.length;
  const nextMediaSettings = { ...mediaSettings, mobile: { ...jsonRecord(mediaSettings.mobile), targetPages: pageCount, studio } };

  // 2. The rows: chapters, pages, pictures; then the plan and the project.
  await writeTakeoverRows(tx, projectId, rows);
  const replanned = rows.chapterSlots ? planWithTakeoverChapters(plan.planningPackage, rows.chapterSlots, rows.repartitioned) : null;
  await tx.planVersion.update({
    where: { id: plan.id },
    data: {
      inputSnapshot: takenOverSnapshot(plan.inputSnapshot, project, pageCount, nextMediaSettings),
      ...(replanned ? { planningPackage: jsonInputValue(replanned) } : {})
    }
  });
  const bumped = await tx.project.update({
    where: { id: projectId },
    data: {
      status: "EDITING",
      contentRevision: { increment: 1 },
      targetPages: pageCount,
      mediaSettings: jsonInputValue(nextMediaSettings)
    },
    select: { contentRevision: true }
  });
  const contentRevision = bumped.contentRevision;

  // 3. Undo writes snapshots with no revision check, and the takeover just
  // rewrote pages: an undo of an earlier chat edit would drop a picture's line
  // (its hero is detached now) or bring back a stripped heading.
  await sealEarlierOperations(tx, projectId, now.toISOString());
  const writtenIndexes = rows.pageWrites.map((page) => page.index).sort((left, right) => left - right);
  const operation = await tx.bookEditOperation.create({
    data: {
      projectId,
      requestId: `studio-takeover:${requestId}`,
      kind: "MANUSCRIPT_PUBLISH",
      status: "APPLIED",
      request: "Moved into the Writing Studio",
      classifier: jsonInputValue({ source: "writing_studio", takeover: true, firstPublish: false, pagesWritten: writtenIndexes.length, pagesRemoved: 0 }),
      affectedPageIndexes: writtenIndexes,
      creditsCharged: 0,
      appliedAt: now
    }
  });
  const message = await tx.projectChatMessage.create({
    data: {
      projectId,
      parentId: options.chatParentId,
      role: "ASSISTANT",
      content:
        "Your book is in the Writing Studio now. Write and edit it chapter by chapter there, then update the book when you're ready — I'm still here for changes.",
      operationId: operation.id,
      metadata: jsonInputValue({ charged: false, manuscriptPublish: { operationId: operation.id, takeover: true } })
    }
  });
  await tx.bookEditOperation.update({ where: { id: operation.id }, data: { assistantMessageId: message.id } });

  // 4. The working copy, from the book as the writes above left it.
  const castCharacterIds = libraryCharactersFromMediaSettings(project.mediaSettings)
    .map((character) => character.id)
    .filter((id, index, ids) => Boolean(id) && ids.indexOf(id) === index)
    .slice(0, MANUSCRIPT_CAST_LIMIT);
  const settings: ManuscriptSettings = {
    layout,
    kind,
    artStyle,
    goalWords: null,
    dedication: null,
    castCharacterIds,
    published: null
  };
  const takenOver = { ...project, mediaSettings: nextMediaSettings, targetPages: pageCount };
  const words = await createPublishedWorkingCopy(tx, takenOver, await loadBookSnapshot(tx, projectId), settings, now, requestId);

  // 5. The free recompile under the author rules — the publish's policy, a row
  // in this commit dispatched after it — and the voice pass the AI tools read.
  const policy = compilePublicationPolicyFromPayload({ skipFinalReview: true, [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING" });
  const compile = await enqueueGenerationJob({
    projectId,
    type: "COMPILE_EXPORT",
    dedupeKey: compilePublicationDedupeKey({ projectId, planId: plan.id, contentRevision, policy, projectStatus: "EDITING" }),
    contentRevision,
    payload: { planId: plan.id, contentRevision, ...compilePolicyPayload(policy, "EDITING") },
    transaction: tx,
    dispatch: false
  });
  const styleProfileOpen =
    (await tx.manuscriptAssist.count({ where: { projectId, kind: "STYLE_PROFILE", status: { in: ["QUEUED", "RUNNING"] } } })) > 0;
  const assistJobIds = await enqueuePublishAssists(tx, {
    projectId,
    publishRequestId: `takeover:${requestId}`,
    words,
    learnStyle: styleProfileDue({ studioBook: true, words, mediaSettings: nextMediaSettings, styleProfileOpen }),
    reembedPages: []
  });
  return { contentRevision, jobIds: [compile.id], assistJobIds };
}

/**
 * Take the book over. Resolves `"replayed"` for a request that already did,
 * `"already_author"` for a book that is already the author's (written,
 * imported or taken over by another request — nothing is written), and throws
 * `ManuscriptTakeoverRefusal` for every answer the app shows as a sentence.
 */
export async function takeOverGeneratedBook(options: {
  project: ManuscriptProject;
  requestId: string;
  bookStorageDir: string;
}): Promise<TakeoverOutcome> {
  const { project, requestId } = options;
  if (manuscriptSource(project.mediaSettings) !== null) {
    return takenOverBy(project.mediaSettings, requestId) ? "replayed" : "already_author";
  }
  const refusal = await refusalBeforeLock(project);
  if (refusal) throw refusal;
  const publishedMarkdown = await publishedBookMarkdown(project.id);
  const chatParentId = activeProjectChatLeafId(await loadActiveProjectChatMessages(project.id));
  let committed: CommittedTakeover | Exclude<TakeoverOutcome, "taken_over">;
  try {
    committed = await prisma.$transaction(
      (tx) => takeOverInTransaction(tx, { projectId: project.id, requestId, publishedMarkdown, chatParentId }),
      PUBLISH_TRANSACTION_OPTIONS
    );
  } catch (error) {
    // Undo and redo lock their operation row before the project, the reverse
    // of this order; nothing committed, and the app retries once.
    if (!(error instanceof ManuscriptTakeoverRefusal) && isRetryableTransactionConflict(error)) {
      throw REFUSALS.retry();
    }
    throw error;
  }
  if (typeof committed === "string") {
    return committed;
  }
  await invalidateCompiledProjectExports(options.bookStorageDir, project.id);
  try {
    for (const jobId of committed.jobIds) {
      await dispatchGenerationJob(jobId);
    }
  } catch (error) {
    // The pages are already the author's book; a book whose export the repair
    // lane can rebuild beats one sitting EDITING behind a compile that may never run.
    console.error(`Writing Studio takeover could not dispatch its compile for project ${project.id}`, error);
    await prisma.project
      .updateMany({ where: { id: project.id, status: "EDITING", contentRevision: committed.contentRevision }, data: { status: "COMPLETE" } })
      .catch(() => undefined);
  }
  await dispatchPublishAssists(committed.assistJobIds);
  return "taken_over";
}
