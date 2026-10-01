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

import { FakeTextModelAdapter, composedChaptersStrategy, makeFallbackPlan, type CreateProjectInput, type GenerateJsonOptions, type GenerateTextOptions, type ProviderSet } from "@book-maker/core";
import { generateBookComposedChapters } from "./composedChaptersPass.js";

/**
 * The continuity ledger through the whole pass: chapter N's compose and edit
 * are handed the facts of chapters below N — waiting for N-1's read — and
 * never a later chapter's, including on a resumed run that holds one.
 */
const input: CreateProjectInput = {
  prompt: "A fantasy novel about an archivist who finds the founding chronicle forged.",
  category: "HISTORY",
  targetPages: 20,
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

type Seen = { purpose: string; chapterIndex: number; establishedFacts: string[]; continuityNotes: string[] };

/** The fake, with the ledger's read answering one fact per chapter after a delay, and every compose and edit payload recorded. */
function recordingFake(delayMs: number) {
  const fake = new FakeTextModelAdapter(input);
  const seen: Seen[] = [];
  const reads: number[] = [];
  const originalText = fake.generateText.bind(fake);
  const originalJson = fake.generateJson.bind(fake);
  fake.generateText = async (options: GenerateTextOptions) => {
    if (options.purpose === "compose-chapter" || options.purpose === "edit-chapter") {
      const payload = JSON.parse(options.messages.find((message) => message.role === "user")!.content);
      seen.push({
        purpose: options.purpose,
        chapterIndex: payload.chapter?.index ?? payload.chapterPosition.index,
        establishedFacts: payload.establishedFacts ?? [],
        continuityNotes: payload.continuityNotes ?? []
      });
    }
    return originalText(options);
  };
  fake.generateJson = async <T,>(options: GenerateJsonOptions<T>) => {
    if (options.purpose === "extract-chapter-facts") {
      const index = JSON.parse(options.messages.find((message) => message.role === "user")!.content).chapter.index as number;
      reads.push(index);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const data = options.schema.parse({ subjects: [{ name: `Witness of chapter ${index}`, kind: "person", facts: [{ attribute: "named in", value: `chapter ${index}` }] }] });
      return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    }
    if (options.purpose === "inventory-chapter-claims") {
      const data = options.schema.parse({ complete: true, claims: [] });
      return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    }
    return originalJson(options);
  };
  return { fake, seen, reads };
}

/** Five four-page chapters: enough for a chapter to have a neighbour on each side and one further off. */
function fiveChapterPlan() {
  const base = makeFallbackPlan(input);
  return {
    ...base,
    chapters: [1, 2, 3, 4, 5].map((index) => ({ index, title: `Chapter ${index}`, summary: `What chapter ${index} tells.`, keyBeats: [], targetPages: 4 }))
  };
}

const run = (fake: FakeTextModelAdapter, plan: ReturnType<typeof makeFallbackPlan>) =>
  generateBookComposedChapters({ projectId: "project-1", planId: "plan-1", input, plan, providers: { text: fake } as unknown as ProviderSet, strategy: composedChaptersStrategy });

const witnessesIn = (lines: string[]) => lines.map((line) => Number(line.match(/Witness of chapter (\d+)/)?.[1])).filter(Number.isFinite);

beforeEach(() => {
  store.chapters = [];
  store.pages = [];
  store.notes = [];
  store.planningPackage = { title: "Plan" };
  vi.clearAllMocks();
  mocks.qualityEnabled.mockImplementation(() => true);
  mocks.developmentEnabled = false;
});

describe("the continuity ledger in the composed pass", () => {
  it("hands chapter N's compose and edit the facts of every chapter below N, waiting for N-1's read", async () => {
    const plan = fiveChapterPlan();
    const chapters = plan.chapters.map((chapter) => chapter.index);
    // A read slower than nothing: without the wait, a compose would go ahead without its neighbour's facts.
    const { fake, seen, reads } = recordingFake(25);
    await run(fake, plan);

    for (const index of chapters) {
      const below = chapters.filter((other) => other < index);
      for (const purpose of ["compose-chapter", "edit-chapter"]) {
        const calls = seen.filter((call) => call.purpose === purpose && call.chapterIndex === index);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(witnessesIn(call.establishedFacts)).toEqual(below);
      }
    }
    // The last chapter's facts are read by no chapter, so they are never taken.
    expect(reads.sort((a, b) => a - b)).toEqual(chapters.slice(0, -1));
    // And each chapter keeps its own facts on its report, for a resumed run.
    const reportFacts = (index: number) => (store.chapters.find((chapter) => chapter.index === index)!.productionBrief as { report: { facts?: unknown } }).report.facts;
    expect(reportFacts(chapters[0]!)).toEqual([{ subject: `Witness of chapter ${chapters[0]}`, attribute: "named in", value: `chapter ${chapters[0]}` }]);
    expect(reportFacts(chapters.at(-1)!)).toBeUndefined();
  });

  it("never tells a redone chapter what a chapter checkpointed ahead of it wrote, facts or page notes", async () => {
    const plan = fiveChapterPlan();
    const chapters = plan.chapters.map((chapter) => chapter.index);
    await run(recordingFake(0).fake, plan);

    // A failed run: chapter 3 never staged, chapter 4 did, with facts and notes of its own.
    const redo = chapters[2]!;
    const ahead = chapters[3]!;
    const redoChapter = store.chapters.find((chapter) => chapter.index === redo)!;
    store.pages = store.pages.filter((page) => page.chapterId !== redoChapter.id);
    const aheadChapter = store.chapters.find((chapter) => chapter.index === ahead)!;
    const brief = aheadChapter.productionBrief as { pages: Array<{ requiredContinuity: string[] }>; report: Record<string, unknown> };
    aheadChapter.productionBrief = {
      ...brief,
      pages: brief.pages.map((page) => ({ ...page, requiredContinuity: ["Note written by the later chapter"] })),
      report: { ...brief.report, facts: [{ subject: "The later chapter's witness", attribute: "fixed", value: "after the redone chapter" }] }
    };
    const { fake, seen, reads } = recordingFake(0);
    await run(fake, plan);

    const redoCalls = seen.filter((call) => call.chapterIndex === redo);
    expect(redoCalls.map((call) => call.purpose)).toContain("compose-chapter");
    for (const call of redoCalls) {
      expect(witnessesIn(call.establishedFacts)).toEqual(chapters.filter((other) => other < redo));
      expect(call.establishedFacts.join("\n")).not.toContain("later chapter");
      expect(call.continuityNotes).not.toContain("Note written by the later chapter");
    }
    // The finished chapters kept their facts, so the resume re-read only the chapter it wrote.
    expect(reads).toEqual([redo]);
  });
});
