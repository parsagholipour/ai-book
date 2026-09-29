import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationJobFindUnique: vi.fn(),
  generationJobUpdate: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  assistFindUnique: vi.fn(),
  assistUpdateMany: vi.fn(),
  bookEditOperationFindUnique: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
  failGenerationAttempt: vi.fn(),
  markGenerationAttemptActive: vi.fn(),
  markGenerationAttemptSucceeded: vi.fn(),
  refundCreditLedgerEntry: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  planRevisionRetryDelayMs: () => 1_000,
  prisma: {
    generationJob: {
      findUnique: mocks.generationJobFindUnique,
      update: mocks.generationJobUpdate,
      updateMany: mocks.generationJobUpdateMany
    },
    project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
    manuscriptAssist: { findUnique: mocks.assistFindUnique, updateMany: mocks.assistUpdateMany },
    bookEditOperation: {
      findUnique: mocks.bookEditOperationFindUnique,
      updateMany: mocks.bookEditOperationUpdateMany
    }
  }
}));

vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  markGenerationAttemptActive: mocks.markGenerationAttemptActive,
  markGenerationAttemptSucceeded: mocks.markGenerationAttemptSucceeded,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn(),
  releaseManuscriptImportUse: vi.fn()
}));

import { ImageContentRefusedError, STOPPED_JOB_ERROR } from "@book-maker/core";
import { cancelStaleGenerationJob, markCompleted, markFailed, markStopped } from "./jobLifecycle.js";
import { WritingAssistFailure, writingAssistFailureSentence } from "./writingAssistSettlement.js";

function assistJob(data: Record<string, unknown> = {}) {
  return {
    name: "writing-assist",
    data: { projectId: "project-1", generationJobId: "job-assist", assistId: "assist-1", attemptId: "attempt-1", ...data },
    attemptsMade: 0,
    opts: {}
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generationJobFindUnique.mockResolvedValue({ steps: [], status: "ACTIVE", qualityReport: null, message: null });
  mocks.generationJobUpdate.mockResolvedValue({});
  mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
  mocks.assistFindUnique.mockResolvedValue({
    kind: "ILLUSTRATE",
    creditsCharged: 12,
    projectId: "project-1",
    ledgerEntryId: "ledger-1"
  });
  mocks.assistUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookEditOperationFindUnique.mockResolvedValue(null);
  mocks.failGenerationAttempt.mockResolvedValue(undefined);
  mocks.markGenerationAttemptSucceeded.mockResolvedValue(undefined);
  mocks.refundCreditLedgerEntry.mockResolvedValue({});
});

describe("writing-assist settlement", () => {
  it("refunds a failed assist through its attempt and fails only its own row", async () => {
    await markFailed(assistJob(), new Error("provider timed out"));

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-1", "provider timed out");
    // The attempt owns the refund; the row's ledger fallback stays quiet.
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.assistUpdateMany).toHaveBeenCalledWith({
      where: { id: "assist-1", status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        status: "FAILED",
        error: "That picture couldn’t be drawn. Your credits were returned. Try again in a moment."
      }
    });
    // Derivative: the book it assists is never failed or refunded.
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
  });

  it("refunds against the row's own ledger entry when a payload somehow carries no attempt", async () => {
    await markFailed(assistJob({ attemptId: undefined }), new Error("provider timed out"));

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-1", "Writing assist failed");
  });

  it("settles nothing twice: a row already verdicted keeps its verdict", async () => {
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 0 });

    await markFailed(assistJob(), new Error("late failure"));

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.assistUpdateMany).not.toHaveBeenCalled();
  });

  it("commits a delivered assist's charge when the job completes", async () => {
    await expect(markCompleted(assistJob())).resolves.toBe(true);

    expect(mocks.markGenerationAttemptSucceeded).toHaveBeenCalledWith("attempt-1");
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("fails a stopped assist's row and refunds it as canceled", async () => {
    await markStopped(assistJob());

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-1", STOPPED_JOB_ERROR, "CANCELED");
    expect(mocks.assistUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "FAILED", error: "Stopped before it finished. Your credits were returned." }
      })
    );
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("does not leave a stale-canceled assist waiting QUEUED", async () => {
    await cancelStaleGenerationJob(assistJob(), "The durable job was canceled before it could run.");

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "The durable job was canceled before it could run.",
      "CANCELED"
    );
    expect(mocks.assistUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("ignores an assist row that belongs to another project", async () => {
    mocks.assistFindUnique.mockResolvedValue({ kind: "OUTLINE", creditsCharged: 0, projectId: "other", ledgerEntryId: null });

    await markFailed(assistJob(), new Error("boom"));

    expect(mocks.assistUpdateMany).not.toHaveBeenCalled();
  });
});

describe("writingAssistFailureSentence", () => {
  it("asks for different words when both image providers refused the picture", () => {
    const refusal = new ImageContentRefusedError({ provider: "gemini", model: "m", reason: "IMAGE_SAFETY" });

    expect(writingAssistFailureSentence("ILLUSTRATE", refusal, { charged: true })).toBe(
      "The picture service wouldn’t draw that description. Try describing the scene differently. Your credits were returned."
    );
  });

  it("passes a reader-facing refusal through, and names no refund when nothing was charged", () => {
    expect(
      writingAssistFailureSentence("CHAPTER_FEEDBACK", new WritingAssistFailure("This chapter has no text yet to give notes on."), {
        charged: false
      })
    ).toBe("This chapter has no text yet to give notes on.");
    const inputError = Object.assign(new Error("Give the chapter a title or some notes to draft from."), {
      name: "AuthorAssistInputError",
      code: "NOTHING_TO_READ"
    });
    expect(writingAssistFailureSentence("DRAFT_CHAPTER", inputError, { charged: true })).toBe(
      "Give the chapter a title or some notes to draft from. Your credits were returned."
    );
  });

  it("never leaks a provider's own words into the card", () => {
    const sentence = writingAssistFailureSentence("OUTLINE", new Error("ECONNRESET 10.0.0.3:443"), { charged: false });

    expect(sentence).toBe("The outline couldn’t be written. Try again in a moment.");
    expect(sentence).not.toContain("ECONNRESET");
  });
});
