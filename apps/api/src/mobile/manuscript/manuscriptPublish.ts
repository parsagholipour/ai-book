import {
  bookPdfCoverNumbering,
  bookPlanSchema,
  compilePolicyPayload,
  compilePublicationDedupeKey,
  compilePublicationPolicyFromPayload,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  includeCoverForSource,
  jsonRecord,
  parseStoredBookPdfPageMap,
  synthesizeAuthorBookPlan,
  type AuthorPlanCharacter,
  type BookPlan
} from "@book-maker/core";
import { deletePageContinuityNotes, deletePageEmbeddings, Prisma, prisma } from "@book-maker/db";
import { copyrightRestrictionsEnabled } from "../../contentRestrictions.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { isRetryableTransactionConflict } from "../characterWriteBudget.js";
import { hasOpenProjectWork } from "../editOperations.js";
import { imageSettingsFromMediaSettings } from "../imageSettings.js";
import { invalidateCompiledProjectExports } from "../manualEdits.js";
import { activeProjectChatLeafId, loadActiveProjectChatMessages } from "../projectChat.js";
import { inputSnapshotFromProject } from "../projectSummarySerializers.js";
import { rebuildStoryStateAfterUndo } from "../rebuildStoryState.js";
import { jsonInputValue } from "../support.js";
import { loadBookSnapshot, detectBookDrift } from "./manuscriptBook.js";
import { castPlanCharacters, loadCastCharacters } from "./manuscriptCast.js";
import { assertPublishContentAllowed } from "./manuscriptContentScreen.js";
import { ensureManuscript, type ManuscriptProject } from "./manuscriptDerivation.js";
import { dispatchPublishAssists, enqueuePublishAssists, styleProfileDue } from "./manuscriptPublishAssists.js";
import {
  buildPublishChecklist,
  MAX_BOOK_PAGES,
  paginateWorkingCopy,
  planBookSlots,
  type BookSlotPlan,
  type PaginatedWorkingCopy
} from "./manuscriptPublishPlan.js";
import type { PublishChecklistDto } from "./manuscriptDto.js";
import {
  chapterHasUnpublishedChanges,
  claimManuscript,
  coverMetaChanged,
  currentPublishedMeta,
  liveChapters,
  loadManuscript,
  manuscriptHasUnpublishedChanges,
  manuscriptIsPublished,
  manuscriptSource,
  parseManuscriptSettings,
  publishedMetaEqual,
  settingsJson,
  styleProfileFromMediaSettings,
  writeChapterVersion,
  type LoadedManuscript,
  type ManuscriptDb,
  type ManuscriptSettings
} from "./manuscriptStore.js";

/**
 * Publish: the working copy becomes the book people read and export.
 *
 * Synchronous in the API and free, modelled on `applyManualBookEdit`: one
 * transaction (a 120 s ceiling, the import's, because a long book rewrites
 * hundreds of rows in it) with set-based page writes, then the compile and —
 * on a first publish or a retitled designed cover — the cover, dispatched after
 * commit. Each step below exists because of a hazard measured in the plan
 * (`.scratch/writing-studio/plan.md`, "Publish"); read it before reordering.
 */

export class ManuscriptPublishRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const PUBLISH_TRANSACTION_OPTIONS = { timeout: 120_000, maxWait: 10_000 } as const;

const REFUSALS = {
  busy: () =>
    new ManuscriptPublishRefusal(
      409,
      "PROJECT_BUSY",
      "Your book is still being worked on. Publish again once the current job finishes."
    ),
  bookChanged: () =>
    new ManuscriptPublishRefusal(
      409,
      "BOOK_CHANGED",
      "Your book was changed outside the Studio. Review the changes, then publish again."
    ),
  nothing: () => new ManuscriptPublishRefusal(409, "NOTHING_TO_PUBLISH", "Your book already has every change."),
  empty: () =>
    new ManuscriptPublishRefusal(409, "EMPTY_MANUSCRIPT", "There's nothing to publish yet. Write something in a chapter first."),
  tooLong: () =>
    new ManuscriptPublishRefusal(
      409,
      "MANUSCRIPT_TOO_LONG",
      `A book can have up to ${MAX_BOOK_PAGES} pages. Combine some pages before publishing.`
    ),
  retry: () =>
    new ManuscriptPublishRefusal(409, "PUBLISH_RETRY", "Another change to this book landed at the same moment. Try again.")
} as const;

