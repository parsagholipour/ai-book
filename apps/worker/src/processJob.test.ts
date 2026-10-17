import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  staleGenerationJobReason: vi.fn(),
  cancelStaleGenerationJob: vi.fn(),
  markActive: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  markMalformedJobFailed: vi.fn(),
  markRecovering: vi.fn(),
  markStopped: vi.fn(),
  hasStoppedGenerationJob: vi.fn(),
  shouldRecoverJobAttempt: vi.fn(),
  shouldBypassConfiguredRetries: vi.fn(),
  maybeCompileAfterCompletedJob: vi.fn(),
  maybeCompileAfterFailedJob: vi.fn(),
  runLoggerAppend: vi.fn(),
  planBook: vi.fn(),
  compileExport: vi.fn(),
  continueBook: vi.fn(),
  generateBook: vi.fn(),
  stagedReplanSuccessorOperationId: vi.fn(),
  generatePage: vi.fn(),
  generateImage: vi.fn(),
  applyBookEdit: vi.fn(),
  writingAssist: vi.fn(),
  generateCharacterPortrait: vi.fn(),
  findProject: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: { project: { findUnique: mocks.findProject } }, Prisma: {} }));
vi.mock("./runtime/jobLifecycle.js", () => ({
  cancelStaleGenerationJob: mocks.cancelStaleGenerationJob,
  hasStoppedGenerationJob: mocks.hasStoppedGenerationJob,
  jobMaxAttempts: () => 1,
  markActive: mocks.markActive,
  markCompleted: mocks.markCompleted,
  markFailed: mocks.markFailed,
  markMalformedJobFailed: mocks.markMalformedJobFailed,
  markRecovering: mocks.markRecovering,
  markStopped: mocks.markStopped,
  shouldBypassConfiguredRetries: mocks.shouldBypassConfiguredRetries,
  shouldRecoverJobAttempt: mocks.shouldRecoverJobAttempt,
  staleGenerationJobReason: mocks.staleGenerationJobReason
}));
vi.mock("./runtime/dispatch.js", () => ({
  maybeCompileAfterCompletedJob: mocks.maybeCompileAfterCompletedJob,
  maybeCompileAfterFailedJob: mocks.maybeCompileAfterFailedJob
}));
vi.mock("./providers/runLogging.js", () => ({
  createRunLogger: () => ({ append: mocks.runLoggerAppend }),
  providerConfigSnapshot: () => ({})
}));
vi.mock("./handlers/applyBookEdit.js", () => ({ applyBookEdit: mocks.applyBookEdit }));
vi.mock("./handlers/characters.js", () => ({ buildCharacterPersona: vi.fn(), prepareCharacterCandidates: vi.fn() }));
vi.mock("./handlers/compileExport.js", () => ({ compileExport: mocks.compileExport }));
vi.mock("./handlers/continueBook.js", () => ({ continueBook: mocks.continueBook }));
vi.mock("./handlers/generateAudiobook.js", () => ({ generateAudiobook: vi.fn() }));
vi.mock("./handlers/characterPortrait.js", () => ({ generateCharacterPortrait: mocks.generateCharacterPortrait }));
vi.mock("./handlers/generateBook.js", () => ({
  generateBook: mocks.generateBook,
  stagedReplanSuccessorOperationId: mocks.stagedReplanSuccessorOperationId
}));
vi.mock("./handlers/generateImage.js", () => ({ generateImage: mocks.generateImage }));
vi.mock("./handlers/generatePage.js", () => ({ generatePage: mocks.generatePage }));
vi.mock("./handlers/importBook.js", () => ({ importBook: vi.fn() }));
vi.mock("./handlers/planning.js", () => ({ planBook: mocks.planBook, revisePlan: vi.fn() }));
vi.mock("./handlers/replanBook.js", () => ({ replanBook: vi.fn() }));
vi.mock("./handlers/writingAssist.js", () => ({ writingAssist: mocks.writingAssist }));

import { processWorkerJob } from "./processJob.js";
import { currentProviderSpendUserId } from "./runtime/providerSpendUser.js";
import {
  StopRequestedError,
  StructuralRollbackRedeliveryError,
  UnownedReplanDeliveryError,
  UnownedStructuralDeliveryError,
  UnownedTextEditDeliveryError
} from "./runtime/jobTypes.js";

