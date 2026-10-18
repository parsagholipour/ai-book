import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    planVersion: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    project: { update: vi.fn(), findUnique: vi.fn() },
    bookEditOperation: { findUnique: vi.fn() },
    character: { deleteMany: vi.fn(), createMany: vi.fn() },
    location: { deleteMany: vi.fn(), createMany: vi.fn() },
    researchSource: { createMany: vi.fn(), findMany: vi.fn() },
    embedding: { findMany: vi.fn() },
    generationJob: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn()
  },
  createPlan: vi.fn(),
  revisePlan: vi.fn(),
  nextPlanVersion: vi.fn(),
  prepareEmbedding: vi.fn(),
  txPlanVersionCreate: vi.fn(),
  txPlanVersionUpdate: vi.fn(),
  txPlanVersionUpdateMany: vi.fn(),
  txProjectUpdateMany: vi.fn(),
  enqueueWorkerJob: vi.fn(),
  withSeriesEndingFacts: vi.fn(),
  strategy: { executionMode: "composed-chapters" as string }
}));
vi.mock("../generation/seriesEndingFacts.js", async () => ({
  ...(await vi.importActual<typeof import("../generation/seriesEndingFacts.js")>("../generation/seriesEndingFacts.js")),
  withSeriesEndingFacts: mocks.withSeriesEndingFacts
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma, Prisma: {}, researchScope: (id: string) => `research:${id}`,
  RESEARCH_SCOPE_PREFIX: "research:", embeddingIsDegraded: () => false
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  editOperationIdFromJob: (job: { data: Record<string, unknown> }) =>
    (typeof job.data.operationId === "string" ? job.data.operationId : null) ??
    (typeof job.data.editOperationId === "string" ? job.data.editOperationId : null)
}));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: true } }));
vi.mock("../providers/loggedAdapters.js", () => ({
  createLoggedProviders: () => ({ text: {}, research: {}, embedding: {} })
}));
// True so the embed-degradation tests keep exercising the embedding path.
vi.mock("../generation/embeddingWrites.js", () => ({
  strategyUsesSemanticMemory: () => true,
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: vi.fn(async () => "stored")
}));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async (id: string) => ({
    id,
    currentPlanId: null,
    contentRevision: 0,
    updatedAt: new Date("2026-01-01"),
    title: "Working Title",
    prompt: "A guide to backyard birds with enough detail to parse correctly.",
    category: "SCIENCE",
    targetPages: 12,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {}
  }),
  nextPlanVersion: mocks.nextPlanVersion,
  planInputSnapshot: (input: { targetPages: number; language: string }) => ({ targetPages: input.targetPages, language: input.language }),
  // The real deep clone, not a stub: the mediaSettings write-back merge is one
  // of the behaviors these tests exist to pin down.
  planMediaSettingsSnapshot: (input: { mediaSettings: unknown }) => JSON.parse(JSON.stringify(input.mediaSettings)),
  strategyForInput: () => ({ createPlan: mocks.createPlan, revisePlan: mocks.revisePlan, executionMode: mocks.strategy.executionMode })
}));
vi.mock("../generation/qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: () => false
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({})
  };
});

import { planBook, revisePlan } from "./planning.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

