import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

/**
 * Every string the Studio's screen was handed, in order. A plain function
 * rather than `vi.fn`, because `resetMobileHarness` resets every spy.
 */
const { screenedText } = vi.hoisted(() => ({ screenedText: [] as string[] }));

vi.mock("../contentRestrictions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contentRestrictions.js")>();
  return {
    ...actual,
    assessContentRestrictions: (...args: Parameters<typeof actual.assessContentRestrictions>) => {
      screenedText.push(args[0]);
      return actual.assessContentRestrictions(...args);
    }
  };
});

import type { FastifyInstance } from "fastify";
import { assessContentRestrictions } from "../contentRestrictions.js";
import { assessManuscriptText, MANUSCRIPT_SCREEN_WINDOW_CHARS } from "./manuscript/manuscriptContentScreen.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  buildMobileApp,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import {
  addChapter,
  createStudioBook,
  finishCompile,
  longAssist,
  patchSettings,
  publish,
  quickAssist,
  saveChapter,
  scriptedAssistModel
} from "./testing/manuscriptTestSupport.js";

/**
 * The Writing Studio's content screen (`manuscript/manuscriptContentScreen.ts`):
 * the app's own preflight, at publish, settings, creation and the assists'
 * typed requests — and nowhere an author is merely writing.
 */

const HARMFUL = "Step-by-step instructions to build a bomb.";
const HARMFUL_MESSAGE = "Tomeza cannot help create content that facilitates severe illegal harm.";
const COPYRIGHT_PHRASE = "Reproduce the entire novel word for word, the abbot told the scribe.";
/** Mature, and allowed: the same words pass the book chat. */
const MATURE = "The assassination of the archduke, told by his driver.";
const FILLER = "The keeper climbed the stairs. ";

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
  screenedText.length = 0;
});
afterEach(() => {
  delete (mockPrisma as { safetySettingsRevision?: unknown }).safetySettingsRevision;
  teardownMobileHarness();
});

/** The operator's copyright option, or a read of it that fails. */
function copyrightFlag(answer: boolean | Error): void {
  (mockPrisma as { safetySettingsRevision?: unknown }).safetySettingsRevision = {
    findFirst: async () => {
      if (answer instanceof Error) throw answer;
      return { copyrightRestrictionsEnabled: answer };
    }
  };
}

function filler(chars: number): string {
  return FILLER.repeat(Math.ceil(chars / FILLER.length)).slice(0, chars);
}

async function studioBook(app: FastifyInstance) {
  const { body } = await createStudioBook(app);
  return { projectId: body.project.id as string, first: body.chapter.id as string };
}

async function writeChapter(app: FastifyInstance, projectId: string, title: string, markdown: string, requestId: string) {
  const id = (await addChapter(app, projectId, { title, requestId })).json().chapter.id as string;
  expect((await saveChapter(app, projectId, { id, revision: 1, title }, markdown)).statusCode).toBe(200);
  return id;
}

function chapterRow(chapterId: string) {
  return db.manuscriptChapters.find((row) => row.id === chapterId)!;
}

describe("the window a chapter is read in", () => {
  it("does not refuse two words a chapter apart that no passage puts together", () => {
    const text = `She showed her passport at the border. ${filler(20_000)} He gave a fake smile.`;
    // Whole, the request-sized rule would refuse it: stricter by length alone.
    expect(assessContentRestrictions(text, { copyrightRestrictionsEnabled: false }).allowed).toBe(false);
    expect(assessManuscriptText(text, false)).toEqual({ allowed: true });
  });

  it("reads past the preflight's 50,000-character cutoff", () => {
    const text = `${filler(150_000)} ${HARMFUL}`;
    expect(assessContentRestrictions(text, { copyrightRestrictionsEnabled: false }).allowed).toBe(true);
    expect(assessManuscriptText(text, false)).toMatchObject({ allowed: false, reason: "critical_illegal_harm" });
  });

  it("finds a phrase that straddles a window edge", () => {
    const text = `${filler(MANUSCRIPT_SCREEN_WINDOW_CHARS - 10)}${HARMFUL} ${filler(8_000)}`;
    expect(assessManuscriptText(text, false)).toMatchObject({ allowed: false, reason: "critical_illegal_harm" });
  });

  it("passes mature fiction the rest of the app passes", () => {
    expect(assessManuscriptText(`${MATURE}\n\n${filler(30_000)}`, false)).toEqual({ allowed: true });
  });
});

