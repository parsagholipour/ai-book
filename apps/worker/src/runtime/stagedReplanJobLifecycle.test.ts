import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationJobFindUnique: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  generationAttemptFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  bookEditOperationFindUnique: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
  pageFindUnique: vi.fn(),
  stagedReplanSuccessorProof: vi.fn(),
  failGenerationAttempt: vi.fn(),
  refundCreditLedgerEntry: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  planRevisionRetryDelayMs: () => 1_000,
  prisma: {
    generationJob: {
      findUnique: mocks.generationJobFindUnique,
      updateMany: mocks.generationJobUpdateMany
    },
    generationAttempt: { findUnique: mocks.generationAttemptFindUnique },
    project: { findUnique: mocks.projectFindUnique },
    bookEditOperation: {
      findUnique: mocks.bookEditOperationFindUnique,
      updateMany: mocks.bookEditOperationUpdateMany
    },
    page: { findUnique: mocks.pageFindUnique }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  markGenerationAttemptActive: vi.fn(),
  markGenerationAttemptSucceeded: vi.fn(),
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn(),
  releaseManuscriptImportUse: vi.fn()
}));
vi.mock("./stagedReplanJobGuard.js", () => ({
  stagedReplanSuccessorProof: mocks.stagedReplanSuccessorProof
}));

import { cancelStaleGenerationJob, staleGenerationJobReason } from "./jobLifecycle.js";

function replanJob() {
  return {
    name: "generate-book",
    data: {
      generationJobId: "job-successor",
      projectId: "project-target",
      planId: "plan-staged",
      replanOperationId: "operation-1"
    }
  } as never;
}

describe("staged replan lifecycle stale guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-target",
      type: "GENERATE_BOOK",
      contentRevision: null,
      status: "QUEUED",
      attemptId: null
    });
    mocks.projectFindUnique.mockResolvedValue({
      currentPlanId: "plan-source",
      contentRevision: 4,
      status: "EDITING"
    });
    mocks.stagedReplanSuccessorProof.mockResolvedValue("exact");
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-1" });
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    mocks.refundCreditLedgerEntry.mockResolvedValue({});
  });

  it("admits only a durable exact staged successor through the plan mismatch", async () => {
    await expect(staleGenerationJobReason(replanJob())).resolves.toBeNull();
    expect(mocks.stagedReplanSuccessorProof).toHaveBeenCalledWith({
      targetProjectId: "project-target",
      generationJobId: "job-successor",
      operationId: "operation-1",
      stagedPlanId: "plan-staged"
    });
  });

  it("supports a copy target whose current plan is still null", async () => {
    mocks.projectFindUnique.mockResolvedValue({
      currentPlanId: null,
      contentRevision: 0,
      status: "EDITING"
    });
    await expect(staleGenerationJobReason(replanJob())).resolves.toBeNull();
  });

  it("keeps the ordinary stale cancellation answer on any failed durable proof", async () => {
    mocks.stagedReplanSuccessorProof.mockResolvedValue("mismatch");
    await expect(staleGenerationJobReason(replanJob())).resolves.toBe(
      "The staged replan successor no longer matches its durable operation."
    );
  });

  it("rejects an open successor even if its staged plan appeared as current", async () => {
    mocks.projectFindUnique.mockResolvedValue({
      currentPlanId: "plan-staged",
      contentRevision: 5,
      status: "EDITING"
    });
    mocks.stagedReplanSuccessorProof.mockResolvedValue("mismatch");
    await expect(staleGenerationJobReason(replanJob())).resolves.toContain("durable operation");
    expect(mocks.stagedReplanSuccessorProof).toHaveBeenCalledTimes(1);
  });

  // A replan successor enqueued before staging existed. Its plan is already the
  // project's current one, so the ordinary guard admits it; the staged proof has
  // no stamps to read and must not answer for it, or the deploy that introduced
  // staging cancels and refunds every paid replan still in flight.
  it("hands an unstaged successor back to the ordinary plan check", async () => {
    mocks.stagedReplanSuccessorProof.mockResolvedValue("unstaged");
    mocks.projectFindUnique.mockResolvedValue({
      currentPlanId: "plan-staged",
      contentRevision: 5,
      status: "GENERATING"
    });

    await expect(staleGenerationJobReason(replanJob())).resolves.toBeNull();
  });

  it("still supersedes an unstaged successor whose plan the project replaced", async () => {
    mocks.stagedReplanSuccessorProof.mockResolvedValue("unstaged");

    await expect(staleGenerationJobReason(replanJob())).resolves.toBe(
      "The job targets a superseded book plan."
    );
  });

  it("does not offer the exception to an ordinary GENERATE_BOOK draft", async () => {
    const job = replanJob();
    delete (job as { data: { replanOperationId?: string } }).data.replanOperationId;
    await expect(staleGenerationJobReason(job)).resolves.toBe("The job targets a superseded book plan.");
    expect(mocks.stagedReplanSuccessorProof).not.toHaveBeenCalled();
  });

  it("does not offer the exception when the durable job type was changed", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-target",
      type: "GENERATE_PAGE",
      contentRevision: null,
      status: "QUEUED",
      attemptId: null
    });
    mocks.stagedReplanSuccessorProof.mockResolvedValue("mismatch");
    await expect(staleGenerationJobReason(replanJob())).resolves.toContain("durable operation");
    expect(mocks.stagedReplanSuccessorProof).toHaveBeenCalledTimes(1);
  });

  it("leaves a completed published successor to the APPLIED tail replay", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-target",
      type: "GENERATE_BOOK",
      contentRevision: null,
      status: "COMPLETED",
      attemptId: null
    });
    mocks.projectFindUnique.mockResolvedValue({
      currentPlanId: "plan-staged",
      contentRevision: 5,
      status: "EDITING"
    });
    await expect(staleGenerationJobReason(replanJob())).resolves.toBeNull();
    expect(mocks.stagedReplanSuccessorProof).not.toHaveBeenCalled();
  });

  it("rejects canceled or refunded work before consulting the staged proof", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-target",
      type: "GENERATE_BOOK",
      contentRevision: null,
      status: "CANCELED",
      attemptId: null
    });
    await expect(staleGenerationJobReason(replanJob())).resolves.toContain("canceled");

    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-target",
      type: "GENERATE_BOOK",
      contentRevision: null,
      status: "QUEUED",
      attemptId: "attempt-1"
    });
    mocks.generationAttemptFindUnique.mockResolvedValue({ status: "CANCELED" });
    await expect(staleGenerationJobReason(replanJob())).resolves.toContain("refunded");
    expect(mocks.stagedReplanSuccessorProof).not.toHaveBeenCalled();
  });

  it("cancels the open successor and its paid attempt on a failed proof", async () => {
    const job = replanJob() as { data: Record<string, unknown> };
    job.data.attemptId = "attempt-1";

    await cancelStaleGenerationJob(job as never, "The staged replan proof changed.");

    expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-successor", status: { in: ["QUEUED", "ACTIVE"] } },
      data: expect.objectContaining({ status: "CANCELED" })
    }));
    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "The staged replan proof changed.",
      "CANCELED"
    );
    expect(mocks.bookEditOperationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "CANCELED", error: "The staged replan proof changed." }
    });
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });

  it("refunds the operation ledger for a legacy successor without an attempt", async () => {
    await cancelStaleGenerationJob(replanJob(), "The staged replan proof changed.");
    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith(
      "ledger-1",
      "The staged replan proof changed."
    );
  });
});
