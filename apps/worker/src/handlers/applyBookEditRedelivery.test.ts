import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), update: vi.fn() },
    pageEditSnapshot: { findMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    $executeRawUnsafe: vi.fn()
  },
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  rewritePageForUserRequest: vi.fn(),
  prepareEmbedding: vi.fn(),
  strategyUsesSemanticMemory: vi.fn(() => false),
  writePreparedEmbedding: vi.fn(),
  keeperStoryExtractForSave: vi.fn(),
  persistStoryExtract: vi.fn(),
  refundSkippedEditOperation: vi.fn(),
  settleSkippedTextEditLeaseTx: vi.fn(),
  assertTextEditLeaseTx: vi.fn(async (_tx: unknown, _operationId: string, _ownerToken: string) => ({
    status: "APPLIED",
    classifier: {}
  })),
  completeTextEditLease: vi.fn(async () => true),
  waitForTextEditLease: vi.fn(
    async (): Promise<
      | { outcome: "acquired"; phase: "draft" | "tail" }
      | { outcome: "completed" }
      | { outcome: "settled" }
      | { outcome: "abandoned" }
    > => ({ outcome: "acquired", phase: "tail" })
  ),
  waitForTextEditLeaseCompletion: vi.fn(
    async (): Promise<"completed" | "abandoned"> => "completed"
  ),
  heartbeatAssertHeld: vi.fn(async () => undefined),
  heartbeatStop: vi.fn(async () => undefined),
  claimAppliedEditPublication: vi.fn(async () => true),
  restoreEditProjectStatus: vi.fn(async () => true),
  publishTextEditManuscript: vi.fn(async (options: {
    ownerToken: string;
    pages: Array<{ preparedEmbedding: unknown }>;
  }) => ({
    identity: {
      projectId: "project-1", operationId: "op-1", planVersionId: "plan-1",
      publicationRevision: 8, fallbackStatus: "REVIEW_REQUIRED"
    },
    memory: options.pages.flatMap((page) => page.preparedEmbedding ? [page] : [])
  })),
  textEditPublicationCompletion: vi.fn(() => ({
    durableCompletionCommitted: true,
    lifecycleCompletionCommitted: true,
    retryFollowUpOnRedelivery: true,
    afterJobCompleted: vi.fn()
  })),
  textEditPublicationIdentity: vi.fn((): null | {
    projectId: string;
    operationId: string;
    planVersionId: string;
    publicationRevision: number;
    fallbackStatus: "REVIEW_REQUIRED";
  } => null),
  adoptLegacyTextEditTail: vi.fn(async (): Promise<null | {
    projectId: string;
    operationId: string;
    planVersionId: string;
    publicationRevision: number;
    fallbackStatus: "REVIEW_REQUIRED";
  }> => ({
    projectId: "project-1", operationId: "op-1", planVersionId: "plan-1",
    publicationRevision: 8, fallbackStatus: "REVIEW_REQUIRED"
  }))
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  pageScope: vi.fn(),
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  refundSkippedEditOperation: mocks.refundSkippedEditOperation
}));
vi.mock("../runtime/durableEditCompletion.js", () => ({
  claimDurableEditCompletionTx: vi.fn(async () => true),
  settleDurableEditAttemptTx: vi.fn(async () => true)
}));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: vi.fn(() => ({ text: {}, embedding: {} })) }));
vi.mock("../generation/embeddingWrites.js", () => ({
  prepareEmbedding: mocks.prepareEmbedding,
  strategyUsesSemanticMemory: mocks.strategyUsesSemanticMemory,
  writePreparedEmbedding: mocks.writePreparedEmbedding
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: vi.fn(() => ({})) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: vi.fn(() => ({}))
}));
vi.mock("./applyImageInsertion.js", () => ({ applyImageInsertion: vi.fn() }));
vi.mock("./applyImageLayout.js", () => ({ applyImageLayout: vi.fn() }));
vi.mock("./restructurePages.js", () => ({ restructurePages: vi.fn() }));
vi.mock("../generation/qualitySettings.js", () => ({ loadQualityContext: vi.fn(() => ({ enabled: () => false })) }));
vi.mock("../generation/storyStateStore.js", () => ({
  rebuildProjectStoryState: vi.fn(),
  loadProjectStoryState: vi.fn(() => ({ promises: [], facts: [], entities: {}, unanswered: [] }))
}));
vi.mock("../generation/qualityEnrichment.js", () => ({
  keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
  persistStoryExtract: mocks.persistStoryExtract
}));
vi.mock("../generation/textEditLease.js", () => ({
  assertTextEditLeaseTx: mocks.assertTextEditLeaseTx,
  completeTextEditLease: mocks.completeTextEditLease,
  isTextEditLeaseLostError: (error: unknown) => error instanceof Error && error.name === "StructuralPageLeaseLostError",
  startTextEditLeaseHeartbeat: () => ({ assertHeld: mocks.heartbeatAssertHeld, stop: mocks.heartbeatStop }),
  waitForTextEditLease: mocks.waitForTextEditLease,
  waitForTextEditLeaseCompletion: mocks.waitForTextEditLeaseCompletion,
  settleSkippedTextEditLeaseTx: mocks.settleSkippedTextEditLeaseTx
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));
vi.mock("../generation/textEditPublication.js", () => ({
  publishTextEditManuscript: mocks.publishTextEditManuscript,
  textEditPublicationCompletion: mocks.textEditPublicationCompletion,
  textEditPublicationIdentity: mocks.textEditPublicationIdentity,
  adoptLegacyTextEditTail: mocks.adoptLegacyTextEditTail
}));
vi.mock("../generation/textEditRewrite.js", () => ({ locallyPatchedPage: vi.fn(), rewritePageForUserRequest: mocks.rewritePageForUserRequest }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: () => ({}) },
    createProviders: () => ({}),
    reviewAppliedBookEdit: async () => ({
      satisfied: true,
      confidence: 1,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    })
  };
});

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { applyBookEdit } from "./applyBookEdit.js";

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: "Make page 1 funnier",
      affectedPageIndexes: [1],
      planId: "plan-1",
      [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED",
      ...data
    }
  }) as unknown as Job;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
    id: "op-1",
    kind: "PAGE_REWRITE",
    status: "APPLIED"
  });
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.project.update.mockResolvedValue({ contentRevision: 8 });
  mocks.prisma.pageEditSnapshot.findMany.mockResolvedValue([]);
  mocks.prisma.pageEditSnapshot.createManyAndReturn.mockImplementation(
    async ({ data }: { data: Array<Record<string, unknown>> }) =>
      data.map((snapshot) => ({ ...snapshot, id: `snap-${String(snapshot.pageId)}` }))
  );
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma));
  mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "tail" });
  mocks.waitForTextEditLeaseCompletion.mockResolvedValue("completed");
  mocks.completeTextEditLease.mockResolvedValue(true);
  mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: {} });
  mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  mocks.strategyUsesSemanticMemory.mockReturnValue(false);
  mocks.keeperStoryExtractForSave.mockResolvedValue(null);
  mocks.writePreparedEmbedding.mockResolvedValue("stored");
  mocks.persistStoryExtract.mockResolvedValue(null);
  mocks.refundSkippedEditOperation.mockResolvedValue(undefined);
  mocks.settleSkippedTextEditLeaseTx.mockResolvedValue({ classifier: {} });
  mocks.claimAppliedEditPublication.mockResolvedValue(true);
  mocks.restoreEditProjectStatus.mockResolvedValue(true);
  mocks.textEditPublicationIdentity.mockReturnValue(null);
  mocks.adoptLegacyTextEditTail.mockResolvedValue({
    projectId: "project-1",
    operationId: "op-1",
    planVersionId: "plan-1",
    publicationRevision: 8,
    fallbackStatus: "REVIEW_REQUIRED"
  });
});