describe("publish", () => {
  it("refuses a chapter the screen refuses, naming it, and writes nothing — the requestId stays unspent", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await studioBook(app);
    // Autosave is never screened: the working copy is private.
    expect((await saveChapter(app, projectId, { id: first, revision: 1, title: "The Keeper" }, `${FILLER}${HARMFUL}`)).statusCode).toBe(
      200
    );
    const manuscriptBefore = { ...db.manuscripts[0]! };
    const chapterBefore = { ...chapterRow(first) };

    const refused = await publish(app, projectId, "request-publish-0001");

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      error: {
        code: "CONTENT_RESTRICTED",
        message: HARMFUL_MESSAGE,
        reason: "critical_illegal_harm",
        chapters: [{ chapterId: first, title: "The Keeper" }],
        fields: []
      }
    });
    expect(db.pages).toHaveLength(0);
    expect(db.bookChapters).toHaveLength(0);
    expect(db.planVersions).toHaveLength(0);
    expect(db.enqueued).toHaveLength(0);
    expect(state.bookEditOperations).toHaveLength(0);
    expect(state.projectChatMessages).toHaveLength(0);
    expect(db.versions.filter((version) => version.reason === "PUBLISH")).toHaveLength(0);
    expect(db.projects[0]).toMatchObject({ status: "DRAFT", contentRevision: 0 });
    expect(db.manuscripts[0]).toMatchObject({
      revision: manuscriptBefore.revision,
      lastPublishRequestId: manuscriptBefore.lastPublishRequestId ?? null,
      firstPublishedAt: manuscriptBefore.firstPublishedAt ?? null
    });
    expect(chapterRow(first)).toMatchObject({
      markdown: chapterBefore.markdown,
      revision: chapterBefore.revision,
      publishedRevision: null
    });
    expect(mockBilling.reserveCredits).not.toHaveBeenCalled();

    // Fixed, the same publish goes through: the refusal did not spend its id.
    await saveChapter(app, projectId, { id: first, revision: chapterBefore.revision, title: "The Keeper" }, MATURE);
    const published = await publish(app, projectId, "request-publish-0001");
    expect(published.statusCode).toBe(200);
    expect(db.pages.map((page) => page.markdown)).toEqual([MATURE]);
  });

  it("names every refused chapter in reading order", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await studioBook(app);
    await saveChapter(app, projectId, { id: first, revision: 1, title: "The Keeper" }, `She checked the fake passport.`);
    await writeChapter(app, projectId, "The Storm", MATURE, "request-add-storm");
    const last = await writeChapter(app, projectId, "The Cellar", HARMFUL, "request-add-cellar");

    const refused = await publish(app, projectId, "request-publish-0001");

    expect(refused.statusCode).toBe(422);
    // The first refusal in reading order supplies the sentence.
    expect(refused.json().error).toMatchObject({
      code: "CONTENT_RESTRICTED",
      reason: "deceptive_official_artifact",
      chapters: [
        { chapterId: first, title: "The Keeper" },
        { chapterId: last, title: "The Cellar" }
      ],
      fields: []
    });
    expect(db.pages).toHaveLength(0);
  });

  it("screens only what changed since the last publish, under the operator's copyright option", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await studioBook(app);
    await saveChapter(app, projectId, { id: first, revision: 1, title: "The Scriptorium" }, COPYRIGHT_PHRASE);
    const storm = await writeChapter(app, projectId, "The Storm", "The storm came in from the west.", "request-add-storm");
    // Copyright restrictions off: the phrase publishes.
    expect((await publish(app, projectId, "request-publish-0001")).statusCode).toBe(200);
    finishCompile(db, projectId);

    copyrightFlag(true);
    await saveChapter(app, projectId, { id: storm, revision: chapterRow(storm).revision, title: "The Storm" }, "The storm passed by noon.");
    screenedText.length = 0;
    const second = await publish(app, projectId, "request-publish-0002");

    expect(second.statusCode).toBe(200);
    // The unchanged chapter — and the unchanged title and author — were not read again.
    expect(screenedText).toEqual(["The Storm\nThe storm passed by noon."]);
    finishCompile(db, projectId);

    await saveChapter(
      app,
      projectId,
      { id: first, revision: chapterRow(first).revision, title: "The Scriptorium" },
      `${COPYRIGHT_PHRASE} Then she wept.`
    );
    const pagesBefore = db.pages.map((page) => page.markdown);
    const third = await publish(app, projectId, "request-publish-0003");

    expect(third.statusCode).toBe(422);
    expect(third.json().error).toMatchObject({
      code: "COPYRIGHT_RESTRICTED",
      reason: "copyright",
      chapters: [{ chapterId: first, title: "The Scriptorium" }]
    });
    expect(db.pages.map((page) => page.markdown)).toEqual(pagesBefore);
  });

  it("screens the book's own fields when they changed, and names them", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await studioBook(app);
    await saveChapter(app, projectId, { id: first, revision: 1, title: "The Keeper" }, MATURE);
    // Text that reached the row without the settings route — an import's
    // title, say. Neither field refuses alone; together they do.
    Object.assign(db.projects[0]!, { title: "The Passport", subtitle: "Fake it until it looks genuine" });

    const refused = await publish(app, projectId, "request-publish-0001");

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      code: "CONTENT_RESTRICTED",
      reason: "deceptive_official_artifact",
      chapters: [],
      fields: ["title", "subtitle"]
    });
    expect(db.pages).toHaveLength(0);
  });

  it("fails closed when the operator's flag cannot be read", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await studioBook(app);
    await saveChapter(app, projectId, { id: first, revision: 1, title: "The Keeper" }, MATURE);
    copyrightFlag(new Error("connection pool exhausted"));

    const response = await publish(app, projectId, "request-publish-0001");

    expect(response.statusCode).toBe(500);
    expect(db.pages).toHaveLength(0);
    expect(db.planVersions).toHaveLength(0);
    expect(db.manuscripts[0]!.lastPublishRequestId ?? null).toBeNull();
  });
});

