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
    planVersion: {
      findUnique: vi.fn(async () => ({ planningPackage: store.planningPackage })),
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
    persistKeeperStoryDelta: vi.fn(async () => null),
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
vi.mock("./qualityEnrichment.js", () => ({ persistKeeperStoryDelta: mocks.persistKeeperStoryDelta }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({ tier: "balanced", enabled: mocks.qualityEnabled, settings: {}, pageReviewPromptMode: "normal" })
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

import { FakeTextModelAdapter, makeFallbackPlan, type CreateProjectInput, type ProviderSet } from "@book-maker/core";
import { composedChaptersStrategy } from "@book-maker/core";
import { composedResumeState, derivedChapterBrief, generateBookComposedChapters } from "./composedChaptersPass.js";

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
    // One line edit per chapter, plus one reshaping edit when the deterministic
    // shape check finds the edited chapter uniform — the fake's paragraphs
    // never run past 150 words, so every chapter takes that second pass here.
    const edits = purposes.filter((purpose) => purpose === "edit-chapter").length;
    expect(edits).toBeGreaterThanOrEqual(plan.chapters.length);
    expect(edits).toBeLessThanOrEqual(plan.chapters.length * 2);
    expect(purposes.filter((purpose) => purpose === "describe-pages")).toHaveLength(plan.chapters.length);
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
    // The plan carried no stance, so the one the pass generated is written back onto it.
    expect(mocks.prisma.planVersion.update).toHaveBeenCalledTimes(1);
    expect((store.planningPackage.authorStance as { thesis: string }).thesis).not.toBe("");

    expect(store.pages).toHaveLength(input.targetPages);
    expect(store.pages.every((page) => page.status === "COMPLETED" && page.markdown.trim().length > 0)).toBe(true);
    expect(mocks.stageGeneratedPageAndBrief).toHaveBeenCalledTimes(input.targetPages);
    expect(store.notes.length).toBeGreaterThan(0);
    expect(mocks.publishStagedGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
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

  it("skips the editor and the read when their gates are off", async () => {
    const plan = makeFallbackPlan(input);
    mocks.qualityEnabled.mockImplementation((feature: string) => feature !== "chapterEditorPass" && feature !== "manuscriptReadPass");
    const { fake, purposes } = recordingFake();
    await generateBookComposedChapters({
      projectId: "project-1",
      planId: "plan-1",
      input,
      plan,
      providers: providersWith(fake),
      strategy: composedChaptersStrategy
    });
    expect(purposes).not.toContain("edit-chapter");
    expect(purposes).not.toContain("read-manuscript");
    expect(store.pages).toHaveLength(input.targetPages);
  });
});
