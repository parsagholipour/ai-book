import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSetup } from "../runtime/jobTypes.js";

const store = vi.hoisted(() => ({
  chapters: [] as Array<{ id: string; index: number; title: string; targetPages: number; productionBrief: unknown }>,
  pages: [] as Array<{
    id: string;
    index: number;
    status: string;
    title: string;
    markdown: string;
    summary: string;
    imagePrompt: string | null;
    chapterId: string | null;
    revision: number;
    updatedAt: Date;
  }>,
  notes: [] as Array<{ pageId: string; body: string }>,
  planningPackage: {} as Record<string, unknown>
}));

const mocks = vi.hoisted(() => {
  const prisma = {
    chapter: {
      findFirst: vi.fn(async (args: { where: { index: number } }) => store.chapters.find((chapter) => chapter.index === args.where.index)),
      findMany: vi.fn(async () => store.chapters.map((chapter) => ({ ...chapter }))),
      update: vi.fn(async (args: { where: { id: string }; data: { productionBrief: unknown } }) => {
        const chapter = store.chapters.find((candidate) => candidate.id === args.where.id);
        if (chapter) chapter.productionBrief = args.data.productionBrief;
        return chapter;
      })
    },
    page: {
      findMany: vi.fn(async () => [...store.pages].sort((a, b) => a.index - b.index).map((page) => ({ ...page }))),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        for (const row of args.data) {
          store.pages.push({
            id: `page-${String(row.index)}`,
            index: row.index as number,
            status: row.status as string,
            title: row.title as string,
            markdown: row.markdown as string,
            summary: row.summary as string,
            imagePrompt: (row.imagePrompt as string | null) ?? null,
            chapterId: (row.chapterId as string | null) ?? null,
            revision: 1,
            updatedAt: new Date(0)
          });
        }
        return { count: args.data.length };
      }),
      updateMany: vi.fn(async (args: { where: { index: number; status: string }; data: Record<string, unknown> }) => {
        const page = store.pages.find((candidate) => candidate.index === args.where.index && candidate.status === args.where.status);
        if (page) Object.assign(page, args.data);
        return { count: page ? 1 : 0 };
      }),
      count: vi.fn(async (args: { where: { status: string; index: { gte: number; lte: number } } }) =>
        store.pages.filter(
          (page) => page.status === args.where.status && page.index >= args.where.index.gte && page.index <= args.where.index.lte
        ).length
      ),
      deleteMany: vi.fn(async (args: { where: { OR: Array<{ index: { gte: number; lte: number } }> } }) => {
        const before = store.pages.length;
        store.pages = store.pages.filter(
          (page) => !args.where.OR.some((range) => page.index >= range.index.gte && page.index <= range.index.lte)
        );
        return { count: before - store.pages.length };
      })
    },
    project: { update: vi.fn(async () => ({})) },
    generationJob: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) }, // no composition prep
    planVersion: {
      findUnique: vi.fn(async () => ({ planningPackage: store.planningPackage })),
      updateMany: vi.fn(async (args: { data: { planningPackage: unknown } }) => {
        store.planningPackage = args.data.planningPackage as Record<string, unknown>;
        return { count: 1 };
      }),
      update: vi.fn(async (args: { data: { planningPackage: unknown } }) => {
        store.planningPackage = args.data.planningPackage as Record<string, unknown>;
        return {};
      })
    },
    continuityNote: {
      createMany: vi.fn(async (args: { data: Array<{ pageId: string; body: string }> }) => {
        store.notes.push(...args.data);
        return { count: args.data.length };
      })
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma))
  };
  return {
    prisma,
    maybeEnqueueCompile: vi.fn(),
    maybeEnqueueCover: vi.fn(),
    ensureCharacterReferenceAssets: vi.fn(),
    resetBookForDirectGeneration: vi.fn(async (_projectId: string, setups: ChapterSetup[]) => {
      store.chapters = setups.map((setup) => ({
        id: `chapter-${setup.chapter.index}`,
        index: setup.chapter.index,
        title: setup.chapter.title,
        targetPages: setup.chapter.targetPages,
        productionBrief: null
      }));
      store.pages = [];
      return new Map(store.chapters.map((chapter) => [chapter.index, chapter.id]));
    }),
    stageGeneratedPageAndBrief: vi.fn(async (options: { pageIndex: number; status: string; revision: number }) => {
      const page = store.pages.find((candidate) => candidate.index === options.pageIndex)!;
      page.status = options.status;
      return { id: page.id, revision: options.revision, updatedAt: new Date(1) };
    }),
    publishStagedGeneratedPage: vi.fn(async () => "completed"),
    keeperStoryExtractForSave: vi.fn(async () => null),
    developmentEnabled: false,
    qualityEnabled: vi.fn((_feature: string): boolean => true)
  };
});

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  maybeEnqueueCover: mocks.maybeEnqueueCover
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./bookState.js", () => ({ resetBookForDirectGeneration: mocks.resetBookForDirectGeneration }));
vi.mock("./characterReferences.js", () => ({ ensureCharacterReferenceAssets: mocks.ensureCharacterReferenceAssets }));
vi.mock("./sourceDossier.js", async (original) => ({ ...await original<object>(), retrieveChapterSources: vi.fn(async () => ({ documents: [], excerpts: [] })) }));
// The claim review is off in production (`SOURCE_CLAIM_REVIEW`); these tests keep its dormant path working.
vi.mock("./sourceClaimState.js", async (original) => ({ ...await original<object>(), SOURCE_CLAIM_REVIEW: true }));
vi.mock("./bookHelpers.js", async () => {
  const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    chapterSetupsForPlan: (plan: import("@book-maker/core").BookPlan, targetPages: number) => {
      let next = 1;
      return core.normalizePlanPageTargets(plan, targetPages).chapters.map((chapter) => {
        const startPage = next;
        const endPage = Math.min(targetPages, startPage + chapter.targetPages - 1);
        next = endPage + 1;
        return { chapter, startPage, endPage };
      });
    }
  };
});
vi.mock("./generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("./pagePublication.js", () => ({
  GeneratedPagePublicationClaimLostError: class extends Error {},
  loadGeneratedPagePublicationSnapshot: async (_projectId: string, pageIndex: number) => {
    const page = store.pages.find((candidate) => candidate.index === pageIndex);
    return page ? { ...page } : null;
  },
  stageGeneratedPageAndBrief: mocks.stageGeneratedPageAndBrief,
  publishStagedGeneratedPage: mocks.publishStagedGeneratedPage
}));
vi.mock("./qualityEnrichment.js", () => ({ keeperStoryExtractForSave: mocks.keeperStoryExtractForSave, persistStoryExtract: async () => null }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({ tier: "balanced", enabled: (feature: string) => ["bookDevelopment", "caseEvidence", "developmentalEdit"].includes(feature) ? mocks.developmentEnabled : mocks.qualityEnabled(feature), settings: {}, pageReviewPromptMode: "normal" })
}));
vi.mock("./storyStateStore.js", async () => {
  const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { loadProjectStoryState: async (_projectId: string, promises: string[]) => core.seedStoryStateFromPromises(promises) };
});
vi.mock("./wholeBookPageReview.js", () => ({
  reviewWholeBookDraftPages: async (options: { pages: Array<{ index: number }> }) =>
    options.pages.map((draft) => ({
      draft,
      revision: 1,
      qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "", checks: {} }
    }))
}));