/** The pre-publish checklist. Reads only, takes no lock. */
export async function publishChecklist(project: ManuscriptProject): Promise<PublishChecklistDto> {
  const manuscript = await ensureManuscript(project);
  const settings = parseManuscriptSettings(manuscript.settings);
  return buildPublishChecklist({
    liveChapters: liveChapters(manuscript.chapters),
    deletedPublishedChapters: manuscript.chapters.filter(
      (chapter) => chapter.deletedAt !== null && chapter.publishedRevision !== null
    ).length,
    layout: settings.layout,
    firstPublish: !manuscriptIsPublished(project.mediaSettings, manuscript.firstPublishedAt)
  });
}

/**
 * The plan this publish writes. Synthesized from the working copy — no model
 * call — with the book's own characters so references and chat pictures keep
 * working; when there is no style profile to re-derive the voice from, the
 * previous plan's understanding of the book (premise, voice, promises) is kept
 * and only its chapters, characters and illustration style are replaced.
 */
async function authorPlan(
  tx: ManuscriptDb,
  project: ManuscriptProject,
  settings: ManuscriptSettings,
  paginated: PaginatedWorkingCopy,
  previousPackage: unknown
): Promise<BookPlan> {
  // The author's cast first (the story bible's library characters, resolved
  // now so a rename there is a rename here), then any per-book character row
  // the cast does not already name.
  const cast = castPlanCharacters(await loadCastCharacters(project.userId, settings.castCharacterIds, tx));
  const castNames = new Set(cast.map((character) => character.name.trim().toLowerCase()));
  const bookCharacters = await tx.character.findMany({
    where: { projectId: project.id },
    select: { name: true, role: true, description: true, visualRules: true }
  });
  const characters: AuthorPlanCharacter[] = [
    ...cast,
    ...bookCharacters
      .filter((character) => !castNames.has(character.name.trim().toLowerCase()))
      .map((character) => ({
        name: character.name,
        role: character.role,
        description: character.description,
        visualRules: Array.isArray(character.visualRules)
          ? character.visualRules.filter((rule): rule is string => typeof rule === "string")
          : []
      }))
  ];
  const style = styleProfileFromMediaSettings(project.mediaSettings);
  const synthesized = synthesizeAuthorBookPlan({
    title: project.title,
    subtitle: project.subtitle,
    kind: settings.kind,
    chapters: paginated.chapters.map((chapter) => ({
      title: chapter.title,
      summary: chapter.summary,
      pageCount: chapter.pages.length
    })),
    artStyle: settings.artStyle,
    characters,
    style
  });
  const previous = bookPlanSchema.safeParse(previousPackage);
  if (style || !previous.success) {
    return synthesized;
  }
  const { subtitle: _previousSubtitle, ...kept } = previous.data;
  return bookPlanSchema.parse({
    ...kept,
    title: synthesized.title,
    ...(synthesized.subtitle ? { subtitle: synthesized.subtitle } : {}),
    chapters: synthesized.chapters,
    characters: synthesized.characters.length > 0 ? synthesized.characters : previous.data.characters,
    illustrationPlan: synthesized.illustrationPlan
  });
}

/**
 * A page map whose ranges name pages this publish removed cannot stand; the
 * cover-numbering stub a structural delete leaves (`repointedPageMapUpdate`)
 * keeps the one fact still true of the PDF on screen — whether it numbers its
 * cover — stamped as the stored map was.
 */
function shrunkPageMap(stored: unknown): Prisma.InputJsonValue | undefined {
  const parsed = parseStoredBookPdfPageMap(stored);
  if (!parsed) {
    return undefined;
  }
  return jsonInputValue({
    ...bookPdfCoverNumbering(parsed.hasCoverPage, parsed.version),
    ...(parsed.contentRevision === undefined ? {} : { contentRevision: parsed.contentRevision }),
    ...(parsed.pdfDigest === undefined ? {} : { pdfDigest: parsed.pdfDigest })
  });
}

