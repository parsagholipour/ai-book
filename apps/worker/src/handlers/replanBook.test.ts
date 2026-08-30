import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    generationJob: { updateMany: vi.fn(), upsert: vi.fn() },
    project: { update: vi.fn(), findUnique: vi.fn() },
    planVersion: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    character: { deleteMany: vi.fn(), createMany: vi.fn() },
    location: { deleteMany: vi.fn(), createMany: vi.fn() },
    researchSource: { deleteMany: vi.fn(), createMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn()
  },
  revisePlan: vi.fn(),
  stagedPlanCreate: vi.fn(),
  canEnqueueProjectWork: vi.fn(),
  dispatchWorkerGenerationJob: vi.fn(),
  nextPlanVersion: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({
  canEnqueueProjectWork: mocks.canEnqueueProjectWork,
  dispatchWorkerGenerationJob: mocks.dispatchWorkerGenerationJob
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async (id: string) => ({ id, currentPlanId: "plan-1", targetPages: 12 }),
  nextPlanVersion: mocks.nextPlanVersion,
  planInputSnapshot: (input: { targetPages: number }) => ({ targetPages: input.targetPages }),
  strategyForInput: () => ({ revisePlan: mocks.revisePlan })
}));
vi.mock("../generation/storyStateStore.js", () => ({
  seedProjectStoryState: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: () => ({ chapters: [] }) },
    createProviders: () => ({})
  };
});

import { seedProjectStoryState } from "../generation/storyStateStore.js";
import { UnownedReplanDeliveryError } from "../runtime/jobTypes.js";
import { replanBook } from "./replanBook.js";

const sourceSnapshot = {
  prompt: "A guide to budget shops with enough detail to parse correctly.",
  category: "BUSINESS",
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
    toneProfile: "neutral",
    mobile: { targetPages: 12, imagesEnabled: true }
  }
};

function replanJob(payload: Record<string, unknown>): Job {
  return {
    data: {
      projectId: "project-copy",
      generationJobId: "job-replan",
      operationId: "operation-1",
      request: "make it 3 pages",
      sourceProjectId: "project-1",
      sourcePlanId: "plan-1",
      ...payload
    }
  } as unknown as Job;
}

