import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    manuscriptAssist: { findUnique: vi.fn(), updateMany: vi.fn() },
    manuscript: { findUnique: vi.fn() },
    libraryCharacter: { findMany: vi.fn() },
    page: { findFirst: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn()
  },
  append: vi.fn(),
  advanceJobStep: vi.fn(),
  getProjectOrThrow: vi.fn(),
  executionMode: { value: "chaptered" },
  draftChapterFromNotes: vi.fn(),
  reviewChapterForAuthor: vi.fn(),
  checkBookConsistency: vi.fn(),
  outlineAuthorBook: vi.fn(),
  analyzeManuscriptStyle: vi.fn(),
  prepareEmbedding: vi.fn(),
  writePreparedEmbedding: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  prisma: mocks.prisma,
  pageScope: (index: number) => `page:${index}`
}));
vi.mock("../providers/loggedAdapters.js", () => ({
  createLoggedProviders: () => ({ text: { kind: "text" }, image: { kind: "image" }, embedding: { kind: "embedding" } })
}));
vi.mock("../providers/runLogging.js", () => ({ createRunLogger: () => ({ append: mocks.append }) }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: mocks.advanceJobStep }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  strategyForInput: () => ({ executionMode: mocks.executionMode.value })
}));
vi.mock("../generation/projectInput.js", () => ({ inputFromProject: () => ({ mediaSettings: {} }) }));
vi.mock("../generation/embeddingWrites.js", () => ({
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding,
  strategyUsesSemanticMemory: (strategy: { executionMode: string }) => strategy.executionMode === "sequential-pages"
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    createProviders: () => ({}),
    draftChapterFromNotes: mocks.draftChapterFromNotes,
    reviewChapterForAuthor: mocks.reviewChapterForAuthor,
    checkBookConsistency: mocks.checkBookConsistency,
    outlineAuthorBook: mocks.outlineAuthorBook,
    analyzeManuscriptStyle: mocks.analyzeManuscriptStyle
  };
});

import { writingAssist } from "./writingAssist.js";
import { WritingAssistFailure } from "../runtime/writingAssistSettlement.js";

const studioSettings = { layout: "flow", kind: "story", createdAt: "2026-09-29" };
const styleProfile = {
  voiceGuide: ["Short, plain sentences."],
  antiAiRules: ["No summaries at the end of a scene."],
  tone: "wry",
  pointOfView: "first person",
  tense: "past",
  audience: "Adults",
  writingComplexity: 5,
  premise: "A lighthouse keeper's last winter.",
  detectedLanguage: "en",
  sampleExcerpts: ["The lamp never cared who wound it."]
};

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    userId: "user-1",
    title: "The Last Winter",
    language: "en",
    currentPlanId: "plan-1",
    status: "COMPLETE",
    mediaSettings: { mobile: { studio: { ...studioSettings, styleProfile } } },
    ...overrides
  };
}

const chapters = [
  { id: "ch-1", position: 1, title: "The Lamp", markdown: `${"Early prose. ".repeat(200)}\n\nShe climbed the stairs.`, notes: "" },
  { id: "ch-2", position: 2, title: "The Storm", markdown: "", notes: "The storm arrives; the keeper refuses to leave." },
  { id: "ch-3", position: 3, title: "Chapter 3", markdown: "", notes: "" }
];

function assistRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "assist-1",
    projectId: "project-1",
    chapterId: "ch-2",
    kind: "DRAFT_CHAPTER",
    status: "QUEUED",
    input: {},
    result: null,
    error: null,
    ...overrides
  };
}

function job(data: Record<string, unknown> = {}) {
  return {
    id: "bull-1",
    name: "writing-assist",
    data: { projectId: "project-1", generationJobId: "job-1", assistId: "assist-1", attemptId: "attempt-1", ...data }
  } as never;
}

