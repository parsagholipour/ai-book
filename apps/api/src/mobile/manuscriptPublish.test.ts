import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { deletePageEmbeddings } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { BookEditIntent } from "../bookEditIntent.js";
import { redoLastBookEdit } from "./bookEditRedoApply.js";
import { canRedoBookEdit } from "./bookEditRedo.js";
import { canUndoBookEdit, undoLastBookEdit } from "./manualEdits.js";
import type { ProjectForChat } from "./projectChat.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  mockQueue,
  openJobRow,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import {
  addChapter,
  AUTH,
  chatEditPage,
  createStudioBook,
  finishCompile,
  getManuscript,
  longProse,
  publish,
  saveChapter
} from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

/** A Studio book with a three-page chapter, a one-page chapter and an empty one. */
async function writtenBook(app: FastifyInstance) {
  const { body } = await createStudioBook(app);
  const projectId = body.project.id as string;
  const first = body.chapter.id as string;
  await saveChapter(app, projectId, { id: first, revision: 1, title: "The Keeper" }, longProse(9));
  const storm = (await addChapter(app, projectId, { title: "The Storm", requestId: "request-add-storm" })).json().chapter.id as string;
  await saveChapter(app, projectId, { id: storm, revision: 1, title: "The Storm" }, "The storm came in from the west.");
  const notes = (await addChapter(app, projectId, { title: "Notes", requestId: "request-add-notes" })).json().chapter.id as string;
  return { projectId, first, storm, notes };
}

function chapterRevision(chapterId: string): number {
  return db.manuscriptChapters.find((row) => row.id === chapterId)!.revision;
}

function pagesInOrder() {
  return [...db.pages].sort((left, right) => left.index - right.index);
}

