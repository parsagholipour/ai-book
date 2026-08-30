import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn() },
    researchSource: { findMany: vi.fn(), createMany: vi.fn() },
    chapter: { findMany: vi.fn() },
    page: { findMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    $transaction: vi.fn()
  },
  getProjectOrThrow: vi.fn(),
  strategyForInput: vi.fn(),
  inputForPlanVersion: vi.fn(),
  generateReplannedBook: vi.fn(),
  expandChapterResearch: vi.fn(),
  embedResearchSourcesForProject: vi.fn(),
  updateJobProgress: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
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
  getProjectOrThrow: mocks.getProjectOrThrow,
  strategyForInput: mocks.strategyForInput
}));
vi.mock("../generation/bookPasses.js", () => ({
  generateBookBatchWindow: vi.fn(),
  generateBookChapterWholePass: vi.fn(),
  generateBookDraftThenPolish: vi.fn(),
  generateBookWholePass: vi.fn()
}));
vi.mock("../generation/bookState.js", () => ({ prepareChapterSetups: vi.fn() }));
vi.mock("../generation/characterReferences.js", () => ({ ensureCharacterReferenceAssets: vi.fn() }));
vi.mock("../generation/researchMemory.js", () => ({
  embedResearchSourcesForProject: mocks.embedResearchSourcesForProject
}));
vi.mock("../generation/embeddingWrites.js", () => ({ strategyUsesSemanticMemory: () => false }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: mocks.inputForPlanVersion }));
vi.mock("../generation/replanEditCandidates.js", () => ({
  generateReplannedBook: mocks.generateReplannedBook
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    expandChapterResearch: mocks.expandChapterResearch,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({})
  };
});

import {
  generateBook,
  generateBookSequential,
  maybeExpandStrategyResearch,
  stagedReplanSuccessorOperationId
} from "./generateBook.js";
import { generateBookWholePass } from "../generation/bookPasses.js";
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
  // Every successor the staged pipeline queues carries this stamp; `replanBook`
  // writes it before it creates the GENERATE_BOOK row.
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
    classifier: { replanStagedPlanId: "plan-2" }
  });
});

describe("generateBook replan recovery payload", () => {
  it("forwards standalone instruction, legacy request, and character canon as separate fallbacks", async () => {
    const planVersion = { planningPackage: { chapters: [] }, inputSnapshot: {} };
    const resolvedInput = { targetPages: 3, mediaSettings: {} };
    const strategy = { id: "standard" };
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion);
    mocks.inputForPlanVersion.mockReturnValue(resolvedInput);
    mocks.strategyForInput.mockReturnValue(strategy);
    mocks.generateReplannedBook.mockResolvedValue({});

    await generateBook({
      data: {
        projectId: "project-1",
        planId: "plan-2",
        generationJobId: "job-generate",
        attemptId: "attempt-1",
        replanOperationId: "operation-1",
        sourceProjectId: "project-source",
        editInstruction: "Rewrite the ending so Mara refuses the red key.",
        request: "change the ending",
        characterContext: "Mentioned character profiles:\n- Mara: a careful navigator"
      }
    } as never);

    expect(mocks.generateReplannedBook).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "operation-1",
      queuedEditInstruction: "Rewrite the ending so Mara refuses the red key.",
      queuedRequest: "change the ending",
      queuedCharacterContext: "Mentioned character profiles:\n- Mara: a careful navigator"
    }));
  });

  /**
   * The replan publication replaces every ResearchSource row with the revised
   * plan's own notes, so expansion can only run against the published corpus.
   * Before it, the guard reads the *old* plan's stored queries as "an earlier
   * expansion already ran" and skips; after it, the rows are exactly the plan's
   * and the guard passes.
   */
  it("expands chapter research after the replan's manuscript is published, never before it", async () => {
    const followUp = vi.fn(async () => undefined);
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ planningPackage: plan, inputSnapshot: {} });
    mocks.inputForPlanVersion.mockReturnValue({ targetPages: 3, mediaSettings: {} });
    mocks.strategyForInput.mockReturnValue({ id: "research-grounded", researchDepth: 3 });
    mocks.generateReplannedBook.mockResolvedValue({
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: followUp
    });
    mocks.expandChapterResearch.mockResolvedValue([
      { query: "expanded-q", title: "Expanded", url: "https://example.com/e", summary: "Found." }
    ]);

    const completion = await generateBook({
      data: { projectId: "project-1", planId: "plan-2", generationJobId: "job-generate", replanOperationId: "operation-1" }
    } as never);

    expect(mocks.expandChapterResearch).not.toHaveBeenCalled();
    await completion?.afterJobCompleted?.();

    expect(mocks.expandChapterResearch).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.researchSource.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ projectId: "project-1", query: "expanded-q" })]
    });
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(completion).toMatchObject({ retryFollowUpOnRedelivery: true });
  });

  it("starts the delivery tail before the unbounded research expansion", async () => {
    // The publication transaction is the tail lease's last renewal and nothing
    // heartbeats it until the tail begins, so an expansion in front of it can
    // spend the whole three-minute budget and leave the tail's first statement
    // to find the lease gone.
    const order: string[] = [];
    const followUp = vi.fn(async () => {
      order.push("tail");
    });
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ planningPackage: plan, inputSnapshot: {} });
    mocks.inputForPlanVersion.mockReturnValue({ targetPages: 3, mediaSettings: {} });
    mocks.strategyForInput.mockReturnValue({ id: "research-grounded", researchDepth: 3 });
    mocks.generateReplannedBook.mockResolvedValue({ afterJobCompleted: followUp });
    mocks.expandChapterResearch.mockImplementation(async () => {
      order.push("research");
      return [];
    });

    const completion = await generateBook({
      data: { projectId: "project-1", planId: "plan-2", generationJobId: "job-generate", replanOperationId: "operation-1" }
    } as never);
    await completion?.afterJobCompleted?.();

    expect(order).toEqual(["tail", "research"]);
  });

  it("never lets a research outage reopen a replan that is already published", async () => {
    const followUp = vi.fn(async () => undefined);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ planningPackage: plan, inputSnapshot: {} });
    mocks.inputForPlanVersion.mockReturnValue({ targetPages: 3, mediaSettings: {} });
    mocks.strategyForInput.mockReturnValue({ id: "research-grounded", researchDepth: 3 });
    mocks.generateReplannedBook.mockResolvedValue({ afterJobCompleted: followUp });
    mocks.expandChapterResearch.mockRejectedValue(new Error("research provider down"));

    const completion = await generateBook({
      data: { projectId: "project-1", planId: "plan-2", generationJobId: "job-generate", replanOperationId: "operation-1" }
    } as never);
    await expect(completion?.afterJobCompleted?.()).resolves.toBeUndefined();

    expect(followUp).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });
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