const inputSnapshot = {
  prompt: "A guide to backyard birds with enough detail to parse correctly.",
  category: "SCIENCE",
  targetPages: 12,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const revisedPlan = {
  title: "Revised Title",
  chapters: [],
  characters: [],
  locations: [],
  researchNotes: []
};

function reviseJob(data: Record<string, unknown> = {}): Job {
  return {
    data: {
      projectId: "project-1",
      planId: "plan-1",
      message: "Make the tone warmer.",
      generationJobId: "gj-1",
      ...data
    }
  } as unknown as Job;
}

function mockTransaction() {
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      planVersion: {
        create: mocks.txPlanVersionCreate,
        update: mocks.txPlanVersionUpdate,
        updateMany: mocks.txPlanVersionUpdateMany
      },
      project: {
        update: mocks.prisma.project.update,
        updateMany: mocks.txProjectUpdateMany,
        findUnique: mocks.prisma.project.findUnique
      },
      character: mocks.prisma.character,
      location: mocks.prisma.location,
      researchSource: mocks.prisma.researchSource,
      generationJob: mocks.prisma.generationJob,
      $executeRawUnsafe: mocks.prisma.$executeRawUnsafe
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction();
  mocks.withSeriesEndingFacts.mockImplementation(async (input: unknown) => input);
  mocks.txPlanVersionCreate.mockResolvedValue({ id: "plan-2" });
  mocks.txPlanVersionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.txProjectUpdateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.planVersion.findUnique.mockResolvedValue({
    id: "plan-1",
    inputSnapshot,
    planningPackage: { title: "Current", chapters: [] },
    messages: [{ role: "user", content: "Earlier note", at: "2026-01-01T00:00:00.000Z" }],
    project: { id: "project-1", currentPlanId: "plan-1", mediaSettings: null }
  });
  mocks.prisma.project.findUnique.mockResolvedValue({ mediaSettings: null });
  mocks.nextPlanVersion.mockResolvedValue(3);
  mocks.revisePlan.mockResolvedValue(revisedPlan);
  mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1]", error: null });
  mocks.prisma.embedding.findMany.mockResolvedValue([]);
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ status: "ACTIVE", contentRevision: 0, steps: [] });
  mocks.prisma.generationJob.findFirst.mockResolvedValue({ id: "gj-plan" });
  mocks.prisma.generationJob.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.researchSource.findMany.mockResolvedValue([]);
});

describe("revisePlan guards", () => {
  it("throws when the plan no longer exists", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(null);

    await expect(revisePlan(reviseJob())).rejects.toThrow("Plan not found");
    expect(mocks.revisePlan).not.toHaveBeenCalled();
  });

  it("refuses to revise a superseded plan", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot,
      planningPackage: {},
      messages: [],
      project: { id: "project-1", currentPlanId: "plan-9" }
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(revisePlan(reviseJob())).rejects.toThrow("Plan revision targets a superseded plan");
    expect(mocks.revisePlan).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("refuses when the operation no longer owns the durable job", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      generationJobId: "gj-someone-else",
      ledgerEntryId: "ledger-1",
      status: "RUNNING",
      classifier: {}
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      revisePlan(reviseJob({ operationId: "op-1", billingLedgerEntryId: "ledger-1" }))
    ).rejects.toThrow("Plan revision operation no longer owns this job");
    expect(mocks.revisePlan).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("refuses a billed revision whose billing linkage is missing or mismatched", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      generationJobId: "gj-1",
      ledgerEntryId: null,
      status: "RUNNING",
      classifier: {}
    });
    await expect(revisePlan(reviseJob({ operationId: "op-1" }))).rejects.toThrow(
      "Plan revision billing linkage is inconsistent"
    );

    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      generationJobId: "gj-1",
      ledgerEntryId: "ledger-1",
      status: "RUNNING",
      classifier: {}
    });
    await expect(
      revisePlan(reviseJob({ operationId: "op-1", billingLedgerEntryId: "ledger-2" }))
    ).rejects.toThrow("Plan revision billing linkage is inconsistent");

    expect(mocks.revisePlan).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("lets an operator-console revision through without billing linkage", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      generationJobId: "gj-1",
      ledgerEntryId: null,
      status: "RUNNING",
      classifier: { source: "web" }
    });

    await revisePlan(reviseJob({ operationId: "op-1" }));

    expect(mocks.revisePlan).toHaveBeenCalled();
  });
});

describe("revisePlan and the composition prep", () => {
  it("revises the plan without anything the prep stored for it, and queues the revised plan's own prep", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot,
      planningPackage: {
        title: "Current", chapters: [], authorStance: { thesis: "The planner's" }, episodes: { chapters: [] },
        compositionPrep: { version: 1, generationJobId: "prep", fingerprint: "f", planned: ["episodes"], steps: { episodes: "stored" }, written: ["episodes"] }
      },
      messages: [],
      project: { id: "project-1", currentPlanId: "plan-1", mediaSettings: null }
    });
    const completion = await revisePlan(reviseJob({ prepareComposition: true }));
    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ currentPlan: { title: "Current", chapters: [], authorStance: { thesis: "The planner's" } } }));
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "PLAN_READY", currentPlanId: "plan-2" });
    await completion.afterJobCompleted?.();
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(expect.objectContaining({ type: "PREPARE_COMPOSITION", dedupeKey: "prepare-composition:plan-2" }));
  });
});