import { FakeTextModelAdapter, assignedSectionCount, caseEvidencePacketSchema, chapterWordBudget, figureCapFor, figureSpecSchema, makeFallbackPlan, proseWordCount, sustainedSectionShare, type CreateProjectInput, type ProviderSet } from "@book-maker/core";
import { composedChaptersResearchStrategy, composedChaptersStrategy } from "@book-maker/core";
import { retrieveChapterSources } from "./sourceDossier.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { composedResumeState, derivedChapterBrief, generateBookComposedChapters } from "./composedChaptersPass.js";
import { finalizePendingPages } from "./composedChaptersFinalize.js";
import { sourceClaimDigest } from "./composedClaimReview.js";

const input: CreateProjectInput = {
  prompt: "A global history of aggression and its causes.",
  category: "HISTORY",
  targetPages: 24,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

function providersWith(text: FakeTextModelAdapter): ProviderSet {
  return { text } as unknown as ProviderSet;
}

function recordingFake(): { fake: FakeTextModelAdapter; purposes: string[] } {
  const fake = new FakeTextModelAdapter(input);
  const purposes: string[] = [];
  const originalText = fake.generateText.bind(fake);
  const originalJson = fake.generateJson.bind(fake);
  fake.generateText = async (options) => {
    purposes.push(options.purpose ?? "text");
    return originalText(options);
  };
  fake.generateJson = async (options) => {
    purposes.push(options.purpose ?? "json");
    if (options.purpose === "inventory-chapter-claims") {
      const data = options.schema.parse({ complete: true, claims: [] });
      return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    }
    return originalJson(options);
  };
  return { fake, purposes };
}

beforeEach(() => {
  store.chapters = [];
  store.pages = [];
  store.notes = [];
  store.planningPackage = { title: "Plan" };
  vi.clearAllMocks();
  mocks.qualityEnabled.mockImplementation(() => true);
  mocks.developmentEnabled = false;
});

describe("composedResumeState", () => {
  const ranges = [
    { chapterIndex: 1, title: "One", targetPages: 3, startPage: 1, endPage: 3 },
    { chapterIndex: 2, title: "Two", targetPages: 3, startPage: 4, endPage: 6 }
  ];
  const chapters = [
    { index: 1, title: "One", targetPages: 3 },
    { index: 2, title: "Two", targetPages: 3 }
  ];

  it("is fresh with no rows, a mismatched structure, or a duplicate page", () => {
    expect(composedResumeState({ ranges, storedChapters: [], storedPages: [] })).toEqual({ kind: "fresh" });
    expect(
      composedResumeState({ ranges, storedChapters: [chapters[0]!, { ...chapters[1]!, title: "Other" }], storedPages: [] })
    ).toEqual({ kind: "fresh" });
    expect(
      composedResumeState({
        ranges,
        storedChapters: chapters,
        storedPages: [
          { index: 1, status: "PENDING" },
          { index: 1, status: "PENDING" }
        ]
      })
    ).toEqual({ kind: "fresh" });
  });

  it("resumes at the first chapter without pages and redoes a partial one", () => {
    expect(
      composedResumeState({
        ranges,
        storedChapters: chapters,
        storedPages: [1, 2, 3, 4].map((index) => ({ index, status: "PENDING" }))
      })
    ).toEqual({ kind: "resume", doneChapterIndexes: [1], partialChapterIndexes: [2] });
  });

  it("finalizes when every chapter is present but pages are still pending, and stops when none are", () => {
    const all = [1, 2, 3, 4, 5, 6];
    expect(
      composedResumeState({ ranges, storedChapters: chapters, storedPages: all.map((index) => ({ index, status: index < 4 ? "COMPLETED" : "PENDING" })) })
    ).toEqual({ kind: "resume", doneChapterIndexes: [1, 2], partialChapterIndexes: [] });
    expect(
      composedResumeState({ ranges, storedChapters: chapters, storedPages: all.map((index) => ({ index, status: "COMPLETED" })) })
    ).toEqual({ kind: "already-complete" });
  });
});

describe("derivedChapterBrief", () => {
  it("names each page's section, carries its notes, and lands only on the last page", () => {
    const setup: ChapterSetup = {
      chapter: { index: 2, title: "Empires", summary: "S", targetPages: 4, keyBeats: [] },
      startPage: 5,
      endPage: 8
    };
    const composition = {
      chapterIndex: 2,
      throughLine: "Through",
      sections: [
        { form: "scene", subject: "Babylon", share: 0.5, owns: [] },
        { form: "argument", subject: "Provisional rule", share: 0.5, owns: [] }
      ],
      landing: "Rule was provisional.",
      avoid: []
    };
    const pages = [5, 6, 7, 8].map((index) => ({
      index,
      title: `T${index}`,
      summary: `Summary ${index}`,
      continuityNotes: [`Fact ${index}`],
      markdown: `Prose ${index}`,
      ...(index === 5 ? { imagePrompt: "A gate" } : {})
    }));
    const brief = derivedChapterBrief(setup, composition, pages);
    expect(brief.pages.map((page) => page.purpose)).toEqual([
      'Part of the section "Babylon", written as a scene.',
      'Part of the section "Babylon", written as a scene.',
      'Part of the section "Provisional rule", written as a argument.',
      'Part of the section "Provisional rule", written as a argument.'
    ]);
    expect(brief.pages[3]!.endingPressure).toBe("Rule was provisional.");
    expect(brief.pages[0]!.endingPressure).toContain("add no landing sentence");
    expect(brief.pages[1]!.requiredContinuity).toEqual(["Fact 6"]);
    expect(brief.pages[0]!.imageMoment).toBe("A gate");
    expect(brief.composition).toBe(composition);
  });
});

describe("generateBookComposedChapters", () => {
  it("rechecks changed final pages and persists the verdict for the text that will publish", async () => {
    mocks.qualityEnabled.mockImplementation((feature) => feature !== "figures");
    const plan = makeFallbackPlan(input);
    const { fake } = recordingFake();
    const args = { projectId: "project-1", planId: "plan-1", input, plan, providers: providersWith(fake), strategy: composedChaptersStrategy };
    await generateBookComposedChapters(args);
    const page = store.pages[0]!;
    const claim = "The three authors were listed alphabetically.";
    page.markdown += `\n\n${claim}`;
    page.status = "PENDING";
    const review = vi.spyOn(fake, "generateJson").mockImplementation(async (request) => {
      expect(request.purpose).toBe("inventory-chapter-claims");
      const data = request.schema.parse({ complete: true, claims: [{ quote: claim, searchQuery: "RSA paper author order" }] });
      return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    });
    await finalizePendingPages(args);
    expect(review).toHaveBeenCalledOnce();
    const chapter = store.chapters.find((entry) => entry.id === page.chapterId)!;
    const manuscript = store.pages.filter((entry) => entry.chapterId === chapter.id).map((entry) => entry.markdown).join("\n\n");
    expect(chapter.productionBrief).toMatchObject({ report: { sourceClaims: {
      textDigest: sourceClaimDigest(manuscript), coverage: { status: "reviewed", unsupported: 1 },
      claims: [expect.objectContaining({ quote: claim, status: "insufficient_evidence" })]
    } } });
    expect(page.status).toBe("COMPLETED");
    // Replaying the publication step reuses only a review of identical final text.
    page.status = "PENDING";
    await finalizePendingPages(args);
    expect(review).toHaveBeenCalledOnce();
  });
  it("keeps a chapter's draft when its length retry fails, finishes the book, and logs it", async () => {
    // r2-fast-guide (2026-09-30): the length retry ran away to its output cap and the book FAILED.
    const [plan, { fake }] = [makeFallbackPlan(input), recordingFake()];
    const compose = fake.generateText;
    fake.generateText = async (options) => options.purpose !== "compose-chapter" ? compose(options)
      : options.messages[0]!.content.includes("Your previous answer was") ? Promise.reject(new Error("OpenAI response was incomplete: max_output_tokens."))
      : compose(options).then((full) => ({ ...full, text: full.text.split(/(?<=\.)\s+/).filter((_, i, all) => i < all.length / 3).join("\n\n") }));
    const append = vi.fn(async (_event: string, _data: Record<string, unknown>) => "");
    await generateBookComposedChapters({ projectId: "project-1", planId: "plan-1", input, plan, providers: providersWith(fake), strategy: composedChaptersStrategy, generationJobId: "job-1", runLog: { append } });
    expect(append.mock.calls.filter(([event]) => event === "generation.composed_chapters.length_retry_failed").map(([, data]) => data)).toEqual(plan.chapters.map((chapter) => expect.objectContaining({ chapterIndex: chapter.index, error: "OpenAI response was incomplete: max_output_tokens." })));
    expect(store.pages.length > 0 && store.pages.every((page) => page.markdown.trim().length > 0)).toBe(true);
  });

  it("writes every chapter whole, checkpoints its pages, reads the book once, and finalizes", async () => {
    const plan = makeFallbackPlan(input);
    const { fake, purposes } = recordingFake();
    await generateBookComposedChapters({
      projectId: "project-1",
      planId: "plan-1",
      input,
      plan,
      providers: providersWith(fake),
      strategy: composedChaptersStrategy,
      generationJobId: "job-1"
    });

    expect(mocks.resetBookForDirectGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCharacterReferenceAssets).toHaveBeenCalledTimes(1);
    expect(mocks.maybeEnqueueCover).toHaveBeenCalledTimes(1);
    expect(purposes.filter((purpose) => purpose === "author-stance")).toHaveLength(1);
    expect(purposes.filter((purpose) => purpose === "plan-chapter-forms")).toHaveLength(1);
    expect(purposes.filter((purpose) => purpose === "compose-chapter")).toHaveLength(plan.chapters.length);
    // No line edit and no review of one (removed 2026-10-16): the draft is the chapter.
    expect(purposes).not.toContain("edit-chapter");
    expect(purposes).not.toContain("review-chapter-edit-acceptance");
    expect(store.chapters.map((chapter) => (chapter.productionBrief as { report: { lineEdited?: boolean; editorChanged: boolean } }).report))
      .toEqual(plan.chapters.map(() => expect.objectContaining({ lineEdited: false, editorChanged: false })));
    // Described once after the compose; the arc and the seams are off by default (composedChaptersState.ts).
    expect(purposes.filter((purpose) => purpose === "describe-pages")).toHaveLength(plan.chapters.length);
    expect(purposes).not.toContain("architect-book");
    expect(purposes).not.toContain("rewrite-seams");
    expect(purposes.filter((purpose) => purpose === "read-manuscript")).toHaveLength(1);
    expect(purposes).not.toContain("review-page");
    expect(purposes).not.toContain("generate-page");

    expect(mocks.prisma.page.createMany).toHaveBeenCalledTimes(plan.chapters.length);
    const firstBatch = mocks.prisma.page.createMany.mock.calls[0]![0] as { data: Array<{ index: number; status: string; chapterId: string }> };
    expect(firstBatch.data.map((row) => row.index)).toEqual(Array.from({ length: plan.chapters[0]!.targetPages }, (_, index) => index + 1));
    expect(firstBatch.data.every((row) => row.status === "PENDING" && row.chapterId === "chapter-1")).toBe(true);

    const briefs = store.chapters.map(
      (chapter) =>
        chapter.productionBrief as {
          pages: unknown[];
          composition: { sections: unknown[] };
          report: { draftWords: number; editedWords: number; formPlanSource: string; readNotes: string[]; wordBudget: { target: number } };
        }
    );
    expect(briefs.every((brief) => brief.pages.length > 0 && brief.composition.sections.length >= 3)).toBe(true);
    expect(briefs.every((brief) => brief.report.draftWords > 0 && brief.report.editedWords > 0 && brief.report.wordBudget.target > 0)).toBe(true);
    const shaped = briefs[0]!.report as unknown as { paragraphCv: number; shapePassApplied: boolean };
    expect(typeof shaped.paragraphCv).toBe("number");
    expect(typeof shaped.shapePassApplied).toBe("boolean");
    expect(briefs[0]!.report.formPlanSource).toBe("model");
    // The plan carried no stance, so the one the pass generated is written back onto it (a CAS); no arc by default.
    expect(mocks.prisma.planVersion.update).not.toHaveBeenCalled();
    expect((store.planningPackage.authorStance as { thesis: string }).thesis).not.toBe("");
    expect(store.planningPackage.bookArc).toBeUndefined();
    expect(briefs.some((brief) => (brief.report as { seamsApplied?: boolean }).seamsApplied)).toBe(false);

    expect(store.pages).toHaveLength(input.targetPages);
    expect(store.pages.every((page) => page.status === "COMPLETED" && page.markdown.trim().length > 0)).toBe(true);
    expect(mocks.stageGeneratedPageAndBrief).toHaveBeenCalledTimes(input.targetPages);
    expect(store.notes.length).toBeGreaterThan(0);
    expect(mocks.publishStagedGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");

    const briefPhases = vi
      .mocked(advanceJobStep)
      .mock.calls.filter((call) => call[1] === "briefs")
      .map((call) => call[4]?.phase);
    expect(briefPhases).toContain("stance");
    expect(briefPhases).toContain("forms");

    const setupCounters = vi
      .mocked(advanceJobStep)
      .mock.calls.filter((call) => call[1] === "setup" && call[4] && typeof call[4].total === "number")
      .map((call) => call[4]);
    expect(setupCounters[0]).toMatchObject({
      done: 0,
      total: plan.chapters.length,
      phase: "compose",
      chapterIndex: 1
    });
    expect(setupCounters.some((counters) => counters?.phase === "compose" && counters.chapterIndex === 1)).toBe(true);
    // No "edit" phase since the line edit was removed (2026-10-16); the API still maps the token for older jobs.
    expect(setupCounters.some((counters) => counters?.phase === "edit")).toBe(false);
    expect(setupCounters.some((counters) => counters?.phase === "read" && counters.total === plan.chapters.length)).toBe(true);
    expect(setupCounters.some((counters) => counters?.phase === "finalize" && counters.done === plan.chapters.length)).toBe(true);
  });

  it("resumes after a restart without rewriting finished chapters or resetting the book", async () => {
    const plan = makeFallbackPlan(input);
    const first = plan.chapters[0]!;
    store.chapters = plan.chapters.map((chapter) => ({
      id: `chapter-${chapter.index}`,
      index: chapter.index,
      title: chapter.title,
      targetPages: chapter.targetPages,
      productionBrief: null
    }));
    store.chapters[0]!.productionBrief = {
      chapterIndex: first.index,
      title: first.title,
      summary: "done",
      continuityFocus: [],
      pages: Array.from({ length: first.targetPages }, (_, offset) => ({
        pageIndex: offset + 1,
        chapterIndex: first.index,
        purpose: "p",
        beat: "b",
        requiredContinuity: [`Fact ${offset + 1}`],
        endingPressure: "e"
      })),
      composition: {
        chapterIndex: first.index,
        throughLine: "T",
        sections: [
          { form: "scene", subject: "A", share: 0.5, owns: [] },
          { form: "argument", subject: "B", share: 0.5, owns: [] }
        ],
        landing: "L",
        avoid: []
      }
    };
    store.pages = Array.from({ length: first.targetPages }, (_, offset) => ({
      id: `page-${offset + 1}`,
      index: offset + 1,
      status: "PENDING",
      title: `Stored ${offset + 1}`,
      markdown: `Stored prose ${offset + 1}.`,
      summary: `Stored summary ${offset + 1}`,
      imagePrompt: null,
      chapterId: "chapter-1",
      revision: 1,
      updatedAt: new Date(0)
    }));
    const { fake, purposes } = recordingFake();
    await generateBookComposedChapters({
      projectId: "project-1",
      planId: "plan-1",
      input,
      plan,
      providers: providersWith(fake),
      strategy: composedChaptersStrategy,
      generationJobId: "job-2"
    });

    expect(mocks.resetBookForDirectGeneration).not.toHaveBeenCalled();
    expect(purposes.filter((purpose) => purpose === "compose-chapter")).toHaveLength(plan.chapters.length - 1);
    expect(mocks.prisma.page.createMany).toHaveBeenCalledTimes(plan.chapters.length - 1);
    expect(store.pages).toHaveLength(input.targetPages);
    expect(store.pages.every((page) => page.status === "COMPLETED")).toBe(true);
    expect(store.pages[0]!.markdown).toBe("Stored prose 1.");
    expect(store.notes.some((note) => note.body === "Fact 1")).toBe(true);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
  });

  it("hands the form planner each chapter's word target so sections are counted from words", async () => {
    const plan = makeFallbackPlan(input);
    const { fake } = recordingFake();
    const originalJson = fake.generateJson;
    let formsPayload: { chapters: Array<{ chapterIndex: number; pages: number; words?: number; sectionCount: { min: number; max: number }; sustainedShare: number }> } | undefined;
    fake.generateJson = async (options) => {
      if (options.purpose === "plan-chapter-forms") {
        formsPayload = JSON.parse(options.messages.find((message) => message.role === "user")!.content);
      }
      return originalJson(options);
    };
    await generateBookComposedChapters({
      projectId: "project-1",
      planId: "plan-1",
      input,
      plan,
      providers: providersWith(fake),
      strategy: composedChaptersStrategy,
      generationJobId: "job-1"
    });
    expect(formsPayload).toBeDefined();
    for (const chapter of formsPayload!.chapters) {
      const planned = plan.chapters.find((entry) => entry.index === chapter.chapterIndex)!;
      expect(chapter.pages).toBe(planned.targetPages);
      expect(chapter.words).toBe(chapterWordBudget(input, planned.targetPages).target);
      expect(chapter.sectionCount).toEqual(assignedSectionCount(chapter.chapterIndex, planned.targetPages, chapter.words));
      expect(chapter.sustainedShare).toBe(sustainedSectionShare(chapter.words));
    }
  });

  it.each([["none", 0], ["sources", 1]] as const)("starts the research of a book whose stance says research: %s exactly %i time", async (research, times) => {
    // A novel searches nothing and plans no episodes, even with materialFirst on (2026-09-30).
    const stance = { thesis: "Loneliness is a skill.", positions: ["Detail over summary", "The keeper never explains himself"], refusals: [], voiceSample: "The keeper at Ardnamurchan wrote the wind in the log. ".repeat(12), research };
    const plan = { ...makeFallbackPlan(input), authorStance: stance };
    const { fake, purposes } = recordingFake();
    const start = vi.fn();
    const ready = vi.fn(async () => {});
    await generateBookComposedChapters({ projectId: "project-1", planId: "plan-1", input, plan, providers: providersWith(fake), strategy: composedChaptersStrategy, research: { start, ready } });
    expect(start).toHaveBeenCalledTimes(times);
    expect(ready).toHaveBeenCalledOnce();
    expect(purposes.includes("plan-episodes")).toBe(times === 1);
    expect(purposes).not.toContain("author-stance");
    expect(store.pages).toHaveLength(input.targetPages);
  });

  it("keeps a research book's lead answers as its notes and starts research only for the chapters no lead answered", async () => {
    // H3b (2026-10-16): a chapter with leads gets no chapter-research search of its own.
    const base = makeFallbackPlan(input);
    const last = base.chapters.at(-1)!.index;
    const episodes = { chapters: base.chapters.map((chapter) => ({ index: chapter.index, episodes: chapter.index === last ? [] : [{ title: `Lead ${chapter.index}`, kind: "document", why: "", searchQueries: [`query ${chapter.index}`] }] })) };
    const plan = { ...base, authorStance: { thesis: "T.", positions: ["P", "Q"], refusals: [], voiceSample: "The keeper wrote the wind in the log. ".repeat(12), research: "sources" as const }, episodes, researchQueries: [] } as unknown as typeof base;
    store.planningPackage = plan as unknown as Record<string, unknown>;
    const search = vi.fn(async (query: { query: string }) => ({ query: query.query, summary: "An answer.", sources: [] }));
    vi.mocked(retrieveChapterSources).mockImplementation(async (options) => {
      await options.leadSearch?.(`query ${options.chapter.index}`, `Lead ${options.chapter.index}`);
      return { documents: [], excerpts: [] };
    });
    const start = vi.fn();
    const providers = { text: recordingFake().fake, research: { search } } as unknown as ProviderSet;
    try {
      await generateBookComposedChapters({ projectId: "project-1", planId: "plan-1", input, plan, providers, strategy: composedChaptersResearchStrategy, research: { start, ready: async () => {} } });
    } finally { vi.mocked(retrieveChapterSources).mockImplementation(async () => ({ documents: [], excerpts: [] })); }
    expect(start).toHaveBeenCalledExactlyOnceWith({ chapterIndexes: [last], researchQueries: [] });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "query 1", purpose: "case-source-search" }));
  });

  it("lets two chapters finish beside the one being composed, and never more", async () => {
    // Finishing a chapter (then edit, review, descriptions) outlasted composing the next and paced the loop (2026-09-30).
    const long = { ...input, targetPages: 30 };
    const plan = makeFallbackPlan(long);
    const { fake } = recordingFake();
    const originalJson = fake.generateJson.bind(fake);
    let finishing = 0;
    let peak = 0;
    fake.generateJson = async (options) => {
      if (options.purpose !== "describe-pages") return originalJson(options);
      finishing += 1;
      peak = Math.max(peak, finishing);
      await new Promise((resolve) => setTimeout(resolve, 30));
      finishing -= 1;
      return originalJson(options);
    };
    await generateBookComposedChapters({ projectId: "project-1", planId: "plan-1", input: long, plan, providers: providersWith(fake), strategy: composedChaptersStrategy });
    expect(plan.chapters.length).toBeGreaterThanOrEqual(3);
    expect(peak).toBe(2);
    expect(store.pages).toHaveLength(long.targetPages);
  });

  it("skips the read when its gate is off, and never line-edits: Balanced's default since 2026-10-16", async () => {
    const plan = makeFallbackPlan(input);
    mocks.qualityEnabled.mockImplementation((feature: string) => feature !== "manuscriptReadPass");
    const { fake, purposes } = recordingFake();
    const append = vi.fn(async (_event: string, _data: Record<string, unknown>) => "");
    await generateBookComposedChapters({
      projectId: "project-1",
      planId: "plan-1",
      input,
      plan,
      providers: providersWith(fake),
      strategy: composedChaptersStrategy,
      generationJobId: "job-1",
      runLog: { append }
    });
    for (const purpose of ["edit-chapter", "read-manuscript", "cut-chapter", "review-chapter-edit-acceptance"]) expect(purposes).not.toContain(purpose);
    expect(store.pages).toHaveLength(input.targetPages);
    expect(store.pages.every((page) => page.status === "COMPLETED")).toBe(true);
    // The continuity notes the chapters staged are published without a read to re-stage them.
    expect(store.pages.every((page) => store.notes.some((note) => note.pageId === page.id))).toBe(true);
    // Nothing says a read happened, or that one was skipped or left something unverified.
    const phases = vi.mocked(advanceJobStep).mock.calls.map((call) => (call[4] as { phase?: string } | undefined)?.phase);
    expect(phases).not.toContain("read");
    expect(append.mock.calls.map(([event]) => event).filter((event) => /read|cut|unverified/.test(event))).toEqual([]);
    const reports = store.chapters.map((chapter) => (chapter.productionBrief as { report: { readNotes: string[]; secondEditApplied: boolean } }).report);
    expect(reports.every((report) => report.readNotes.length === 0 && report.secondEditApplied === false)).toBe(true);
  });
});

