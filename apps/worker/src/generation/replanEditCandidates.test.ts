import { beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_ADHERENCE_FAILED } from "@book-maker/core/editFailure";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn() },
    page: { findMany: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    $executeRawUnsafe: vi.fn(),
    bookEditOperation: { updateMany: vi.fn(), update: vi.fn() },
    generationJob: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    generationAttempt: { updateMany: vi.fn() },
    imageAsset: { deleteMany: vi.fn() },
    page: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    chapter: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    continuityNote: { deleteMany: vi.fn(), createMany: vi.fn() },
    embedding: { deleteMany: vi.fn() },
    character: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    location: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    researchSource: { deleteMany: vi.fn(), createMany: vi.fn() },
    planVersion: { updateMany: vi.fn(), update: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() }
  },
  invalidateProjectExports: vi.fn(),
  prepareChapterSetups: vi.fn(),
  ensureCharacterReferenceAssets: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  revisePageDraftWithRestart: vi.fn(),
  reviewAppliedBookEdit: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  maybeEnqueueCover: vi.fn(),
  enqueueReplanIllustrations: vi.fn(),
  generatePageDraft: vi.fn(),
  waitForReplanEditLease: vi.fn(),
  completeReplanEditLease: vi.fn(),
  releaseReplanEditTailLease: vi.fn(),
  waitForReplanEditLeaseCompletion: vi.fn(),
  assertReplanEditLeaseTx: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn(),
  startReplanEditLeaseHeartbeat: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  PAGE_SCOPE_PREFIX: "page:",
  pageScope: (index: number) => `page:${index}`
}));
vi.mock("./bookHelpers.js", () => ({
  invalidateProjectExports: mocks.invalidateProjectExports,
  planMediaSettingsSnapshot: (input: { mediaSettings: unknown }) => input.mediaSettings,
  styleExcerptsForPage: async () => [],
  toPriorPageContext: (page: unknown) => page
}));
vi.mock("./bookState.js", () => ({ prepareChapterSetups: mocks.prepareChapterSetups }));
vi.mock("./characterReferences.js", () => ({
  ensureCharacterReferenceAssets: mocks.ensureCharacterReferenceAssets
}));
vi.mock("./generationContext.js", () => ({
  chapterSetupForPage: (setups: Array<{ startPage: number; endPage: number }>, index: number) =>
    setups.find((setup) => setup.startPage <= index && setup.endPage >= index),
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("./pageReview.js", () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage,
  revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({ enabled: () => false, settings: {}, tier: "balanced" })
}));
vi.mock("./replanEditLease.js", () => {
  class ReplanEditLeaseLostError extends Error {}
  return {
    assertReplanEditLeaseTx: mocks.assertReplanEditLeaseTx,
    completeReplanEditLease: mocks.completeReplanEditLease,
    releaseReplanEditTailLease: mocks.releaseReplanEditTailLease,
    isReplanEditLeaseLostError: (error: unknown) => error instanceof ReplanEditLeaseLostError,
    ReplanEditLeaseLostError,
    startReplanEditLeaseHeartbeat: mocks.startReplanEditLeaseHeartbeat,
    startReplanEditTailLeaseHeartbeat: mocks.startReplanEditLeaseHeartbeat,
    waitForReplanEditLease: mocks.waitForReplanEditLease,
    waitForReplanEditLeaseCompletion: mocks.waitForReplanEditLeaseCompletion
  };
});
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  maybeEnqueueCover: mocks.maybeEnqueueCover
}));
vi.mock("./replanCoverDispatch.js", () => ({
  maybeEnqueueRevisionOwnedReplanCover: mocks.maybeEnqueueCover
}));
vi.mock("./replanPageIllustrationDispatch.js", () => ({
  enqueueRevisionOwnedReplanIllustrations: mocks.enqueueReplanIllustrations
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("@book-maker/core", async () => ({
  ...(await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core")),
  reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
}));

import { generateReplannedBook } from "./replanEditCandidates.js";
import { ReplanEditLeaseLostError } from "./replanEditLease.js";
import { UnownedReplanDeliveryError } from "../runtime/jobTypes.js";

const instruction = "Rewrite the whole book so Mara finds a red key and refuses to use it.";
const plan = {
  title: "Revised",
  chapters: [{ index: 1, title: "One", summary: "Chapter", targetPages: 2, keyBeats: [] }],
  characters: [],
  locations: [],
  researchNotes: [],
  promises: []
};
const input = {
  prompt: "Original prompt",
  category: "STORY",
  targetPages: 2,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {}
};
const sourcePages = [1, 2].map((index) => ({
  id: `old-${index}`,
  index,
  title: `Old ${index}`,
  markdown: `Old prose ${index}.`,
  summary: `Old summary ${index}.`,
  imagePrompt: null,
  revision: 1
}));
let leaseStatus = "ACTIVE";
let generationJobStatus = "ACTIVE";
let attemptStatus = "ACTIVE";
let operationClassifier: Record<string, unknown> = {};

const options = () => ({
  projectId: "project-1",
  planId: "plan-new",
  operationId: "operation-1",
  input: input as never,
  plan: plan as never,
  providers: { text: {} } as never,
  strategy: { id: "standard", generatePageDraft: mocks.generatePageDraft } as never,
  generationJobId: "generation-1",
  attemptId: "attempt-1"
});

/** The barrier the publication stamped, until this tail's checkpoint clears it. */
const exportBarrier = (): number | null =>
  mocks.tx.project.updateMany.mock.calls.some((call) => (call[0] as { where?: { exportInvalidationRevision?: number } }).where?.exportInvalidationRevision === 5) ? null : 5;

beforeEach(() => {
  vi.clearAllMocks();
  leaseStatus = "ACTIVE";
  generationJobStatus = "ACTIVE";
  attemptStatus = "ACTIVE";
  operationClassifier = {};
  mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => ({
    id: "operation-1",
    projectId: "project-source",
    sourceProjectId: "project-source",
    status: leaseStatus,
    request: "stale contextual request",
    editInstruction: instruction,
    characterContext: "Mentioned character profiles:\n- Mara: a careful navigator",
    classifier: operationClassifier,
    publicationRevision: leaseStatus === "APPLIED" ? 5 : null
  }));
  mocks.prisma.page.findMany.mockResolvedValue(sourcePages);
  mocks.prepareChapterSetups.mockResolvedValue([
    { chapter: plan.chapters[0], startPage: 1, endPage: 2, brief: { pages: [] } }
  ]);
  mocks.generatePageDraft.mockImplementation(async ({ pageIndex }: { pageIndex: number }) => ({
    title: `New ${pageIndex}`,
    markdown: `New prose ${pageIndex}.`,
    summary: `New summary ${pageIndex}.`,
    continuityNotes: []
  }));
  mocks.reviewAndSaveGeneratedPage.mockImplementation(
    async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => ({
      page: draft,
      candidate: {
        draft,
        qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
      }
    })
  );
  mocks.reviewAppliedBookEdit.mockResolvedValue({
    satisfied: true,
    confidence: 1,
    missingRequirements: [],
    contradictions: [],
    pageIndexesToRevise: []
  });
  mocks.revisePageDraftWithRestart.mockImplementation(
    async ({ reviseOptions }: { reviseOptions: { draft: Record<string, unknown> } }) => ({
      ...reviseOptions.draft,
      markdown: "Repaired prose."
    })
  );
  mocks.tx.chapter.createMany.mockResolvedValue({ count: 1 });
  mocks.tx.$executeRawUnsafe.mockResolvedValue(1);
  mocks.tx.character.findMany.mockResolvedValue([]);
  mocks.tx.location.findMany.mockResolvedValue([]);
  mocks.tx.chapter.findMany.mockResolvedValue([{ id: "chapter-new", index: 1 }]);
  mocks.tx.page.findMany.mockImplementation(async ({ where }: { where: { index: { in: number[] } } }) =>
    where.index.in.map((index) => ({ id: `new-page-${index}`, index }))
  );
  mocks.tx.generationJob.updateMany.mockImplementation(async ({ where, data }) => {
    const matches =
      where.id === "generation-1" &&
      where.projectId === "project-1" &&
      where.type === "GENERATE_BOOK" &&
      where.status === "ACTIVE" &&
      where.attemptId === "attempt-1" &&
      generationJobStatus === "ACTIVE";
    if (matches && data.status === "COMPLETED") generationJobStatus = "COMPLETED";
    return { count: matches ? 1 : 0 };
  });
  mocks.tx.generationJob.findUnique.mockResolvedValue({
    steps: [{ key: "generate", label: "Generate", status: "active" }]
  });
  mocks.tx.generationAttempt.updateMany.mockImplementation(async ({ where, data }) => {
    const successor = where.jobs?.some;
    const matches =
      where.id === "attempt-1" &&
      where.projectId === "project-1" &&
      where.editOperationId === "operation-1" &&
      where.status === "ACTIVE" &&
      successor?.id === "generation-1" &&
      successor?.projectId === "project-1" &&
      successor?.type === "GENERATE_BOOK" &&
      successor?.attemptId === "attempt-1" &&
      attemptStatus === "ACTIVE";
    if (matches && data.status === "SUCCEEDED") attemptStatus = "SUCCEEDED";
    return { count: matches ? 1 : 0 };
  });
  mocks.tx.project.update.mockImplementation(async ({ select }: { select?: { mediaSettings?: boolean } }) =>
    select?.mediaSettings
      ? { mediaSettings: {} }
      : { contentRevision: 5, currentPlanId: "plan-new", status: "EDITING", exportInvalidationRevision: exportBarrier() }
  );
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    const snapshot = { leaseStatus, generationJobStatus, attemptStatus, operationClassifier };
    try {
      return await run(mocks.tx);
    } catch (error) {
      leaseStatus = snapshot.leaseStatus;
      generationJobStatus = snapshot.generationJobStatus;
      attemptStatus = snapshot.attemptStatus;
      operationClassifier = snapshot.operationClassifier;
      throw error;
    }
  });
  mocks.waitForReplanEditLease.mockResolvedValue({ outcome: "acquired", phase: "draft" });
  mocks.completeReplanEditLease.mockResolvedValue(true);
  mocks.releaseReplanEditTailLease.mockResolvedValue(true);
  mocks.waitForReplanEditLeaseCompletion.mockResolvedValue("completed");
  mocks.assertReplanEditLeaseTx.mockImplementation(async () => ({
    status: leaseStatus,
    classifier: operationClassifier
  }));
  mocks.tx.bookEditOperation.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    if (data.status === "APPLIED") leaseStatus = "APPLIED";
    if (data.classifier && typeof data.classifier === "object") {
      operationClassifier = data.classifier as Record<string, unknown>;
    }
    return {};
  });
  mocks.heartbeatAssertHeld.mockResolvedValue(undefined);
  mocks.heartbeatStop.mockResolvedValue(undefined);
  mocks.startReplanEditLeaseHeartbeat.mockReturnValue({
    assertHeld: mocks.heartbeatAssertHeld,
    stop: mocks.heartbeatStop
  });
});