describe("revisePlan persistence", () => {
  it.each([
    ["No in English", "en"],
    ["Write it in French", "French"],
    ["Make Neymar kinder", "pt"]
  ])("resolves a direct revision's language without a chat classifier: %s", async (message, language) => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1", inputSnapshot: { ...inputSnapshot, language: "pt" },
      planningPackage: { title: "Entre o Ruído e o Silêncio", chapters: [] }, messages: [],
      project: { id: "project-1", currentPlanId: "plan-1", language: "pt", mediaSettings: null }
    });
    await revisePlan(reviseJob({ message }));
    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ language }));
    expect(mocks.txPlanVersionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inputSnapshot: expect.objectContaining({ language }) })
    }));
    expect(mocks.txProjectUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ language })
    }));
  });

  it("applies the detected language correction before revising and persists it for generation", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: { ...inputSnapshot, language: "pt" },
      planningPackage: { title: "Entre o Ruído e o Silêncio", chapters: [] },
      messages: [],
      project: { id: "project-1", currentPlanId: "plan-1", language: "pt", mediaSettings: null }
    });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      generationJobId: "gj-1",
      ledgerEntryId: "ledger-1",
      status: "RUNNING",
      classifier: { kind: "plan_revision", targetLanguage: "English" },
      request: "No in English",
      editInstruction: "No in English"
    });

    await revisePlan(reviseJob({
      message: "No in English",
      editOperationId: "op-1",
      billingLedgerEntryId: "ledger-1"
    }));

    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({
      language: "en",
      input: expect.objectContaining({ language: "en" })
    }));
    expect(mocks.txPlanVersionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inputSnapshot: expect.objectContaining({ language: "en" }) })
    }));
    expect(mocks.txProjectUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ language: "en" })
    }));
  });

  it("supersedes the old plan and installs the new one as current", async () => {
    await revisePlan(reviseJob());

    expect(mocks.txPlanVersionUpdateMany).toHaveBeenCalledWith({
      where: { id: "plan-1", status: { notIn: ["APPROVED", "SUPERSEDED"] } },
      data: { status: "SUPERSEDED" }
    });
    expect(mocks.txPlanVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "project-1",
          version: 3,
          planningPackage: revisedPlan,
          messages: [
            { role: "user", content: "Earlier note", at: "2026-01-01T00:00:00.000Z" },
            expect.objectContaining({ role: "user", content: "Make the tone warmer." })
          ]
        })
      })
    );
    expect((mocks.revisePlan.mock.calls[0]![0] as { userMessage: string }).userMessage).toContain(
      "Approved editInstruction"
    );
    expect((mocks.revisePlan.mock.calls[0]![0] as { userMessage: string }).userMessage).toContain(
      "Make the tone warmer."
    );
    expect(mocks.txProjectUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1", currentPlanId: "plan-1" },
        data: expect.objectContaining({
          currentPlanId: "plan-2",
          status: "PLAN_READY",
          title: "Revised Title"
        })
      })
    );
  });

  it("fails instead of demoting a plan a concurrent approval committed", async () => {
    // The route rejects revising an APPROVED plan, but an approval can commit
    // while the revision is being drafted. Superseding it anyway would
    // silently un-approve the plan and yank the project back to PLAN_READY
    // underneath the paid GENERATE_BOOK the approval dispatched.
    mocks.txPlanVersionUpdateMany.mockResolvedValue({ count: 0 });

    await expect(revisePlan(reviseJob())).rejects.toThrow("Plan revision lost to a concurrent approval");
    expect(mocks.txPlanVersionCreate).not.toHaveBeenCalled();
    expect(mocks.txProjectUpdateMany).not.toHaveBeenCalled();
  });

  it("fails when a sibling approval moved the project's current plan mid-revision", async () => {
    mocks.txProjectUpdateMany.mockResolvedValue({ count: 0 });

    await expect(revisePlan(reviseJob())).rejects.toThrow("Plan revision lost to a concurrent approval");
  });

  it("merges the snapshot's mediaSettings over the live row instead of replacing it", async () => {
    // The row owns live presentation preferences (chapter headings, the
    // Sources toggle) that the plan's frozen snapshot knows nothing about; a
    // wholesale replacement would silently revert a reader's free edits.
    mocks.prisma.project.findUnique.mockResolvedValue({
      mediaSettings: {
        chapterHeadingStyle: "title_only",
        chapterHeadingLabel: "Part",
        includeSources: false,
        mobile: { targetPages: 12 }
      }
    });

    await revisePlan(reviseJob());

    const written = mocks.txProjectUpdateMany.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data.mediaSettings)
      .find((value) => value !== undefined) as Record<string, unknown>;
    expect(written).toMatchObject({
      chapterHeadingStyle: "title_only",
      chapterHeadingLabel: "Part",
      includeSources: false,
      fullIllustrations: true
    });
    expect(written.mobile).toMatchObject({ targetPages: 12 });
  });

  it("keeps fused character sheets out of the stored plan-revision contract", async () => {
    const editInstruction = "Make the book brighter around Luna.";
    const request = "Make it brighter around @Luna.";
    const characterContext = "Mentioned character profiles:\n- Luna: a brave night-flying rabbit.";
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      generationJobId: "gj-1",
      ledgerEntryId: "ledger-1",
      status: "RUNNING",
      classifier: {},
      request,
      editInstruction,
      characterContext
    });

    await revisePlan(
      reviseJob({
        message: `${request}\n\n${characterContext}`,
        editInstruction,
        characterContext,
        editOperationId: "op-1",
        billingLedgerEntryId: "ledger-1"
      })
    );

    const userMessage = (mocks.revisePlan.mock.calls[0]![0] as { userMessage: string }).userMessage;
    expect(userMessage).toContain(editInstruction);
    expect(userMessage).toContain("Character context (supplemental canon, not an additional edit requirement):");
    expect(userMessage).toContain("night-flying");
    expect(userMessage).toContain(request);
    const stored = mocks.txPlanVersionCreate.mock.calls[0]![0] as {
      data: { messages: Array<{ content: string }> };
    };
    expect(stored.data.messages.at(-1)?.content).toBe(editInstruction);
    expect(stored.data.messages.at(-1)?.content).not.toContain("night-flying");
  });
});

