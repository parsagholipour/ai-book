import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { bookSeriesFromMediaSettings } from "@book-maker/core";
import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  jobRecord,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * A creation chat's series link (`creationSeries.ts`): the offer derived from
 * the finished books a mentioned library character already appears in, the
 * stored answer, the "write the next book" start, and the copy Build makes of
 * the earlier book into the new one.
 */

const PRESETS = {
  bookType: "short_story",
  lengthPreset: "short",
  qualityPreset: "balanced",
  imagesEnabled: true,
  pageCountMode: "custom",
  targetPages: 12,
  pageCountSource: "settings"
};

const SOURCE_PLAN = {
  title: "The Night Garden",
  premise: "Luna the fox finds the lantern bridge home.",
  audience: "Children aged 4 to 7",
  writingComplexity: 2,
  voiceGuide: ["Short, warm sentences."],
  antiAiRules: ["No moral stated outright."],
  chapters: [
    { index: 1, title: "Lost", summary: "Luna wanders off.", targetPages: 6, keyBeats: ["glow-worm"] },
    { index: 2, title: "Home", summary: "Bram lights the bridge.", targetPages: 6, keyBeats: ["bridge"] }
  ],
  characters: [{ name: "Bram", role: "Friend", description: "An old badger.", traits: [], visualRules: ["grey coat with a lantern"] }],
  locations: [{ name: "The night garden", description: "Glowing moss.", rules: [] }],
  continuityRules: ["The bridge only lights for the polite."],
  illustrationPlan: { cadence: "template-driven", globalStyle: "Soft watercolor, moonlit palette.", characterReferencePrompts: [], pageRules: [] }
};

/** A finished book carrying Luna (library row `char-1`), as every reader of it is handed the row. */
function sourceBook(overrides: Record<string, unknown> = {}) {
  return {
    id: "book-1",
    userId: "user-a",
    title: "The Night Garden",
    status: "COMPLETE",
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
    category: "KIDS",
    subcategory: null,
    targetPages: 12,
    prompt: "A night-sky bedtime story about Luna the fox.",
    mediaSettings: {
      fullIllustrations: true,
      includeCover: true,
      coverArtSource: "design",
      storyPageDesign: "night",
      mobile: {
        bookType: "short_story",
        bookTypeChoice: "children_story",
        lengthPreset: "short",
        qualityPreset: "premium",
        imagesEnabled: true,
        coverEnabled: false,
        illustrationsEnabled: true,
        characters: [{ id: "char-1", name: "Luna", description: "A curious fox.", fields: [] }]
      }
    },
    currentPlan: { planningPackage: SOURCE_PLAN },
    chapters: [
      { id: "chapter-1", title: "Lost", summary: "Luna wanders off.", productionBrief: { report: { facts: [{ subject: "Luna", attribute: "home", value: "the den under the oak" }] } } },
      { id: "chapter-2", title: "Home", summary: "Bram lights the bridge.", productionBrief: null }
    ],
    pages: [
      { markdown: "Luna followed a glow-worm past the wall.", chapterId: "chapter-1" },
      { markdown: "Bram lit the bridge and Luna ran home to the den.", chapterId: "chapter-2" }
    ],
    images: [{ metadata: { coverArtSource: "design", coverDesignId: "moonlit-garden" } }],
    ...overrides
  };
}

/** The draft of a chat whose first message tapped Luna. */
function mentionDraft(overrides: Record<string, unknown> = {}) {
  return creationDraftRecord({
    revision: 3,
    payload: {
      payloadVersion: 3,
      selectedPresets: PRESETS,
      messages: [
        { id: "m-1", role: "user", content: "Another adventure for @Luna", characters: [{ id: "char-1", name: "Luna" }] },
        { id: "m-2", parentId: "m-1", role: "assistant", content: "What happens this time?" }
      ]
    },
    ...overrides
  });
}

/** The offer's one query, answered with the rows it would find. */
function offerRows(rows: Array<Record<string, unknown>>) {
  mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) =>
    (strings ?? []).join("?").includes("jsonb_array_elements") ? rows : []
  );
}

function offerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "book-1",
    title: "The Night Garden",
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
    characters: [{ id: "char-1", name: "Luna" }],
    importRecord: null,
    studioRecord: null,
    ...overrides
  };
}