describe("the first publish", () => {
  it("materializes the working copy into a plan, chapters and pages, and queues the compile and a designed cover", async () => {
    const app = await buildMobileApp();
    const { projectId, first, storm, notes } = await writtenBook(app);

    const response = await publish(app, projectId, "request-publish-0001");

    expect(response.statusCode).toBe(200);
    const pages = pagesInOrder();
    expect(pages.map((page) => [page.index, page.title, page.status])).toEqual([
      [1, "The Keeper · 1", "COMPLETED"],
      [2, "The Keeper · 2", "COMPLETED"],
      [3, "The Keeper · 3", "COMPLETED"],
      [4, "The Storm · 1", "COMPLETED"]
    ]);
    expect(pages[3]!.markdown).toBe("The storm came in from the west.");
    // A cut falls between paragraphs only, and no page ends with a heading.
    expect(pages.every((page) => page.markdown === page.markdown.trim())).toBe(true);
    const chapters = [...db.bookChapters].sort((left, right) => left.index - right.index);
    expect(chapters.map((chapter) => [chapter.index, chapter.title, chapter.targetPages])).toEqual([
      [1, "The Keeper", 3],
      [2, "The Storm", 1]
    ]);
    expect(pages.map((page) => page.chapterId)).toEqual([chapters[0]!.id, chapters[0]!.id, chapters[0]!.id, chapters[1]!.id]);

    const plan = db.planVersions[0]!;
    const project = db.projects[0]!;
    expect(plan).toMatchObject({ status: "APPROVED", version: 1 });
    expect(plan.inputSnapshot).toMatchObject({ targetPages: 4, mediaSettings: { mobile: { studio: { layout: "flow" } } } });
    expect(plan.planningPackage.chapters.map((chapter: { targetPages: number }) => chapter.targetPages)).toEqual([3, 1]);
    expect(plan.planningPackage.illustrationPlan.globalStyle).not.toMatch(/no illustrations/i);
    expect(project).toMatchObject({ status: "EDITING", contentRevision: 1, currentPlanId: plan.id, targetPages: 4 });

    expect(state.bookEditOperations).toHaveLength(1);
    const operation = state.bookEditOperations[0]!;
    expect(operation).toMatchObject({ kind: "MANUSCRIPT_PUBLISH", status: "APPLIED", creditsCharged: 0 });
    expect(operation).not.toHaveProperty("publicationRevision");
    expect(state.projectChatMessages.map((message) => message.content)).toEqual(["Book published from the Writing Studio."]);

    expect(db.enqueued.map((job) => [job.type, job.dispatch, job.contentRevision])).toEqual([
      ["COMPILE_EXPORT", false, 1],
      ["GENERATE_IMAGE", false, 1],
      // The free re-embed of every page this publish wrote (Phase 2).
      ["WRITING_ASSIST", false, undefined]
    ]);
    expect(db.enqueued[0]!.payload).toMatchObject({
      planId: plan.id,
      contentRevision: 1,
      skipFinalReview: true,
      exportPublicationProjectStatus: "EDITING"
    });
    expect(db.enqueued[0]!.dedupeKey).toMatch(new RegExp(`^compile-export:${projectId}:${plan.id}:revision-1:`));
    expect(db.enqueued[1]!.payload).toEqual({
      planId: plan.id,
      assetType: "COVER",
      contentRevision: 1,
      exportPublicationProjectStatus: "EDITING"
    });
    expect(db.enqueued[1]!.dedupeKey).toBe(`generate-cover:${projectId}:${plan.id}:revision-1:status-EDITING`);
    expect(mockQueue.dispatchGenerationJob.mock.calls.map((call) => call[0])).toEqual(["job-1", "job-2", "job-3"]);
    expect(db.assists).toEqual([
      expect.objectContaining({
        kind: "REEMBED",
        status: "QUEUED",
        creditsCharged: 0,
        generationJobId: "job-3",
        requestId: "publish:request-publish-0001:reembed",
        input: { pages: pages.map((page) => ({ pageId: page.id, index: page.index, revision: 1 })) }
      })
    ]);
    expect(db.enqueued[2]!.payload).toEqual({
      assistId: db.assists[0]!.id,
      pages: pages.map((page) => ({ pageId: page.id, index: page.index, revision: 1 }))
    });

    const body = response.json();
    expect(body.project).toMatchObject({ id: projectId, source: "written", status: "editing", hasPlan: true });
    expect(body.manuscript).toMatchObject({ published: true, hasUnpublishedChanges: false });
    expect(body.manuscript.chapters.map((chapter: { id: string; bookChapterId: string | null }) => [chapter.id, chapter.bookChapterId])).toEqual([
      [first, chapters[0]!.id],
      [storm, chapters[1]!.id],
      [notes, null]
    ]);
    expect(db.versions.filter((version) => version.reason === "PUBLISH").map((version) => version.chapterId).sort()).toEqual(
      [first, storm].sort()
    );
  });

  it("replays a retried request without publishing twice", async () => {
    const app = await buildMobileApp();
    const { projectId } = await writtenBook(app);

    await publish(app, projectId, "request-publish-0001");
    const again = await publish(app, projectId, "request-publish-0001");

    expect(again.statusCode).toBe(200);
    expect(state.bookEditOperations).toHaveLength(1);
    expect(db.enqueued).toHaveLength(3);
    expect(db.projects[0]!.contentRevision).toBe(1);
  });

  it("refuses an empty book, and a book with nothing new since the last publish", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const empty = await publish(app, body.project.id, "request-publish-empty");
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error.code).toBe("EMPTY_MANUSCRIPT");
    expect(db.projects[0]!.status).toBe("DRAFT");

    const { projectId } = await writtenBook(app);
    await publish(app, projectId, "request-publish-0001");
    finishCompile(db, projectId);
    const nothing = await publish(app, projectId, "request-publish-0002");
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json().error.code).toBe("NOTHING_TO_PUBLISH");
  });
});