/** The publish write — the last `updateMany` on the row. */
function publishedWrite() {
  const calls = mocks.prisma.manuscriptAssist.updateMany.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executionMode.value = "chaptered";
  mocks.getProjectOrThrow.mockResolvedValue(project());
  mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow());
  mocks.prisma.manuscriptAssist.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.manuscript.findUnique.mockResolvedValue({
    id: "manuscript-1",
    settings: { layout: "flow", kind: "story", castCharacterIds: [] },
    chapters
  });
  mocks.prisma.libraryCharacter.findMany.mockResolvedValue([]);
  mocks.prisma.$transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(mocks.prisma));
  mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);
  mocks.draftChapterFromNotes.mockResolvedValue({ markdown: "The wind came first." });
  mocks.reviewChapterForAuthor.mockResolvedValue({
    notes: [{ quote: "She climbed the stairs.", note: "Slow this down.", severity: "suggestion" }]
  });
  mocks.checkBookConsistency.mockResolvedValue({
    notes: [{ quote: "the lamp", note: "The lamp is gas here, electric in chapter 1.", severity: "issue", chapterId: "ch-1" }]
  });
  mocks.outlineAuthorBook.mockResolvedValue({ chapters: [{ title: "Arrival", notes: "She reaches the island." }] });
  mocks.analyzeManuscriptStyle.mockResolvedValue(styleProfile);
  mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1]", error: null });
  mocks.writePreparedEmbedding.mockResolvedValue("stored");
});

describe("writing-assist text kinds", () => {
  it("drafts a chapter from its notes after the previous chapter's ending, in the learned voice", async () => {
    await writingAssist(job());

    const [input, deps] = mocks.draftChapterFromNotes.mock.calls[0]!;
    expect(input.chapter).toEqual({ title: "The Storm", notes: "The storm arrives; the keeper refuses to leave." });
    expect(input.previousChapterEnding).toMatch(/She climbed the stairs\.$/);
    expect(input.previousChapterEnding.length).toBeLessThanOrEqual(1500);
    expect(input.targetWords).toBe(1500);
    expect(input.book).toMatchObject({ title: "The Last Winter", kind: "story", language: "en", layout: "flow" });
    expect(input.book.styleProfile).toEqual(styleProfile);
    expect(deps.textModel).toEqual({ kind: "text" });

    expect(mocks.prisma.manuscriptAssist.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "assist-1", status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "RUNNING" }
    });
    expect(publishedWrite()).toEqual({
      where: { id: "assist-1", status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "READY", result: { type: "draft", markdown: "The wind came first." }, error: null }
    });
    // A suggestion, never the book: no project or page write at all.
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.updateMany).not.toHaveBeenCalled();
    expect(mocks.advanceJobStep).toHaveBeenCalledWith("job-1", "assist", 35, "Drafting the chapter");
    expect(mocks.append).toHaveBeenCalledWith("writing_assist.published", expect.objectContaining({ status: "READY" }));
  });

  it("prefers the notes sent with the request and passes the requested length through", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(
      assistRow({ input: { notes: "Only the dog survives.", targetWords: 900 } })
    );

    await writingAssist(job());

    expect(mocks.draftChapterFromNotes.mock.calls[0]![0]).toMatchObject({
      chapter: { title: "The Storm", notes: "Only the dog survives." },
      targetWords: 900
    });
  });

  it("returns margin notes on the chapter's working copy", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ kind: "CHAPTER_FEEDBACK", chapterId: "ch-1" }));

    await writingAssist(job());

    expect(mocks.reviewChapterForAuthor.mock.calls[0]![0].chapter).toEqual({
      title: "The Lamp",
      markdown: chapters[0]!.markdown
    });
    expect(publishedWrite().data).toMatchObject({
      status: "READY",
      result: { type: "notes", notes: [{ quote: "She climbed the stairs.", note: "Slow this down.", severity: "suggestion" }] }
    });
  });

  it("refuses notes on an empty chapter before any model call", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ kind: "CHAPTER_FEEDBACK", chapterId: "ch-2" }));

    await expect(writingAssist(job())).rejects.toBeInstanceOf(WritingAssistFailure);
    expect(mocks.reviewChapterForAuthor).not.toHaveBeenCalled();
    expect(mocks.prisma.manuscriptAssist.updateMany).toHaveBeenCalledTimes(1);
  });

  it("fails an assist whose chapter has been deleted", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ chapterId: "ch-gone" }));

    await expect(writingAssist(job())).rejects.toThrow("That chapter is no longer in your manuscript.");
    expect(mocks.draftChapterFromNotes).not.toHaveBeenCalled();
  });

  it("checks consistency across the chapters that have text, keeping each note's chapter", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ kind: "CONSISTENCY", chapterId: null }));

    await writingAssist(job());

    expect(mocks.checkBookConsistency.mock.calls[0]![0].chapters).toEqual([
      { id: "ch-1", title: "The Lamp", markdown: chapters[0]!.markdown }
    ]);
    expect(publishedWrite().data.result).toEqual({
      type: "notes",
      notes: [{ quote: "the lamp", note: "The lamp is gas here, electric in chapter 1.", severity: "issue", chapterId: "ch-1" }]
    });
  });

  it("outlines from the author's premise, keeping named chapters and dropping the placeholder", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(
      assistRow({ kind: "OUTLINE", chapterId: null, input: { notes: "A keeper, an island, a last winter." } })
    );

    await writingAssist(job());

    expect(mocks.outlineAuthorBook.mock.calls[0]![0]).toMatchObject({
      premise: "A keeper, an island, a last winter.",
      existingChapters: [
        { title: "The Lamp", notes: "" },
        { title: "The Storm", notes: "The storm arrives; the keeper refuses to leave." }
      ]
    });
    expect(publishedWrite().data.result).toEqual({
      type: "outline",
      chapters: [{ title: "Arrival", notes: "She reaches the island." }]
    });
  });

  it("describes the cast to the runner", async () => {
    mocks.prisma.manuscript.findUnique.mockResolvedValue({
      id: "manuscript-1",
      settings: { layout: "flow", kind: "story", castCharacterIds: ["char-1", "char-foreign"] },
      chapters
    });
    mocks.prisma.libraryCharacter.findMany.mockResolvedValue([
      {
        id: "char-1",
        name: "Mara",
        description: "The keeper.",
        appearance: "Grey braid, oilskin coat.",
        fields: [],
        portraitStatus: "NONE",
        portraitPath: null,
        portraitSource: null,
        outgoingMentions: []
      }
    ]);

    await writingAssist(job());

    expect(mocks.prisma.libraryCharacter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["char-1", "char-foreign"] }, userId: "user-1" } })
    );
    expect(mocks.draftChapterFromNotes.mock.calls[0]![0].book.characters).toEqual([
      { name: "Mara", description: "The keeper. Grey braid, oilskin coat." }
    ]);
  });
});