describe("figures in the composed pass", () => {
  const run = async () => {
    const plan = makeFallbackPlan(input);
    const { fake } = recordingFake();
    await generateBookComposedChapters({
      projectId: "project-1",
      planId: "plan-1",
      input,
      plan,
      providers: providersWith(fake),
      strategy: composedChaptersStrategy,
      generationJobId: "job-1"
    });
    return plan;
  };
  const briefs = () =>
    store.chapters.map(
      (chapter) => chapter.productionBrief as { pages: Array<{ purpose: string }>; composition: { sections: Array<{ figure?: unknown }> } }
    );

  it("carries each planned figure through the edit into exactly one stored page, canonical and without its stand-in", async () => {
    const plan = await run();
    const expected = Math.min(2, figureCapFor(plan.chapters.length));
    const figured = store.pages.filter((page) => /```figure\n\{.*\}\n```/.test(page.markdown));
    expect(figured).toHaveLength(expected);
    for (const page of figured) {
      const body = page.markdown.match(/```figure\n(.*)\n```/)![1]!;
      expect(figureSpecSchema.safeParse(JSON.parse(body)).success).toBe(true);
      expect(page.status).toBe("COMPLETED");
    }
    expect(store.pages.some((page) => /\[figure:/i.test(page.markdown))).toBe(false);
    expect(briefs().filter((brief) => brief.composition.sections.some((section) => section.figure))).toHaveLength(expected);
    expect(briefs().flatMap((brief) => brief.pages).filter((page) => page.purpose.includes("Carries the chapter's figure"))).toHaveLength(expected);
    for (const chapter of store.chapters) {
      const pages = store.pages.filter((page) => page.chapterId === chapter.id);
      const report = (chapter.productionBrief as { report: { wordBudget: { min: number }; editedWords: number } }).report;
      const figureCount = pages.filter((page) => /```figure/.test(page.markdown)).length;
      expect(report.wordBudget.min).toBe(chapterWordBudget(input, chapter.targetPages).min - figureCount * 140);
      expect(report.editedWords).toBe(proseWordCount(pages.map((page) => page.markdown).join("\n\n")));
    }
  });

  it("plans and stores no figure when the gate is off", async () => {
    mocks.qualityEnabled.mockImplementation((feature: string) => feature !== "figures");
    await run();
    expect(store.pages.some((page) => page.markdown.includes("```figure"))).toBe(false);
    expect(briefs().every((brief) => brief.composition.sections.every((section) => !section.figure))).toBe(true);
  });
});


describe("developed nonfiction manuscript integration", () => {
  it("finishes staged chapters through one extractive development plan, then resumes without repeating it", async () => {
    mocks.developmentEnabled = true;
    mocks.qualityEnabled.mockImplementation((feature) => !["figures", "chapterApparatus"].includes(feature));
    const chapters = [1, 2].map((index) => ({ index, title: `Trial ${index}`, summary: `Finding ${index}`, keyBeats: [`Evidence ${index}`], targetPages: 12 }));
    const packets = chapters.map((chapter) => caseEvidencePacketSchema.parse({
      id: `case-${chapter.index}`, sourceChapterIndex: chapter.index, reviewVersion: 1,
      episode: { title: `Test case ${chapter.index}`, kind: "document", document: `Test record ${chapter.index}` },
      claims: [{ id: "a", text: "First finding", kind: "fact", excerptIds: ["e"] }, { id: "b", text: "Second finding", kind: "fact", excerptIds: ["e"] }],
      sequence: [], disagreements: [], unknowns: ["No scene is documented"],
      excerpts: [{ id: "e", chapterIndex: chapter.index, episodeTitle: `Test case ${chapter.index}`, documentTitle: "Test record", documentUrl: "https://example.org/test", text: "A test record of two separate findings." }]
    }));
    const plan = {
      ...makeFallbackPlan(input), chapters,
      authorStance: { thesis: "The evidence changes the finding.", positions: ["Findings can change", "A verdict can be reopened"], refusals: [], voiceSample: "The clerk carried the court record into the next room. ".repeat(10) },
      episodes: { chapters: chapters.map((chapter, i) => ({ index: chapter.index, episodes: [packets[i]!.episode] })) },
      dossier: { excerpts: packets.flatMap((packet) => packet.excerpts), documents: [], evidencePackets: packets },
      bookDevelopment: { version: 1 as const, question: "What changes a finding?", answer: "The evidence changes the finding.", coverage: [{ id: "evidence", requirement: "Examine findings" }], chapters: chapters.map((chapter, i) => ({ ...chapter, contribution: `New inference ${chapter.index}`, requires: i ? [1] : [], covers: ["evidence"], caseIds: [packets[i]!.id], callbacks: [] })) }
    };
    store.planningPackage = structuredClone(plan);
    const { fake, purposes } = recordingFake();
    const json = fake.generateJson.bind(fake);
    const text = fake.generateText.bind(fake);
    fake.generateJson = async (options) => {
      const data = options.purpose === "plan-developmental-edit" ? { groups: [] } : options.purpose === "review-chapter-evidence" && !JSON.parse(String(options.messages[1]?.content)).phase ? { issues: [] } : undefined;
      if (!data) return json(options);
      purposes.push(options.purpose!);
      return { data: options.schema.parse(data), text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    };
    fake.generateText = async (options) => {
      if (options.purpose !== "compose-chapter") return text(options);
      purposes.push(options.purpose);
      const markdown = Array.from({ length: 600 }, (_, i) => `Record ${i} supplies another detail about the disputed original judgment.`).join("\n\n");
      return { text: markdown, provider: "fixture", model: "fixture" };
    };
    const args = { projectId: "project-1", planId: "plan-1", input, plan, providers: providersWith(fake), strategy: composedChaptersStrategy };
    await generateBookComposedChapters(args);
    expect(store.pages).toHaveLength(24);
    expect(store.pages.every((page) => page.status === "COMPLETED")).toBe(true);
    expect(purposes.filter((purpose) => purpose === "plan-developmental-edit")).toHaveLength(1);
    expect(purposes).not.toContain("read-manuscript");
    expect(purposes.slice(purposes.indexOf("plan-developmental-edit") + 1)).not.toContain("edit-chapter");
    expect(store.planningPackage.developmentalEdit).toMatchObject({ version: 1, appliedGroups: [] });
    const before = [...purposes];
    await generateBookComposedChapters(args);
    expect(purposes).toEqual(before);
  });
});

describe("manuscript read cuts", () => {
  // A draft long enough to have room over its page floor, with a distinct
  // opening on every sentence so the degeneracy guard reads it as prose.
  function longDraft(words: number): string {
    const sentences = Array.from({ length: Math.ceil(words / 14) }, (_, index) =>
      `Ledger ${index} records the fee the office charged for the hearing of that season.`
    );
    const paragraphs: string[] = [];
    for (let at = 0; at < sentences.length; at += 5) paragraphs.push(sentences.slice(at, at + 5).join(" "));
    return paragraphs.join("\n\n");
  }

  // The read flags chapter 1; the cut answers with a share of the draft's
  // paragraphs, which is a deletion the code can verify.
  function readingFake(options: { keepShare?: number | undefined }) {
    const { fake, purposes } = recordingFake();
    const json = fake.generateJson.bind(fake);
    const text = fake.generateText.bind(fake);
    fake.generateJson = async (callOptions) => {
      if (callOptions.purpose !== "read-manuscript") return json(callOptions);
      purposes.push(callOptions.purpose);
      const data = {
        chapters: [{ chapterIndex: 1, edit: true, notes: ["Paragraph beginning 'Ledger 0': cut the closing paragraph. Chapter 2 already records the same fee."] }],
        bookNotes: ["The book restates its argument at every close."]
      };
      return { data: callOptions.schema.parse(data), text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    };
    fake.generateText = async (callOptions) => {
      if (callOptions.purpose === "compose-chapter") {
        purposes.push(callOptions.purpose);
        return { text: longDraft(5800), provider: "fixture", model: "fixture" };
      }
      if (callOptions.purpose !== "cut-chapter") return text(callOptions);
      purposes.push(callOptions.purpose);
      const draft = (JSON.parse(callOptions.messages.find((message) => message.role === "user")!.content) as { draft: string }).draft;
      const paragraphs = draft.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0);
      const keep = options.keepShare === undefined
        ? paragraphs.length - 1
        : Math.max(1, Math.round(paragraphs.length * options.keepShare));
      return { text: paragraphs.slice(0, keep).join("\n\n"), provider: "fixture", model: "fixture" };
    };
    return { fake, purposes };
  }

  const gatesOffFor = (extra: string[]) => {
    mocks.qualityEnabled.mockImplementation((feature: string) => !extra.includes(feature));
  };

  const run = async (fake: FakeTextModelAdapter, decisions?: ProviderSet["decisions"], plan = makeFallbackPlan(input)) => {
    await generateBookComposedChapters({
      projectId: "project-1",
      planId: "plan-1",
      input,
      plan,
      providers: { ...providersWith(fake), ...(decisions ? { decisions } : {}) },
      strategy: composedChaptersStrategy,
      generationJobId: "job-1"
    });
    return plan;
  };
  const reports = () =>
    store.chapters.map((chapter) => (chapter.productionBrief as { report: { readNotes: string[]; secondEditApplied: boolean } }).report);

  /** The decision route stays out of the chapter gate; it is present so a regression that consulted it would show. */
  const rejectingDecisions = () => {
    const choose = vi.fn(async () => ({ provider: "vercel-ai-gateway", model: "typesafe-ai/jev",
      selectedOption: "regression", probabilities: { pass: 0.05, regression: 0.9, needs_review: 0.05 } }));
    return { choose, resolve: vi.fn(async () => ({ choose })) };
  };
  const rejectingReviewer = (fake: FakeTextModelAdapter) => {
    const generateJson = fake.generateJson.bind(fake);
    return vi.spyOn(fake, "generateJson").mockImplementation(async (request) => request.purpose === "review-chapter-edit-acceptance"
      ? { data: request.schema.parse({ meaning: "regression", intent: "regression", meaningReason: "Essential qualification lost", intentReason: "Not a justified change" }), text: "", provider: "fixture", model: "fixture" }
      : generateJson(request));
  };

  it.each([true, false])("honors the semantic gate (%s) on worker cuts and preserves read findings", async (enabled) => {
    gatesOffFor(enabled ? [] : ["chapterEditAcceptance"]);
    const { fake } = readingFake({});
    const review = rejectingReviewer(fake);
    const decisions = rejectingDecisions();
    const fallback = makeFallbackPlan(input);
    const threeChapters = { ...fallback, chapters: [1, 2, 3].map((index) => ({ ...fallback.chapters[0]!, index, title: `Ledger ${index}`, targetPages: 8 })) };
    await run(fake, decisions, threeChapters);
    expect(reports()[0]!.secondEditApplied).toBe(!enabled);
    expect(reports()[0]!.readNotes).toHaveLength(1);
    // The contextual reviewer is the whole gate; no decision model is consulted.
    expect(decisions.choose).not.toHaveBeenCalled();
    const reviews = review.mock.calls.filter(([request]) => request.purpose === "review-chapter-edit-acceptance");
    expect(reviews).toHaveLength(enabled ? 1 : 0);
    if (enabled) {
      // The note named chapter 2, so the reviewer reads chapter 2 beside the comparison and not chapter 3.
      const payload = JSON.parse(reviews[0]![0].messages.find((message) => message.role === "user")!.content) as { chapterIndex: number; surroundingChapters: Array<{ index: number }> };
      expect(payload.chapterIndex).toBe(1);
      expect(payload.surroundingChapters.map((chapter) => chapter.index)).toEqual([2]);
    }
  });

  it.each([true, false])("keeps the arithmetic repair, reviewed only when the acceptance gate is on (%s)", async (enabled) => {
    // The line edit is gone; the repair is a factual correction through the editor, judged against its computation.
    mocks.qualityEnabled.mockImplementation((feature: string) => feature !== "manuscriptReadPass" && (enabled || feature !== "chapterEditAcceptance"));
    const { fake, purposes } = recordingFake();
    const text = fake.generateText.bind(fake);
    const json = fake.generateJson.bind(fake);
    fake.generateText = async (request) => {
      const reply = await text(request);
      if (request.purpose === "compose-chapter") return { ...reply, text: `${reply.text}\n\nThe first block gives \\(2 + 2 = 5\\) before the key is applied.` };
      if (request.purpose !== "edit-chapter") return reply;
      const payload = JSON.parse(request.messages.find((message) => message.role === "user")!.content) as { draft: string; factualCorrection?: { computations?: string[] } };
      expect(payload.factualCorrection?.computations?.length).toBeGreaterThan(0);
      return { ...reply, text: payload.draft.replace("2 + 2 = 5", "2 + 2 = 4") };
    };
    fake.generateJson = async (request) => {
      if (request.purpose !== "review-chapter-edit-acceptance") return json(request);
      purposes.push(request.purpose);
      return { data: request.schema.parse({ meaning: "pass", intent: "pass", meaningReason: "Only the wrong sum changed", intentReason: "The requested correction" }), text: "", provider: "fixture", model: "fixture" };
    };
    const plan = await run(fake);
    const book = store.pages.map((page) => page.markdown).join("\n\n");
    expect(book).toContain("2 + 2 = 4");
    expect(book).not.toContain("2 + 2 = 5");
    expect(purposes.filter((purpose) => purpose === "edit-chapter")).toHaveLength(plan.chapters.length);
    expect(purposes.filter((purpose) => purpose === "review-chapter-edit-acceptance")).toHaveLength(enabled ? plan.chapters.length : 0);
  });

  it("cuts exactly the flagged chapter when the gate is on", async () => {
    gatesOffFor([]);
    const { fake, purposes } = readingFake({});
    await run(fake);
    expect(purposes.filter((purpose) => purpose === "cut-chapter")).toHaveLength(1);
    expect(reports()[0]!.readNotes).toHaveLength(1);
    expect(reports()[0]!.secondEditApplied).toBe(true);
    expect(reports().slice(1).every((report) => report.readNotes.length === 0)).toBe(true);
    expect(store.pages).toHaveLength(input.targetPages);
    expect(store.pages.every((page) => page.status === "COMPLETED")).toBe(true);
  });

  it("keeps the chapter when the cut would drop it under its word floor", async () => {
    gatesOffFor([]);
    const { fake, purposes } = readingFake({ keepShare: 0.8 });
    await run(fake);
    expect(purposes.filter((purpose) => purpose === "cut-chapter")).toHaveLength(1);
    expect(reports()[0]!.readNotes).toHaveLength(1);
    expect(reports()[0]!.secondEditApplied).toBe(false);
    expect(store.pages).toHaveLength(input.targetPages);
    // Re-staged uncut on a fresh run, it keeps its pages' continuity notes, and finalize publishes them.
    const kept = store.pages.filter((page) => page.chapterId === store.chapters[0]!.id).map((page) => page.id);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((id) => store.notes.some((note) => note.pageId === id))).toBe(true);
  });

  it("makes no cut call with the gate off, and still records the read's notes", async () => {
    gatesOffFor(["manuscriptReadCuts"]);
    const { fake, purposes } = readingFake({});
    await run(fake);
    expect(purposes).not.toContain("cut-chapter");
    expect(reports()[0]!.readNotes).toHaveLength(1);
    expect(reports()[0]!.secondEditApplied).toBe(false);
  });
});