function job(name: string, data: Record<string, unknown> = {}): Job {
  const nameSpecific =
    name === "generate-page"
      ? { pageId: "page-1" }
      : name === "apply-book-edit"
        ? { operationId: "operation-1", request: "Edit this", affectedPageIndexes: [1] }
        : name === "continue-book"
          ? { operationId: "operation-1", request: "Continue this" }
        : {};
  return {
    id: "bull-1",
    name,
    data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...nameSpecific, ...data },
    attemptsMade: 0,
    opts: { attempts: 1 }
  } as unknown as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.staleGenerationJobReason.mockImplementation(async () => {
    mocks.order.push("stale-check");
    return null;
  });
  mocks.markActive.mockImplementation(async () => {
    mocks.order.push("mark-active");
    return true;
  });
  mocks.markCompleted.mockResolvedValue(true);
  mocks.hasStoppedGenerationJob.mockResolvedValue(false);
  mocks.shouldRecoverJobAttempt.mockReturnValue(false);
  mocks.shouldBypassConfiguredRetries.mockReturnValue(false);
  mocks.runLoggerAppend.mockResolvedValue(undefined);
  mocks.generatePage.mockImplementation(async () => {
    mocks.order.push("handler");
  });
  // The staged successor is the ordinary shape; the pre-staging one is pinned
  // below, because only it may not be replayed through the destructive path.
  mocks.stagedReplanSuccessorOperationId.mockImplementation(
    async (job: Job) => (job.data as { replanOperationId?: string }).replanOperationId ?? null
  );
  mocks.planBook.mockResolvedValue(undefined);
  mocks.compileExport.mockResolvedValue({});
  mocks.continueBook.mockResolvedValue({});
  mocks.maybeCompileAfterCompletedJob.mockResolvedValue(undefined);
  mocks.maybeCompileAfterFailedJob.mockResolvedValue(null);
});

