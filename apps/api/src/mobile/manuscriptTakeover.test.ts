import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { compileBookMarkdownWithPageAnchors, isAuthorManuscript, studioSettingsFromMediaSettings } from "@book-maker/core";
import type { FastifyInstance } from "fastify";
import { AUTHOR_BOOK_REPLAN_MESSAGE, refuseAuthorBookReplan } from "./authorBookReplan.js";
import { canUndoBookEdit } from "./manualEdits.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  appliedEditOperationRecord,
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  openJobRow,
  resetMobileHarness,
  state,
  teardownMobileHarness,
  writeProjectFile
} from "./testing/mobileApiHarness.js";
import { getChapter, getManuscript, publish, saveChapter, seedGeneratedBook, takeOver } from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;
let app: FastifyInstance;

beforeEach(async () => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
  app = await buildMobileApp();
});
afterEach(teardownMobileHarness);

const project = (id = "project-gen") => db.projects.find((row) => row.id === id)!;
const plan = (id = "project-gen") => db.planVersions.find((row) => row.projectId === id)!;
const pagesOf = (id = "project-gen") => db.pages.filter((row) => row.projectId === id).sort((a, b) => a.index - b.index);
const figure = '```figure\n{"kind":"bar","title":"Ships","categories":["1950","1960"],"series":[{"name":"Ships","values":[3,5]}]}\n```';

describe("who may take a book over", () => {
  it("refuses a book that is not finished, or is being changed, and writes nothing", async () => {
    for (const [status, code] of [
      ["GENERATING", "BOOK_NOT_READY"],
      ["PLAN_READY", "BOOK_NOT_READY"],
      ["FAILED", "BOOK_NOT_READY"],
      ["EDITING", "PROJECT_BUSY"]
    ] as const) {
      db.projects.length = 0;
      seedGeneratedBook(db, { status });
      const response = await takeOver(app, "project-gen");
      expect(response.statusCode, status).toBe(409);
      expect(response.json().error.code).toBe(code);
      expect(isAuthorManuscript(project().mediaSettings)).toBe(false);
    }
    expect(db.manuscripts).toHaveLength(0);
    expect(db.enqueued).toHaveLength(0);
  });

  it("refuses while a job or an edit owns the book, naming a narration", async () => {
    seedGeneratedBook(db);
    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow()]);
    let response = await takeOver(app, "project-gen");
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "PROJECT_BUSY" });

    mockPrisma.generationJob.count.mockResolvedValue(1);
    response = await takeOver(app, "project-gen");
    expect(response.json().error.message).toContain("narrated");

    mockPrisma.generationJob.findMany.mockResolvedValue([]);
    mockPrisma.generationJob.count.mockResolvedValue(0);
    state.bookEditOperations.push(appliedEditOperationRecord({ id: "op-open", projectId: "project-gen", status: "QUEUED" }));
    response = await takeOver(app, "project-gen");
    expect(response.json().error).toMatchObject({ code: "PROJECT_BUSY" });
    expect(db.manuscripts).toHaveLength(0);
  });

  it("answers 404 for someone else's book", async () => {
    seedGeneratedBook(db);
    const response = await takeOver(app, "project-gen", "request-takeover-b", bearer("token-b"));
    expect(response.statusCode).toBe(404);
  });
});