describe("writing-assist internal passes", () => {
  it("learns the Studio voice into the studio record and the current plan's snapshot, then settles APPLIED", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ kind: "STYLE_PROFILE", chapterId: null }));

    await writingAssist(job());

    expect(mocks.analyzeManuscriptStyle).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en", text: expect.stringContaining("She climbed the stairs.") }),
      { model: { kind: "text" } }
    );
    const [projectSql, projectId, patch] = mocks.prisma.$executeRawUnsafe.mock.calls[0]!;
    expect(projectSql).toContain(`jsonb_set("mediaSettings", '{mobile,studio}'`);
    expect(projectSql).toContain(`jsonb_typeof("mediaSettings"->'mobile'->'studio') = 'object'`);
    expect(projectId).toBe("project-1");
    expect(JSON.parse(patch as string)).toEqual({ styleProfile, styleProfileWords: expect.any(Number) });
    const [planSql, planId] = mocks.prisma.$executeRawUnsafe.mock.calls[1]!;
    expect(planSql).toContain(`"PlanVersion"`);
    expect(planId).toBe("plan-1");
    expect(publishedWrite().data).toMatchObject({ status: "APPLIED", result: { type: "style", stored: true } });
  });

  it("leaves an imported book's own profile alone", async () => {
    mocks.getProjectOrThrow.mockResolvedValue(
      project({ mediaSettings: { mobile: { import: { importId: "imp-1", styleProfile } } } })
    );
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ kind: "STYLE_PROFILE", chapterId: null }));

    await writingAssist(job());

    expect(mocks.analyzeManuscriptStyle).not.toHaveBeenCalled();
    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(publishedWrite().data.result).toMatchObject({ type: "style", stored: false, skipped: "imported" });
  });

  it("re-embeds only the pages that still hold the id, index and revision the publish saw", async () => {
    mocks.executionMode.value = "sequential-pages";
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ kind: "REEMBED", chapterId: null }));
    const pages = [
      { pageId: "page-3", index: 3, revision: 4 },
      { pageId: "page-4", index: 4, revision: 2 },
      { pageId: "page-5", index: 5, revision: 1 }
    ];
    mocks.prisma.page.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "page-4" ? null : { summary: `Summary of ${where.id}`, markdown: "Prose." }
    );
    // page-5 changed hands between the read and the write.
    mocks.prisma.$queryRawUnsafe.mockImplementation(async (_sql: string, pageId: string) =>
      pageId === "page-5" ? [] : [{ id: pageId }]
    );
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(0);

    await writingAssist(job({ pages }));

    expect(mocks.prisma.$queryRawUnsafe.mock.calls[0]).toEqual([
      expect.stringContaining("FOR UPDATE"),
      "page-3",
      "project-1",
      3,
      4
    ]);
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(
      { projectId: "project-1", scope: "page:3", sourceId: "page-3", text: "Summary of page-3" },
      { vectorLiteral: "[0.1]", error: null },
      mocks.prisma
    );
    expect(publishedWrite().data).toMatchObject({
      status: "APPLIED",
      result: { type: "memory", embedded: 1, skipped: 2 }
    });
  });

  it("spends no embedding call on a book whose strategy never reads page memory", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(
      assistRow({ kind: "REEMBED", chapterId: null, input: { pages: [{ pageId: "page-3", index: 3, revision: 4 }] } })
    );

    await writingAssist(job());

    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expect(publishedWrite().data.result).toEqual({ type: "memory", embedded: 0, skipped: 1, unused: true });
  });
});