describe("processWorkerJob ordering", () => {
  it("runs the stale check before claiming the row ACTIVE", async () => {
    // The old entry point flipped the row ACTIVE first, which overwrote the
    // CANCELED status the stale check reads — refunded work then ran anyway.
    await processWorkerJob(job("generate-page"));

    expect(mocks.order).toEqual(["stale-check", "mark-active", "handler"]);
  });

  it("dispatches an admitted staged replan successor instead of canceling it", async () => {
    const staged = job("generate-book", { replanOperationId: "operation-1", planId: "plan-staged" });

    await processWorkerJob(staged);

    expect(mocks.cancelStaleGenerationJob).not.toHaveBeenCalled();
    expect(mocks.generateBook).toHaveBeenCalledWith(staged);
  });

  it("cancels a stale job without ever claiming it or running its handler", async () => {
    mocks.staleGenerationJobReason.mockResolvedValue("The durable job was canceled before it could run.");

    await processWorkerJob(job("generate-page"));

    expect(mocks.cancelStaleGenerationJob).toHaveBeenCalled();
    expect(mocks.markActive).not.toHaveBeenCalled();
    expect(mocks.generatePage).not.toHaveBeenCalled();
  });

  it("never re-runs a pre-staging replan successor whose row is already COMPLETED", async () => {
    // `generateBook` answers this question the same way and would fall through
    // to the execution-mode switch, which deletes every page, chapter and
    // illustration before it rewrites a book the reader already paid for.
    mocks.markActive.mockResolvedValue(false);
    mocks.stagedReplanSuccessorOperationId.mockResolvedValue(null);
    const legacyReplan = job("generate-book", { replanOperationId: "operation-1" });

    await processWorkerJob(legacyReplan);

    expect(mocks.generateBook).not.toHaveBeenCalled();
    expect(mocks.markCompleted).toHaveBeenCalledWith(legacyReplan);
    expect(mocks.maybeCompileAfterCompletedJob).toHaveBeenCalled();
  });

  it("keeps the generic fan-in for a pre-staging replan successor that ran the ordinary path", async () => {
    mocks.stagedReplanSuccessorOperationId.mockResolvedValue(null);
    mocks.generateBook.mockResolvedValue(undefined);

    await processWorkerJob(job("generate-book", { replanOperationId: "operation-1" }));

    expect(mocks.generateBook).toHaveBeenCalled();
    expect(mocks.maybeCompileAfterCompletedJob).toHaveBeenCalled();
  });

  it("settles the attempt of a completed image apply whose replay returns no completion", async () => {
    // applyImageInsertion/applyImageLayout publish outside
    // claimDurableEditCompletionTx and return void, so this markCompleted is
    // the only thing that ever marks their paid attempt SUCCEEDED.
    mocks.markActive.mockResolvedValue(false);
    mocks.applyBookEdit.mockResolvedValue(undefined);
    const imageApply = job("apply-book-edit", { attemptId: "attempt-1" });

    await processWorkerJob(imageApply);

    expect(mocks.applyBookEdit).toHaveBeenCalledWith(imageApply);
    expect(mocks.markCompleted).toHaveBeenCalledWith(imageApply);
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("replays success settlement and fan-in when the row is already COMPLETED", async () => {
    // A stalled delivery redelivered a finished job: the work must not run
    // twice, but the compile trigger is idempotent and may be what a crash
    // between markCompleted and the fan-in lost.
    mocks.markActive.mockResolvedValue(false);

    await processWorkerJob(job("generate-page"));

    expect(mocks.generatePage).not.toHaveBeenCalled();
    expect(mocks.markCompleted).toHaveBeenCalled();
    expect(mocks.maybeCompileAfterCompletedJob).toHaveBeenCalled();
  });
});

describe("processWorkerJob completion", () => {
  it("completes a terminally superseded APPLIED text-edit tail", async () => {
    const editJob = job("apply-book-edit", { operationId: "op-old" });

    await expect(processWorkerJob(editJob)).resolves.toBeUndefined();

    expect(mocks.applyBookEdit).toHaveBeenCalledWith(editJob);
    expect(mocks.markCompleted).toHaveBeenCalledWith(editJob, undefined);
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
  });

  it("never converts a post-completion failure into a failed, refunded run", async () => {
    // This exact shape used to flip a COMPLETED job to FAILED, refund the
    // finished book, and mark the project FAILED.
    mocks.maybeCompileAfterCompletedJob.mockRejectedValue(new Error("db blip after completion"));

    await expect(processWorkerJob(job("generate-page"))).resolves.toBeUndefined();

    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
  });

  it("skips follow-ups when a concurrent stop won the completion write", async () => {
    mocks.planBook.mockResolvedValue({ afterJobCompleted: vi.fn() });
    mocks.markCompleted.mockResolvedValue(false);

    await processWorkerJob(job("plan-book"));

    const completion = await mocks.planBook.mock.results[0]?.value;
    expect(completion.afterJobCompleted).not.toHaveBeenCalled();
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
  });

  it("runs a completion's follow-up after the row is COMPLETED", async () => {
    const afterJobCompleted = vi.fn();
    mocks.planBook.mockResolvedValue({ afterJobCompleted });

    await processWorkerJob(job("plan-book"));

    expect(afterJobCompleted).toHaveBeenCalled();
  });

  it("passes a compile successor handoff through the durable completion seam", async () => {
    const afterJobCompleted = vi.fn();
    mocks.compileExport.mockResolvedValue({
      lifecycleSettlement: "defer-to-successor",
      afterJobCompleted
    });
    const compileJob = job("compile-export", { attemptId: "attempt-1", operationId: "operation-1" });

    await processWorkerJob(compileJob);

    expect(mocks.markCompleted).toHaveBeenCalledWith(compileJob, "defer-to-successor");
    expect(afterJobCompleted).toHaveBeenCalled();
  });

  it("keeps a published export successful when character fan-out enqueue fails", async () => {
    const enqueueCharacters = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    mocks.compileExport.mockResolvedValue({ afterJobCompleted: enqueueCharacters });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      processWorkerJob(job("compile-export", { attemptId: "attempt-1", operationId: "operation-1" }))
    ).resolves.toBeUndefined();

    expect(mocks.markCompleted).toHaveBeenCalled();
    expect(enqueueCharacters).toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.follow_up_failed",
      expect.objectContaining({ error: expect.anything() })
    );
    logged.mockRestore();
  });

  it("retries a delivered continuation tail without entering failure or refund routing", async () => {
    const enqueueExport = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    mocks.continueBook.mockResolvedValue({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: enqueueExport
    });
    const continuationJob = job("continue-book");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processWorkerJob(continuationJob)).rejects.toThrow("queue unavailable");

    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(enqueueExport).toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.follow_up_failed",
      expect.objectContaining({ error: expect.anything() })
    );
    logged.mockRestore();
  });

  it("reconstructs a completed continuation's missing tail without reopening its lifecycle", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    mocks.markActive.mockResolvedValue(false);
    mocks.continueBook.mockResolvedValue({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: followUp
    });
    const continuationJob = job("continue-book");

    await expect(processWorkerJob(continuationJob)).resolves.toBeUndefined();

    expect(mocks.continueBook).toHaveBeenCalledWith(continuationJob);
    expect(followUp).toHaveBeenCalledTimes(1);
    // Once, for the settlement half of the crash this branch replays — never
    // a second write that could reopen the lifecycle the tail runs under.
    expect(mocks.markCompleted).toHaveBeenCalledTimes(1);
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
  });

  it("skips every tail and generic fan-in step when a completed continuation lease is settled", async () => {
    mocks.markActive.mockResolvedValue(false);
    mocks.continueBook.mockResolvedValue({});

    await expect(processWorkerJob(job("continue-book"))).resolves.toBeUndefined();

    expect(mocks.continueBook).toHaveBeenCalledTimes(1);
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("settles a published replan before a retryable tail failure without entering refund routing", async () => {
    const followUp = vi.fn().mockRejectedValue(new Error("asset service unavailable"));
    mocks.generateBook.mockResolvedValue({
      durableCompletionCommitted: true,
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: followUp
    });
    const replanJob = job("generate-book", { replanOperationId: "operation-1" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processWorkerJob(replanJob)).rejects.toThrow("asset service unavailable");

    expect(mocks.markCompleted).toHaveBeenCalledWith(replanJob, undefined);
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.follow_up_failed",
      expect.objectContaining({ error: expect.anything() })
    );
    logged.mockRestore();
  });

  it("replays a completed replan's missing tail without reopening its settled lifecycle", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    mocks.markActive.mockResolvedValue(false);
    mocks.generateBook.mockResolvedValue({
      durableCompletionCommitted: true,
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: followUp
    });
    const replanJob = job("generate-book", { replanOperationId: "operation-1" });

    await expect(processWorkerJob(replanJob)).resolves.toBeUndefined();

    expect(mocks.markCompleted).toHaveBeenCalledTimes(2);
    expect(mocks.generateBook).toHaveBeenCalledWith(replanJob);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
  });

  it("keeps durable export publication outside failure routing when bookkeeping throws", async () => {
    mocks.compileExport.mockResolvedValue({ durableCompletionCommitted: true });
    mocks.markCompleted.mockRejectedValue(new Error("completion write unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      processWorkerJob(job("compile-export", { attemptId: "attempt-1", operationId: "operation-1" }))
    ).resolves.toBeUndefined();

    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.completion_bookkeeping_failed",
      expect.objectContaining({ error: expect.anything() })
    );
    logged.mockRestore();
  });

  it.each([
    { label: "text edit", name: "apply-book-edit", data: {} },
    {
      label: "structural edit",
      name: "apply-book-edit",
      data: {
        structuralEdit: { action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 1 }
      }
    },
    { label: "continuation", name: "continue-book", data: {} }
  ])(
    "does not issue a second completion write after durable $label publication",
    async ({ name, data }) => {
      if (name === "apply-book-edit") {
        mocks.applyBookEdit.mockResolvedValue({
          durableCompletionCommitted: true,
          lifecycleCompletionCommitted: true
        });
      } else {
        mocks.continueBook.mockResolvedValue({
          durableCompletionCommitted: true,
          lifecycleCompletionCommitted: true
        });
      }
      mocks.markCompleted.mockRejectedValue(new Error("old post-publication completion failure"));

      await expect(processWorkerJob(job(name, data))).resolves.toBeUndefined();

      expect(mocks.markCompleted).not.toHaveBeenCalled();
      expect(mocks.markFailed).not.toHaveBeenCalled();
    }
  );

  it("does not mask completion errors for a compile that did not durably publish", async () => {
    mocks.compileExport.mockResolvedValue({});
    mocks.markCompleted.mockRejectedValue(new Error("completion write unavailable"));

    await expect(processWorkerJob(job("compile-export"))).rejects.toThrow("completion write unavailable");

    expect(mocks.markFailed).toHaveBeenCalled();
  });
});