describe("taking over a finished generated book", () => {
  it("makes it an author manuscript on the row and in the plan snapshot the compile reads", async () => {
    seedGeneratedBook(db);
    const response = await takeOver(app, "project-gen");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project).toMatchObject({ id: "project-gen", source: "written", status: "editing" });
    expect(body.manuscript).toMatchObject({ source: "written", layout: "flow", kind: "story", published: true, hasUnpublishedChanges: false });

    const studio = studioSettingsFromMediaSettings(project().mediaSettings);
    expect(studio).toMatchObject({ layout: "flow", kind: "story", origin: "takeover", artStyle: "Soft watercolour with warm harbour light" });
    expect(studioSettingsFromMediaSettings(plan().inputSnapshot.mediaSettings)).toMatchObject({ origin: "takeover", layout: "flow" });
    // Everything else the snapshot knew about how the book was made is kept.
    expect(plan().inputSnapshot.mediaSettings).toMatchObject({ generationStrategy: "auto", modelTier: "balanced" });
    expect(plan().inputSnapshot.targetPages).toBe(4);
    expect(plan().status).toBe("APPROVED");
    expect(project()).toMatchObject({ status: "EDITING", contentRevision: 4, targetPages: 4, category: "STORY" });
  });

  it("turns every hero into one inline line, detaches it, and clears the generator's page verdicts", async () => {
    seedGeneratedBook(db);
    await takeOver(app, "project-gen");
    const pages = pagesOf();
    expect(pages[0]!.markdown).toBe("![Illustration](/assets/images/project-gen/page-project-gen-page-1-k1.jpg)\n\nThe harbour was quiet at dawn.");
    expect(pages[2]!.markdown.startsWith("![Illustration](/assets/images/project-gen/page-project-gen-page-3-k3.jpg)\n\n")).toBe(true);
    // Only pages whose text changed moved their revision; prose-only pages are untouched.
    expect(pages.map((page) => page.revision)).toEqual([3, 2, 3, 2]);
    expect(pages[1]!.markdown).toBe("Boats rocked against the pier.");
    for (const page of pages) {
      expect(page).toMatchObject({ status: "COMPLETED", qualityReport: null, imagePrompt: null, imageFailureReason: null });
      // The prose's own memory stays.
      expect(page.storyDelta).toBeTruthy();
    }
    const interior = db.images.filter((image) => image.type !== "COVER");
    expect(interior.map((image) => image.pageId)).toEqual([null, null]);
    expect(db.images.find((image) => image.type === "COVER")?.metadata).toEqual({ coverArtSource: "ai" });
  });

  it("prints each picture exactly once under the author rules", async () => {
    seedGeneratedBook(db);
    await takeOver(app, "project-gen");
    const compiled = compileBookMarkdownWithPageAnchors({
      plan: plan().planningPackage,
      authorManuscript: true,
      // The compile's hero comes from an *attached* row; every row is detached now.
      pages: pagesOf().map((page) => ({ index: page.index, title: page.title, markdown: page.markdown }))
    });
    for (const file of ["page-project-gen-page-1-k1.jpg", "page-project-gen-page-3-k3.jpg"]) {
      expect(compiled.markdown.split(file)).toHaveLength(2);
    }
  });

  it("opens a published working copy in the book's own chapters, with the picture lines in the text", async () => {
    seedGeneratedBook(db);
    const body = (await takeOver(app, "project-gen")).json();
    expect(body.manuscript.chapters.map((chapter: { title: string }) => chapter.title)).toEqual(["The Harbour", "The Storm"]);
    expect(body.manuscript.chapters.map((chapter: { bookChapterId: string }) => chapter.bookChapterId)).toEqual(["chapter-g1", "chapter-g2"]);
    const chapter = (await getChapter(app, "project-gen", body.manuscript.chapters[0].id)).json().chapter;
    expect(chapter.markdown).toBe(
      "![Illustration](/assets/images/project-gen/page-project-gen-page-1-k1.jpg)\n\nThe harbour was quiet at dawn.\n\nBoats rocked against the pier."
    );
    expect(chapter).toMatchObject({ hasUnpublishedChanges: false, hasConflict: false });
    expect(db.manuscripts[0]!.firstPublishedAt).toBeInstanceOf(Date);

    // Reopening finds no drift: the working copy recorded the pages as the takeover left them.
    const reopened = (await getManuscript(app, "project-gen")).json().manuscript;
    expect(reopened.chapters.every((entry: { hasConflict: boolean }) => !entry.hasConflict)).toBe(true);
    // And there is nothing to publish until the author writes something.
    project().status = "COMPLETE";
    expect((await publish(app, "project-gen", "request-publish-0001")).json().error.code).toBe("NOTHING_TO_PUBLISH");
  });

  it("brings the book's dedication into the Studio's settings, so the first Update prints it rather than dropping it", async () => {
    seedGeneratedBook(db);
    project().bookMatter = { dedication: "For Mira, who kept the light", isbn: "978-0-00-000000-0" };
    const body = (await takeOver(app, "project-gen")).json();

    expect(body.manuscript).toMatchObject({ dedication: "For Mira, who kept the light", hasUnpublishedChanges: false });
    expect(db.manuscripts[0]!.settings).toMatchObject({
      dedication: "For Mira, who kept the light",
      // Recorded as already published, so it is not a change waiting for an Update.
      published: { dedication: "For Mira, who kept the light" }
    });

    // An Update writes it back where it came from, beside the matter the Studio does not own.
    project().status = "COMPLETE";
    const chapter = (await getChapter(app, "project-gen", body.manuscript.chapters[0].id)).json().chapter;
    await saveChapter(app, "project-gen", { id: chapter.id, revision: chapter.revision, title: chapter.title }, `${chapter.markdown}\n\nThe end.`);
    expect((await publish(app, "project-gen", "request-publish-after-takeover")).statusCode).toBe(200);
    expect(project().bookMatter).toEqual({ dedication: "For Mira, who kept the light", isbn: "978-0-00-000000-0" });
  });

  it("opens with no dedication when the book had none", async () => {
    seedGeneratedBook(db);
    const body = (await takeOver(app, "project-gen")).json();
    expect(body.manuscript.dedication).toBeNull();
  });

  it("queues one free skip-review recompile, no cover, and seals every earlier edit", async () => {
    seedGeneratedBook(db);
    state.bookEditOperations.push(appliedEditOperationRecord({ id: "op-before", projectId: "project-gen", classifier: { kind: "local_patch" } }));
    await takeOver(app, "project-gen");
    const compiles = db.enqueued.filter((job) => job.type === "COMPILE_EXPORT");
    expect(compiles).toHaveLength(1);
    expect(compiles[0]).toMatchObject({ contentRevision: 4, dispatch: false, payload: { planId: "plan-project-gen", skipFinalReview: true } });
    // The generated book's charge is not this free compile's to refund (launch review B3).
    expect(compiles[0]!.payload).toMatchObject({ freeEditRecompile: true, preEditProjectStatus: "COMPLETE" });
    expect(db.enqueued.some((job) => job.type === "GENERATE_IMAGE")).toBe(false);

    const before = state.bookEditOperations.find((operation) => operation.id === "op-before")!;
    expect(before.classifier.sealedAt).toEqual(expect.any(String));
    expect(canUndoBookEdit(before as never)).toBe(false);
    const record = state.bookEditOperations.find((operation) => operation.requestId === "studio-takeover:request-takeover-0001")!;
    expect(record).toMatchObject({ kind: "MANUSCRIPT_PUBLISH", status: "APPLIED", creditsCharged: 0, affectedPageIndexes: [1, 3] });
    expect(record.classifier).toMatchObject({ takeover: true });
  });

  it("is idempotent, and a book that is already the author's is simply opened", async () => {
    seedGeneratedBook(db);
    expect((await takeOver(app, "project-gen")).statusCode).toBe(200);
    const enqueued = db.enqueued.length;
    const replay = await takeOver(app, "project-gen");
    expect(replay.statusCode).toBe(200);
    expect(replay.json().manuscript.published).toBe(true);
    const again = await takeOver(app, "project-gen", "request-takeover-0002");
    expect(again.statusCode).toBe(200);
    expect(db.enqueued).toHaveLength(enqueued);
    expect(project().contentRevision).toBe(4);
    expect(db.manuscripts).toHaveLength(1);
  });

  it("copies figures and citation tokens byte for byte, and prints what the generated compile printed", async () => {
    seedGeneratedBook(db, {
      category: "SCIENCE",
      chapters: [{ id: "chapter-s1", title: "Ships" }, { id: "chapter-s2", title: "Storms" }],
      pages: [
        { markdown: `The port counted ships [source:src1:2:7].\n\n${figure}`, chapter: "chapter-s1" },
        { markdown: "```markdown\n## Page 2\n\nTrade doubled in a decade.\n```", chapter: "chapter-s1" },
        { markdown: "## Storms\n\nThe storms came every autumn.", chapter: "chapter-s2" },
        { markdown: "## Page 4 title\n\nNobody forgot them.", chapter: "chapter-s2" }
      ]
    });
    const body = (await takeOver(app, "project-gen")).json();
    expect(body.manuscript.kind).toBe("nonfiction");
    const pages = pagesOf();
    expect(pages[0]!.markdown).toBe(`The port counted ships [source:src1:2:7].\n\n${figure}`);
    expect(pages[0]!.revision).toBe(2);
    expect(pages[1]!.markdown).toBe("Trade doubled in a decade.");
    // A repeat of the chapter heading goes, as the generated compile dropped it.
    expect(pages[2]!.markdown).toBe("The storms came every autumn.");
    expect(pages[3]!.markdown).toBe("Nobody forgot them.");
    const first = (await getChapter(app, "project-gen", body.manuscript.chapters[0].id)).json().chapter;
    expect(first.markdown).toBe(`The port counted ships [source:src1:2:7].\n\n${figure}\n\nTrade doubled in a decade.`);
  });

  it("keeps a short picture book one page a card, and its pictures on their pages", async () => {
    seedGeneratedBook(db, {
      category: "KIDS",
      chapters: [{ id: "chapter-k1", title: "Morning" }, { id: "chapter-k2", title: "Night" }],
      pages: Array.from({ length: 6 }, (_, offset) => ({
        markdown: `Page ${offset + 1}: the cat looks at the sea.`,
        chapter: offset < 3 ? "chapter-k1" : "chapter-k2",
        hero: true
      }))
    });
    const body = (await takeOver(app, "project-gen")).json();
    expect(body.manuscript).toMatchObject({ layout: "picture", kind: "picture" });
    const morning = (await getChapter(app, "project-gen", body.manuscript.chapters[0].id)).json().chapter;
    const cards = morning.markdown.split("\n\n<!-- page -->\n\n");
    expect(cards).toHaveLength(3);
    expect(cards[1]).toBe("![Illustration](/assets/images/project-gen/page-project-gen-page-2-k2.jpg)\n\nPage 2: the cat looks at the sea.");
  });
});