describe("updating a published book", () => {
  it("reuses page and chapter rows by position as the book grows, then shrinks and reorders", async () => {
    const app = await buildMobileApp();
    const { projectId, first, storm, notes } = await writtenBook(app);
    await publish(app, projectId, "request-publish-0001");
    finishCompile(db, projectId);
    db.images.push({ id: "cover-1", projectId, pageId: null, type: "COVER", path: "/assets/images/p/cover.jpg", metadata: { coverArtSource: "design" } });
    const firstIds = pagesInOrder().map((page) => page.id);
    const planId = db.planVersions[0]!.id;

    // Grow: the first chapter gains a page, so the storm moves to page 5.
    await saveChapter(app, projectId, { id: first, revision: chapterRevision(first), title: "The Keeper" }, longProse(12));
    const grown = await publish(app, projectId, "request-publish-0002");

    expect(grown.statusCode).toBe(200);
    const afterGrow = pagesInOrder();
    expect(afterGrow.map((page) => page.title)).toEqual([
      "The Keeper · 1",
      "The Keeper · 2",
      "The Keeper · 3",
      "The Keeper · 4",
      "The Storm · 1"
    ]);
    expect(afterGrow.slice(0, 4).map((page) => page.id)).toEqual(firstIds);
    // Unchanged slots keep their revision; the slot that now holds new text moved on.
    expect(afterGrow.map((page) => page.revision)).toEqual([1, 1, 1, 2, 1]);
    expect(db.planVersions).toHaveLength(1);
    expect(db.planVersions[0]).toMatchObject({ id: planId, inputSnapshot: { targetPages: 5 } });
    expect(db.projects[0]).toMatchObject({ targetPages: 5, contentRevision: 2, status: "EDITING" });
    expect(state.projectChatMessages.at(-1)!.content).toBe("Book updated from the Writing Studio.");
    // The cover exists and its words did not change, so only the compile is
    // queued — and the re-embed of the two pages that moved on.
    expect(db.enqueued.slice(3).map((job) => job.type)).toEqual(["COMPILE_EXPORT", "WRITING_ASSIST"]);
    expect(db.enqueued[4]!.payload.pages).toEqual([
      { pageId: afterGrow[3]!.id, index: 4, revision: 2 },
      { pageId: afterGrow[4]!.id, index: 5, revision: 1 }
    ]);

    // Shrink and reorder: the storm opens the book, the keeper's chapter is cut
    // to one page, and the stored page map loses the pages it described.
    finishCompile(db, projectId);
    db.projects[0]!.pdfPageMap = {
      version: 2,
      totalPdfPages: 7,
      hasCoverPage: true,
      pages: [1, 2, 3, 4, 5].map((index) => ({ index, startPdfPage: index + 1, endPdfPage: index + 1 })),
      contentRevision: 2,
      pdfDigest: "digest-2"
    };
    const chapterSlotIds = [...db.bookChapters].sort((left, right) => left.index - right.index).map((chapter) => chapter.id);
    await app.inject({
      method: "POST",
      url: `/api/mobile/projects/${projectId}/manuscript/order`,
      headers: AUTH,
      payload: { chapterIds: [storm, first, notes] }
    });
    await saveChapter(app, projectId, { id: first, revision: chapterRevision(first), title: "The Keeper" }, "A single short page now.");
    vi.mocked(deletePageEmbeddings).mockClear();
    const shrunk = await publish(app, projectId, "request-publish-0003");

    expect(shrunk.statusCode).toBe(200);
    const afterShrink = pagesInOrder();
    expect(afterShrink.map((page) => [page.index, page.title, page.markdown])).toEqual([
      [1, "The Storm · 1", "The storm came in from the west."],
      [2, "The Keeper · 1", "A single short page now."]
    ]);
    expect(afterShrink.map((page) => page.id)).toEqual(firstIds.slice(0, 2));
    expect([...db.bookChapters].sort((left, right) => left.index - right.index).map((chapter) => [chapter.id, chapter.title])).toEqual([
      [chapterSlotIds[0], "The Storm"],
      [chapterSlotIds[1], "The Keeper"]
    ]);
    expect(db.projects[0]!.pdfPageMap).toMatchObject({ pages: [], hasCoverPage: true, contentRevision: 2, pdfDigest: "digest-2" });
    expect(db.projects[0]!.targetPages).toBe(2);
    const embeddingDrops = vi.mocked(deletePageEmbeddings).mock.calls[0]![2];
    expect([...embeddingDrops].sort()).toEqual(afterGrow.map((page) => page.id).sort());
  });

  it("redraws a designed cover when the words on it change", async () => {
    const app = await buildMobileApp();
    const { projectId } = await writtenBook(app);
    await publish(app, projectId, "request-publish-0001");
    finishCompile(db, projectId);
    db.images.push({ id: "cover-1", projectId, pageId: null, type: "COVER", path: "/assets/images/p/cover.jpg", metadata: { coverArtSource: "design" } });

    await app.inject({
      method: "PATCH",
      url: `/api/mobile/projects/${projectId}/manuscript/settings`,
      headers: AUTH,
      payload: { title: "The Last Lighthouse" }
    });
    const manuscript = await getManuscript(app, projectId);
    expect(manuscript.json().manuscript.hasUnpublishedChanges).toBe(true);
    const response = await publish(app, projectId, "request-publish-0002");

    expect(response.statusCode).toBe(200);
    // A retitle writes no page, so there is nothing to re-embed.
    expect(db.enqueued.slice(3).map((job) => job.type)).toEqual(["COMPILE_EXPORT", "GENERATE_IMAGE"]);
  });

  it("refuses while another job or a chat Apply owns the book, and writes nothing", async () => {
    const app = await buildMobileApp();
    const { projectId } = await writtenBook(app);
    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow()]);

    const busy = await publish(app, projectId, "request-publish-0001");
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe("PROJECT_BUSY");
    expect((await getManuscript(app, projectId)).json().manuscript.publishBlockedReason).toBe("busy");

    mockPrisma.generationJob.findMany.mockResolvedValue([]);
    state.bookEditOperations.push({ id: "operation-open", projectId, kind: "PAGE_REWRITE", status: "QUEUED", classifier: {} });
    const applying = await publish(app, projectId, "request-publish-0002");
    expect(applying.statusCode).toBe(409);
    expect(applying.json().error.code).toBe("PROJECT_BUSY");

    expect(db.pages).toEqual([]);
    expect(db.projects[0]).toMatchObject({ status: "DRAFT", contentRevision: 0 });
    expect(db.enqueued).toEqual([]);
  });

  it("refuses with BOOK_CHANGED when a chat edit wrote a page since the last publish", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await writtenBook(app);
    await publish(app, projectId, "request-publish-0001");
    finishCompile(db, projectId);
    chatEditPage(db, pagesInOrder()[0]!.id, "A chat edit rewrote the opening.");
    // The Studio has not been reopened, so this is still the pre-edit copy.
    await saveChapter(app, projectId, { id: first, revision: chapterRevision(first), title: "The Keeper" }, longProse(6));

    const response = await publish(app, projectId, "request-publish-0002");

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("BOOK_CHANGED");
    expect(pagesInOrder()[0]!.markdown).toBe("A chat edit rewrote the opening.");
  });

  it("answers a deadlock with a retryable 409 and leaves nothing behind", async () => {
    const app = await buildMobileApp();
    const { projectId } = await writtenBook(app);
    mockPrisma.$queryRaw.mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "P2034" }));

    const response = await publish(app, projectId, "request-publish-0001");

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PUBLISH_RETRY");
    expect(db.pages).toEqual([]);
    expect(db.manuscripts[0]!.lastPublishRequestId).toBeNull();
    expect((await publish(app, projectId, "request-publish-0001")).statusCode).toBe(200);
  });

  it("goes back to COMPLETE, never DRAFT, when its jobs cannot be dispatched", async () => {
    const app = await buildMobileApp();
    const { projectId } = await writtenBook(app);
    mockQueue.dispatchGenerationJob.mockRejectedValue(new Error("redis down"));

    const response = await publish(app, projectId, "request-publish-0001");

    expect(response.statusCode).toBe(200);
    expect(db.projects[0]).toMatchObject({ status: "COMPLETE", contentRevision: 1 });
    expect(db.pages).toHaveLength(4);
  });
});