/**
 * Chapters and pages, set-based. Order matters twice: surplus pages go first,
 * so a created page never meets an index a doomed one still holds; surplus
 * chapters go last, after every page has been pointed at its new chapter.
 */
async function writeBookSlots(tx: ManuscriptDb, projectId: string, slots: BookSlotPlan): Promise<void> {
  const rewrittenPageIds = [...slots.pageUpdates.map((page) => page.id), ...slots.pageDeleteIds];
  await deletePageEmbeddings(tx, projectId, rewrittenPageIds);
  await deletePageContinuityNotes(tx, projectId, rewrittenPageIds);
  if (slots.pageDeleteIds.length > 0) {
    await tx.page.deleteMany({ where: { projectId, id: { in: slots.pageDeleteIds } } });
  }
  if (slots.chapterUpdates.length > 0) {
    const rows = slots.chapterUpdates;
    await tx.$executeRaw`/* studio:update-chapters */
      UPDATE "Chapter" AS c
         SET "title" = v."title", "summary" = v."summary", "targetPages" = v."targetPages",
             "productionBrief" = NULL, "status" = 'COMPLETED', "updatedAt" = NOW()
        FROM unnest(${rows.map((row) => row.id)}::text[], ${rows.map((row) => row.title)}::text[],
                    ${rows.map((row) => row.summary)}::text[], ${rows.map((row) => row.targetPages)}::int[])
             AS v("id", "title", "summary", "targetPages")
       WHERE c."id" = v."id" AND c."projectId" = ${projectId}`;
  }
  if (slots.chapterCreates.length > 0) {
    await tx.chapter.createMany({
      data: slots.chapterCreates.map((chapter) => ({ ...chapter, projectId, status: "COMPLETED" }))
    });
  }
  if (slots.pageUpdates.length > 0) {
    const rows = slots.pageUpdates;
    // Every derived field the old text owned goes with it: the image prompt and
    // failure (the picture is inline markdown now), the QA verdict and the
    // story delta (both describe prose that no longer exists).
    await tx.$executeRaw`/* studio:update-pages */
      UPDATE "Page" AS p
         SET "title" = v."title", "markdown" = v."markdown", "summary" = v."summary", "chapterId" = v."chapterId",
             "imagePrompt" = NULL, "imageFailureReason" = NULL, "qualityReport" = NULL, "storyDelta" = NULL,
             "status" = 'COMPLETED', "revision" = p."revision" + 1, "updatedAt" = NOW()
        FROM unnest(${rows.map((row) => row.id)}::text[], ${rows.map((row) => row.title)}::text[],
                    ${rows.map((row) => row.markdown)}::text[], ${rows.map((row) => row.summary)}::text[],
                    ${rows.map((row) => row.chapterId)}::text[])
             AS v("id", "title", "markdown", "summary", "chapterId")
       WHERE p."id" = v."id" AND p."projectId" = ${projectId}`;
  }
  if (slots.pageCreates.length > 0) {
    await tx.page.createMany({
      data: slots.pageCreates.map((page) => ({ ...page, projectId, status: "COMPLETED" }))
    });
  }
  if (slots.detachImageIds.length > 0) {
    await tx.imageAsset.updateMany({ where: { projectId, id: { in: slots.detachImageIds } }, data: { pageId: null } });
  }
  if (slots.chapterDeleteIds.length > 0) {
    await tx.chapter.deleteMany({ where: { projectId, id: { in: slots.chapterDeleteIds } } });
  }
}

/**
 * Seals every applied edit before this publish.
 *
 * Undo and Redo write their snapshots with no revision check — they restore
 * *text*, and after a publish that text is the author's. A chat Undo of an edit
 * made before the publish would therefore overwrite what the author just
 * published. `canUndoBookEdit` and `canRedoBookEdit` refuse a sealed row; undo
 * across a publish is the Studio's version history instead. One statement, and
 * guarded against a classifier that is not an object, which `||` would turn
 * into an array.
 */