describe("applyBookEdit APPLIED redelivery", () => {
  it("stands down immediately on the durable exact-text no-op marker", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      kind: "PAGE_REWRITE",
      status: "APPLIED",
      classifier: { textExactSkipped: true, skippedPageIndexes: [1] }
    });

    await applyBookEdit(job());

    expect(mocks.waitForTextEditLease).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
  });

  it("replays the durable publication tail without redrafting pages", async () => {
    const identity = {
      projectId: "project-1",
      operationId: "op-1",
      planVersionId: "plan-1",
      publicationRevision: 8,
      fallbackStatus: "REVIEW_REQUIRED" as const
    };
    mocks.textEditPublicationIdentity.mockReturnValue(identity);

    await expect(applyBookEdit(job())).resolves.toMatchObject({ retryFollowUpOnRedelivery: true });

    expect(mocks.textEditPublicationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ identity, durableCompletionCommitted: true, memory: expect.any(Function) })
    );
    expect(mocks.adoptLegacyTextEditTail).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
  });

  it("adopts a legacy APPLIED operation before returning its replay tail", async () => {
    await expect(applyBookEdit(job())).resolves.toMatchObject({ retryFollowUpOnRedelivery: true });

    expect(mocks.adoptLegacyTextEditTail).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        operationId: "op-1",
        planVersionId: "plan-1",
        fallbackStatus: "REVIEW_REQUIRED"
      })
    );
    expect(mocks.textEditPublicationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ durableCompletionCommitted: false })
    );
  });

  it("stands down when a legacy publication no longer owns the manuscript", async () => {
    mocks.adoptLegacyTextEditTail.mockResolvedValueOnce(null);

    await expect(applyBookEdit(job())).resolves.toEqual({});

    expect(mocks.textEditPublicationCompletion).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    // The delivery still owes the APPLIED-tail completion, or the operation
    // keeps a live lease nobody is working under and every redelivery waits
    // out its expiry before finding the same answer.
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("op-1", expect.any(String));
  });

  it("reads the follow-up checkpoint from the row as it stands under the claim", async () => {
    // The first read happens before the lease wait, which blocks for as long as
    // the winning delivery holds the operation — and that delivery is the one
    // that writes the checkpoint and rewrites `affectedPageIndexes`.
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", kind: "PAGE_REWRITE", status: "ACTIVE", classifier: {} })
      .mockResolvedValueOnce({
        classifier: { textEditFollowUp: { completedSteps: [] } },
        affectedPageIndexes: [4]
      });

    await applyBookEdit(job());

    expect(mocks.textEditPublicationIdentity).toHaveBeenCalledWith(
      { textEditFollowUp: { completedSteps: [] } },
      { projectId: "project-1", operationId: "op-1" }
    );
  });

  it("stands down on a no-op marker that landed while this delivery waited for the lease", async () => {
    // The entry read is taken before the lease wait, and that wait blocks for
    // as long as the winning delivery holds the operation — so the settlement
    // that marks the edit a delivered no-op is invisible to the copy this
    // delivery carried in.
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", kind: "PAGE_REWRITE", status: "ACTIVE", classifier: {} })
      .mockResolvedValueOnce({
        classifier: { textExactSkipped: true, skippedPageIndexes: [1] },
        affectedPageIndexes: []
      });

    await expect(applyBookEdit(job())).resolves.toEqual({});

    expect(mocks.adoptLegacyTextEditTail).not.toHaveBeenCalled();
    expect(mocks.claimAppliedEditPublication).not.toHaveBeenCalled();
    expect(mocks.textEditPublicationCompletion).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    // It still owes the APPLIED-tail lease completion, or the operation keeps a
    // live lease nobody is working under.
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("op-1", expect.any(String));
  });

  it("never falls through into drafting after standing down from the APPLIED tail", async () => {
    const lostLease = new Error("lease replaced by a live delivery");
    lostLease.name = "StructuralPageLeaseLostError";
    mocks.adoptLegacyTextEditTail.mockRejectedValue(lostLease);
    // The winner finished, so this delivery owns nothing at all — and its
    // heartbeat is already stopped, which makes every later ownership barrier
    // a no-op.
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("completed");

    await expect(applyBookEdit(job())).resolves.toEqual({});

    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.publishTextEditManuscript).not.toHaveBeenCalled();
  });

  it("retains no-settlement behavior when a live owner wins the APPLIED-tail lease race", async () => {
    const lostLease = new Error("lease replaced by a live delivery");
    lostLease.name = "StructuralPageLeaseLostError";
    mocks.adoptLegacyTextEditTail.mockRejectedValue(lostLease);
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("abandoned");

    await expect(applyBookEdit(job())).rejects.toMatchObject({ name: "UnownedTextEditDeliveryError" });

    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("op-1");
  });
});