describe("generateReplannedBook adherence publication", () => {
  it("keeps the durable instruction authoritative over stale regenerated-book payload text", async () => {
    await generateReplannedBook({
      ...options(),
      queuedEditInstruction: "stale queued instruction",
      queuedRequest: "stale queued request",
      queuedCharacterContext: "stale queued sheets"
    });

    expect(mocks.generatePageDraft).toHaveBeenCalledWith(expect.objectContaining({
      editInstruction: instruction,
      characterContext: "Mentioned character profiles:\n- Mara: a careful navigator"
    }));
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledWith(expect.objectContaining({ instruction }));
  });

  it("reconstructs the approved instruction from the successor payload when the durable value is null", async () => {
    const recovered = "Rewrite the ending so Mara refuses the red key.";
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-source",
      sourceProjectId: "project-source",
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: null,
      classifier: {}
    });

    await generateReplannedBook({ ...options(), queuedEditInstruction: recovered, queuedRequest: "change the ending" });

    expect(mocks.generatePageDraft).toHaveBeenCalledWith(expect.objectContaining({ editInstruction: recovered }));
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledWith(expect.objectContaining({ instruction: recovered }));
  });

  it("reconstructs a request-only legacy successor without inventing an instruction", async () => {
    const legacyRequest = "Rebuild the story around Mara's red key.";
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-source",
      sourceProjectId: "project-source",
      status: "ACTIVE",
      request: legacyRequest,
      editInstruction: null,
      classifier: {}
    });

    await generateReplannedBook({ ...options(), queuedRequest: legacyRequest });

    expect(mocks.generatePageDraft).toHaveBeenCalledWith(expect.objectContaining({ editInstruction: legacyRequest }));
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledWith(expect.objectContaining({ instruction: legacyRequest }));
  });

  it("atomically completes the exact active paid attempt with the published manuscript", async () => {
    const completion = await generateReplannedBook(options());

    expect(completion).toMatchObject({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true
    });
    expect(generationJobStatus).toBe("COMPLETED");
    expect(attemptStatus).toBe("SUCCEEDED");
    expect(mocks.tx.generationAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: "attempt-1",
        projectId: "project-1",
        editOperationId: "operation-1",
        status: "ACTIVE",
        jobs: {
          some: {
            id: "generation-1",
            projectId: "project-1",
            type: "GENERATE_BOOK",
            attemptId: "attempt-1"
          }
        }
      },
      data: {
        status: "SUCCEEDED",
        finishedAt: expect.any(Date),
        error: null,
        refundPending: false
      }
    });
    expect(mocks.tx.generationJob.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!
    );
    expect(mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.generationAttempt.updateMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.tx.generationAttempt.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.page.deleteMany.mock.invocationCallOrder[0]!
    );
  });

  it.each(["FAILED", "CANCELED"])(
    "blocks publication when the paid attempt is already %s",
    async (terminalStatus) => {
      attemptStatus = terminalStatus;

      await expect(generateReplannedBook(options())).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

      expect(generationJobStatus).toBe("ACTIVE");
      expect(attemptStatus).toBe(terminalStatus);
      expect(leaseStatus).toBe("ACTIVE");
      expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
      expect(mocks.tx.bookEditOperation.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
      );
    }
  );

  it("stands down when the delivered attempt does not match the durable successor job", async () => {
    await expect(
      generateReplannedBook({ ...options(), attemptId: "attempt-other" })
    ).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(generationJobStatus).toBe("ACTIVE");
    expect(attemptStatus).toBe("ACTIVE");
    expect(mocks.tx.generationAttempt.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
  });

  it("rolls job and attempt settlement back when a later manuscript write fails", async () => {
    mocks.tx.page.createMany.mockRejectedValueOnce(new Error("replacement page insert failed"));

    await expect(generateReplannedBook(options())).rejects.toThrow("replacement page insert failed");

    expect(mocks.tx.generationAttempt.updateMany).toHaveBeenCalledTimes(1);
    expect(generationJobStatus).toBe("ACTIVE");
    expect(attemptStatus).toBe("ACTIVE");
    expect(leaseStatus).toBe("ACTIVE");
    expect(mocks.completeReplanEditLease).not.toHaveBeenCalled();
  });

  it("bulk-publishes a large replacement under the manuscript transaction budget and final CAS", async () => {
    const pageCount = 120;
    const largePlan = {
      ...plan,
      chapters: [{ ...plan.chapters[0], targetPages: pageCount }]
    };
    const largeInput = { ...input, targetPages: pageCount };
    const largeSourcePages = Array.from({ length: pageCount }, (_, offset) => ({
      id: `old-${offset + 1}`,
      index: offset + 1,
      title: `Old ${offset + 1}`,
      markdown: `Old prose ${offset + 1}.`,
      summary: `Old summary ${offset + 1}.`,
      imagePrompt: null,
      revision: 1
    }));
    mocks.prisma.page.findMany.mockResolvedValue(largeSourcePages);
    mocks.prepareChapterSetups.mockResolvedValue([
      { chapter: largePlan.chapters[0], startPage: 1, endPage: pageCount, brief: { pages: [] } }
    ]);

    await generateReplannedBook({
      ...options(),
      input: largeInput as never,
      plan: largePlan as never
    });

    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30_000, maxWait: 10_000 }
    );
    expect(mocks.tx.chapter.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.page.createMany).toHaveBeenCalledTimes(1);
    expect((mocks.tx.page.createMany.mock.calls[0]![0] as { data: unknown[] }).data).toHaveLength(pageCount);
    expect(mocks.tx.generationJob.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.page.createMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.page.createMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
  });

  it("uses the durable instruction in every page prompt and reviews the complete replacement before publishing", async () => {
    const completion = await generateReplannedBook(options());

    for (const call of mocks.generatePageDraft.mock.calls) {
      expect(call[0]).toMatchObject({
        editInstruction: instruction,
        characterContext: expect.stringContaining("careful navigator")
      });
    }
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledWith(
      expect.objectContaining({ instruction, beforePages: expect.any(Array), afterPages: expect.any(Array) })
    );
    expect(mocks.prisma.page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "project-source" }, orderBy: { index: "asc" } })
    );
    expect((mocks.reviewAppliedBookEdit.mock.calls[0]![0] as { beforePages: unknown[] }).beforePages).toHaveLength(2);
    expect((mocks.reviewAppliedBookEdit.mock.calls[0]![0] as { afterPages: unknown[] }).afterPages).toHaveLength(2);
    expect(JSON.stringify(mocks.reviewAppliedBookEdit.mock.calls[0]![0])).not.toContain("careful navigator");
    expect(mocks.reviewAppliedBookEdit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.tx.page.deleteMany.mock.invocationCallOrder[0]!
    );
    const ownerToken = mocks.waitForReplanEditLease.mock.calls[0]![1] as string;
    expect(ownerToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mocks.startReplanEditLeaseHeartbeat).toHaveBeenCalledWith("operation-1", ownerToken);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledWith(
      expect.objectContaining({ assertOwnership: mocks.heartbeatAssertHeld })
    );
    expect(mocks.tx.project.update).toHaveBeenNthCalledWith(1, {
      where: { id: "project-1" },
      data: { contentRevision: { increment: 0 } },
      select: { mediaSettings: true }
    });
    expect(mocks.tx.project.update.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!
    );
    expect(mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.page.deleteMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED", editInstruction: instruction }) })
    );
    expect(mocks.tx.generationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "generation-1", status: "ACTIVE" }),
        data: expect.objectContaining({ status: "COMPLETED" })
      })
    );
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    await completion.afterJobCompleted?.();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
  });

  it("deletes obsolete memory and attaches replacement continuity to the new page ids", async () => {
    mocks.reviewAndSaveGeneratedPage.mockImplementation(
      async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => ({
        page: draft,
        candidate: {
          draft: { ...draft, continuityNotes: [`Replacement fact ${draft.index}.`] },
          qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
        }
      })
    );

    await generateReplannedBook(options());

    expect(mocks.tx.continuityNote.deleteMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.continuityNote.createMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.tx.embedding.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", scope: { startsWith: "page:" } }
    });
    // Over the notes rather than the statements, because
    // `persistPreparedDeferredPageMemory` batches them: this is about page ids.
    const noteCalls = mocks.tx.continuityNote.createMany.mock.calls as Array<[{ data: unknown[] }]>;
    expect(noteCalls.flatMap(([call]) => call.data)).toEqual([
      expect.objectContaining({ pageId: "new-page-1", body: "Replacement fact 1." }),
      expect.objectContaining({ pageId: "new-page-2", body: "Replacement fact 2." })
    ]);
  });

  it("loads beforePages from the durable source instead of a stale empty-target payload", async () => {
    mocks.prisma.page.findMany.mockImplementation(async ({ where }: { where: { projectId: string } }) =>
      where.projectId === "project-source" ? sourcePages : []
    );

    await generateReplannedBook({ ...options(), sourceProjectId: "project-1" });

    expect(mocks.prisma.page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "project-source" } })
    );
    expect(mocks.reviewAppliedBookEdit.mock.calls[0]![0]).toMatchObject({
      beforePages: [
        expect.objectContaining({ index: 1, markdown: "Old prose 1." }),
        expect.objectContaining({ index: 2, markdown: "Old prose 2." })
      ],
      afterPages: [
        expect.objectContaining({ index: 1, markdown: "New prose 1." }),
        expect.objectContaining({ index: 2, markdown: "New prose 2." })
      ]
    });
  });

  it("fails an omission measured against the complete source manuscript", async () => {
    const completeSource = [
      sourcePages[1]!,
      { ...sourcePages[0]!, index: 3, id: "old-3", markdown: "The ending reveals the red key." },
      sourcePages[0]!
    ];
    mocks.prisma.page.findMany.mockResolvedValue(completeSource);
    mocks.reviewAppliedBookEdit.mockImplementation(async ({ beforePages, afterPages }) => {
      const missingEnding = beforePages.some((page: { index: number }) => page.index === 3)
        && !afterPages.some((page: { index: number }) => page.index === 3);
      return {
        satisfied: !missingEnding,
        confidence: 1,
        missingRequirements: missingEnding ? ["The source ending was omitted."] : [],
        contradictions: [],
        pageIndexesToRevise: []
      };
    });

    await expect(generateReplannedBook(options())).rejects.toThrow(EDIT_ADHERENCE_FAILED);

    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    expect(mocks.reviewAppliedBookEdit.mock.calls[0]![0].beforePages.map((page: { index: number }) => page.index))
      .toEqual([1, 2, 3]);
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
  });

  it("falls back to a legacy operation owner when durable and queued source fields are absent", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-legacy-source",
      sourceProjectId: null,
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: instruction
    });

    await generateReplannedBook(options());

    expect(mocks.prisma.page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "project-legacy-source" } })
    );
  });

  it("refuses to review an empty target as a legacy source manuscript", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      projectId: "project-1",
      sourceProjectId: null,
      status: "ACTIVE",
      request: "legacy request",
      editInstruction: instruction
    });
    mocks.prisma.page.findMany.mockResolvedValue([]);

    await expect(generateReplannedBook(options())).rejects.toThrow(
      "Cannot review a replan against an empty source manuscript"
    );

    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
  });

  it("revises only flagged pages with concrete missing requirements", async () => {
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce({
        satisfied: false,
        confidence: 0.8,
        missingRequirements: ["Mara never refuses the key."],
        contradictions: [],
        pageIndexesToRevise: [2]
      })
      .mockResolvedValue({
        satisfied: true,
        confidence: 1,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });

    const completion = await generateReplannedBook(options());
    await completion.afterJobCompleted?.();

    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledTimes(1);
    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "Replanned page 2",
        reviseOptions: expect.objectContaining({
          editInstruction: instruction,
          adherenceRepair: ["Mara never refuses the key."]
        })
      })
    );
  });

  it("publishes a replanned page the reviewer never approved as FAILED_QA", async () => {
    // One page the reviewer will not pass is flagged for the replan recompile's
    // repair pass, exactly as generation flags it — never a refund of the book.
    mocks.reviewAndSaveGeneratedPage.mockImplementation(
      async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => ({
        page: draft,
        candidate: {
          draft,
          qualityReport:
            draft.index === 2
              ? { approved: false, score: 41, issues: ["Repeats page 1."], requiredRevisions: [], notes: "" }
              : { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
        }
      })
    );

    const completion = await generateReplannedBook(options());
    await completion.afterJobCompleted?.();

    const created = mocks.tx.page.createMany.mock.calls[0]?.[0] as { data: Array<{ index: number; status: string }> };
    expect(created.data.map((page) => [page.index, page.status])).toEqual([[1, "COMPLETED"], [2, "FAILED_QA"]]);
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          adherenceAudit: expect.objectContaining({ proseApproved: false })
        })
      })
    );
  });

  it("keeps the original manuscript and never marks APPLIED when all three candidates fail", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: false,
      confidence: 0.8,
      missingRequirements: ["The red key is absent."],
      contradictions: [],
      pageIndexesToRevise: [1]
    });

    await expect(generateReplannedBook(options())).rejects.toThrow(EDIT_ADHERENCE_FAILED);

    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ adherenceAudit: expect.any(Object) }) })
    );
  });

  it("replays only the publication follow-up after APPLIED", async () => {
    leaseStatus = "APPLIED";
    generationJobStatus = "COMPLETED";
    attemptStatus = "SUCCEEDED";
    operationClassifier = {
      replanFollowUp: {
        planVersionId: "plan-new",
        publicationRevision: 5,
        completedSteps: [],
        updatedAt: new Date().toISOString()
      }
    };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      status: "APPLIED",
      request: "legacy",
      editInstruction: instruction,
      classifier: operationClassifier
    });
    mocks.waitForReplanEditLease.mockResolvedValue({ outcome: "acquired", phase: "tail" });

    const completion = await generateReplannedBook(options());

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    await completion.afterJobCompleted?.();

    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.tx.generationAttempt.updateMany).not.toHaveBeenCalled();
    expect(attemptStatus).toBe("SUCCEEDED");
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-new",
      expect.objectContaining({ expectedProjectStatus: "EDITING" }),
      { contentRevision: 5, requireContentRevisionMatch: true }
    );
    expect(mocks.completeReplanEditLease).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "export invalidation",
      failingMock: () => mocks.invalidateProjectExports,
      expected: { exports: 2, characters: 1, cover: 1, compile: 1 }
    },
    {
      label: "character asset generation",
      failingMock: () => mocks.ensureCharacterReferenceAssets,
      expected: { exports: 1, characters: 2, cover: 1, compile: 1 }
    }
    // A compile enqueue outage is not one of these: it settles as `not-ready`, which `replanFollowUp.test.ts` pins.
  ])("keeps publication settled and retries only missing tails after $label fails", async ({ failingMock, expected }) => {
    mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => ({
      id: "operation-1",
      status: leaseStatus,
      request: "stale contextual request",
      editInstruction: instruction,
      classifier: operationClassifier
    }));
    failingMock().mockRejectedValueOnce(new Error("tail unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await generateReplannedBook(options());
    await expect(first.afterJobCompleted?.()).rejects.toThrow("tail unavailable");

    expect(leaseStatus).toBe("APPLIED");
    expect(attemptStatus).toBe("SUCCEEDED");
    expect(mocks.tx.page.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.generationJob.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.releaseReplanEditTailLease).toHaveBeenCalledTimes(1);
    expect(mocks.completeReplanEditLease).not.toHaveBeenCalled();

    mocks.waitForReplanEditLease.mockResolvedValue({ outcome: "acquired", phase: "tail" });
    const replay = await generateReplannedBook(options());
    await replay.afterJobCompleted?.();

    expect(mocks.generatePageDraft).toHaveBeenCalledTimes(2);
    expect(mocks.tx.page.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProjectExports).toHaveBeenCalledTimes(expected.exports);
    expect(mocks.ensureCharacterReferenceAssets).toHaveBeenCalledTimes(expected.characters);
    expect(mocks.maybeEnqueueCover).toHaveBeenCalledTimes(expected.cover);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(expected.compile);
    expect(mocks.completeReplanEditLease).toHaveBeenCalledTimes(1);
    expect(mocks.tx.generationAttempt.updateMany).toHaveBeenCalledTimes(1);
    expect(attemptStatus).toBe("SUCCEEDED");
    expect(operationClassifier).toMatchObject({
      replanFollowUp: { completedSteps: ["exports", "characters", "cover", "compile"] }
    });
    logged.mockRestore();
  });

  it("lets one concurrent delivery publish while the active-lease loser stands down", async () => {
    mocks.waitForReplanEditLease
      .mockResolvedValueOnce({ outcome: "acquired", phase: "draft" })
      .mockResolvedValueOnce({ outcome: "abandoned" });

    const results = await Promise.allSettled([generateReplannedBook(options()), generateReplannedBook(options())]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(UnownedReplanDeliveryError) });
    expect(mocks.tx.page.deleteMany).toHaveBeenCalledTimes(1);
    const winner = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof generateReplannedBook>>> =>
        result.status === "fulfilled"
    );
    await winner?.value.afterJobCompleted?.();
    expect(mocks.completeReplanEditLease).toHaveBeenCalledTimes(1);
  });

  it("allows an expired-lease takeover after the former owner stands down", async () => {
    const lostHeartbeat = {
      assertHeld: vi.fn(async () => {
        throw new ReplanEditLeaseLostError();
      }),
      stop: vi.fn(async () => undefined)
    };
    mocks.startReplanEditLeaseHeartbeat
      .mockReturnValueOnce(lostHeartbeat)
      .mockReturnValueOnce({ assertHeld: mocks.heartbeatAssertHeld, stop: mocks.heartbeatStop });
    mocks.waitForReplanEditLease
      .mockResolvedValueOnce({ outcome: "acquired", phase: "draft" })
      .mockResolvedValueOnce({ outcome: "acquired", phase: "draft" });

    await expect(generateReplannedBook(options())).rejects.toBeInstanceOf(UnownedReplanDeliveryError);
    await expect(generateReplannedBook(options())).resolves.toMatchObject({ afterJobCompleted: expect.any(Function) });

    expect(lostHeartbeat.stop).toHaveBeenCalledTimes(1);
    expect(mocks.tx.page.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.project.update.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!
    );
    expect(mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.page.deleteMany.mock.invocationCallOrder[0]!
    );
  });

  it("stands down when the claim itself loses the lease, and still raises anything else", async () => {
    // The claim's tail-identity check locks Project and re-asserts an unheartbeated
    // token, so it raises lease loss from outside the guard. Escaping as a plain
    // error reached `markFailed`, refunding a replan the reader already has.
    leaseStatus = "APPLIED";
    mocks.waitForReplanEditLease.mockRejectedValueOnce(new ReplanEditLeaseLostError());
    await expect(generateReplannedBook(options())).rejects.toBeInstanceOf(UnownedReplanDeliveryError);
    expect(mocks.waitForReplanEditLeaseCompletion).toHaveBeenCalledWith("operation-1");
    expect(mocks.startReplanEditLeaseHeartbeat).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();

    mocks.waitForReplanEditLeaseCompletion.mockClear();
    mocks.waitForReplanEditLease.mockRejectedValueOnce(new Error("claim query failed"));
    await expect(generateReplannedBook(options())).rejects.toThrow("claim query failed");
    expect(mocks.waitForReplanEditLeaseCompletion).not.toHaveBeenCalled();
  });

  it("stands down while another unexpired owner remains active", async () => {
    mocks.waitForReplanEditLease.mockResolvedValue({ outcome: "abandoned" });

    await expect(generateReplannedBook(options())).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.startReplanEditLeaseHeartbeat).not.toHaveBeenCalled();
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stands down on cancellation without generating, publishing, failing or replaying", async () => {
    mocks.waitForReplanEditLease.mockResolvedValue({ outcome: "settled" });

    await expect(generateReplannedBook(options())).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.startReplanEditLeaseHeartbeat).not.toHaveBeenCalled();
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
  });

  it("treats exact-owner loss immediately before publication as superseded", async () => {
    mocks.assertReplanEditLeaseTx.mockRejectedValue(new ReplanEditLeaseLostError());

    await expect(generateReplannedBook(options())).rejects.toBeInstanceOf(UnownedReplanDeliveryError);

    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalled();
    expect(mocks.tx.project.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.project.update.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.assertReplanEditLeaseTx.mock.invocationCallOrder[0]!
    );
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.completeReplanEditLease).not.toHaveBeenCalled();
    expect(mocks.waitForReplanEditLeaseCompletion).toHaveBeenCalledWith("operation-1");
  });
});