/**
 * Every `project.findFirst` a series path makes resolves to the one book, or
 * to nothing — honouring the owner and status filters the query carries, so a
 * path that forgets either is a test that fails.
 */
function sourceBookIs(book: Record<string, unknown> | null) {
  mockPrisma.project.findFirst.mockImplementation(
    async ({ where }: { where: { id?: string; userId?: string; status?: { in?: string[] } } }) =>
      [...(book ? [book] : []), ...builtBooks].find(
        (known) =>
          where?.id === known.id &&
          where.userId === known.userId &&
          (!where.status?.in || where.status.in.includes(String(known.status)))
      ) ?? null
  );
}

/** The books this file's Builds made, so a replay of one loads the book it made. */
let builtBooks: Array<Record<string, unknown>> = [];

describe("the series offer", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("offers the finished books a tapped character already appears in", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(mentionDraft());
    offerRows([
      offerRow(),
      // An author's own book is never offered: its plan was synthesized from text a model never wrote.
      offerRow({ id: "book-import", title: "My Manuscript", importRecord: { fileName: "m.docx" } })
    ]);
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions/draft-1", headers: bearer("token-a") });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.series).toEqual({
      books: [{ projectId: "book-1", title: "The Night Garden", characterNames: ["Luna"], updatedAt: "2026-10-01T10:00:00.000Z" }],
      choice: null
    });
    await app.close();
  });

  it("offers nothing, and asks nothing, while no character is mentioned", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord());
    offerRows([offerRow()]);
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions/draft-1", headers: bearer("token-a") });

    expect(response.json().session.series).toBeNull();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the session readable when the offer's read fails", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(mentionDraft());
    mockPrisma.$queryRaw.mockRejectedValue(new Error("database blip"));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions/draft-1", headers: bearer("token-a") });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.series).toBeNull();
    await app.close();
  });

  it("keeps the linked book on offer when no message names its character", async () => {
    // A "Write the next book" chat taps no character; Change must still have the book to show.
    mockAccessTokens({ "token-a": "user-a" });
    sourceBookIs(sourceBook());
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ seriesMode: "continuation", seriesSourceProjectId: "book-1" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions/draft-1", headers: bearer("token-a") });

    expect(response.json().session.series).toEqual({
      books: [{ projectId: "book-1", title: "The Night Garden", characterNames: [], updatedAt: "2026-10-01T10:00:00.000Z" }],
      choice: { mode: "continuation", projectId: "book-1", title: "The Night Garden" }
    });
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("leaves authors' own books out ahead of the query's limit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(mentionDraft());
    offerRows([offerRow()]);
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    await app.inject({ method: "GET", url: "/api/mobile/creation-sessions/draft-1", headers: bearer("token-a") });

    const sql = (mockPrisma.$queryRaw.mock.calls[0]![0] as readonly string[]).join("?");
    expect(sql.indexOf("'import'")).toBeLessThan(sql.indexOf("LIMIT"));
    expect(sql.indexOf("'studio'")).toBeLessThan(sql.indexOf("LIMIT"));
    await app.close();
  });
});