const targetPage = {
  id: "page-1",
  index: 1,
  title: "Page 1",
  markdown: "Original.",
  summary: "Summary.",
  imagePrompt: null,
  storyDelta: null,
  revision: 1,
  qualityReport: null,
  chapterId: null,
  chapter: null
};

function prepareDraftDelivery(): void {
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
    id: "op-1",
    kind: "PAGE_REWRITE",
    status: "ACTIVE",
    classifier: {}
  });
  mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
  mocks.prisma.page.findMany.mockResolvedValue([targetPage]);
  mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...targetPage,
    ...data,
    revision: 2
  }));
  mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "draft" });
  mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "ACTIVE", classifier: {} });
}

const exactNoopJob = () =>
  job({
    request: "Replace rabbit with fly",
    affectedPageIndexes: [1],
    exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
    mode: "exact"
  });

function prepareExactNoopDelivery(): void {
  prepareDraftDelivery();
  mocks.prisma.page.findMany.mockResolvedValue([{ ...targetPage, markdown: "The literal is gone." }]);
  mocks.prisma.pageEditSnapshot.findMany.mockResolvedValue([]);
  mocks.prisma.pageEditSnapshot.createManyAndReturn.mockResolvedValue([
    { id: "snap-page-1", pageId: "page-1", pageIndex: 1, revisionAfter: null }
  ]);
}