/**
 * A rolling deploy can find a GENERATE_BOOK successor in the queue that the
 * pre-staging build enqueued: it names a replan operation the old `replanBook`
 * already marked APPLIED, and the staleness guard deliberately has no opinion
 * about it. Taken into `generateReplannedBook` that delivery reads
 * `phase: "tail"`, finds no publication identity, and throws
 * `UnownedReplanDeliveryError` — which settles nothing, leaving the durable job
 * ACTIVE and the project GENERATING on a paid book.
 */
describe("generateBook legacy replan successor", () => {
  function legacySuccessorJob() {
    return {
      data: {
        projectId: "project-1",
        planId: "plan-2",
        generationJobId: "job-generate",
        replanOperationId: "operation-1"
      }
    } as never;
  }

  beforeEach(() => {
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ planningPackage: plan, inputSnapshot: {} });
    mocks.inputForPlanVersion.mockReturnValue({ targetPages: 3, mediaSettings: {} });
    mocks.strategyForInput.mockReturnValue({ id: "whole-book", executionMode: "whole-book" });
  });

  it("regenerates a successor with no staging stamp through the ordinary execution path", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ classifier: {} });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(generateBook(legacySuccessorJob())).resolves.toEqual({});

    expect(mocks.generateReplannedBook).not.toHaveBeenCalled();
    expect(vi.mocked(generateBookWholePass)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", planId: "plan-2" })
    );
    warned.mockRestore();
  });

  it("still takes the replan fork for a staged successor", async () => {
    mocks.generateReplannedBook.mockResolvedValue({});

    await generateBook(legacySuccessorJob());

    expect(mocks.generateReplannedBook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateBookWholePass)).not.toHaveBeenCalled();
  });

  it("answers processJob's replay gate with the same verdict as the fork", async () => {
    // One predicate for both, or a redelivery of a COMPLETED pre-staging
    // successor is replayed into the destructive execution-mode switch.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ classifier: {} });
    await expect(stagedReplanSuccessorOperationId(legacySuccessorJob())).resolves.toBeNull();

    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ classifier: { replanStagedPlanId: "plan-2" } });
    await expect(stagedReplanSuccessorOperationId(legacySuccessorJob())).resolves.toBe("operation-1");

    await expect(
      stagedReplanSuccessorOperationId({
        data: { projectId: "project-1", planId: "plan-2", generationJobId: "job-generate" }
      } as never)
    ).resolves.toBeNull();
    warned.mockRestore();
  });

  it("keeps the fork — and its own settling failure — when the operation row is gone", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(null);
    mocks.generateReplannedBook.mockRejectedValue(new Error("Book edit operation not found"));

    await expect(generateBook(legacySuccessorJob())).rejects.toThrow("Book edit operation not found");

    expect(vi.mocked(generateBookWholePass)).not.toHaveBeenCalled();
  });
});