export async function sealEarlierOperations(tx: ManuscriptDb, projectId: string, sealedAt: string): Promise<void> {
  await tx.$executeRaw`/* studio:seal-operations */
    UPDATE "BookEditOperation"
       SET "classifier" = "classifier" || jsonb_build_object('sealedAt', ${sealedAt}::text), "updatedAt" = NOW()
     WHERE "projectId" = ${projectId}
       AND "status" = 'APPLIED'
       AND jsonb_typeof("classifier") = 'object'
       AND ("classifier" -> 'sealedAt') IS NULL`;
}

type CommittedPublish = {
  contentRevision: number;
  planId: string;
  promises: string[];
  jobIds: string[];
  /** The free style-profile and re-embed passes; dispatched on their own, best-effort. */
  assistJobIds: string[];
};

async function publishInTransaction(
  tx: ManuscriptDb,
  options: {
    project: ManuscriptProject;
    manuscriptId: string;
    requestId: string;
    chatParentId: string | null;
    copyrightRestrictionsEnabled: boolean;
  }
): Promise<CommittedPublish | "replayed"> {
  const { project: projectAtRequest, requestId } = options;
  const projectId = projectAtRequest.id;
  // 1. Lock the project — the row publication and every edit lock — then ask
  // whether it is free. `hasOpenProjectWork` is the one definition of "a job
  // owns this book"; the operation re-count covers a chat Apply, which inserts
  // its QUEUED operation before the transaction that creates its job.
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  await claimManuscript(tx, options.manuscriptId);
  const manuscript = await loadManuscript(tx, projectId);
  const project = (await tx.project.findUnique({ where: { id: projectId } })) as ManuscriptProject | null;
  if (!manuscript || !project) {
    throw REFUSALS.bookChanged();
  }
  if (manuscript.lastPublishRequestId === requestId) {
    return "replayed";
  }
  const openOperations = await tx.bookEditOperation.count({ where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } } });
  if (openOperations > 0 || (await hasOpenProjectWork(projectId))) {
    throw REFUSALS.busy();
  }

  // 2. Drift, under the lock. A chat edit, Edit Mode, a picture, a restructure,
  // a continuation or an undo may have written pages since the author last
  // opened the Studio; overwriting them would silently throw away (paid) work,
  // so the app re-derives and shows its conflict cards instead.
  const book = await loadBookSnapshot(tx, projectId);
  const drift = detectBookDrift(manuscript.chapters, book);
  const live = liveChapters(manuscript.chapters);
  if (drift.drifted.size > 0 || drift.unmapped.length > 0 || live.some((chapter) => chapter.conflictDetectedAt !== null)) {
    throw REFUSALS.bookChanged();
  }
  const settings = parseManuscriptSettings(manuscript.settings);
  const published = manuscriptIsPublished(project.mediaSettings, manuscript.firstPublishedAt);
  const meta = currentPublishedMeta(project, settings);
  const metaChanged = settings.published !== null && !publishedMetaEqual(settings.published, meta);
  if (
    published &&
    !manuscriptHasUnpublishedChanges({ liveChapters: live, publishedOrder: manuscript.publishedOrder, published, metaChanged })
  ) {
    throw REFUSALS.nothing();
  }

  // 3. Paginate, then land the pages on the rows by position.
  const paginated = paginateWorkingCopy(live, settings.layout);
  if (paginated.pageCount === 0) throw REFUSALS.empty();
  if (paginated.pageCount > MAX_BOOK_PAGES) throw REFUSALS.tooLong();
  // The content screen, on exactly the text this commit is about to write and
  // before it writes any: what changed since the last publish and prints
  // (`manuscriptContentScreen.ts`). A refusal rolls back the lot.
  assertPublishContentAllowed(
    {
      chapters: live,
      printedChapterIds: new Set(paginated.chapters.map((chapter) => chapter.workingChapterId)),
      published: settings.published,
      meta
    },
    options.copyrightRestrictionsEnabled
  );
  const slots = planBookSlots({ paginated, existingChapters: book.chapters, existingPages: book.pages });
  await writeBookSlots(tx, projectId, slots);

  // 4. The plan: the first publish writes an APPROVED version, and every later
  // one updates it in place. A new version per publish would drop the voice
  // cast, which is scoped to `currentPlanId`, and re-run the uncharged
  // character preparation for a book whose cast did not change.
  const previousPlan = project.currentPlanId
    ? await tx.planVersion.findUnique({
        where: { id: project.currentPlanId },
        select: { id: true, status: true, planningPackage: true }
      })
    : null;
  const plan = await authorPlan(tx, project, settings, paginated, previousPlan?.planningPackage);
  // Whether this publish draws a cover, decided before the snapshot is
  // written because the cover job reads its source off that snapshot. A book
  // with no cover gets one — on its first publish, and on any later one whose
  // predecessor's cover was cancelled as stale before it ran. A designed cover
  // is re-rendered when the words on it changed (the worker keeps the design
  // and makes no model call); an AI or uploaded cover is never redrawn for a
  // retitle — an upload's metadata says `source: "upload"` and carries no
  // `coverArtSource`, so it can never match.
  const coverSource = imageSettingsFromMediaSettings(project.mediaSettings).coverArtSource;
  const cover = await tx.imageAsset.findFirst({ where: { projectId, type: "COVER" }, select: { metadata: true } });
  const redrawDesign =
    cover !== null && jsonRecord(cover.metadata).coverArtSource === "design" && coverMetaChanged(settings.published, meta);
  const drawCover = coverSource !== "none" && (cover === null || redrawDesign);
  const mediaSettings = jsonRecord(project.mediaSettings);
  const nextMediaSettings = {
    ...mediaSettings,
    // A cover publish draws is always a design — publish is free, and the paid
    // AI artwork is its own request (`manuscriptCover.ts`). Said explicitly so
    // an old "ai" choice left on the book cannot buy artwork nobody paid for.
    ...(drawCover ? { coverArtSource: "design", includeCover: includeCoverForSource("design") } : {}),
    mobile: { ...jsonRecord(mediaSettings.mobile), targetPages: slots.pageCount }
  };
  const inputSnapshot = jsonInputValue(
    inputSnapshotFromProject({ ...project, targetPages: slots.pageCount, mediaSettings: nextMediaSettings })
  );
  let planId: string;
  if (previousPlan) {
    await tx.planVersion.update({
      where: { id: previousPlan.id },
      data: {
        planningPackage: jsonInputValue(plan),
        inputSnapshot,
        // Already APPROVED for every book that reaches here; said again so a
        // current plan left in any other state cannot hold the compile back.
        ...(previousPlan.status === "APPROVED" ? {} : { status: "APPROVED" as const, approvedAt: new Date() })
      }
    });
    planId = previousPlan.id;
  } else {
    const latest = await tx.planVersion.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { version: true }
    });
    const created = await tx.planVersion.create({
      data: {
        projectId,
        version: (latest?.version ?? 0) + 1,
        status: "APPROVED",
        approvedAt: new Date(),
        planningPackage: jsonInputValue(plan),
        inputSnapshot,
        messages: []
      },
      select: { id: true }
    });
    planId = created.id;
  }

  // 5. The project: EDITING until the compile publishes, a new revision, and a
  // page map that no longer names pages this publish removed.
  const pageMap = slots.shrank ? shrunkPageMap(project.pdfPageMap) : undefined;
  const bumped = await tx.project.update({
    where: { id: projectId },
    data: {
      status: "EDITING",
      contentRevision: { increment: 1 },
      currentPlanId: planId,
      targetPages: slots.pageCount,
      mediaSettings: jsonInputValue(nextMediaSettings),
      ...(pageMap !== undefined ? { pdfPageMap: pageMap } : {})
    },
    select: { contentRevision: true }
  });
  const contentRevision = bumped.contentRevision;

  // 6. The edit record. Free and APPLIED, and deliberately *without*
  // `publicationRevision`: manual edits do not stamp it either, and a stamped
  // one makes the compile's publication claim stand down whenever a cover job
  // exists — which a first publish always queues. Sealing first, so the new
  // row is the one edit a chat Undo cannot reach past.
  const now = new Date();
  await sealEarlierOperations(tx, projectId, now.toISOString());
  const firstPublish = !published;
  const writtenPageIndexes = [...slots.pageUpdates, ...slots.pageCreates].map((page) => page.index).sort((a, b) => a - b);
  const operation = await tx.bookEditOperation.create({
    data: {
      projectId,
      requestId: `studio-publish:${requestId}`,
      kind: "MANUSCRIPT_PUBLISH",
      status: "APPLIED",
      request: firstPublish ? "Published from the Writing Studio" : "Updated from the Writing Studio",
      classifier: jsonInputValue({
        source: "writing_studio",
        firstPublish,
        pagesWritten: writtenPageIndexes.length,
        pagesRemoved: slots.pageDeleteIds.length
      }),
      affectedPageIndexes: writtenPageIndexes,
      creditsCharged: 0,
      appliedAt: now
    }
  });
  const message = await tx.projectChatMessage.create({
    data: {
      projectId,
      parentId: options.chatParentId,
      role: "ASSISTANT",
      content: firstPublish ? "Book published from the Writing Studio." : "Book updated from the Writing Studio.",
      operationId: operation.id,
      metadata: jsonInputValue({ charged: false, manuscriptPublish: { operationId: operation.id } })
    }
  });
  await tx.bookEditOperation.update({ where: { id: operation.id }, data: { assistantMessageId: message.id } });

  // 7. The working copy's own bookkeeping: what each chapter published as, a
  // publish version of every chapter that changed, and the deleted chapters
  // purged — their pages just left the book.
  for (const chapter of live) {
    const landed = slots.published.get(chapter.id);
    if (chapterHasUnpublishedChanges(chapter)) {
      await writeChapterVersion(tx, chapter.id, "PUBLISH", {
        title: chapter.title,
        markdown: chapter.markdown,
        wordCount: chapter.wordCount
      });
    }
    await tx.manuscriptChapter.update({
      where: { id: chapter.id },
      data: {
        publishedRevision: chapter.revision,
        publishedChapterId: landed?.bookChapterId ?? null,
        publishedPages: landed?.pages ?? []
      }
    });
  }
  await tx.manuscriptChapter.deleteMany({ where: { manuscriptId: manuscript.id, deletedAt: { not: null } } });
  const nextSettings: ManuscriptSettings = { ...settings, published: meta };
  await tx.manuscript.update({
    where: { id: manuscript.id },
    data: {
      settings: settingsJson(nextSettings),
      publishedOrder: live.map((chapter) => chapter.id),
      ...(manuscript.firstPublishedAt ? {} : { firstPublishedAt: now }),
      lastPublishedAt: now,
      lastPublishRequestId: requestId
    }
  });

  // 8. Jobs, as durable rows in this commit and dispatched after it (the
  // `presentationEdits.ts` handoff): a crash between the two leaves rows the
  // undispatched-job sweep recovers, never a published revision with no
  // compile to finish it. The compile skips final review — nothing may rewrite
  // the author's words — and stands down while a cover is open; the cover's
  // completion queues it again.
  const policy = compilePublicationPolicyFromPayload({
    skipFinalReview: true,
    [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING"
  });
  const compile = await enqueueGenerationJob({
    projectId,
    type: "COMPILE_EXPORT",
    dedupeKey: compilePublicationDedupeKey({ projectId, planId, contentRevision, policy, projectStatus: "EDITING" }),
    contentRevision,
    payload: { planId, contentRevision, ...compilePolicyPayload(policy, "EDITING") },
    transaction: tx,
    dispatch: false
  });
  const jobIds = [compile.id];
  if (drawCover) {
    // Shaped like `maybeEnqueueRevisionOwnedReplanCover`: the revision and the
    // EDITING expectation ride the payload, so the worker's stale guard stands
    // it down if the author publishes again before it runs.
    const coverJob = await enqueueGenerationJob({
      projectId,
      type: "GENERATE_IMAGE",
      dedupeKey: `generate-cover:${projectId}:${planId}:revision-${contentRevision}:status-EDITING`,
      contentRevision,
      payload: { planId, assetType: "COVER", contentRevision, exportPublicationProjectStatus: "EDITING" },
      transaction: tx,
      dispatch: false
    });
    jobIds.push(coverJob.id);
  }
  // 9. The free passes: the author's voice (a Studio book past 2,000 words, or
  // doubled since its last profile) and the memory of every page this publish
  // wrote. The re-embed names each page by id, index and revision, and the
  // worker writes only while the page still is that.
  const words = live.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const styleProfileOpen =
    (await tx.manuscriptAssist.count({
      where: { projectId, kind: "STYLE_PROFILE", status: { in: ["QUEUED", "RUNNING"] } }
    })) > 0;
  const assistJobIds = await enqueuePublishAssists(tx, {
    projectId,
    publishRequestId: requestId,
    words,
    learnStyle: styleProfileDue({
      studioBook: manuscriptSource(project.mediaSettings) === "written",
      words,
      mediaSettings: project.mediaSettings,
      styleProfileOpen
    }),
    reembedPages: [...slots.pageUpdates, ...slots.pageCreates]
      .map((page) => ({ pageId: page.id, index: page.index, revision: page.revision }))
      .sort((left, right) => left.index - right.index)
  });
  return { contentRevision, planId, promises: plan.promises ?? [], jobIds, assistJobIds };
}

