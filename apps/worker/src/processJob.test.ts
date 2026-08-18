import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  staleGenerationJobReason: vi.fn(),
  cancelStaleGenerationJob: vi.fn(),
  markActive: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  markRecovering: vi.fn(),
  markStopped: vi.fn(),
  hasStoppedGenerationJob: vi.fn(),
  shouldRecoverJobAttempt: vi.fn(),
  shouldBypassConfiguredRetries: vi.fn(),
  maybeCompileAfterCompletedJob: vi.fn(),
  runLoggerAppend: vi.fn(),
  planBook: vi.fn(),
  compileExport: vi.fn(),
  generatePage: vi.fn(),
  applyBookEdit: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("./runtime/jobLifecycle.js", () => ({
  cancelStaleGenerationJob: mocks.cancelStaleGenerationJob,
  hasStoppedGenerationJob: mocks.hasStoppedGenerationJob,
  jobMaxAttempts: () => 1,
  markActive: mocks.markActive,
  markCompleted: mocks.markCompleted,
  markFailed: mocks.markFailed,
  markRecovering: mocks.markRecovering,
  markStopped: mocks.markStopped,
  shouldBypassConfiguredRetries: mocks.shouldBypassConfiguredRetries,
  shouldRecoverJobAttempt: mocks.shouldRecoverJobAttempt,
  staleGenerationJobReason: mocks.staleGenerationJobReason
}));
vi.mock("./runtime/dispatch.js", () => ({
  maybeCompileAfterCompletedJob: mocks.maybeCompileAfterCompletedJob
}));
vi.mock("./providers/runLogging.js", () => ({
  createRunLogger: () => ({ append: mocks.runLoggerAppend }),
  providerConfigSnapshot: () => ({})
}));
vi.mock("./handlers/applyBookEdit.js", () => ({ applyBookEdit: mocks.applyBookEdit }));
vi.mock("./handlers/characters.js", () => ({ buildCharacterPersona: vi.fn(), prepareCharacterCandidates: vi.fn() }));
vi.mock("./handlers/compileExport.js", () => ({ compileExport: mocks.compileExport }));
vi.mock("./handlers/continueBook.js", () => ({ continueBook: vi.fn() }));
vi.mock("./handlers/generateAudiobook.js", () => ({ generateAudiobook: vi.fn() }));
vi.mock("./handlers/generateBook.js", () => ({ generateBook: vi.fn() }));
vi.mock("./handlers/generateImage.js", () => ({ generateImage: vi.fn() }));
vi.mock("./handlers/generatePage.js", () => ({ generatePage: mocks.generatePage }));
vi.mock("./handlers/importBook.js", () => ({ importBook: vi.fn() }));
vi.mock("./handlers/planning.js", () => ({ planBook: mocks.planBook, revisePlan: vi.fn() }));
vi.mock("./handlers/replanBook.js", () => ({ replanBook: vi.fn() }));

import { processWorkerJob } from "./processJob.js";
import {
  StopRequestedError,
  StructuralRollbackRedeliveryError,
  UnownedStructuralDeliveryError
} from "./runtime/jobTypes.js";

function job(name: string, data: Record<string, unknown> = {}): Job {
  return {
    id: "bull-1",
    name,
    data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...data },
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
  mocks.planBook.mockResolvedValue(undefined);
  mocks.compileExport.mockResolvedValue({});
  mocks.maybeCompileAfterCompletedJob.mockResolvedValue(undefined);
});

describe("processWorkerJob ordering", () => {
  it("runs the stale check before claiming the row ACTIVE", async () => {
    // The old entry point flipped the row ACTIVE first, which overwrote the
    // CANCELED status the stale check reads — refunded work then ran anyway.
    await processWorkerJob(job("generate-page"));

    expect(mocks.order).toEqual(["stale-check", "mark-active", "handler"]);
  });

  it("cancels a stale job without ever claiming it or running its handler", async () => {
    mocks.staleGenerationJobReason.mockResolvedValue("The durable job was canceled before it could run.");

    await processWorkerJob(job("generate-page"));

    expect(mocks.cancelStaleGenerationJob).toHaveBeenCalled();
    expect(mocks.markActive).not.toHaveBeenCalled();
    expect(mocks.generatePage).not.toHaveBeenCalled();
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

  it("keeps Bull successful when completion bookkeeping throws after durable export publication", async () => {
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

  it("does not mask completion errors for a compile that did not durably publish", async () => {
    mocks.compileExport.mockResolvedValue({});
    mocks.markCompleted.mockRejectedValue(new Error("completion write unavailable"));

    await expect(processWorkerJob(job("compile-export"))).rejects.toThrow("completion write unavailable");

    expect(mocks.markFailed).toHaveBeenCalled();
  });
});

describe("processWorkerJob failure routing", () => {
  it("settles a handler failure through markFailed and rethrows", async () => {
    mocks.generatePage.mockRejectedValue(new Error("provider outage"));

    await expect(processWorkerJob(job("generate-page"))).rejects.toThrow("provider outage");

    expect(mocks.markFailed).toHaveBeenCalled();
    expect(mocks.maybeCompileAfterCompletedJob).not.toHaveBeenCalled();
  });

  it("routes a stop request to markStopped as unrecoverable", async () => {
    mocks.generatePage.mockRejectedValue(new StopRequestedError());

    await expect(processWorkerJob(job("generate-page"))).rejects.toThrow();

    expect(mocks.markStopped).toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
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