describe("planBook", () => {
  const createdPlan = {
    title: "Planned Title",
    chapters: [],
    characters: [
      { name: "Robin", role: "Guide", description: "A robin.", traits: ["curious"], visualRules: ["red breast"] }
    ],
    locations: [{ name: "Garden", description: "A garden.", rules: [] }],
    researchNotes: [
      { query: "birds", title: "Bird facts", url: "https://example.org/birds", summary: "Facts.", publishedAt: null }
    ]
  };

  function planJob(): Job {
    return { data: { projectId: "project-1", generationJobId: "gj-plan" } } as unknown as Job;
  }

  beforeEach(() => {
    mocks.createPlan.mockResolvedValue(createdPlan);
  });

  it("saves the plan, replaces the cast, and completes into PLAN_READY", async () => {
    const completion = await planBook(planJob());

    expect(mocks.txPlanVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: "project-1", version: 3, planningPackage: createdPlan })
      })
    );
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1" },
        data: expect.objectContaining({ currentPlanId: "plan-2", title: "Planned Title", status: "PLAN_READY", storyState: expect.any(Object) })
      })
    );
    expect(mocks.prisma.character.deleteMany).toHaveBeenCalledWith({ where: { projectId: "project-1" } });
    expect(mocks.prisma.character.createMany).toHaveBeenCalled();
    expect(mocks.prisma.location.deleteMany).toHaveBeenCalledWith({ where: { projectId: "project-1" } });
    expect(mocks.prisma.researchSource.createMany).toHaveBeenCalled();
    expect(mocks.prisma.generationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "gj-plan", status: "ACTIVE" }),
      data: expect.objectContaining({ status: "COMPLETED" })
    }));
    expect(completion).toEqual({ durableCompletionCommitted: true });
  });

  it("queues the speculative composition prep after the plan only when its door asked for it, and only for a composed book", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "PLAN_READY", currentPlanId: "plan-2" });
    expect(await planBook(planJob())).toEqual({ durableCompletionCommitted: true });
    const completion = await planBook({ data: { projectId: "project-1", generationJobId: "gj-plan", prepareComposition: true } } as unknown as Job);
    await completion.afterJobCompleted?.();
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith({
      projectId: "project-1", type: "PREPARE_COMPOSITION", payload: { planId: "plan-2" }, dedupeKey: "prepare-composition:plan-2", attemptIdOverride: null
    });
    // A plan a revision or an approval has already moved past gets none, and neither does a book written page by page.
    mocks.enqueueWorkerJob.mockClear();
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", currentPlanId: "plan-2" });
    await completion.afterJobCompleted?.();
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "PLAN_READY", currentPlanId: "plan-2" });
    mocks.strategy.executionMode = "sequential-pages";
    await (await planBook({ data: { projectId: "project-1", generationJobId: "gj-plan", prepareComposition: true } } as unknown as Job)).afterJobCompleted?.();
    mocks.strategy.executionMode = "composed-chapters";
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });

  it("does not re-insert research sources a previous delivery already saved", async () => {
    // Legacy or previous planning runs may already have saved these sources.
    mocks.prisma.researchSource.findMany.mockResolvedValue([
      { query: "birds", title: "Bird facts", url: "https://example.org/birds" }
    ]);

    await planBook(planJob());

    expect(mocks.prisma.researchSource.createMany).not.toHaveBeenCalled();
  });

  it("inserts only the research sources that are not already stored", async () => {
    mocks.prisma.researchSource.findMany.mockResolvedValue([
      { query: "other", title: "Older note", url: null }
    ]);

    await planBook(planJob());

    expect(mocks.prisma.researchSource.createMany).toHaveBeenCalledTimes(1);
    const created = mocks.prisma.researchSource.createMany.mock.calls[0]?.[0] as { data: Array<{ title: string }> };
    expect(created.data.map((row) => row.title)).toEqual(["Bird facts"]);
  });

  it("treats a failed research embedding as degradation, not failure", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.prepareEmbedding.mockRejectedValue(new Error("embedding outage"));

    await expect(planBook(planJob())).resolves.toBeDefined();
    consoleWarn.mockRestore();
  });

  describe("a sequel", () => {
    const series = {
      version: 1,
      mode: "continuation",
      sourceProjectId: "book-1",
      sourceTitle: "The Night Garden",
      seriesName: "The Night Garden",
      premise: "Luna finds the lantern bridge.",
      synopsis: ["Lost: Luna wanders off."],
      characters: [],
      locations: [],
      continuityRules: [],
      voiceGuide: [],
      facts: [],
      finalChapter: "Bram gave Luna the lantern."
    };
    const enriched = { ...series, finalChapter: undefined, endingFactsTaken: true, facts: [{ subject: "Luna", attribute: "carries", value: "the lantern" }] };
    const sequelJob = () =>
      ({
        data: {
          projectId: "project-1",
          generationJobId: "gj-plan",
          inputSnapshot: { ...inputSnapshot, mediaSettings: { ...inputSnapshot.mediaSettings, mobile: { series } } }
        }
      }) as unknown as Job;

    it("plans from the ending's facts and writes them onto the live row", async () => {
      mocks.withSeriesEndingFacts.mockImplementation(async (input: { mediaSettings: Record<string, unknown> }) => ({
        ...input,
        mediaSettings: { ...input.mediaSettings, mobile: { series: enriched } }
      }));
      mocks.prisma.project.findUnique.mockResolvedValue({
        mediaSettings: { includeSources: true, storyPageDesign: "night", mobile: { characters: [{ id: "char-1" }], series } }
      });

      await planBook(sequelJob());

      expect(mocks.createPlan.mock.calls[0]![0].input.mediaSettings.mobile.series).toMatchObject({ endingFactsTaken: true });
      // Merged onto what the row holds, never the snapshot's settings over it.
      expect(mocks.prisma.project.update.mock.calls[0]![0].data.mediaSettings).toEqual({
        includeSources: true,
        storyPageDesign: "night",
        mobile: { characters: [{ id: "char-1" }], series: enriched }
      });
    });

    it("writes nothing back when no facts were taken", async () => {
      await planBook(sequelJob());

      expect(mocks.prisma.project.update.mock.calls[0]![0].data).not.toHaveProperty("mediaSettings");
    });
  });

  it("still propagates a user stop out of the embedding step", async () => {
    const stop = new StopRequestedError();
    mocks.prepareEmbedding.mockRejectedValue(stop);

    await expect(planBook(planJob())).rejects.toBe(stop);
  });
});
