import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { FastifyInstance } from "fastify";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import { buildMobileApp, mockAccessTokens, resetMobileHarness, state, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import {
  AUTH,
  chatEditPage,
  createStudioBook,
  finishCompile,
  getChapter,
  getManuscript,
  longProse,
  patchSettings,
  publish,
  saveChapter,
  seedImportedBook
} from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

function pagesInOrder() {
  return [...db.pages].sort((left, right) => left.index - right.index);
}

function chapterRow(chapterId: string) {
  return db.manuscriptChapters.find((row) => row.id === chapterId)!;
}

/** A published two-chapter Studio book, settled as the worker leaves it. */
async function publishedBook(app: FastifyInstance) {
  const { body } = await createStudioBook(app);
  const projectId = body.project.id as string;
  const first = body.chapter.id as string;
  await saveChapter(app, projectId, { id: first, revision: 1, title: "The Keeper" }, longProse(3));
  const storm = (
    await app.inject({
      method: "POST",
      url: `/api/mobile/projects/${projectId}/manuscript/chapters`,
      headers: AUTH,
      payload: { title: "The Storm", requestId: "request-add-storm" }
    })
  ).json().chapter.id as string;
  await saveChapter(app, projectId, { id: storm, revision: 1, title: "The Storm" }, "The storm came in from the west.");
  expect((await publish(app, projectId, "request-publish-0001")).statusCode).toBe(200);
  finishCompile(db, projectId);
  return { projectId, first, storm };
}

describe("opening an imported book in the Studio", () => {
  it.each(["For my mother", "برای مادرم", "Für meine Mutter"])("preserves the imported dedication %s when publishing an unrelated chapter edit", async (dedication) => {
    const app = await buildMobileApp();
    const projectId = seedImportedBook(db);
    const matter = { dedication, aboutAuthor: "Ada writes stories.", copyrightHolder: "Ada" };
    db.projects[0]!.bookMatter = matter;

    const opened = await getManuscript(app, projectId);
    expect(opened.statusCode).toBe(200);
    const { manuscript } = opened.json();
    expect.soft(manuscript.dedication).toBe(dedication);
    expect(manuscript.hasUnpublishedChanges).toBe(false);
    expect((await saveChapter(app, projectId, manuscript.chapters[0], "Updated harbour text.")).statusCode).toBe(200);

    expect((await publish(app, projectId, "request-import-dedication")).statusCode).toBe(200);
    expect(db.projects[0]!.bookMatter).toEqual(matter);
  });

  it("allows an author to clear the imported dedication in Studio settings", async () => {
    const app = await buildMobileApp();
    const projectId = seedImportedBook(db);
    db.projects[0]!.bookMatter = { dedication: "For my mother", aboutAuthor: "Ada writes stories." };
    await getManuscript(app, projectId);

    expect((await patchSettings(app, projectId, { dedication: "" })).statusCode).toBe(200);
    expect((await publish(app, projectId, "request-clear-import-dedication")).statusCode).toBe(200);
    expect(db.projects[0]!.bookMatter).toEqual({ aboutAuthor: "Ada writes stories." });
  });

  it("derives a clean working copy from its chapters and pages, carrying a hero illustration as an image line", async () => {
    const app = await buildMobileApp();
    const projectId = seedImportedBook(db);

    const response = await getManuscript(app, projectId);

    expect(response.statusCode).toBe(200);
    const { manuscript } = response.json();
    expect(manuscript).toMatchObject({
      source: "imported",
      layout: "flow",
      published: true,
      hasUnpublishedChanges: false,
      title: "Imported Tales",
      authorName: "Ada"
    });
    expect(manuscript.chapters.map((chapter: Record<string, unknown>) => [chapter.title, chapter.bookChapterId, chapter.hasUnpublishedChanges])).toEqual([
      ["The Harbour", "chapter-a", false],
      ["The Storm", "chapter-b", false]
    ]);
    const harbour = await getChapter(app, projectId, manuscript.chapters[0].id);
    expect(harbour.json().chapter.markdown).toBe(
      `![Illustration](/assets/images/${projectId}/page-1.jpg)\n\nThe harbour was quiet at dawn.\n\nBoats rocked against the pier.`
    );

    // Opening twice makes nothing twice.
    await getManuscript(app, projectId);
    expect(db.manuscripts).toHaveLength(1);
    expect(db.manuscriptChapters).toHaveLength(2);
    const list = await app.inject({ method: "GET", url: "/api/mobile/projects", headers: AUTH });
    expect(list.json().projects[0]).toMatchObject({ source: "imported", manuscript: { chapterCount: 2, published: true } });
  });

  it("waits for a running import", async () => {
    const app = await buildMobileApp();
    const projectId = seedImportedBook(db, { status: "GENERATING" });
    const response = await getManuscript(app, projectId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("BOOK_NOT_READY");
  });

  it("publishes the hero as an inline picture, detaching the row the compile would print twice", async () => {
    const app = await buildMobileApp();
    const projectId = seedImportedBook(db);
    const { manuscript } = (await getManuscript(app, projectId)).json();
    const storm = manuscript.chapters[1];
    await saveChapter(app, projectId, { id: storm.id, revision: storm.revision, title: "The Storm" }, "Then the storm came in from the west, and it did not stop.");

    const response = await publish(app, projectId, "request-publish-import");

    expect(response.statusCode).toBe(200);
    const pages = pagesInOrder();
    expect(pages[0]!.markdown).toContain(`![Illustration](/assets/images/${projectId}/page-1.jpg)`);
    expect(db.images.find((image) => image.id === "image-hero")!.pageId).toBeNull();
    expect(db.planVersions).toHaveLength(1);
    expect(db.planVersions[0]!.inputSnapshot).toMatchObject({ targetPages: pages.length });
    expect(state.projectChatMessages.at(-1)!.content).toBe("Book updated from the Writing Studio.");
  });
});

describe("the book changing underneath the working copy", () => {
  it("refreshes a chapter with no unpublished edits silently after a chat edit", async () => {
    const app = await buildMobileApp();
    const { projectId, first, storm } = await publishedBook(app);
    const stormPage = pagesInOrder().find((page) => page.title === "The Storm · 1")!;
    chatEditPage(db, stormPage.id, "The storm came in from the east, all at once.");
    const revisionBefore = chapterRow(storm).revision;

    const response = await getManuscript(app, projectId);

    expect(response.statusCode).toBe(200);
    const chapter = response.json().manuscript.chapters.find((candidate: { id: string }) => candidate.id === storm);
    expect(chapter).toMatchObject({ hasConflict: false, hasUnpublishedChanges: false, revision: revisionBefore + 1 });
    expect(chapterRow(storm).markdown).toBe("The storm came in from the east, all at once.");

    // Nothing is in the way of the next update any more.
    await saveChapter(app, projectId, { id: first, revision: chapterRow(first).revision, title: "The Keeper" }, longProse(4));
    expect((await publish(app, projectId, "request-publish-0002")).statusCode).toBe(200);
    expect(pagesInOrder().at(-1)!.markdown).toBe("The storm came in from the east, all at once.");
  });

  it("raises a conflict over unpublished edits, refuses to publish past it, and settles it either way", async () => {
    const app = await buildMobileApp();
    const { projectId, storm } = await publishedBook(app);
    const stormPage = pagesInOrder().find((page) => page.title === "The Storm · 1")!;
    await saveChapter(app, projectId, { id: storm, revision: chapterRow(storm).revision, title: "The Storm" }, "My own new storm.");
    chatEditPage(db, stormPage.id, "The chat's storm.");

    const opened = (await getManuscript(app, projectId)).json().manuscript;
    expect(opened.chapters.find((chapter: { id: string }) => chapter.id === storm)).toMatchObject({ hasConflict: true, hasUnpublishedChanges: true });
    const card = (await getChapter(app, projectId, storm)).json().chapter;
    expect(card).toMatchObject({ markdown: "My own new storm.", conflict: { title: "The Storm", markdown: "The chat's storm." } });

    const refused = await publish(app, projectId, "request-publish-0002");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("BOOK_CHANGED");
    const checklist = (await publish(app, projectId, "request-dry-0002", true)).json().checklist;
    expect(checklist.items).toContainEqual(expect.objectContaining({ kind: "conflict", chapterId: storm, blocking: true }));

    // Keep mine: the book's version is kept as a version, and publish goes through.
    const mine = await saveChapter(app, projectId, { id: storm, revision: card.revision, title: "The Storm" }, "My own new storm.", {
      resolveConflict: "mine"
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().chapter).toMatchObject({ hasConflict: false, hasUnpublishedChanges: true });
    expect(db.versions.find((version) => version.chapterId === storm && version.reason === "CONFLICT")!.markdown).toBe("The chat's storm.");
    expect((await publish(app, projectId, "request-publish-0003")).statusCode).toBe(200);
    expect(pagesInOrder().at(-1)!.markdown).toBe("My own new storm.");
  });

  it("uses the book's version when the author chooses it, keeping theirs as a version", async () => {
    const app = await buildMobileApp();
    const { projectId, storm } = await publishedBook(app);
    const stormPage = pagesInOrder().find((page) => page.title === "The Storm · 1")!;
    await saveChapter(app, projectId, { id: storm, revision: chapterRow(storm).revision, title: "The Storm" }, "My own new storm.");
    chatEditPage(db, stormPage.id, "The chat's storm.");
    await getManuscript(app, projectId);

    const book = await saveChapter(app, projectId, { id: storm, revision: chapterRow(storm).revision, title: "The Storm" }, "ignored", {
      resolveConflict: "book"
    });

    expect(book.statusCode).toBe(200);
    expect(book.json().chapter).toMatchObject({ hasConflict: false, hasUnpublishedChanges: false });
    expect(chapterRow(storm).markdown).toBe("The chat's storm.");
    expect(db.versions.find((version) => version.chapterId === storm && version.reason === "CONFLICT")!.markdown).toBe("My own new storm.");
    expect((await getManuscript(app, projectId)).json().manuscript.hasUnpublishedChanges).toBe(false);
  });

  it("appends a chapter a continuation added, as already published", async () => {
    const app = await buildMobileApp();
    const { projectId } = await publishedBook(app);
    const nextIndex = db.pages.length + 1;
    db.bookChapters.push({ id: "chapter-continued", projectId, index: 3, title: "The Calm", summary: "", targetPages: 1, status: "COMPLETED" });
    db.pages.push({
      id: "page-continued",
      projectId,
      index: nextIndex,
      chapterId: "chapter-continued",
      title: "The Calm",
      markdown: "Morning came, and the sea was flat.",
      summary: "",
      status: "COMPLETED",
      revision: 1
    });

    const { manuscript } = (await getManuscript(app, projectId)).json();

    expect(manuscript.chapters.at(-1)).toMatchObject({ title: "The Calm", bookChapterId: "chapter-continued", hasUnpublishedChanges: false, position: 3 });
    expect(manuscript.hasUnpublishedChanges).toBe(false);
    const nothing = await publish(app, projectId, "request-publish-0002");
    expect(nothing.json().error.code).toBe("NOTHING_TO_PUBLISH");
  });
});
