import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), update: vi.fn() },
    pageEditSnapshot: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
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
  restoreEditProjectStatus: vi.fn(async () => true)
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {}, pageScope: vi.fn() }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  refundSkippedEditOperation: mocks.refundSkippedEditOperation
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
vi.mock("./replanBook.js", () => ({ locallyPatchedPage: vi.fn(), rewritePageForUserRequest: mocks.rewritePageForUserRequest }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, bookPlanSchema: { parse: () => ({}) }, createProviders: () => ({}) };
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

  it("recognizes the exact-text no-op marker again under the APPLIED tail lock", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      kind: "PAGE_REWRITE",
      status: "QUEUED",
      classifier: {}
    });
    mocks.assertTextEditLeaseTx.mockResolvedValue({
      status: "APPLIED",
      classifier: { textExactSkipped: true, skippedPageIndexes: [1] }
    });

    await applyBookEdit(job());

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.completeTextEditLease).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["queue-time fallback", "REVIEW_REQUIRED", "compile"],
    ["owned publication window", "EDITING", "waiting"]
  ] as const)(
    "claims the %s before replaying the export tail",
    async (_label, currentStatus, outcome) => {
      let transactionOpen = false;
      mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await run(mocks.prisma);
        } finally {
          transactionOpen = false;
        }
      });
      mocks.prisma.project.updateMany.mockImplementation(async ({ where }: { where: { status: { in: string[] } } }) => {
        expect(transactionOpen).toBe(true);
        return { count: where.status.in.includes(currentStatus) ? 1 : 0 };
      });
      mocks.invalidateProjectExports.mockImplementationOnce(async () => {
        expect(transactionOpen).toBe(true);
      });
      mocks.maybeEnqueueCompile.mockResolvedValue(outcome);
      await applyBookEdit(job());

      expect(mocks.prisma.bookEditOperation.updateMany).not.toHaveBeenCalled();
      expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
      expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
      expect(mocks.prisma.pageEditSnapshot.create).not.toHaveBeenCalled();
      expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
      expect(mocks.prisma.project.update).not.toHaveBeenCalled();
      expect(mocks.claimAppliedEditPublication).toHaveBeenCalledWith(
        mocks.prisma, "project-1", "op-1", "REVIEW_REQUIRED"
      );
      expect(mocks.claimAppliedEditPublication.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.assertTextEditLeaseTx.mock.invocationCallOrder[0]!
      );
      expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
      expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", { skipFinalReview: true });
    }
  );

  it.each([
    "the project lifecycle moved",
    "the manuscript revision moved",
    "a later operation owns publication"
  ])(
    "terminalizes the old APPLIED tail without touching exports when %s",
    async () => {
      mocks.claimAppliedEditPublication.mockResolvedValue(false);

      await expect(applyBookEdit(job())).resolves.toBeUndefined();

      expect(mocks.claimAppliedEditPublication).toHaveBeenCalledTimes(1);
      expect(mocks.prisma.project.update).not.toHaveBeenCalled();
      expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
      expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
      expect(mocks.completeTextEditLease).toHaveBeenCalledWith("op-1", expect.any(String));
    }
  );

  it("retains no-settlement behavior when a live owner wins the APPLIED-tail lease race", async () => {
    const lostLease = new Error("lease replaced by a live delivery");
    lostLease.name = "StructuralPageLeaseLostError";
    mocks.assertTextEditLeaseTx.mockRejectedValue(lostLease);
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("abandoned");

    await expect(applyBookEdit(job())).rejects.toMatchObject({ name: "UnownedTextEditDeliveryError" });

    expect(mocks.claimAppliedEditPublication).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.completeTextEditLease).not.toHaveBeenCalled();
    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("op-1");
  });

  it.each(["not-ready", "throw"])("restores the stamped status when compile handoff ends in %s", async (outcome) => {
    let logged: ReturnType<typeof vi.spyOn> | undefined;
    if (outcome === "throw") {
      mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));
      logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    } else {
      mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");
    }

    await applyBookEdit(job());

    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.prisma, "project-1", "op-1", "REVIEW_REQUIRED"
    );
    logged?.mockRestore();
  });

  it("restores the stamped status when no plan can be handed to a compile", async () => {
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: null });

    await applyBookEdit(job({ planId: undefined }));

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.prisma, "project-1", "op-1", "REVIEW_REQUIRED"
    );
  });

  it("replays the APPLIED tail when the durable claim finds another delivery already settled", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", kind: "PAGE_REWRITE", status: "QUEUED" });
    mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "tail" });

    await applyBookEdit(job());

    expect(mocks.prisma.bookEditOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
  });

  it("keeps an APPLIED-tail delivery successful when lease completion bookkeeping throws", async () => {
    const completionError = new Error("database response lost");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.completeTextEditLease.mockRejectedValue(completionError);
    // A thrown completion write has an unknown outcome, not the explicit
    // ownership-transfer signal represented by a returned false.
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("abandoned");

    await expect(applyBookEdit(job({ generationJobId: "generation-job-1" }))).resolves.toBeUndefined();

    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
    expect(mocks.waitForTextEditLeaseCompletion).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("Text edit lease completion failed after durable compile handoff", {
      event: "generation.text_edit_lease_completion_failed",
      projectId: "project-1",
      operationId: "op-1",
      generationJobId: "generation-job-1",
      phase: "applied-tail",
      recovery: "applied-tail-replay",
      error: completionError
    });
    logged.mockRestore();
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
  mocks.prisma.pageEditSnapshot.create.mockResolvedValue({
    id: "snap-page-1",
    pageId: "page-1",
    pageIndex: 1,
    revisionAfter: null
  });
}

describe("applyBookEdit exact all-skipped settlement", () => {
  it("refunds and marks the first all-skipped delivery without running the publication tail", async () => {
    prepareExactNoopDelivery();
    mocks.settleSkippedTextEditLeaseTx.mockResolvedValue({
      classifier: { preservedClassifierField: "keep" }
    });

    await expect(applyBookEdit(exactNoopJob())).resolves.toBeUndefined();

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

    await expect(applyBookEdit(exactNoopJob())).resolves.toBeUndefined();

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

    await expect(applyBookEdit(exactNoopJob())).resolves.toBeUndefined();

    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });
});

describe("applyBookEdit overlapping delivery lease", () => {
  it("keeps a newly drafted delivery successful when lease completion bookkeeping throws", async () => {
    prepareDraftDelivery();
    mocks.prisma.pageEditSnapshot.findMany.mockResolvedValue([]);
    mocks.prisma.pageEditSnapshot.create.mockResolvedValue({
      id: "snap-page-1",
      pageId: "page-1",
      revisionAfter: null
    });
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 1",
      markdown: "Durably rewritten.",
      summary: "New summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    });
    const completionError = new Error("connection dropped after update");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.completeTextEditLease.mockRejectedValue(completionError);
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("abandoned");

    await expect(applyBookEdit(job({ generationJobId: "generation-job-1" }))).resolves.toBeUndefined();

    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
    expect(mocks.waitForTextEditLeaseCompletion).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("Text edit lease completion failed after durable compile handoff", {
      event: "generation.text_edit_lease_completion_failed",
      projectId: "project-1",
      operationId: "op-1",
      generationJobId: "generation-job-1",
      phase: "draft-success",
      recovery: "applied-tail-replay",
      error: completionError
    });
    logged.mockRestore();
  });

  it.each(["embedding", "story"] as const)(
    "commits the fenced page when the %s SQL write aborts its best-effort block",
    async (failedMemory) => {
      prepareDraftDelivery();
      mocks.rewritePageForUserRequest.mockResolvedValue({
        title: "Page 1",
        markdown: "Published despite optional memory.",
        summary: "New summary.",
        continuityNotes: [],
        qualityReport: { approved: true }
      });
      mocks.prisma.pageEditSnapshot.findMany.mockResolvedValue([]);
      mocks.prisma.pageEditSnapshot.create.mockResolvedValue({
        id: "snap-page-1",
        pageId: "page-1",
        revisionAfter: null
      });
      mocks.strategyUsesSemanticMemory.mockReturnValue(true);
      mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1]", error: null });
      mocks.keeperStoryExtractForSave.mockResolvedValue({ storyDelta: {}, contradictions: [] });

      const aborted = new Error("current transaction is aborted (25P02)");
      const failSqlAndSwallow = async (client: { $executeRawUnsafe: (sql: string) => Promise<unknown> }) => {
        await client.$executeRawUnsafe("FAIL OPTIONAL MEMORY").catch(() => undefined);
        return null;
      };
      if (failedMemory === "embedding") {
        mocks.writePreparedEmbedding.mockImplementation(async (_target, _prepared, client) => {
          await failSqlAndSwallow(client);
          return "degraded";
        });
      } else {
        mocks.persistStoryExtract.mockImplementation(async ({ client }) => failSqlAndSwallow(client));
      }

      const committedMarkdown: string[] = [];
      mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => {
        let transactionAborted = false;
        const stagedMarkdown: string[] = [];
        const tx = {
          ...mocks.prisma,
          page: {
            ...mocks.prisma.page,
            update: vi.fn(async (args: { data: { markdown?: string } }) => {
              const saved = await mocks.prisma.page.update(args);
              if (args.data.markdown) stagedMarkdown.push(args.data.markdown);
              return saved;
            })
          },
          $executeRawUnsafe: vi.fn(async (sql: string) => {
            if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
              transactionAborted = false;
              return 0;
            }
            if (transactionAborted) throw aborted;
            if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE SAVEPOINT")) return 0;
            transactionAborted = true;
            throw new Error("optional memory SQL failed");
          })
        };
        const result = await run(tx as typeof mocks.prisma);
        if (transactionAborted) throw aborted;
        committedMarkdown.push(...stagedMarkdown);
        return result;
      });

      await expect(applyBookEdit(job())).resolves.toBeUndefined();

      expect(committedMarkdown).toContain("Published despite optional memory.");
      expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
      );
    }
  );

  it("keeps a live overlapping delivery out of the rewrite", async () => {
    prepareDraftDelivery();
    let storedSnapshot: Record<string, unknown> | undefined;
    mocks.prisma.pageEditSnapshot.findMany.mockImplementation(async () => (storedSnapshot ? [storedSnapshot] : []));
    mocks.prisma.pageEditSnapshot.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      storedSnapshot = { ...data, id: "snap-page-1", revisionAfter: null };
      return storedSnapshot;
    });
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
    mocks.completeTextEditLease.mockImplementationOnce(async () => {
      releaseWaitingDelivery();
      return true;
    });

    const winner = applyBookEdit(job());
    await vi.waitFor(() => expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1));
    const overlap = applyBookEdit(job());
    await vi.waitFor(() => expect(mocks.waitForTextEditLease).toHaveBeenCalledTimes(2));
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1);
    releaseFirstRewrite();
    await Promise.all([winner, overlap]);

    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledTimes(1);
    expect(
      mocks.prisma.project.update.mock.calls.filter(
        (call) => (call[0] as { data: { contentRevision?: { increment?: number } } }).data.contentRevision?.increment === 1
      )
    ).toHaveLength(1);
  });

  it("lets an expired-lease replacement publish while the stalled owner stands down", async () => {
    prepareDraftDelivery();
    let storedSnapshot: Record<string, unknown> | undefined;
    mocks.prisma.pageEditSnapshot.findMany.mockImplementation(async () => (storedSnapshot ? [storedSnapshot] : []));
    mocks.prisma.pageEditSnapshot.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      storedSnapshot = { ...data, id: "snap-page-1", revisionAfter: null };
      return storedSnapshot;
    });
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

    const stalled = applyBookEdit(job());
    await vi.waitFor(() => expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1));
    await applyBookEdit(job());
    releaseStalledRewrite();
    await stalled;

    // A stale provider call may finish, but only the replacement publishes.
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.pageEditSnapshot.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledTimes(1);
    expect(
      mocks.prisma.project.update.mock.calls.filter(
        (call) => (call[0] as { data: { contentRevision?: { increment?: number } } }).data.contentRevision?.increment === 1
      )
    ).toHaveLength(1);
    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("op-1");
  });
});
