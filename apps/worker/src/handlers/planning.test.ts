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
    $transaction: vi.fn()
  },
  createPlan: vi.fn(),
  revisePlan: vi.fn(),
  nextPlanVersion: vi.fn(),
  embedResearchSourcesForProject: vi.fn(),
  txPlanVersionCreate: vi.fn(),
  txPlanVersionUpdate: vi.fn(),
  txPlanVersionUpdateMany: vi.fn(),
  txProjectUpdateMany: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  editOperationIdFromJob: (job: { data: Record<string, unknown> }) =>
    typeof job.data.operationId === "string" ? job.data.operationId : null
}));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: true } }));
vi.mock("../providers/loggedAdapters.js", () => ({
  createLoggedProviders: () => ({ text: {}, research: {}, embedding: {} })
}));
vi.mock("../generation/semanticMemory.js", () => ({
  embedResearchSourcesForProject: mocks.embedResearchSourcesForProject,
  // True so the embed-degradation tests keep exercising the embedding path.
  strategyUsesSemanticMemory: () => true
}));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async (id: string) => ({
    id,
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
  planInputSnapshot: (input: { targetPages: number }) => ({ targetPages: input.targetPages }),
  // The real deep clone, not a stub: the mediaSettings write-back merge is one
  // of the behaviors these tests exist to pin down.
  planMediaSettingsSnapshot: (input: { mediaSettings: unknown }) => JSON.parse(JSON.stringify(input.mediaSettings)),
  strategyForInput: () => ({ createPlan: mocks.createPlan, revisePlan: mocks.revisePlan })
}));
vi.mock("../generation/qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: () => false
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("../generation/storyStateStore.js", () => ({
  seedProjectStoryState: vi.fn()
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
import { seedProjectStoryState } from "../generation/storyStateStore.js";
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
      researchSource: mocks.prisma.researchSource
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction();
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
  mocks.embedResearchSourcesForProject.mockResolvedValue(undefined);
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

describe("revisePlan persistence", () => {
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
        data: { currentPlanId: "plan-2", title: "Planned Title" }
      })
    );
    expect(mocks.prisma.character.deleteMany).toHaveBeenCalledWith({ where: { projectId: "project-1" } });
    expect(mocks.prisma.character.createMany).toHaveBeenCalled();
    expect(mocks.prisma.location.deleteMany).toHaveBeenCalledWith({ where: { projectId: "project-1" } });
    expect(mocks.prisma.researchSource.createMany).toHaveBeenCalled();
    expect(seedProjectStoryState).toHaveBeenCalledWith("project-1", []);

    // PLAN_READY lands only after the job is marked complete, so a crash in
    // between leaves the row recoverable rather than announcing a ready plan.
    expect(mocks.prisma.project.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PLAN_READY" } })
    );
    await completion.afterJobCompleted?.();
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "PLAN_READY" }
    });
  });

  it("does not re-insert research sources a previous delivery already saved", async () => {
    // A redelivered plan-book re-runs the whole transaction. Characters and
    // locations are replaced wholesale, but sources were appended — doubling
    // the book's Sources list, which every export rebuilds from these rows.
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
    mocks.embedResearchSourcesForProject.mockRejectedValue(new Error("embedding outage"));

    await expect(planBook(planJob())).resolves.toBeDefined();
    consoleWarn.mockRestore();
  });

  it("still propagates a user stop out of the embedding step", async () => {
    const stop = new StopRequestedError();
    mocks.embedResearchSourcesForProject.mockRejectedValue(stop);

    await expect(planBook(planJob())).rejects.toBe(stop);
  });
});