describe("replanBook page budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: sourceSnapshot,
      planningPackage: {},
      messages: []
    });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: "project-1",
      generationJobId: "job-replan",
      status: "ACTIVE",
      request: "make it 3 pages",
      editInstruction: "make it 3 pages",
      classifier: {}
    });
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<void>) => {
      return run({
        planVersion: {
          updateMany: vi.fn(),
          update: vi.fn(),
          create: mocks.stagedPlanCreate
        },
        bookEditOperation: mocks.prisma.bookEditOperation,
        generationJob: mocks.prisma.generationJob,
        project: { update: mocks.prisma.project.update, findUnique: mocks.prisma.project.findUnique },
        character: mocks.prisma.character,
        location: mocks.prisma.location,
        researchSource: mocks.prisma.researchSource,
        $queryRawUnsafe: mocks.prisma.$queryRawUnsafe
      });
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ mediaSettings: null });
    mocks.prisma.project.update.mockResolvedValue({ status: "EDITING" });
    mocks.prisma.generationJob.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.bookEditOperation.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      const current = await mocks.prisma.bookEditOperation.findUnique({ where: { id: "operation-1" } });
      if (current && args.data) {
        mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...current, ...args.data });
      }
      return { count: 1 };
    });
    mocks.prisma.$queryRawUnsafe.mockImplementation(
      async (sql: string, _operationId: string, generationJobId: string, ownerToken: string) => {
        const current = await mocks.prisma.bookEditOperation.findUnique({ where: { id: "operation-1" } });
        if (!current) return [];
        if (sql.includes('SET "status" = \'ACTIVE\'')) {
          if (
            !["QUEUED", "ACTIVE"].includes(current.status as string) ||
            current.structuralLeaseCompletedAt ||
            (current.structuralLeaseToken && current.structuralLeaseToken !== ownerToken)
          ) {
            return [];
          }
          const claimed = {
            ...current,
            generationJobId: current.generationJobId ?? generationJobId,
            status: "ACTIVE",
            structuralLeaseToken: ownerToken,
            structuralLeaseExpiresAt: new Date("2099-01-01T00:03:00.000Z")
          };
          mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(claimed);
          return [claimed];
        }
        if (sql.includes('SET "structuralLeaseExpiresAt" = CURRENT_TIMESTAMP')) {
          if (current.status !== "ACTIVE" || current.structuralLeaseToken !== ownerToken) return [];
          const renewed = {
            ...current,
            structuralLeaseExpiresAt: new Date("2099-01-01T00:06:00.000Z")
          };
          mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(renewed);
          return [renewed];
        }
        if (sql.includes('SET "structuralLeaseToken" = NULL')) {
          if (current.status !== "ACTIVE" || current.structuralLeaseToken !== ownerToken) return [];
          mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
            ...current,
            structuralLeaseToken: null,
            structuralLeaseExpiresAt: null
          });
          return [{ id: current.id }];
        }
        return [];
      }
    );
    mocks.nextPlanVersion.mockResolvedValue(2);
    mocks.stagedPlanCreate.mockResolvedValue({ id: "plan-2" });
    mocks.revisePlan.mockResolvedValue({ title: "Revised", chapters: [], characters: [], locations: [], researchNotes: [] });
    mocks.canEnqueueProjectWork.mockResolvedValue(true);
    mocks.prisma.generationJob.upsert.mockResolvedValue({ id: "job-generate" });
  });
  afterEach(() => vi.clearAllMocks());

  it("plans against the requested page count rather than the source book's", async () => {
    await replanBook(replanJob({ targetPages: 3 }));

    // The plan is revised from the *source* book's input snapshot, which still
    // says 12. Left to it, the planner is instructed to hit 12 and
    // normalizePlanPageTargets pads the revised chapters back up to it — which
    // is how a three-chapter plan came out as an eight-page book.
    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ targetPages: 3 }));
    expect(seedProjectStoryState).not.toHaveBeenCalled();
    expect(mocks.prisma.planVersion.create).not.toHaveBeenCalled();
  });

  it("keeps the source plan's page count when the replan named no length", async () => {
    await replanBook(replanJob({}));

    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ targetPages: 12 }));
  });

  it("prefers the durable instruction over stale queue text in the planner and staged plan", async () => {
    const durable = "Rewrite the book so Mara finds the red key and refuses to use it.";
    const characterContext = "Mentioned character profiles:\n- Mara: a careful navigator";
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: durable,
      characterContext,
      classifier: { preserved: true }
    });

    await replanBook(
      replanJob({ request: "supplemental context", editInstruction: "stale queued instruction" })
    );

    expect(mocks.revisePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining(durable)
      })
    );
    expect((mocks.revisePlan.mock.calls[0]![0] as { userMessage: string }).userMessage).toContain(
      "supplemental context"
    );
    expect((mocks.revisePlan.mock.calls[0]![0] as { userMessage: string }).userMessage).not.toContain(
      "stale queued instruction"
    );
    expect(mocks.stagedPlanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DRAFT",
          messages: expect.arrayContaining([expect.objectContaining({ content: durable })])
        })
      })
    );
    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "GENERATE_BOOK",
          payload: expect.objectContaining({
            editInstruction: durable,
            request: "legacy request",
            characterContext
          })
        })
      })
    );
    const successorPayload = successorCreate()!.payload;
    expect(successorPayload.editInstruction).not.toContain("careful navigator");
    expect(successorPayload.request).not.toContain("careful navigator");
    expect(stagedPlanData()?.classifier).toMatchObject({ preserved: true, replanStagedPlanId: "plan-2" });
  });

  it("strips legacy-composed character sheets from both successor recovery strings", async () => {
    const sheets = "Mentioned character profiles (the user's own library characters; treat as authoritative canon):\n- Mara: a careful navigator";
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: "project-1",
      status: "ACTIVE",
      request: `change the ending\n\n${sheets}`,
      editInstruction: `Rewrite the ending so Mara refuses the red key.\n\n${sheets}`,
      classifier: { replanStagedPlanId: "plan-staged" }
    });

    await replanBook(replanJob({}));

    expect(successorCreate()?.payload).toMatchObject({
      editInstruction: "Rewrite the ending so Mara refuses the red key.",
      request: "change the ending",
      characterContext: sheets
    });
  });

  it("re-enqueues the same staged plan on redelivery without planning again", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: "project-1",
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: "durable instruction",
      classifier: { replanStagedPlanId: "plan-staged" }
    });

    await replanBook(replanJob({}));

    expect(mocks.revisePlan).not.toHaveBeenCalled();
    expect(successorCreate()?.where).toEqual({ dedupeKey: "generate-book:project-copy:plan-staged" });
    expect(successorCreate()?.payload).toMatchObject({
      sourceProjectId: "project-1",
      editInstruction: "durable instruction",
      request: "legacy request"
    });
    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          generationJobId: "job-generate",
          classifier: expect.objectContaining({ replanSuccessorJobId: "job-generate" })
        })
      })
    );
  });

  it("stands down before planning when the edit was canceled and refunded", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: "project-1",
      generationJobId: "job-replan",
      status: "CANCELED",
      request: "make it 3 pages",
      editInstruction: "make it 3 pages",
      classifier: {}
    });
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });

    await expect(replanBook(replanJob({ generationJobId: "job-replan" }))).rejects.toBeInstanceOf(
      UnownedReplanDeliveryError
    );

    expect(mocks.revisePlan).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "EDITING" } })
    );
  });

  it("discards the delivery when Stop closes the job before the provider call", async () => {
    let jobClaims = 0;
    mocks.prisma.generationJob.updateMany.mockImplementation(async () => ({ count: ++jobClaims === 1 ? 1 : 0 }));

    await expect(replanBook(replanJob({}))).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.revisePlan).not.toHaveBeenCalled();
    expect(mocks.stagedPlanCreate).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });

  it("discards a provider result when Stop closes the job during the call", async () => {
    let jobClaims = 0;
    mocks.prisma.generationJob.updateMany.mockImplementation(async () => ({ count: ++jobClaims < 3 ? 1 : 0 }));

    await expect(replanBook(replanJob({}))).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.revisePlan).toHaveBeenCalledOnce();
    expect(mocks.stagedPlanCreate).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });

  it("stands down without planning when the durable replan job is no longer open", async () => {
    mocks.prisma.generationJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(replanBook(replanJob({}))).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.prisma.bookEditOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.revisePlan).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });

  it("lets one concurrent staging owner spend the provider call while the loser stands down", async () => {
    let finishRevision!: (value: { title: string; chapters: never[]; characters: never[]; locations: never[]; researchNotes: never[] }) => void;
    mocks.revisePlan.mockReturnValue(new Promise((resolve) => { finishRevision = resolve; }));
    const winner = replanBook(replanJob({}));
    await vi.waitFor(() => expect(mocks.revisePlan).toHaveBeenCalledOnce());
    await expect(replanBook(replanJob({}))).rejects.toBeInstanceOf(UnownedReplanDeliveryError);
    finishRevision({ title: "Revised", chapters: [], characters: [], locations: [], researchNotes: [] });
    await winner;

    expect(mocks.revisePlan).toHaveBeenCalledOnce();
    expect(mocks.stagedPlanCreate).toHaveBeenCalledOnce();
    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledOnce();
  });

  it("locks Project then predecessor and successor jobs before linking the operation", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: "project-1",
      generationJobId: "job-replan",
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: "durable instruction",
      classifier: { replanStagedPlanId: "plan-staged" }
    });

    await replanBook(replanJob({}));

    const projectLock = mocks.prisma.project.update.mock.invocationCallOrder[0]!;
    const predecessorLock = mocks.prisma.generationJob.updateMany.mock.invocationCallOrder[0]!;
    const operationClaim = mocks.prisma.$queryRawUnsafe.mock.invocationCallOrder[0]!;
    expect(projectLock).toBeLessThan(predecessorLock);
    expect(predecessorLock).toBeLessThan(operationClaim);
    const successorLinkCall = mocks.prisma.bookEditOperation.updateMany.mock.calls.findIndex(
      (call) => (call[0] as { data?: { generationJobId?: string } }).data?.generationJobId === "job-generate"
    );
    const successorLock = mocks.prisma.generationJob.updateMany.mock.invocationCallOrder.at(-1)!;
    expect(successorLock).toBeLessThan(mocks.prisma.bookEditOperation.updateMany.mock.invocationCallOrder[successorLinkCall]!);
  });

  // The successor's own pre-ACTIVE guard proves the operation names *this* row,
  // so a job published to Redis before that linkage commits is one a worker
  // reads as an impostor, cancels and refunds — and the linkage behind it then
  // finds no open row left to claim, wedging the replan on a spent dedupe key.
  it("commits the successor row and its linkage before publishing either", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: "project-1",
      generationJobId: "job-replan",
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: "durable instruction",
      classifier: { replanStagedPlanId: "plan-staged" }
    });

    await replanBook(replanJob({}));

    const linkCall = mocks.prisma.bookEditOperation.updateMany.mock.calls.findIndex(
      (call) => (call[0] as { data?: { generationJobId?: string } }).data?.generationJobId === "job-generate"
    );
    const created = mocks.prisma.generationJob.upsert.mock.invocationCallOrder[0]!;
    const linked = mocks.prisma.bookEditOperation.updateMany.mock.invocationCallOrder[linkCall]!;
    const published = mocks.dispatchWorkerGenerationJob.mock.invocationCallOrder[0]!;
    expect(created).toBeLessThan(linked);
    expect(linked).toBeLessThan(published);
    expect(mocks.dispatchWorkerGenerationJob).toHaveBeenCalledWith("job-generate");
    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: "generate-book:project-copy:plan-staged" },
        create: expect.objectContaining({ projectId: "project-copy", type: "GENERATE_BOOK", status: "QUEUED" }),
        update: {}
      })
    );
  });

  it("publishes nothing when the linkage this delivery no longer owns is refused", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: "project-1",
      generationJobId: "job-replan",
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: "durable instruction",
      classifier: { replanStagedPlanId: "plan-staged" }
    });
    mocks.prisma.bookEditOperation.updateMany.mockImplementation(
      async (args: { data?: Record<string, unknown> }) => ({ count: args.data?.generationJobId ? 0 : 1 })
    );

    await expect(replanBook(replanJob({}))).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();
  });

  it("stages nothing for a project that can take no more work", async () => {
    mocks.canEnqueueProjectWork.mockResolvedValue(false);

    await expect(replanBook(replanJob({}))).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();
  });

  it("uses the durable source when a redelivery carries the empty target as stale provenance", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-owner-source",
      sourceProjectId: "project-durable-source",
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: "durable instruction",
      classifier: { replanStagedPlanId: "plan-staged" }
    });

    await replanBook(replanJob({ sourceProjectId: "project-copy" }));

    expect(successorCreate()?.payload).toMatchObject({ sourceProjectId: "project-durable-source" });
    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceProjectId: "project-durable-source" }) })
    );
  });

  it("reconstructs a legacy staged delivery from the operation owner when its queue source is absent", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-legacy-source",
      sourceProjectId: null,
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: "durable instruction",
      classifier: { replanStagedPlanId: "plan-staged" }
    });

    await replanBook(replanJob({ sourceProjectId: undefined }));

    expect(successorCreate()?.payload).toMatchObject({ sourceProjectId: "project-legacy-source" });
  });

  const successorCreate = () => {
    const call = mocks.prisma.generationJob.upsert.mock.calls[0]?.[0] as
      | { where: { dedupeKey: string }; create: { payload: Record<string, unknown> } }
      | undefined;
    return call ? { where: call.where, payload: call.create.payload } : undefined;
  };

  const stagedPlanData = () =>
    ([...mocks.prisma.bookEditOperation.update.mock.calls, ...mocks.prisma.bookEditOperation.updateMany.mock.calls].find(
      (call) => (call[0] as { data: Record<string, unknown> }).data.classifier !== undefined
    )?.[0] as { data: Record<string, unknown> } | undefined)?.data;

  it("stages the resize without applying project metadata before adherence", async () => {
    await replanBook(replanJob({ targetPages: 3 }));

    expect(stagedPlanData()?.classifier).toMatchObject({ replanStagedPlanId: "plan-2", replanSourcePlanId: "plan-1" });
    expect(mocks.prisma.project.update.mock.calls).not.toContainEqual([
      expect.objectContaining({ data: expect.objectContaining({ targetPages: 3 }) })
    ]);
  });

  it("does not replace live presentation metadata while the candidate is unreviewed", async () => {
    // The target row owns presentation preferences the plan snapshot has
    // schema-stripped, and — for a replan copy — its provenance markers.
    mocks.prisma.project.findUnique.mockResolvedValue({
      mediaSettings: {
        chapterHeadingStyle: "title_only",
        chapterHeadingLabel: "Part",
        includeSources: false,
        mobile: { revisionOfProjectId: "project-1", targetPages: 3 }
      }
    });

    await replanBook(replanJob({ targetPages: 3 }));

    expect(mocks.prisma.project.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mediaSettings: expect.anything() }) })
    );
  });
});