describe("applyBookEdit exact all-skipped settlement", () => {
  it("refunds and marks the first all-skipped delivery without running the publication tail", async () => {
    prepareExactNoopDelivery();
    mocks.settleSkippedTextEditLeaseTx.mockResolvedValue({
      classifier: { preservedClassifierField: "keep" }
    });

    await expect(applyBookEdit(exactNoopJob())).resolves.toEqual({});

    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(
      exactNoopJob(),
      expect.stringContaining("literal disappeared")
    );
    expect(mocks.heartbeatAssertHeld.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.refundSkippedEditOperation.mock.invocationCallOrder[0]!
    );
    expect(mocks.refundSkippedEditOperation.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.settleSkippedTextEditLeaseTx.mock.invocationCallOrder[0]!
    );
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: {
        classifier: {
          preservedClassifierField: "keep",
          skippedPageIndexes: [1],
          textExactSkipped: true
        }
      }
    });
    expect(mocks.prisma.pageEditSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { operationId: "op-1" }
    });
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.prisma, "project-1", "op-1", "REVIEW_REQUIRED", "ACTIVE"
    );
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.completeTextEditLease).not.toHaveBeenCalled();
    expect(
      mocks.prisma.project.update.mock.calls.filter(
        (call) => (call[0] as { data: { contentRevision?: { increment?: number } } }).data.contentRevision?.increment === 1
      )
    ).toHaveLength(0);
  });

  it("waits and stands down when the post-refund lease CAS loses to another delivery", async () => {
    prepareExactNoopDelivery();
    mocks.settleSkippedTextEditLeaseTx.mockResolvedValue(null);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(applyBookEdit(exactNoopJob())).resolves.toEqual({});

    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledTimes(1);
    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("op-1");
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.pageEditSnapshot.deleteMany).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("leaves the operation ACTIVE for normal failure settlement when the refund fails", async () => {
    prepareExactNoopDelivery();
    mocks.refundSkippedEditOperation.mockRejectedValue(new Error("ledger unavailable"));

    await expect(applyBookEdit(exactNoopJob())).rejects.toThrow("ledger unavailable");

    expect(mocks.settleSkippedTextEditLeaseTx).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.pageEditSnapshot.deleteMany).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("lets a concurrent loser observe completed settlement without refunding or publishing", async () => {
    prepareExactNoopDelivery();
    mocks.waitForTextEditLease.mockResolvedValue({ outcome: "completed" });

    await expect(applyBookEdit(exactNoopJob())).resolves.toEqual({});

    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });
});