describe("the first Update book after a takeover", () => {
  it("republishes the author's edit with every picture printed once, from its line", async () => {
    seedGeneratedBook(db);
    const body = (await takeOver(app, "project-gen")).json();
    project().status = "COMPLETE";
    const chapter = (await getChapter(app, "project-gen", body.manuscript.chapters[1].id)).json().chapter;
    const edited = chapter.markdown.replace("Then the storm came in from the west.", "Then, without warning, the storm came in from the west.");
    const saved = await saveChapter(app, "project-gen", { id: chapter.id, revision: chapter.revision, title: chapter.title }, edited);
    expect(saved.statusCode).toBe(200);
    const published = await publish(app, "project-gen", "request-publish-after-takeover");
    expect(published.statusCode).toBe(200);
    const book = pagesOf().map((page) => page.markdown).join("\n\n");
    for (const file of ["page-project-gen-page-1-k1.jpg", "page-project-gen-page-3-k3.jpg"]) {
      expect(book.split(file)).toHaveLength(2);
    }
    expect(book).toContain("Then, without warning, the storm came in from the west.");
    expect(db.images.filter((image) => image.type !== "COVER").every((image) => image.pageId === null)).toBe(true);
    // An AI-covered book keeps its cover: the Update draws none.
    expect(db.enqueued.filter((job) => job.type === "GENERATE_IMAGE")).toHaveLength(0);
  });
});