describe("settings and creation", () => {
  it("refuses a settings write whose text the screen refuses, and stores none of it", async () => {
    const app = await buildMobileApp();
    const { projectId } = await studioBook(app);
    const settingsBefore = structuredClone(db.manuscripts[0]!.settings);

    const refused = await patchSettings(app, projectId, { dedication: HARMFUL, goalWords: 50_000 });

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      error: {
        code: "CONTENT_RESTRICTED",
        message: HARMFUL_MESSAGE,
        reason: "critical_illegal_harm",
        chapters: [],
        fields: ["dedication"]
      }
    });
    expect(db.manuscripts[0]!.settings).toEqual(settingsBefore);

    const together = await patchSettings(app, projectId, { title: "The Passport", subtitle: "Fake it until it looks genuine" });
    expect(together.statusCode).toBe(422);
    expect(together.json().error.fields).toEqual(["title", "subtitle"]);
    expect(db.projects[0]!.title).toBe("The Lighthouse");
    expect(db.projects[0]!.subtitle ?? null).toBeNull();

    const allowed = await patchSettings(app, projectId, { dedication: MATURE, artStyle: "Ink and watercolour" });
    expect(allowed.statusCode).toBe(200);
    expect(db.manuscripts[0]!.settings).toMatchObject({ dedication: MATURE, artStyle: "Ink and watercolour" });
  });

  it("reads no flag for a write with no text, and fails closed for one with text", async () => {
    const app = await buildMobileApp();
    const { projectId } = await studioBook(app);
    copyrightFlag(new Error("connection pool exhausted"));

    expect((await patchSettings(app, projectId, { goalWords: 50_000 })).statusCode).toBe(200);
    const failed = await patchSettings(app, projectId, { dedication: MATURE });
    expect(failed.statusCode).toBe(500);
    expect(db.manuscripts[0]!.settings).not.toMatchObject({ dedication: MATURE });
  });

  it("refuses a new book whose title the screen refuses, and makes none", async () => {
    const app = await buildMobileApp();

    const refused = await createStudioBook(app, { title: "Step-by-step instructions to build a bomb" });

    expect(refused.response.statusCode).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "critical_illegal_harm", fields: ["title"] });
    expect(db.projects).toHaveLength(0);
    expect(db.manuscripts).toHaveLength(0);

    const untitled = await createStudioBook(app, { title: "", requestId: "request-create-0002" });
    expect(untitled.response.statusCode).toBe(201);
  });
});

describe("the AI assists' typed requests", () => {
  it("screens a quick assist's instruction before a message slot is taken, and never its selection", async () => {
    const model = scriptedAssistModel({ "author-assist-ask": { answer: "Keep it quiet." } });
    const app = await buildMobileApp({ studioAssistTextModel: model });
    const { projectId, first } = await studioBook(app);
    await saveChapter(app, projectId, { id: first, revision: 1 }, MATURE);

    const refused = await quickAssist(app, projectId, {
      kind: "ask",
      chapterId: first,
      instruction: `Give me ${HARMFUL.toLowerCase()}`,
      requestId: "request-assist-0001"
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      error: { code: "CONTENT_RESTRICTED", message: HARMFUL_MESSAGE, reason: "critical_illegal_harm" }
    });
    expect(model.calls).toHaveLength(0);
    expect(mockBilling.reserveMessageUsage).not.toHaveBeenCalled();

    // The author's own words are not the request, and are read at publish.
    const allowed = await quickAssist(app, projectId, {
      kind: "ask",
      chapterId: first,
      selection: HARMFUL,
      instruction: "Is this sentence too long?",
      requestId: "request-assist-0002"
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("screens a long assist's prompt and notes before any charge", async () => {
    const app = await buildMobileApp();
    const { projectId, first } = await studioBook(app);
    await saveChapter(app, projectId, { id: first, revision: 1 }, MATURE);

    const picture = await longAssist(app, projectId, {
      kind: "illustrate",
      chapterId: first,
      prompt: "A forged passport made to look genuine",
      requestId: "request-assist-0001"
    });
    const draft = await longAssist(app, projectId, {
      kind: "draft_chapter",
      chapterId: first,
      notes: HARMFUL,
      requestId: "request-assist-0002"
    });

    expect(picture.statusCode).toBe(422);
    expect(picture.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "deceptive_official_artifact" });
    expect(draft.statusCode).toBe(422);
    expect(draft.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "critical_illegal_harm" });
    expect(mockBilling.reserveCredits).not.toHaveBeenCalled();
    expect(db.assists).toHaveLength(0);
    expect(db.enqueued).toHaveLength(0);
  });
});