describe("processWorkerJob writing assists", () => {
  const assist = () => job("writing-assist", { planId: undefined, assistId: "assist-1", attemptId: "attempt-1" });

  it("dispatches a writing assist to its handler and completes it, which commits its charge", async () => {
    mocks.writingAssist.mockResolvedValue(undefined);
    const delivered = assist();

    await processWorkerJob(delivered);

    expect(mocks.writingAssist).toHaveBeenCalledWith(delivered);
    expect(mocks.markCompleted).toHaveBeenCalledWith(delivered, undefined);
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("settles a failed writing assist through markFailed, which refunds it", async () => {
    mocks.writingAssist.mockRejectedValue(new Error("provider outage"));

    await expect(processWorkerJob(assist())).rejects.toThrow("provider outage");

    expect(mocks.markFailed).toHaveBeenCalledWith(expect.objectContaining({ name: "writing-assist" }), expect.any(Error));
    expect(mocks.markCompleted).not.toHaveBeenCalled();
  });
});

describe("processWorkerJob failure routing", () => {
  it("settles malformed data before lifecycle claims or handler side effects", async () => {
    const malformed = job("generate-page", { pageId: undefined });

    await expect(processWorkerJob(malformed)).rejects.toThrow(/pageId/);

    expect(mocks.markMalformedJobFailed).toHaveBeenCalledWith(malformed, expect.any(Error));
    expect(mocks.staleGenerationJobReason).not.toHaveBeenCalled();
    expect(mocks.markActive).not.toHaveBeenCalled();
    expect(mocks.generatePage).not.toHaveBeenCalled();
  });

  it("settles a handler failure through markFailed and rethrows", async () => {
    mocks.generatePage.mockRejectedValue(new Error("provider outage"));

    await expect(processWorkerJob(job("generate-page"))).rejects.toThrow("provider outage");

    expect(mocks.markFailed).toHaveBeenCalled();
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
  });

  it("releases the compile a failed revision-owned cover held, after settling the cover alone", async () => {
    const coverFailure = new Error("Chromium could not render the cover");
    mocks.generateImage.mockRejectedValue(coverFailure);
    mocks.markFailed.mockImplementation(async () => {
      mocks.order.push("mark-failed");
    });
    mocks.maybeCompileAfterFailedJob.mockImplementation(async () => {
      mocks.order.push("release-compile");
      return "compile";
    });
    const cover = job("generate-image", {
      assetType: "COVER",
      contentRevision: 7,
      exportPublicationProjectStatus: "EDITING"
    });

    await expect(processWorkerJob(cover)).rejects.toBe(coverFailure);

    expect(mocks.markFailed).toHaveBeenCalledWith(expect.objectContaining({ name: "generate-image" }), coverFailure);
    expect(mocks.order.slice(-2)).toEqual(["mark-failed", "release-compile"]);
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
  });

  it("never lets a release outage replace the cover's own failure", async () => {
    const coverFailure = new Error("image provider outage");
    mocks.generateImage.mockRejectedValue(coverFailure);
    mocks.maybeCompileAfterFailedJob.mockRejectedValue(new Error("Redis unavailable"));

    await expect(
      processWorkerJob(job("generate-image", { assetType: "COVER", contentRevision: 7, exportPublicationProjectStatus: "EDITING" }))
    ).rejects.toBe(coverFailure);

    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.follow_up_failed",
      expect.objectContaining({ error: expect.objectContaining({ message: "Redis unavailable" }) })
    );
  });

  it("surfaces a stop a compile's stand-down returned past, at the COMPLETED write it would have made", async () => {
    // The early brief inventory is a settled promise, so a stand-down return
    // drains a rejected stop without rethrowing it; `markCompleted` re-reads
    // the stopped row first, and its stop is no durable completion to keep.
    const afterJobCompleted = vi.fn();
    mocks.compileExport.mockResolvedValue({ lifecycleSettlement: "defer-to-successor", afterJobCompleted });
    mocks.markCompleted.mockRejectedValue(new StopRequestedError());

    await expect(processWorkerJob(job("compile-export"))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.markStopped).toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(afterJobCompleted).not.toHaveBeenCalled();
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
  });

  it("fans a book run in only after its COMPLETED write, and leaves a staged replan to its own tail", async () => {
    // `maybeEnqueueCompile` waits while the run is open, so this call — made
    // with the run's row terminal — is what queues a compile no unit could.
    mocks.generateBook.mockImplementation(async () => { mocks.order.push("handler"); return {}; });
    mocks.markCompleted.mockImplementation(async () => { mocks.order.push("completed"); return true; });
    mocks.maybeCompileAfterCompletedJob.mockImplementation(async () => { mocks.order.push("fan-in"); });

    await processWorkerJob(job("generate-book"));
    expect(mocks.order.slice(-3)).toEqual(["handler", "completed", "fan-in"]);

    vi.clearAllMocks();
    mocks.generateBook.mockResolvedValue({});
    await processWorkerJob(job("generate-book", { replanOperationId: "operation-1" }));
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
  });

  it("routes a stop request to markStopped as unrecoverable", async () => {
    mocks.generatePage.mockRejectedValue(new StopRequestedError());

    await expect(processWorkerJob(job("generate-page"))).rejects.toThrow();

    expect(mocks.markStopped).toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.maybeCompileAfterFailedJob).not.toHaveBeenCalled();
  });

  it("does not complete or fail a structural waiter that never owned the delivery", async () => {
    // Returning from the handler would markCompleted the shared job under a
    // live insert still drafting; markFailed would refund that same insert.
    mocks.applyBookEdit.mockRejectedValue(new UnownedStructuralDeliveryError());

    await expect(processWorkerJob(job("apply-book-edit"))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.unowned_structural_delivery",
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it("does not complete or fail a text-edit waiter that never owned the delivery", async () => {
    // This is the live-owner answer, distinct from terminal lifecycle
    // supersession after an APPLIED-tail delivery acquired its own lease.
    mocks.applyBookEdit.mockRejectedValue(new UnownedTextEditDeliveryError());

    await expect(processWorkerJob(job("apply-book-edit"))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.unowned_text_edit_delivery",
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it("routes a replan lease loser as superseded before stopped failure settlement", async () => {
    mocks.hasStoppedGenerationJob.mockResolvedValue(true);
    mocks.generateBook.mockRejectedValue(new UnownedReplanDeliveryError());

    await expect(
      processWorkerJob(job("generate-book", { replanOperationId: "operation-1" }))
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.unowned_replan_delivery",
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it("does not fail or refund a structural edit whose rollback did not land", async () => {
    // A stop landing on the durable row would otherwise run first and do the
    // same three writes markFailed does. The revert did not put the book back.
    mocks.hasStoppedGenerationJob.mockResolvedValue(true);
    mocks.applyBookEdit.mockRejectedValue(new StructuralRollbackRedeliveryError());

    await expect(processWorkerJob(job("apply-book-edit"))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markStopped).not.toHaveBeenCalled();
    expect(mocks.runLoggerAppend).toHaveBeenCalledWith(
      "job.structural_rollback_redelivery",
      expect.objectContaining({ error: expect.anything() })
    );
  });
});

describe("processWorkerJob spend attribution", () => {
  it("runs a book job's handler on its owner's spend context", async () => {
    mocks.findProject.mockResolvedValue({ userId: "reader-book" });
    let seen: string | null | undefined;
    mocks.generatePage.mockImplementation(async () => {
      seen = await currentProviderSpendUserId();
    });

    await processWorkerJob(job("generate-page"));

    expect(seen).toBe("reader-book");
    expect(mocks.findProject).toHaveBeenCalledWith({ where: { id: "project-1" }, select: { userId: true } });
  });

  it("runs the project-less portrait job on the user its payload names", async () => {
    let seen: string | null | undefined;
    mocks.generateCharacterPortrait.mockImplementation(async () => {
      seen = await currentProviderSpendUserId();
    });

    await processWorkerJob(job("generate-character-portrait", {
      projectId: undefined,
      planId: undefined,
      libraryCharacterId: "character-1",
      userId: "reader-portrait"
    }));

    expect(seen).toBe("reader-portrait");
    expect(mocks.findProject).not.toHaveBeenCalled();
  });
});