describe("sealing chat history at a publish", () => {
  const undoIntent = { kind: "undo_last_edit", confidence: 1, reasoning: "", affectedPageIndexes: [], assistantMessage: "", scope: "none", impact: "small_text", clarification: "none" } as unknown as BookEditIntent;

  it("leaves Undo and Redo nothing to do for edits made before the publish", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await writtenBook(app);
    await publish(app, projectId, "request-publish-0001");
    finishCompile(db, projectId);
    const pageId = pagesInOrder()[0]!.id;
    // A manual edit that stays applied, and an undone chat edit Redo could restore.
    state.bookEditOperations.push(
      { id: "operation-manual", projectId, kind: "MANUAL_EDIT", status: "APPLIED", classifier: {}, appliedAt: new Date("2026-09-01T10:00:00Z"), createdAt: new Date("2026-09-01T10:00:00Z") },
      { id: "operation-undone", projectId, kind: "LOCAL_PATCH", status: "APPLIED", classifier: { undoneAt: "2026-09-02T10:00:00.000Z", redoable: true }, appliedAt: new Date("2026-08-30T10:00:00Z"), createdAt: new Date("2026-08-30T10:00:00Z") }
    );
    state.pageEditSnapshots.push(
      { id: "snapshot-1", operationId: "operation-manual", pageId, pageIndex: 1, titleBefore: "t", markdownBefore: "before", summaryBefore: "s", revisionBefore: 1 },
      { id: "snapshot-2", operationId: "operation-undone", pageId, pageIndex: 1, titleBefore: "t", markdownBefore: "b", summaryBefore: "s", revisionBefore: 1, markdownAfter: "after" }
    );
    const asRow = (id: string) => ({ ...state.bookEditOperations.find((operation) => operation.id === id)!, snapshotCount: 1 });
    expect(canUndoBookEdit(asRow("operation-manual"))).toBe(true);
    expect(canRedoBookEdit(asRow("operation-undone"))).toBe(true);

    await saveChapter(app, projectId, { id: first, revision: chapterRevision(first), title: "The Keeper" }, longProse(3));
    expect((await publish(app, projectId, "request-publish-0002")).statusCode).toBe(200);

    expect(state.bookEditOperations.find((operation) => operation.id === "operation-manual")!.classifier.sealedAt).toEqual(expect.any(String));
    expect(canUndoBookEdit(asRow("operation-manual"))).toBe(false);
    expect(canRedoBookEdit(asRow("operation-undone"))).toBe(false);
    const project = { id: projectId, status: "COMPLETE", currentPlanId: db.projects[0]!.currentPlanId, currentPlan: null } as unknown as ProjectForChat;
    const undo = await undoLastBookEdit(project, undoIntent, "chat-parent");
    const redo = await redoLastBookEdit(project, { ...undoIntent, kind: "redo_last_edit" } as BookEditIntent, "chat-parent");
    expect(undo.content).toBe("There’s no recent text edit I can undo on this book.");
    expect(redo.content).toBe("There’s no undone edit I can put back on this book.");
    // Neither touched the author's published page.
    expect(pagesInOrder()[0]!.markdown).not.toBe("before");
  });
});

