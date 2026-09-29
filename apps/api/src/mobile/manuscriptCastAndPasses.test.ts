import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { FastifyInstance } from "fastify";
import { styleProfileDue } from "./manuscript/manuscriptPublishAssists.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import { buildMobileApp, mockAccessTokens, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import {
  createStudioBook,
  finishCompile,
  getManuscript,
  longProse,
  patchSettings,
  publish,
  saveChapter,
  seedImportedBook,
  seedLibraryCharacter
} from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;

/** A profile `manuscriptStyleProfileSchema` accepts, as the STYLE_PROFILE pass stores one. */
const PROFILE = {
  voiceGuide: ["Short, plain sentences."],
  antiAiRules: ["No summaries at the end of a scene."],
  premise: "A lighthouse keeper's daughter keeps the light."
};

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

async function studioBook(app: FastifyInstance, markdown = "The keeper climbed the stairs.") {
  const { body } = await createStudioBook(app);
  const projectId = body.project.id as string;
  const chapterId = body.chapter.id as string;
  await saveChapter(app, projectId, { id: chapterId, revision: 1, title: "The Keeper" }, markdown);
  return { projectId, chapterId };
}

function chapterRevision(chapterId: string): number {
  return db.manuscriptChapters.find((row) => row.id === chapterId)!.revision;
}

function passKinds(): string[] {
  return db.assists.map((row) => row.kind);
}

describe("the cast", () => {
  it("stores the author's own library characters and refuses anybody else's", async () => {
    const app = await buildMobileApp();
    const { projectId } = await studioBook(app);
    seedLibraryCharacter(db, { id: "char-mira", name: "Mira" });
    seedLibraryCharacter(db, { id: "char-otto", name: "Otto" });
    seedLibraryCharacter(db, { id: "char-foreign", name: "Stranger", userId: "user-b" });

    const saved = await patchSettings(app, projectId, { castCharacterIds: ["char-otto", "char-mira", "char-otto"] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().manuscript.castCharacterIds).toEqual(["char-otto", "char-mira"]);

    const foreign = await patchSettings(app, projectId, { castCharacterIds: ["char-mira", "char-foreign"] });
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([400, "UNKNOWN_CHARACTER"]);
    const missing = await patchSettings(app, projectId, { castCharacterIds: ["char-nobody"] });
    expect(missing.json().error.code).toBe("UNKNOWN_CHARACTER");
    const tooMany = await patchSettings(app, projectId, { castCharacterIds: Array.from({ length: 25 }, (_, index) => `c${index}`) });
    expect(tooMany.statusCode).toBe(400);
    expect((await getManuscript(app, projectId)).json().manuscript.castCharacterIds).toEqual(["char-otto", "char-mira"]);
  });

  it("becomes the published plan's characters, look and all", async () => {
    const app = await buildMobileApp();
    const { projectId } = await studioBook(app);
    seedLibraryCharacter(db, { id: "char-mira", name: "Mira", description: "The keeper's daughter.", appearance: "Red coat, grey braid." });
    seedLibraryCharacter(db, { id: "char-otto", name: "Otto", description: "A retired sailor." });
    await patchSettings(app, projectId, { castCharacterIds: ["char-mira", "char-otto"] });

    expect((await publish(app, projectId, "request-publish-0001")).statusCode).toBe(200);

    expect(db.planVersions[0]!.planningPackage.characters).toEqual([
      expect.objectContaining({
        name: "Mira",
        role: "character",
        description: "The keeper's daughter. Red coat, grey braid.",
        visualRules: ["Red coat, grey braid."]
      }),
      expect.objectContaining({ name: "Otto", role: "character", description: "A retired sailor.", visualRules: [] })
    ]);
  });
});

describe("the free passes a publish queues", () => {
  it("learns a Studio book's voice past 2,000 words, once at a time, and again when it has doubled", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await studioBook(app, longProse(20));
    const words = db.manuscriptChapters[0]!.wordCount;
    expect(words).toBeGreaterThanOrEqual(2000);

    await publish(app, projectId, "request-publish-0001");
    expect(passKinds()).toEqual(["STYLE_PROFILE", "REEMBED"]);
    expect(db.assists[0]).toMatchObject({ creditsCharged: 0, input: { words }, requestId: "publish:request-publish-0001:style_profile" });
    const styleJob = db.enqueued.find((job) => job.type === "WRITING_ASSIST" && job.payload.assistId === db.assists[0]!.id)!;
    expect(styleJob.payload).toEqual({ assistId: db.assists[0]!.id });

    // Still queued: a second publish does not queue another.
    finishCompile(db, projectId);
    await saveChapter(app, projectId, { id: chapterId, revision: chapterRevision(chapterId), title: "The Keeper" }, longProse(21));
    await publish(app, projectId, "request-publish-0002");
    expect(passKinds()).toEqual(["STYLE_PROFILE", "REEMBED", "REEMBED"]);

    // The worker learned it, and recorded the words it learned from.
    db.assists[0]!.status = "APPLIED";
    const project = db.projects[0]!;
    project.mediaSettings.mobile.studio.styleProfile = PROFILE;
    project.mediaSettings.mobile.studio.styleProfileWords = words;
    finishCompile(db, projectId);
    await saveChapter(app, projectId, { id: chapterId, revision: chapterRevision(chapterId), title: "The Keeper" }, longProse(30));
    await publish(app, projectId, "request-publish-0003");
    expect(passKinds().filter((kind) => kind === "STYLE_PROFILE")).toHaveLength(1);

    finishCompile(db, projectId);
    await saveChapter(app, projectId, { id: chapterId, revision: chapterRevision(chapterId), title: "The Keeper" }, longProse(45));
    await publish(app, projectId, "request-publish-0004");
    expect(passKinds().filter((kind) => kind === "STYLE_PROFILE")).toHaveLength(2);
  });

  it("never profiles an import, which keeps its own, but refreshes the memory of what it rewrote", async () => {
    const app = await buildMobileApp();
    const projectId = seedImportedBook(db);
    const manuscript = (await getManuscript(app, projectId)).json().manuscript;
    const first = manuscript.chapters[0];
    await saveChapter(app, projectId, { id: first.id, revision: first.revision, title: first.title }, longProse(25));

    expect((await publish(app, projectId, "request-publish-0001")).statusCode).toBe(200);

    expect(passKinds()).toEqual(["REEMBED"]);
  });

  it("decides the profile from the words and what the book has learned", () => {
    const studio = (extra: Record<string, unknown> = {}) => ({ mobile: { studio: { layout: "flow", kind: "story", createdAt: "x", ...extra } } });
    const due = (words: number, mediaSettings: unknown, open = false) =>
      styleProfileDue({ studioBook: true, words, mediaSettings, styleProfileOpen: open });

    expect(due(1999, studio())).toBe(false);
    expect(due(2000, studio())).toBe(true);
    expect(due(2000, studio(), true)).toBe(false);
    expect(due(3999, studio({ styleProfile: PROFILE, styleProfileWords: 2000 }))).toBe(false);
    expect(due(4000, studio({ styleProfile: PROFILE, styleProfileWords: 2000 }))).toBe(true);
    // A profile that no longer parses is no profile: it is learned again.
    expect(due(2500, studio({ styleProfile: { pointOfView: "first" }, styleProfileWords: 2000 }))).toBe(true);
    expect(styleProfileDue({ studioBook: false, words: 9000, mediaSettings: studio(), styleProfileOpen: false })).toBe(false);
  });
});