describe("the chapters the reader saw", () => {
  it("re-partitions a per-page book into its published Contents, rows and plan alike", async () => {
    seedGeneratedBook(db, {
      chapters: [
        { id: "chapter-p1", title: "Plan one" },
        { id: "chapter-p2", title: "Plan two" },
        { id: "chapter-p3", title: "Plan three" }
      ],
      pages: ["One.", "Two.", "Three.", "Four.", "Five.", "Six.", "Seven.", "Eight."].map((markdown, offset) => ({
        markdown,
        chapter: offset < 2 ? "chapter-p1" : offset < 5 ? "chapter-p2" : "chapter-p3"
      }))
    });
    const published = compileBookMarkdownWithPageAnchors({
      plan: plan().planningPackage,
      pages: pagesOf().map((page) => ({ index: page.index, title: page.title, markdown: page.markdown })),
      readerChapters: [
        { index: 1, title: "Arrival", summary: "", startPageIndex: 1, endPageIndex: 4 },
        { index: 2, title: "Departure", summary: "", startPageIndex: 5, endPageIndex: 8 }
      ]
    });
    expect(published.markdown).toContain("book-contents");
    writeProjectFile(state.bookStorageDir, "project-gen", "book.md", published.markdown);

    const body = (await takeOver(app, "project-gen")).json();
    expect(body.manuscript.chapters.map((chapter: { title: string }) => chapter.title)).toEqual(["Arrival", "Departure"]);
    const rows = db.bookChapters.filter((row) => row.projectId === "project-gen").sort((a, b) => a.index - b.index);
    expect(rows.map((row) => [row.id, row.index, row.title, row.targetPages])).toEqual([
      ["chapter-p1", 1, "Arrival", 4],
      ["chapter-p2", 2, "Departure", 4]
    ]);
    expect(pagesOf().map((page) => page.chapterId)).toEqual([...Array(4).fill("chapter-p1"), ...Array(4).fill("chapter-p2")]);
    expect(plan().planningPackage.chapters.map((chapter: { title: string; targetPages: number }) => [chapter.title, chapter.targetPages])).toEqual([
      ["Arrival", 4],
      ["Departure", 4]
    ]);
    // Everything else the plan knew is kept.
    expect(plan().planningPackage.premise).toBe("A harbour town weathers the storm of the century.");
    const first = (await getChapter(app, "project-gen", body.manuscript.chapters[0].id)).json().chapter;
    expect(first.markdown).toBe("One.\n\nTwo.\n\nThree.\n\nFour.");
  });

  it("keeps the chapter rows when the book printed no Contents", async () => {
    seedGeneratedBook(db);
    await takeOver(app, "project-gen");
    expect(db.bookChapters.map((row) => row.title)).toEqual(["The Harbour", "The Storm"]);
    expect(db.bookChapters[0]!.productionBrief).toEqual({ beats: ["planned"] });
  });
});

describe("the chat after a takeover", () => {
  it("never rebuilds an author's book from a new plan", async () => {
    const intent = { kind: "book_replan" } as never;
    const refused = await refuseAuthorBookReplan({
      project: { id: "project-gen", mediaSettings: { mobile: { studio: { layout: "flow", kind: "story", createdAt: "x", origin: "takeover" } } } },
      userMessageId: "message-1",
      intent
    });
    expect(refused?.content).toBe(AUTHOR_BOOK_REPLAN_MESSAGE);
    expect(await refuseAuthorBookReplan({ project: { id: "p", mediaSettings: {} }, userMessageId: "m", intent })).toBeNull();
  });
});
