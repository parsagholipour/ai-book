import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { createProjectSchema, isStudioManuscript } from "@book-maker/core";
import { objectNames } from "../testing/objectStorage.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import { buildMobileApp, mockAccessTokens, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import {
  addChapter,
  AUTH,
  createStudioBook,
  getChapter,
  getManuscript,
  saveChapter
} from "./testing/manuscriptTestSupport.js";

/** A real 1x1 PNG, so the optimizer can decode and re-encode it. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
});
afterEach(teardownMobileHarness);

describe("creating a Studio book", () => {
  it("makes a DRAFT project the worker can parse, a working copy and one empty chapter", async () => {
    const app = await buildMobileApp();
    const { response, body } = await createStudioBook(app, { title: "The Lighthouse", kind: "story" });

    expect(response.statusCode).toBe(201);
    const project = db.projects[0]!;
    expect(project).toMatchObject({
      status: "DRAFT",
      title: "The Lighthouse",
      prompt: "Author-written manuscript: The Lighthouse",
      targetPages: 1,
      category: "STORY"
    });
    expect(project.mediaSettings).toMatchObject({
      finalReview: false,
      fullIllustrations: false,
      coverArtSource: "design",
      modelTier: "balanced",
      mobile: { studio: { layout: "flow", kind: "story" } }
    });
    expect(isStudioManuscript(project.mediaSettings)).toBe(true);
    // The worker parses every project through this schema, a compile included.
    expect(createProjectSchema.safeParse({ ...project, subtitle: undefined, authorName: undefined, coverTagline: undefined, subcategory: undefined }).success).toBe(true);

    expect(body.project).toMatchObject({
      id: project.id,
      source: "written",
      status: "draft",
      statusLabel: "Writing · 0 words",
      manuscript: { wordCount: 0, chapterCount: 1, published: false, hasUnpublishedChanges: false }
    });
    expect(body.manuscript).toMatchObject({ source: "written", layout: "flow", kind: "story", published: false, chapters: [expect.objectContaining({ title: "Chapter 1" })] });
    expect(body.chapter).toMatchObject({ title: "Chapter 1", markdown: "", revision: 1, conflict: null, bookChapterId: null });
    expect(JSON.stringify(body)).not.toMatch(/model/i);
  });

  it("replays the same requestId onto the same book instead of making a second one", async () => {
    const app = await buildMobileApp();
    const first = await createStudioBook(app, { requestId: "request-same-0001" });
    const second = await createStudioBook(app, { requestId: "request-same-0001" });

    expect(first.response.statusCode).toBe(201);
    expect(second.response.statusCode).toBe(200);
    expect(second.body.project.id).toBe(first.body.project.id);
    expect(second.body.chapter.id).toBe(first.body.chapter.id);
    expect(db.projects).toHaveLength(1);
    expect(db.manuscriptChapters).toHaveLength(1);
  });

  it("opens a picture book on the picture layout, titled Untitled book when no title is given", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app, { title: "", kind: "picture" });

    expect(db.projects[0]).toMatchObject({ title: "Untitled book", category: "KIDS" });
    expect(body.manuscript).toMatchObject({ layout: "picture", kind: "picture" });
    expect(body.chapter.title).toBe("Your story");
  });

  it("takes a one-character title, which is a whole title in Chinese or Japanese, and refuses an unknown kind", async () => {
    const app = await buildMobileApp();
    expect((await createStudioBook(app, { title: "雪" })).response.statusCode).toBe(201);
    expect(db.projects.at(-1)).toMatchObject({ title: "雪" });
    expect((await createStudioBook(app, { kind: "epic" })).response.statusCode).toBe(400);
  });
});

describe("the working copy", () => {
  it("autosaves, reads Writing · N words on the project, and answers a stale save with the server copy inside error", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const projectId = body.project.id as string;
    const chapter = body.chapter as { id: string; revision: number };

    const saved = await saveChapter(app, projectId, chapter, "It was a dark and stormy night on the island of Skarv.");
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      chapter: { id: chapter.id, revision: 2, wordCount: 12, hasUnpublishedChanges: true },
      manuscriptRevision: 2
    });

    const list = await app.inject({ method: "GET", url: "/api/mobile/projects", headers: AUTH });
    expect(list.json().projects[0]).toMatchObject({
      statusLabel: "Writing · 12 words",
      manuscript: { wordCount: 12, chapterCount: 1, hasUnpublishedChanges: true }
    });

    // A second device still holding revision 1.
    const stale = await saveChapter(app, projectId, chapter, "Something else entirely.");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: "CHAPTER_CONFLICT",
        chapter: { id: chapter.id, revision: 2, markdown: "It was a dark and stormy night on the island of Skarv." }
      }
    });
    expect(db.manuscripts[0]!.revision).toBe(2);
  });

  it("keeps the text a big change replaces as an automatic version, and the previous text before an AI change", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const projectId = body.project.id as string;
    const chapterId = body.chapter.id as string;

    await saveChapter(app, projectId, { id: chapterId, revision: 1 }, "First draft of the opening, with enough words to matter here.");
    await saveChapter(app, projectId, { id: chapterId, revision: 2 }, "Short.");
    await saveChapter(app, projectId, { id: chapterId, revision: 3 }, "Short, then a little longer.", { checkpoint: "before_ai" });

    const versions = await app.inject({
      method: "GET",
      url: `/api/mobile/projects/${projectId}/manuscript/chapters/${chapterId}/versions`,
      headers: AUTH
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions.map((version: { reason: string }) => version.reason)).toEqual(["before_ai", "auto"]);
    const auto = versions.json().versions[1];
    const one = await app.inject({
      method: "GET",
      url: `/api/mobile/projects/${projectId}/manuscript/chapters/${chapterId}/versions/${auto.id}`,
      headers: AUTH
    });
    expect(one.json().version.markdown).toBe("First draft of the opening, with enough words to matter here.");
  });

  it("adds, deletes with undo, restores and reorders chapters", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const projectId = body.project.id as string;
    const first = body.chapter.id as string;

    const second = await addChapter(app, projectId, { title: "The Keeper", requestId: "request-add-0001" });
    expect(second.statusCode).toBe(200);
    expect(second.json().chapter).toMatchObject({ title: "The Keeper", position: 2 });
    const replay = await addChapter(app, projectId, { title: "The Keeper", requestId: "request-add-0001" });
    expect(replay.json().chapter.id).toBe(second.json().chapter.id);
    const front = await addChapter(app, projectId, { afterChapterId: null, requestId: "request-add-0002" });
    expect(front.json().chapter.position).toBe(1);
    expect(front.json().manuscript.chapters.map((chapter: { id: string }) => chapter.id)).toEqual([
      front.json().chapter.id,
      first,
      second.json().chapter.id
    ]);

    const secondId = second.json().chapter.id as string;
    const deleted = await app.inject({ method: "DELETE", url: `/api/mobile/projects/${projectId}/manuscript/chapters/${secondId}`, headers: AUTH });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().manuscript.chapters).toHaveLength(2);
    const restored = await app.inject({
      method: "POST",
      url: `/api/mobile/projects/${projectId}/manuscript/chapters/${secondId}/restore`,
      headers: AUTH
    });
    expect(restored.json().manuscript.chapters.map((chapter: { id: string }) => chapter.id)).toEqual([
      front.json().chapter.id,
      first,
      secondId
    ]);

    const reordered = await app.inject({
      method: "POST",
      url: `/api/mobile/projects/${projectId}/manuscript/order`,
      headers: AUTH,
      payload: { chapterIds: [secondId, first, front.json().chapter.id] }
    });
    expect(reordered.json().manuscript.chapters.map((chapter: { id: string; position: number }) => [chapter.id, chapter.position])).toEqual([
      [secondId, 1],
      [first, 2],
      [front.json().chapter.id, 3]
    ]);
    const mismatch = await app.inject({
      method: "POST",
      url: `/api/mobile/projects/${projectId}/manuscript/order`,
      headers: AUTH,
      payload: { chapterIds: [secondId, first] }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe("ORDER_MISMATCH");
  });

  it("refuses to delete the last chapter", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/mobile/projects/${body.project.id}/manuscript/chapters/${body.chapter.id}`,
      headers: AUTH
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("LAST_CHAPTER");
    expect(db.manuscriptChapters[0]!.deletedAt).toBeNull();
  });

  it("writes title, subtitle and author through to the project, and the art style and layout through to the Studio record", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const projectId = body.project.id as string;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/mobile/projects/${projectId}/manuscript/settings`,
      headers: AUTH,
      payload: { title: "The Last Lighthouse", subtitle: "A novel", authorName: "Ada Byrne", dedication: "For Mo", artStyle: "Ink and wash", goalWords: 50000, layout: "picture" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().manuscript).toMatchObject({
      title: "The Last Lighthouse",
      subtitle: "A novel",
      authorName: "Ada Byrne",
      dedication: "For Mo",
      artStyle: "Ink and wash",
      goalWords: 50000,
      layout: "picture"
    });
    expect(db.projects[0]).toMatchObject({
      title: "The Last Lighthouse",
      subtitle: "A novel",
      authorName: "Ada Byrne",
      prompt: "Author-written manuscript: The Last Lighthouse",
      mediaSettings: { mobile: { studio: { layout: "picture", artStyle: "Ink and wash", dedication: "For Mo", kind: "story" } } }
    });
  });

  it("keeps another reader out, and a generated book out of the Studio", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const foreign = await app.inject({ method: "GET", url: `/api/mobile/projects/${body.project.id}/manuscript`, headers: { authorization: "Bearer token-b" } });
    expect(foreign.statusCode).toBe(404);

    db.projects.push({ ...db.projects[0]!, id: "project-generated", mediaSettings: { mobile: { bookType: "custom" } } });
    const generated = await getManuscript(app, "project-generated");
    expect(generated.statusCode).toBe(409);
    expect(generated.json().error.code).toBe("NOT_AUTHOR_MANUSCRIPT");
    expect((await getChapter(app, body.project.id, "missing")).statusCode).toBe(404);
  });
});

describe("pictures an author adds", () => {
  it("re-encodes an upload into the book's own image folder under an upload- name", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const projectId = body.project.id as string;

    const response = await app.inject({
      method: "PUT",
      url: `/api/mobile/projects/${projectId}/manuscript/images?filename=harbour.png&contentType=image%2Fpng`,
      headers: { ...AUTH, "content-type": "application/octet-stream" },
      payload: ONE_PIXEL_PNG
    });

    expect(response.statusCode).toBe(200);
    const { url, width, height } = response.json();
    expect(url).toMatch(new RegExp(`^/assets/images/${projectId}/upload-[0-9a-f-]{36}\\.jpg$`));
    expect({ width, height }).toEqual({ width: 1, height: 1 });
    expect(objectNames(`images/${projectId}`)).toEqual([url.split("/").pop()]);
  });

  it("refuses SVG, unknown types and bytes that are not a picture", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const upload = (query: string, payload: Buffer) =>
      app.inject({
        method: "PUT",
        url: `/api/mobile/projects/${body.project.id}/manuscript/images?${query}`,
        headers: { ...AUTH, "content-type": "application/octet-stream" },
        payload
      });

    for (const response of [
      await upload("filename=logo.svg&contentType=image%2Fsvg%2Bxml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")),
      await upload("filename=clip.gif&contentType=image%2Fgif", ONE_PIXEL_PNG),
      await upload("filename=photo.jpg&contentType=image%2Fjpeg", Buffer.from("not a picture at all"))
    ]) {
      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe("UNSUPPORTED_IMAGE");
    }
    expect(objectNames(`images/${body.project.id}`)).toEqual([]);
  });
});