describe("answering the series offer", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  async function answer(body: Record<string, unknown>, draft = mentionDraft()) {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(draft);
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...draft,
      ...data,
      revision: Number((draft as Record<string, unknown>).revision ?? 1) + 1
    }));
    offerRows([offerRow()]);
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({ method: "PUT", url: "/api/mobile/creation-sessions/draft-1/series", headers: bearer("token-a"), payload: body });
    await app.close();
    return response;
  }

  it("links the chat to the book and hands the app that book's format beside the turn", async () => {
    sourceBookIs(sourceBook());
    const response = await answer({ mode: "continuation", projectId: "book-1" });

    expect(response.statusCode).toBe(200);
    // The revision moves, so a Build that read the draft before the answer refuses rather than building from the old one.
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { seriesMode: "continuation", seriesSourceProjectId: "book-1", revision: { increment: 1 } }
    });
    expect(response.json().session.revision).toBe(4);
    expect(response.json().session.series.choice).toEqual({ mode: "continuation", projectId: "book-1", title: "The Night Garden" });
    // Its own field: the app adopts it only where the reader has not chosen, which the turn's presets would overwrite.
    expect(response.json().seriesPresets).toMatchObject({ bookType: "short_story", bookTypeChoice: "children_story", qualityPreset: "premium", coverEnabled: false });
    expect(response.json().turn.presets).toMatchObject({ qualityPreset: "balanced" });
    // The answer writes no turn: a message landing beside it owns the stored turn.
    expect(mockPrisma.mobileCreationDraft.updateMany).not.toHaveBeenCalled();
  });

  it("records a new story of its own as an answer that links nothing", async () => {
    sourceBookIs(sourceBook());
    const response = await answer({ mode: "standalone" });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.mobileCreationDraft.update.mock.calls[0]![0].data).toEqual({
      seriesMode: "standalone",
      seriesSourceProjectId: null,
      revision: { increment: 1 }
    });
    expect(response.json().session.series.choice).toEqual({ mode: "standalone", projectId: null, title: null });
    expect(response.json().seriesPresets).toBeUndefined();
  });

  it("refuses another reader's book", async () => {
    sourceBookIs(sourceBook({ userId: "user-b" }));
    const response = await answer({ mode: "inspired", projectId: "book-1" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("SERIES_BOOK_NOT_FOUND");
    expect(mockPrisma.mobileCreationDraft.update).not.toHaveBeenCalled();
  });

  it("refuses a book that is still being written", async () => {
    sourceBookIs(sourceBook({ status: "GENERATING" }));
    const response = await answer({ mode: "inspired", projectId: "book-1" });

    expect(response.statusCode).toBe(404);
    expect(mockPrisma.mobileCreationDraft.update).not.toHaveBeenCalled();
  });

  it("accepts a finished book while an edit of it runs", async () => {
    sourceBookIs(sourceBook({ status: "EDITING" }));
    const response = await answer({ mode: "inspired", projectId: "book-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.series.choice).toEqual({ mode: "inspired", projectId: "book-1", title: "The Night Garden" });
  });

  it("refuses an answer whose book does not fit its mode", async () => {
    sourceBookIs(sourceBook());
    expect((await answer({ mode: "standalone", projectId: "book-1" })).statusCode).toBe(400);
    expect((await answer({ mode: "continuation" })).statusCode).toBe(400);
  });

  it("refuses to relink a chat that has already built its book", async () => {
    sourceBookIs(sourceBook());
    const response = await answer({ mode: "continuation", projectId: "book-1" }, mentionDraft({ createdProjectId: "project-9" }));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SERIES_LOCKED");
  });
});

describe("writing the next book", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("answers a finished book's format for the chat to start from", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    sourceBookIs(sourceBook());
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/next-book", headers: bearer("token-a") });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projectId: "book-1", title: "The Night Garden", presets: { bookTypeChoice: "children_story" } });
    await app.close();
  });

  it("starts a chat already linked to the book", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    sourceBookIs(sourceBook());
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => creationDraftRecord({ id: "draft-new", ...data }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a"),
      payload: { series: { mode: "continuation", projectId: "book-1" } }
    });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.mobileCreationDraft.create.mock.calls[0]![0].data).toMatchObject({ seriesMode: "continuation", seriesSourceProjectId: "book-1" });
    expect(response.json().session.series.choice).toEqual({ mode: "continuation", projectId: "book-1", title: "The Night Garden" });
    await app.close();
  });

  it("refuses to start from a book the reader cannot continue", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    sourceBookIs(null);
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a"),
      payload: { series: { mode: "continuation", projectId: "book-1" } }
    });

    expect(response.statusCode).toBe(404);
    expect(mockPrisma.mobileCreationDraft.create).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("the series copy at Build", () => {
  beforeEach(() => {
    resetMobileHarness();
    builtBooks = [];
  });
  afterEach(teardownMobileHarness);

  async function build(draft: Record<string, unknown>): Promise<Record<string, any>> {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(draft);
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-kids" });
    // Luna is tapped in the chat; the library read that snapshots her is another suite's subject.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
      const created = projectRecord({ id: "project-sequel", userId: "user-a", title: data.title, prompt: data.prompt, mediaSettings: data.mediaSettings, currentPlan: null, pages: [], _count: { pages: 0, images: 0, jobs: 0 } });
      builtBooks.push(created);
      return created;
    });
    // A replay of this build loads the output it made rather than making another.
    mockPrisma.mobileCreationOutput.findFirst.mockImplementation(
      async () => (await mockPrisma.mobileCreationOutput.create.mock.results.at(-1)?.value) ?? null
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...draft, ...data }));
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan-sequel" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const response = await app.inject({ method: "POST", url: `/api/mobile/creation-sessions/${String(draft.id)}/build`, headers: bearer("token-a"), payload: {} });
    expect(response.statusCode).toBe(201);
    await app.close();
    return mockPrisma.project.create.mock.calls.at(-1)![0].data;
  }

  it("copies the earlier book into the new one and tells every writer it is a sequel", async () => {
    sourceBookIs(sourceBook());
    const data = await build(mentionDraft({ id: "draft-build-1", seriesMode: "continuation", seriesSourceProjectId: "book-1" }));

    const series = bookSeriesFromMediaSettings(data.mediaSettings);
    expect(series).toMatchObject({
      mode: "continuation",
      sourceProjectId: "book-1",
      sourceTitle: "The Night Garden",
      seriesName: "The Night Garden",
      bookNumber: 2,
      illustrationStyle: "Soft watercolor, moonlit palette.",
      storyPageDesign: "night",
      coverDesignId: "moonlit-garden"
    });
    expect(series!.facts).toEqual([{ subject: "Luna", attribute: "home", value: "the den under the oak" }]);
    expect(series!.fullText).toContain("Luna ran home to the den.");
    expect(data.mediaSettings.storyPageDesign).toBe("night");
    expect(data.prompt).toContain('Series: this is book 2 of the series "The Night Garden"');
  });

  it("builds the book unlinked when the earlier book is gone", async () => {
    sourceBookIs(null);
    const data = await build(mentionDraft({ id: "draft-build-2", seriesMode: "continuation", seriesSourceProjectId: "book-1" }));

    expect(bookSeriesFromMediaSettings(data.mediaSettings)).toBeUndefined();
    expect(data.prompt).not.toContain("Series:");
  });

  it("copies nothing for a chat that answered with a story of its own", async () => {
    sourceBookIs(sourceBook());
    const data = await build(mentionDraft({ id: "draft-build-3", seriesMode: "standalone", seriesSourceProjectId: null }));

    expect(bookSeriesFromMediaSettings(data.mediaSettings)).toBeUndefined();
  });

  it("builds a chat's later book unlinked", async () => {
    // The answer was given for the chat's first book; once it has built, the link is that book's.
    sourceBookIs(sourceBook());
    const data = await build(mentionDraft({ id: "draft-build-4", seriesMode: "continuation", seriesSourceProjectId: "book-1", createdProjectId: "project-first" }));

    expect(bookSeriesFromMediaSettings(data.mediaSettings)).toBeUndefined();
    expect(data.prompt).not.toContain("Series:");
  });

  it("replays a retry of a linked build after the chat has built", async () => {
    sourceBookIs(sourceBook());
    const linked = { seriesMode: "continuation", seriesSourceProjectId: "book-1" };
    await build(mentionDraft({ id: "draft-build-6", ...linked }));
    const first = mockBilling.startGenerationAttempt.mock.calls.at(-1)![0].requestFingerprint;

    // The retry reads the chat after its build landed, so no copy is made now;
    // the fingerprint names the answer, which is the same, and the build replays.
    await build(mentionDraft({ id: "draft-build-6", ...linked, createdProjectId: "project-sequel" }));

    expect(mockBilling.startGenerationAttempt.mock.calls.at(-1)![0].requestFingerprint).toBe(first);
    expect(mockPrisma.project.create).toHaveBeenCalledTimes(1);
  });

  it("fingerprints the answer, not the earlier book's text", async () => {
    sourceBookIs(sourceBook());
    await build(mentionDraft({ id: "draft-build-5", seriesMode: "continuation", seriesSourceProjectId: "book-1" }));
    const before = mockBilling.startGenerationAttempt.mock.calls.at(-1)![0].requestFingerprint;
    sourceBookIs(sourceBook({ pages: [{ markdown: "An edit the reader made since.", chapterId: "chapter-1" }] }));
    await build(mentionDraft({ id: "draft-build-5", seriesMode: "continuation", seriesSourceProjectId: "book-1" }));

    expect(mockBilling.startGenerationAttempt.mock.calls.at(-1)![0].requestFingerprint).toBe(before);
  });
});