describe("applyBookEdit overlapping delivery lease", () => {
  it("returns durable completion immediately after the publication seam commits", async () => {
    prepareDraftDelivery();
    mocks.prisma.pageEditSnapshot.findMany.mockResolvedValue([]);
    mocks.prisma.pageEditSnapshot.createManyAndReturn.mockResolvedValue([
      { id: "snap-page-1", pageId: "page-1", revisionAfter: null }
    ]);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 1",
      markdown: "Durably rewritten.",
      summary: "New summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    });
    await expect(applyBookEdit(job({ generationJobId: "generation-job-1" }))).resolves.toMatchObject({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true
    });

    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({
        completion: expect.objectContaining({ generationJobId: "generation-job-1" }),
        pages: [expect.objectContaining({ markdownAfter: "Durably rewritten." })]
      })
    );
    expect(mocks.textEditPublicationCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("prepares optional memory before entering the publication seam", async () => {
    prepareDraftDelivery();
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 1",
      markdown: "Published with prepared memory.",
      summary: "New summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    });
    mocks.strategyUsesSemanticMemory.mockReturnValue(true);
    const embedding = { vectorLiteral: "[0.1]", error: null };
    mocks.prepareEmbedding.mockResolvedValue(embedding);

    await applyBookEdit(job());

    expect(mocks.prepareEmbedding).toHaveBeenCalledWith("New summary.", expect.anything());
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({ pages: [expect.objectContaining({ preparedEmbedding: embedding })] })
    );
    expect(mocks.prepareEmbedding.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publishTextEditManuscript.mock.invocationCallOrder[0]!
    );
  });

  it("keeps a live overlapping delivery out of the rewrite", async () => {
    prepareDraftDelivery();
    let storedSnapshot: Record<string, unknown> | undefined;
    mocks.prisma.pageEditSnapshot.findMany.mockImplementation(async () => (storedSnapshot ? [storedSnapshot] : []));
    mocks.prisma.pageEditSnapshot.createManyAndReturn.mockImplementation(
      async ({ data }: { data: Array<Record<string, unknown>> }) => {
        storedSnapshot = { ...data[0], id: "snap-page-1", revisionAfter: null };
        return [storedSnapshot];
      }
    );
    let releaseFirstRewrite!: () => void;
    const firstRewrite = new Promise<void>((resolve) => {
      releaseFirstRewrite = resolve;
    });
    const rewritten = {
      title: "Page 1",
      markdown: "Rewritten once.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    };
    mocks.rewritePageForUserRequest
      .mockImplementationOnce(async () => {
        await firstRewrite;
        return rewritten;
      })
      .mockResolvedValue(rewritten);
    let releaseWaitingDelivery!: () => void;
    const waitingDelivery = new Promise<{ outcome: "completed" }>((resolve) => {
      releaseWaitingDelivery = () => resolve({ outcome: "completed" });
    });
    mocks.waitForTextEditLease
      .mockResolvedValueOnce({ outcome: "acquired", phase: "draft" })
      .mockImplementationOnce(() => waitingDelivery);
    const winner = applyBookEdit(job());
    await vi.waitFor(() => expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1));
    const overlap = applyBookEdit(job());
    await vi.waitFor(() => expect(mocks.waitForTextEditLease).toHaveBeenCalledTimes(2));
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1);
    releaseFirstRewrite();
    await winner;
    releaseWaitingDelivery();
    await overlap;

    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1);
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(1);
  });

  it("lets an expired-lease replacement publish while the stalled owner stands down", async () => {
    prepareDraftDelivery();
    let committedPublications = 0;
    let storedSnapshot: Record<string, unknown> | undefined;
    mocks.prisma.pageEditSnapshot.findMany.mockImplementation(async () => (storedSnapshot ? [storedSnapshot] : []));
    mocks.prisma.pageEditSnapshot.createManyAndReturn.mockImplementation(
      async ({ data }: { data: Array<Record<string, unknown>> }) => {
        storedSnapshot = { ...data[0], id: "snap-page-1", revisionAfter: null };
        return [storedSnapshot];
      }
    );
    let releaseStalledRewrite!: () => void;
    const stalledRewrite = new Promise<void>((resolve) => {
      releaseStalledRewrite = resolve;
    });
    const rewritten = {
      title: "Page 1",
      markdown: "Replacement keeper.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    };
    mocks.rewritePageForUserRequest
      .mockImplementationOnce(async () => {
        await stalledRewrite;
        return rewritten;
      })
      .mockResolvedValue(rewritten);
    let staleOwner: string | undefined;
    let replacementStarted = false;
    mocks.waitForTextEditLease
      .mockResolvedValueOnce({ outcome: "acquired", phase: "draft" })
      .mockImplementationOnce(async () => {
        replacementStarted = true;
        return { outcome: "acquired", phase: "draft" };
      });
    mocks.assertTextEditLeaseTx.mockImplementation(async (_tx, _operationId, ownerToken) => {
      staleOwner ??= ownerToken;
      if (replacementStarted && ownerToken === staleOwner) {
        const lost = new Error("lease replaced");
        lost.name = "StructuralPageLeaseLostError";
        throw lost;
      }
      return { status: "ACTIVE", classifier: {} };
    });
    mocks.publishTextEditManuscript.mockImplementation(async (options) => {
      await mocks.assertTextEditLeaseTx(mocks.prisma, "op-1", options.ownerToken);
      committedPublications += 1;
      return {
        identity: {
          projectId: "project-1",
          operationId: "op-1",
          planVersionId: "plan-1",
          publicationRevision: 8,
          fallbackStatus: "REVIEW_REQUIRED"
        },
        memory: []
      };
    });

    const stalled = applyBookEdit(job());
    await vi.waitFor(() => expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1));
    await applyBookEdit(job());
    releaseStalledRewrite();
    await stalled;

    // A stale provider call may finish, but only the replacement publishes.
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(2);
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(2);
    expect(committedPublications).toBe(1);
    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("op-1");
  });
});
