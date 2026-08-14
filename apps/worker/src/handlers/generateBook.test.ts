import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    researchSource: { findMany: vi.fn(), createMany: vi.fn() },
    chapter: { findMany: vi.fn() },
    page: { findMany: vi.fn() },
    $transaction: vi.fn()
  },
  expandChapterResearch: vi.fn(),
  embedResearchSourcesForProject: vi.fn(),
  updateJobProgress: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({
  enqueueWorkerJob: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  maybeEnqueueCover: vi.fn(),
  parallelPageWaveSize: () => 1
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  updateJobProgress: mocks.updateJobProgress
}));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({}) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: vi.fn(),
  strategyForInput: vi.fn()
}));
vi.mock("../generation/bookPasses.js", () => ({
  generateBookBatchWindow: vi.fn(),
  generateBookChapterWholePass: vi.fn(),
  generateBookDraftThenPolish: vi.fn(),
  generateBookWholePass: vi.fn()
}));
vi.mock("../generation/bookState.js", () => ({ prepareChapterSetups: vi.fn() }));
vi.mock("../generation/characterReferences.js", () => ({ ensureCharacterReferenceAssets: vi.fn() }));
vi.mock("../generation/semanticMemory.js", () => ({
  embedResearchSourcesForProject: mocks.embedResearchSourcesForProject,
  strategyUsesSemanticMemory: () => false
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: vi.fn() }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    expandChapterResearch: mocks.expandChapterResearch,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({})
  };
});

import { generateBookSequential, maybeExpandStrategyResearch } from "./generateBook.js";
import { prepareChapterSetups } from "../generation/bookState.js";
import { seedStoryStateFromPromises } from "@book-maker/core";

const plan = {
  chapters: [],
  researchQueries: [],
  researchNotes: [{ query: "plan-q", title: "Planner note", url: null, summary: "From the plan." }]
} as unknown as Parameters<typeof maybeExpandStrategyResearch>[0]["plan"];

function options() {
  return {
    projectId: "project-1",
    input: {} as Parameters<typeof maybeExpandStrategyResearch>[0]["input"],
    plan,
    providers: { research: {} } as Parameters<typeof maybeExpandStrategyResearch>[0]["providers"],
    strategy: { researchDepth: 3 } as Parameters<typeof maybeExpandStrategyResearch>[0]["strategy"],
    generationJobId: "gj-1"
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.researchSource.findMany.mockResolvedValue([]);
  mocks.prisma.researchSource.createMany.mockResolvedValue({ count: 0 });
});

describe("maybeExpandStrategyResearch redelivery guard", () => {
  it("expands and stores sources on the first run", async () => {
    mocks.expandChapterResearch.mockResolvedValue([
      { query: "chapter one deep dive", title: "Source", url: "https://example.org", summary: "S.", publishedAt: null }
    ]);

    await maybeExpandStrategyResearch(options());

    expect(mocks.expandChapterResearch).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.researchSource.createMany).toHaveBeenCalledTimes(1);
  });

  it("skips the expansion entirely when a previous run already stored expanded sources", async () => {
    // Rows whose query is not one of the plan's own notes can only have come
    // from this expansion: re-running it doubled the book's Sources list on
    // every resume or redelivery, forever.
    mocks.prisma.researchSource.findMany.mockResolvedValue([
      { query: "plan-q" },
      { query: "chapter one deep dive" }
    ]);

    await maybeExpandStrategyResearch(options());

    expect(mocks.expandChapterResearch).not.toHaveBeenCalled();
    expect(mocks.prisma.researchSource.createMany).not.toHaveBeenCalled();
  });

  it("drops expanded sources whose query is already stored", async () => {
    // Only the plan's own notes exist, so expansion runs — but any query it
    // shares with a stored row is already represented in the Sources list.
    mocks.prisma.researchSource.findMany.mockResolvedValue([{ query: "plan-q" }]);
    mocks.expandChapterResearch.mockResolvedValue([
      { query: "plan-q", title: "Duplicate", url: null, summary: "S.", publishedAt: null },
      { query: "fresh-q", title: "Fresh", url: null, summary: "S.", publishedAt: null }
    ]);

    await maybeExpandStrategyResearch(options());

    expect(mocks.prisma.researchSource.createMany).toHaveBeenCalledTimes(1);
    const created = mocks.prisma.researchSource.createMany.mock.calls[0]?.[0] as {
      data: Array<{ title: string }>;
    };
    expect(created.data.map((row) => row.title)).toEqual(["Fresh"]);
  });

  it("does nothing when the strategy has no research depth", async () => {
    await maybeExpandStrategyResearch({
      ...options(),
      strategy: { researchDepth: 0 } as Parameters<typeof maybeExpandStrategyResearch>[0]["strategy"]
    });

    expect(mocks.prisma.researchSource.findMany).not.toHaveBeenCalled();
    expect(mocks.expandChapterResearch).not.toHaveBeenCalled();
  });
});

describe("generateBookSequential storyState wipe", () => {
  const sequentialPlan = {
    chapters: [{ index: 1, title: "One", summary: "Opening.", targetPages: 2 }],
    promises: ["The lantern will be lit."]
  };
  const sequentialInput = { targetPages: 2 };
  const sequentialOptions = () =>
    ({
      projectId: "project-1",
      planId: "plan-1",
      input: sequentialInput,
      plan: sequentialPlan,
      providers: {},
      strategy: {},
      generationJobId: "gj-1"
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds storyState when wiping pages for a fresh sequential run", async () => {
    mocks.prisma.chapter.findMany.mockResolvedValue([]);
    mocks.prisma.page.findMany.mockResolvedValue([]);
    vi.mocked(prepareChapterSetups).mockResolvedValue([
      {
        chapter: { index: 1, title: "One", summary: "Opening.", targetPages: 2 },
        startPage: 1,
        endPage: 2,
        brief: {}
      }
    ] as never);
    const tx = {
      imageAsset: { deleteMany: vi.fn() },
      page: { deleteMany: vi.fn(), create: vi.fn() },
      chapter: { deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "ch-1" })) },
      continuityNote: { deleteMany: vi.fn() },
      embedding: { deleteMany: vi.fn() },
      project: { update: vi.fn() }
    };
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));

    await generateBookSequential(sequentialOptions());

    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        status: "GENERATING",
        storyState: seedStoryStateFromPromises(["The lantern will be lit."])
      }
    });
  });

  it("does not re-seed storyState on the resume path", async () => {
    mocks.prisma.chapter.findMany.mockResolvedValue([
      { index: 1, title: "One", targetPages: 2 }
    ]);
    mocks.prisma.page.findMany.mockResolvedValue([
      { index: 1, status: "COMPLETED" },
      { index: 2, status: "PENDING" }
    ]);
    const tx = {
      page: { updateMany: vi.fn() },
      project: { update: vi.fn() }
    };
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));

    await generateBookSequential(sequentialOptions());

    expect(prepareChapterSetups).not.toHaveBeenCalled();
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "GENERATING" }
    });
    expect(tx.project.update.mock.calls[0]?.[0].data).not.toHaveProperty("storyState");
  });
});