/**
 * Publish the working copy. Resolves `"replayed"` when this requestId already
 * published, and throws `ManuscriptPublishRefusal` for every answer the app
 * shows as a sentence.
 */
export async function publishManuscript(options: {
  project: ManuscriptProject;
  requestId: string;
  bookStorageDir: string;
}): Promise<"published" | "replayed"> {
  const { project, requestId } = options;
  const manuscript: LoadedManuscript = await ensureManuscript(project);
  if (manuscript.lastPublishRequestId === requestId) {
    return "replayed";
  }
  // The operator's copyright flag is a query on another pool connection, so it
  // is read here rather than under the lock; a failed read fails the publish.
  const [chatMessages, copyright] = await Promise.all([
    loadActiveProjectChatMessages(project.id),
    copyrightRestrictionsEnabled()
  ]);
  const chatParentId = activeProjectChatLeafId(chatMessages);
  let committed: CommittedPublish | "replayed";
  try {
    committed = await prisma.$transaction(
      (tx) =>
        publishInTransaction(tx, {
          project,
          manuscriptId: manuscript.id,
          requestId,
          chatParentId,
          copyrightRestrictionsEnabled: copyright
        }),
      PUBLISH_TRANSACTION_OPTIONS
    );
  } catch (error) {
    // Undo and Redo lock their operation row before the project — the reverse
    // of the order this takes them in — so the two can deadlock. Nothing
    // committed; the app retries once.
    if (!(error instanceof ManuscriptPublishRefusal) && isRetryableTransactionConflict(error)) {
      throw REFUSALS.retry();
    }
    throw error;
  }
  if (committed === "replayed") {
    return "replayed";
  }

  await invalidateCompiledProjectExports(options.bookStorageDir, project.id);
  try {
    for (const jobId of committed.jobIds) {
      await dispatchGenerationJob(jobId);
    }
  } catch (error) {
    // Nothing that will publish is guaranteed to run, so the book goes back to
    // COMPLETE — a published book whose export the repair lane can rebuild —
    // rather than sitting EDITING behind a compile that may never come. Never
    // DRAFT: the pages are already the author's published book.
    console.error(`Writing Studio publish could not dispatch its jobs for project ${project.id}`, error);
    await prisma.project
      .updateMany({
        where: { id: project.id, status: "EDITING", contentRevision: committed.contentRevision },
        data: { status: "COMPLETE" }
      })
      .catch(() => undefined);
  }
  await dispatchPublishAssists(committed.assistJobIds);
  try {
    await rebuildStoryStateAfterUndo(project.id, committed.promises);
  } catch (error) {
    console.warn(`Story state rebuild after a Writing Studio publish skipped for project ${project.id}`, error);
  }
  return "published";
}