describe("writing-assist redelivery", () => {
  it.each(["READY", "APPLIED"])("does no work twice for a %s row, so the charge commits once", async (status) => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ status, result: { type: "draft", markdown: "x" } }));

    await expect(writingAssist(job())).resolves.toBeUndefined();

    expect(mocks.prisma.manuscriptAssist.updateMany).not.toHaveBeenCalled();
    expect(mocks.draftChapterFromNotes).not.toHaveBeenCalled();
    expect(mocks.append).toHaveBeenCalledWith("writing_assist.already_delivered", { assistId: "assist-1" });
  });

  it("treats a result the author dismissed as delivered", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(
      assistRow({ status: "DISMISSED", result: { type: "draft", markdown: "x" } })
    );

    await expect(writingAssist(job())).resolves.toBeUndefined();
    expect(mocks.draftChapterFromNotes).not.toHaveBeenCalled();
  });

  it("fails — and so refunds — a request dismissed before it ran", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ status: "DISMISSED" }));

    await expect(writingAssist(job())).rejects.toThrow("This request was dismissed before it ran.");
    expect(mocks.draftChapterFromNotes).not.toHaveBeenCalled();
  });

  it("rethrows a FAILED row's own verdict rather than running it again", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(
      assistRow({ status: "FAILED", error: "The chapter draft couldn’t be written." })
    );

    await expect(writingAssist(job())).rejects.toThrow("The chapter draft couldn’t be written.");
    expect(mocks.prisma.manuscriptAssist.updateMany).not.toHaveBeenCalled();
    expect(mocks.draftChapterFromNotes).not.toHaveBeenCalled();
  });

  it("re-runs a RUNNING row a crashed delivery left behind", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ status: "RUNNING" }));

    await writingAssist(job());

    expect(mocks.draftChapterFromNotes).toHaveBeenCalledTimes(1);
    expect(publishedWrite().data.status).toBe("READY");
  });

  it("writes nothing over a row another delivery already published", async () => {
    mocks.prisma.manuscriptAssist.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await writingAssist(job());

    expect(mocks.append).toHaveBeenCalledWith("writing_assist.superseded", { assistId: "assist-1", kind: "DRAFT_CHAPTER" });
    expect(mocks.append).not.toHaveBeenCalledWith("writing_assist.published", expect.anything());
  });

  it("refuses a row from another project", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue(assistRow({ projectId: "project-2" }));

    await expect(writingAssist(job())).rejects.toThrow(/no longer exists/);
    expect(mocks.prisma.manuscriptAssist.updateMany).not.toHaveBeenCalled();
  });
});