describe("the pre-publish checklist", () => {
  it("names empty and untitled chapters, placeholders and an unclosed fence, and counts pages", async () => {
    const app = await buildMobileApp();
    const { projectId, storm, notes } = await writtenBook(app);
    await saveChapter(app, projectId, { id: storm, revision: chapterRevision(storm), title: "" }, "The storm came. TODO: the rescue.\n\n```\nunfinished code");

    const response = await publish(app, projectId, "request-dry-0001", true);

    expect(response.statusCode).toBe(200);
    const { checklist } = response.json();
    expect(checklist).toMatchObject({ firstPublish: true, estimatedPages: 4, changedChapters: 2 });
    expect(checklist.words).toBeGreaterThan(100);
    expect(checklist.items.map((item: { kind: string; chapterId: string | null; blocking: boolean }) => [item.kind, item.chapterId, item.blocking])).toEqual([
      ["untitled_chapter", storm, false],
      ["placeholder", storm, false],
      ["unclosed_fence", storm, false],
      ["empty_chapter", notes, false]
    ]);
    expect(db.pages).toEqual([]);
    expect(state.bookEditOperations).toEqual([]);
  });

  it("blocks an empty book", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const response = await publish(app, body.project.id, "request-dry-0002", true);
    expect(response.json().checklist.items).toEqual([
      expect.objectContaining({ kind: "empty_book", chapterId: null, blocking: true })
    ]);
  });
});
