import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationJobFindUnique: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdate: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  projectFindUnique: vi.fn(),
  audiobookUpdateMany: vi.fn(),
  libraryCharacterUpdateMany: vi.fn(),
  bookEditOperationFindUnique: vi.fn(),
  bookEditOperationUpdate: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
  pageFindUnique: vi.fn(),
  generationAttemptFindUnique: vi.fn(),
  failGenerationAttempt: vi.fn(),
  markGenerationAttemptActive: vi.fn(),
  markGenerationAttemptSucceeded: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundCreditLedgerEntryPortion: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  planRevisionRetryDelayMs: () => 1_000,
  prisma: {
    generationJob: {
      findUnique: mocks.generationJobFindUnique,
      findMany: mocks.generationJobFindMany,
      update: mocks.generationJobUpdate,
      updateMany: mocks.generationJobUpdateMany
    },
    project: {
      findUnique: mocks.projectFindUnique,
      update: mocks.projectUpdate,
      updateMany: mocks.projectUpdateMany
    },
    audiobook: { updateMany: mocks.audiobookUpdateMany },
    libraryCharacter: { updateMany: mocks.libraryCharacterUpdateMany },
    bookEditOperation: {
      findUnique: mocks.bookEditOperationFindUnique,
      update: mocks.bookEditOperationUpdate,
      updateMany: mocks.bookEditOperationUpdateMany
    },
    page: { findUnique: mocks.pageFindUnique },
    generationAttempt: { findUnique: mocks.generationAttemptFindUnique }
  }
}));

vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  markGenerationAttemptActive: mocks.markGenerationAttemptActive,
  markGenerationAttemptSucceeded: mocks.markGenerationAttemptSucceeded,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion: mocks.refundCreditLedgerEntryPortion,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits
}));

import {
  markActive,
  markCompleted,
  markFailed,
  markMalformedJobFailed,
  markRecovering,
  markStopped,
  refundSkippedEditOperation,
  refundUnwrittenEditPages,
  staleGenerationJobReason
} from "./jobLifecycle.js";
import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";

describe("job lifecycle ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobFindMany.mockResolvedValue([]);
    mocks.generationJobUpdate.mockResolvedValue({});
    // count 1 is the normal case: an open row takes the conditional
    // transition. Tests for the settled-verdict guards override this to 0.
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.projectUpdate.mockResolvedValue({});
    mocks.projectUpdateMany.mockResolvedValue({ count: 0 });
    mocks.audiobookUpdateMany.mockResolvedValue({ count: 1 });
    mocks.libraryCharacterUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookEditOperationFindUnique.mockResolvedValue(null);
    mocks.bookEditOperationUpdate.mockResolvedValue({});
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.refundCreditLedgerEntry.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    mocks.markGenerationAttemptActive.mockResolvedValue(undefined);
    mocks.markGenerationAttemptSucceeded.mockResolvedValue(undefined);
  });

  it("requeues audiobook work without moving the completed book back to generating", async () => {
    await markRecovering(job("generate-audiobook", { audiobookId: "audio-1" }), new Error("network interruption"));

    expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "ACTIVE" }),
        data: expect.objectContaining({ status: "QUEUED" })
      })
    );
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.audiobookUpdateMany).not.toHaveBeenCalled();
  });

  it("uses Bull's durable id to fail a payload that cannot expose generationJobId", async () => {
    await markMalformedJobFailed(
      {
        id: "durable-job-1",
        name: "generate-page",
        data: { projectId: "project-1", planId: "plan-1" }
      } as never,
      new Error("Invalid payload: generationJobId is required")
    );

    expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith({
      where: { id: "durable-job-1", status: { notIn: ["COMPLETED", "CANCELED"] } },
      data: expect.objectContaining({
        status: "FAILED",
        error: "Invalid payload: generationJobId is required"
      })
    });
  });

  it("fails and refunds an audiobook without changing the book", async () => {
    await markFailed(
      job("generate-audiobook", { audiobookId: "audio-1", billingLedgerEntryId: "ledger-audio" }),
      new Error("speech quota exhausted")
    );

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-audio", "speech quota exhausted");
    expect(mocks.audiobookUpdateMany).toHaveBeenCalledWith({
      where: { id: "audio-1", status: "GENERATING" },
      data: { status: "FAILED", error: "speech quota exhausted" }
    });
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("settles a paid audiobook failure through its attempt without changing the book", async () => {
    await markFailed(
      job("generate-audiobook", {
        audiobookId: "audio-1",
        attemptId: "attempt-audio",
        billingLedgerEntryId: "legacy-ledger"
      }),
      new Error("speech quota exhausted")
    );

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-audio", "speech quota exhausted");
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.audiobookUpdateMany).toHaveBeenCalledWith({
      where: { id: "audio-1", status: "GENERATING" },
      data: { status: "FAILED", error: "speech quota exhausted" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("fails a detached export repair without touching the finished book it belongs to", async () => {
    // A compile queued to rebuild a file that went missing is not the compile
    // that decides whether the book exists. Sharing `compile-export`'s name with
    // that one meant a Chromium blip on a repair marked a COMPLETE project
    // FAILED and refunded the reader's whole book charge — which the payload's
    // own `planId` leads straight to, so it is not even the vague fallback.
    // `compile-export` has no BullMQ retry, so one failure was enough.
    mocks.generationJobFindMany.mockResolvedValue([
      { payload: { planId: "plan-1", billingLedgerEntryId: "entry-book" } }
    ]);

    await markFailed(
      job("compile-export", { planId: "plan-1", detachedFromProjectLifecycle: true }),
      new Error("Render exceeded 90s and was abandoned.")
    );

    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("still fails the book when the compile that generates it fails", async () => {
    // The other half: a compile at the end of generation *does* own the
    // outcome. Detaching by job name rather than per job would have taken this
    // away, leaving a book with no artifacts sitting at COMPLETE.
    mocks.generationJobFindMany.mockResolvedValue([
      { payload: { planId: "plan-1", billingLedgerEntryId: "entry-book" } }
    ]);

    await markFailed(job("compile-export", { planId: "plan-1" }), new Error("compile failed"));

    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-book", "compile failed");
  });

  it("leaves the book alone when a detached repair is stopped", async () => {
    await markStopped(job("compile-export", { planId: "plan-1", detachedFromProjectLifecycle: true }));

    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("restores a presentation reprint's prior settled status without refunding on failure or stop", async () => {
    const payload = {
      planId: "plan-1",
      contentRevision: 9,
      presentationOnlyRecompile: true,
      presentationRecompileFallbackStatus: "REVIEW_REQUIRED"
    };

    await markFailed(job("compile-export", payload), new Error("render failed"));
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING", contentRevision: 9 },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
    await markStopped(job("compile-export", payload));
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING", contentRevision: 9 },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("does not drag a finished book back to generating for a detached repair retry", async () => {
    await markRecovering(
      job("compile-export", { planId: "plan-1", detachedFromProjectLifecycle: true }),
      new Error("network interruption")
    );

    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("settles an attempt-aware descendant by attempt and never by a mutable payload ledger", async () => {
    await markFailed(
      job("generate-page", {
        attemptId: "attempt-1",
        billingLedgerEntryId: "legacy-ledger"
      }),
      new Error("page failed")
    );

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-1", "page failed");
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    // The refund covers the whole fan-out, so every open sibling stops with it
    // — as FAILED, which is what keeps them copyable by the paid retry.
    expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith({
      where: { attemptId: "attempt-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: expect.objectContaining({ status: "FAILED", error: "Stopped by user" })
    });
  });

  it("stops and refunds an audiobook without changing the book", async () => {
    await markStopped(job("generate-audiobook", { audiobookId: "audio-1", billingLedgerEntryId: "ledger-audio" }));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-audio", "Stopped by user");
    expect(mocks.audiobookUpdateMany).toHaveBeenCalledWith({
      where: { id: "audio-1", status: "GENERATING" },
      data: { status: "FAILED", error: "Stopped by user" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("fails and stops derivative character work without failing the book", async () => {
    for (const name of ["prepare-character-candidates", "build-character-persona"]) {
      vi.clearAllMocks();
      mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
      mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });

      await markFailed(job(name), new Error("character operation failed"));

      expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
      );
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
      expect(mocks.projectUpdate).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
      mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
      await markStopped(job(name));

      expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
      );
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
      expect(mocks.projectUpdate).not.toHaveBeenCalled();
    }
  });

  it("fails a character portrait by flipping its own row, settling through the attempt", async () => {
    const portraitJob = () =>
      job("generate-character-portrait", {
        projectId: undefined,
        libraryCharacterId: "char-1",
        userId: "user-1",
        attemptId: "attempt-1"
      });

    await markFailed(portraitJob(), new Error("image provider down"));

    expect(mocks.libraryCharacterUpdateMany).toHaveBeenCalledWith({
      where: { id: "char-1", portraitStatus: { in: ["QUEUED", "GENERATING"] } },
      data: { portraitStatus: "FAILED", portraitError: "image provider down" }
    });
    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-1", "image provider down");
    // The attempt settlement owns the refund; the ledger fallback stays quiet.
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.libraryCharacterUpdateMany.mockResolvedValue({ count: 1 });
    await markStopped(portraitJob());

    expect(mocks.libraryCharacterUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ portraitStatus: "FAILED" }) })
    );
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("refunds an attempt-less portrait against the payload's own ledger entry", async () => {
    await markFailed(
      job("generate-character-portrait", {
        projectId: undefined,
        libraryCharacterId: "char-1",
        billingLedgerEntryId: "ledger-portrait"
      }),
      new Error("image provider down")
    );

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-portrait", "image provider down");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("still applies the CANCELED and settled-attempt stale checks to project-less jobs", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: null,
      type: "GENERATE_CHARACTER_PORTRAIT",
      contentRevision: null,
      status: "CANCELED"
    });
    await expect(
      staleGenerationJobReason(job("generate-character-portrait", { projectId: undefined }))
    ).resolves.toBe("The durable job was canceled before it could run.");

    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: null,
      type: "GENERATE_CHARACTER_PORTRAIT",
      contentRevision: null,
      status: "QUEUED",
      attemptId: "attempt-1"
    });
    mocks.generationAttemptFindUnique.mockResolvedValue({ status: "FAILED" });
    await expect(
      staleGenerationJobReason(job("generate-character-portrait", { projectId: undefined }))
    ).resolves.toBe("The paid attempt behind this job was already settled and refunded.");

    // A healthy project-less row is simply not stale; there is no project to
    // compare it against and the project section must not run.
    mocks.generationAttemptFindUnique.mockResolvedValue({ status: "ACTIVE" });
    await expect(
      staleGenerationJobReason(job("generate-character-portrait", { projectId: undefined }))
    ).resolves.toBeNull();
    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
  });

  it("refunds a failed plan against its own charge, not the book's", async () => {
    await markFailed(job("plan-book", { billingLedgerEntryId: "ledger-plan" }), new Error("planner outage"));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-plan", "planner outage");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
  });

  it("falls back to the latest PLAN_GENERATION charge for plan rows without a stamp", async () => {
    await markFailed(job("plan-book"), new Error("planner outage"));

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).toHaveBeenCalledWith({
      projectId: "project-1",
      operation: "PLAN_GENERATION",
      reason: "planner outage"
    });
  });

  it("refunds a stopped plan the same way", async () => {
    await markStopped(job("plan-book", { billingLedgerEntryId: "ledger-plan" }));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-plan", "Stopped by user");
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
  });

  it("refunds a failed fan-out job against its own run's charge, not the latest one", async () => {
    // Run 1 (plan-1) still has a straggler page job; run 2 (plan-2) was charged
    // later. The straggler must refund entry-1, never entry-2.
    mocks.generationJobFindMany.mockResolvedValue([
      { payload: { planId: "plan-2", billingLedgerEntryId: "entry-2" } },
      { payload: { planId: "plan-1", billingLedgerEntryId: "entry-1" } }
    ]);

    await markFailed(job("generate-page", { planId: "plan-1" }), new Error("page failed"));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-1", "page failed");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("settles a stopped edit against the operation's ledger entry, leaving the book alone", async () => {
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op" });

    await markStopped(job("apply-book-edit", { operationId: "op-1" }));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-op", "Stopped by user");
    expect(mocks.bookEditOperationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1", status: { in: ["QUEUED", "ACTIVE"] } },
        data: expect.objectContaining({ status: "FAILED" })
      })
    );
    // The edit belongs to a COMPLETE book: restore EDITING, never fail the
    // project or touch its FULL_BOOK_GENERATION charge.
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("restores a failed edit to the status stamped before enqueue", async () => {
    await markFailed(
      job("apply-book-edit", {
        operationId: "op-1",
        [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
      }),
      new Error("edit failed")
    );

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("restores a stopped edit to the status stamped before enqueue", async () => {
    await markStopped(
      job("apply-book-edit", {
        operationId: "op-1",
        [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
      })
    );

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("fails a stopped replan copy instead of restoring a status it never had", async () => {
    await markStopped(job("replan-book", { operationId: "op-replan" }));

    expect(mocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "FAILED" }
    });
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
  });

  it("treats a CANCELED durable row as stale so refunded work never runs", async () => {
    mocks.projectFindUnique.mockResolvedValue({ currentPlanId: "plan-1", contentRevision: 0 });
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-1",
      type: "PLAN_BOOK",
      contentRevision: null,
      status: "CANCELED"
    });

    await expect(staleGenerationJobReason(job("plan-book"))).resolves.toBe(
      "The durable job was canceled before it could run."
    );

    // Strictly CANCELED: FAILED rows are legitimately re-run by BullMQ retries.
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-1",
      type: "PLAN_BOOK",
      contentRevision: null,
      status: "FAILED"
    });
    await expect(staleGenerationJobReason(job("plan-book"))).resolves.toBeNull();
  });

  it("treats a job whose attempt was settled as stale so refunded work never runs", async () => {
    // One failed page settled and refunded the whole attempt; its queued
    // siblings — or the same row requeued by a shared resume route — must
    // cancel on arrival instead of delivering work the user was paid back for.
    mocks.projectFindUnique.mockResolvedValue({ currentPlanId: "plan-1", contentRevision: 0 });
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      contentRevision: null,
      status: "QUEUED",
      attemptId: "attempt-1"
    });
    mocks.generationAttemptFindUnique.mockResolvedValue({ status: "FAILED" });

    await expect(staleGenerationJobReason(job("generate-page", { planId: "plan-1" }))).resolves.toBe(
      "The paid attempt behind this job was already settled and refunded."
    );

    // A live attempt keeps running its own children.
    mocks.generationAttemptFindUnique.mockResolvedValue({ status: "ACTIVE" });
    await expect(staleGenerationJobReason(job("generate-page", { planId: "plan-1" }))).resolves.toBeNull();

    // A SUCCEEDED attempt is not a refund; stragglers stay governed by the
    // plan/page staleness rules alone.
    mocks.generationAttemptFindUnique.mockResolvedValue({ status: "SUCCEEDED" });
    await expect(staleGenerationJobReason(job("generate-page", { planId: "plan-1" }))).resolves.toBeNull();
  });

  it.each(["ACTIVE", "APPLIED"])(
    "lets an %s stamped structural edit resume after creating the project's current plan",
    async (operationStatus) => {
      mocks.projectFindUnique.mockResolvedValue({ currentPlanId: "plan-2", contentRevision: 0 });
      mocks.generationJobFindUnique.mockResolvedValue({
        projectId: "project-1",
        type: "APPLY_BOOK_EDIT",
        contentRevision: null,
        status: "ACTIVE"
      });
      mocks.bookEditOperationFindUnique.mockResolvedValue({
        projectId: "project-1",
        generationJobId: "job-apply-book-edit",
        kind: "RESTRUCTURE_PAGES",
        status: operationStatus,
        classifier: { structuralApplication: structuralApplication() }
      });

      await expect(
        staleGenerationJobReason(job("apply-book-edit", { operationId: "op-1", planId: "plan-1" }))
      ).resolves.toBeNull();
    }
  );

  it("keeps unrelated apply-book-edit jobs stale after the current plan changes", async () => {
    mocks.projectFindUnique.mockResolvedValue({ currentPlanId: "plan-2", contentRevision: 0 });
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-1",
      type: "APPLY_BOOK_EDIT",
      contentRevision: null,
      status: "ACTIVE"
    });
    mocks.bookEditOperationFindUnique.mockResolvedValue({
      projectId: "project-1",
      generationJobId: "job-apply-book-edit",
      kind: "PAGE_REWRITE",
      status: "ACTIVE",
      classifier: { structuralApplication: structuralApplication() }
    });

    await expect(
      staleGenerationJobReason(job("apply-book-edit", { operationId: "op-1", planId: "plan-1" }))
    ).resolves.toBe("The job targets a superseded book plan.");
  });

  it("preserves project recovery, failure and stop transitions for book jobs", async () => {
    await markRecovering(job("generate-book"), new Error("network interruption"));
    expect(mocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "GENERATING" }
    });

    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.projectUpdate.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
    await markFailed(job("generate-page"), new Error("page failed"));
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
    expect(mocks.refundLatestProjectOperationCredits).toHaveBeenCalledWith({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "page failed"
    });

    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.projectUpdate.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
    await markStopped(job("compile-export"));
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
  });

  it("skips settlement entirely when the row already holds a settled verdict", async () => {
    // A COMPLETED row means the run was delivered: a straggling failure — a
    // throw in post-completion follow-ups, a redelivered Bull job — must not
    // refund it or fail the project over it.
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 0 });

    await markFailed(job("generate-book", { billingLedgerEntryId: "ledger-book" }), new Error("late failure"));
    await markStopped(job("generate-book", { billingLedgerEntryId: "ledger-book" }));

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.bookEditOperationUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to resurrect a settled row as ACTIVE and reports the refusal", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({ status: "COMPLETED", message: null, error: null });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 0 });

    await expect(markActive(job("generate-page", { attemptId: "attempt-1" }))).resolves.toBe(false);
    expect(mocks.markGenerationAttemptActive).not.toHaveBeenCalled();

    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    await expect(markActive(job("generate-page", { attemptId: "attempt-1" }))).resolves.toBe(true);
    expect(mocks.markGenerationAttemptActive).toHaveBeenCalledWith("attempt-1");
  });

  it("lets a stop that landed mid-completion win instead of burying it under COMPLETED", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [], status: "ACTIVE", message: null, error: null });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 0 });

    await expect(markCompleted(job("compile-export", { attemptId: "attempt-1" }))).resolves.toBe(false);
    expect(mocks.markGenerationAttemptSucceeded).not.toHaveBeenCalled();
  });

  it("terminalizes an APPLIED text-edit tail without rewriting its operation verdict", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      steps: [],
      status: "ACTIVE",
      message: "Refreshing exports",
      qualityReport: null
    });

    await expect(
      markCompleted(
        job("apply-book-edit", {
          generationJobId: "job-old",
          operationId: "op-old",
          attemptId: "attempt-old"
        })
      )
    ).resolves.toBe(true);

    expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-old", status: { in: ["QUEUED", "ACTIVE"] } },
      data: expect.objectContaining({ status: "COMPLETED", progress: 100 })
    });
    expect(mocks.markGenerationAttemptSucceeded).toHaveBeenCalledWith("attempt-old");
    expect(mocks.bookEditOperationUpdateMany).not.toHaveBeenCalled();
  });

  it("terminalizes a compile handoff but lets its same-attempt successor settle success", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      steps: [],
      status: "ACTIVE",
      message: "Compiling",
      qualityReport: null
    });
    const scope = { attemptId: "attempt-1", operationId: "operation-1" };

    await expect(
      markCompleted(job("compile-export", { generationJobId: "compile-predecessor", ...scope }), "defer-to-successor")
    ).resolves.toBe(true);

    expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith({
      where: { id: "compile-predecessor", status: { in: ["QUEUED", "ACTIVE"] } },
      data: expect.objectContaining({ status: "COMPLETED" })
    });
    expect(mocks.markGenerationAttemptSucceeded).not.toHaveBeenCalled();
    expect(mocks.bookEditOperationUpdateMany).not.toHaveBeenCalled();

    const predecessorCompletion = mocks.generationJobUpdateMany.mock.calls.find(
      ([query]) => query.data.status === "COMPLETED"
    )?.[0];
    mocks.generationJobFindUnique.mockResolvedValue({
      steps: [],
      status: "COMPLETED",
      message: predecessorCompletion?.data.message,
      qualityReport: null
    });
    await markCompleted(job("compile-export", { generationJobId: "compile-predecessor", ...scope }));
    expect(mocks.markGenerationAttemptSucceeded).not.toHaveBeenCalled();
    expect(mocks.bookEditOperationUpdateMany).not.toHaveBeenCalled();

    mocks.generationJobFindUnique.mockResolvedValue({
      steps: [],
      status: "ACTIVE",
      message: "Compiling",
      qualityReport: null
    });
    await expect(
      markCompleted(job("compile-export", { generationJobId: "compile-successor", ...scope }))
    ).resolves.toBe(true);

    expect(mocks.markGenerationAttemptSucceeded).toHaveBeenCalledTimes(1);
    expect(mocks.markGenerationAttemptSucceeded).toHaveBeenCalledWith("attempt-1");
    expect(mocks.bookEditOperationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "APPLIED", appliedAt: expect.any(Date) }
    });
  });

  it("leaves a compile handoff attempt open for its same-attempt successor to fail and refund", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      steps: [],
      status: "ACTIVE",
      message: "Compiling",
      qualityReport: null
    });
    const scope = { attemptId: "attempt-1", operationId: "operation-1" };

    await markCompleted(
      job("compile-export", { generationJobId: "compile-predecessor", ...scope }),
      "defer-to-successor"
    );
    await markFailed(
      job("compile-export", { generationJobId: "compile-successor", ...scope }),
      new Error("successor image failed")
    );
    expect(mocks.markGenerationAttemptSucceeded).not.toHaveBeenCalled();
    // The attempt settlement keeps the cause; the operation column is read.
    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-1", "successor image failed");
    expect(mocks.bookEditOperationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: {
        status: "FAILED",
        error: "That change couldn’t be finished. Send it again to try once more.",
        structuralLeaseToken: null,
        structuralLeaseExpiresAt: null
      }
    });
  });

  it("replays attempt and edit settlement after publication already committed COMPLETED", async () => {
    mocks.generationJobFindUnique.mockResolvedValue({
      steps: [],
      status: "COMPLETED",
      message: "Export published",
      qualityReport: null
    });

    await expect(
      markCompleted(job("compile-export", { attemptId: "attempt-1", operationId: "operation-1" }))
    ).resolves.toBe(true);

    expect(mocks.markGenerationAttemptSucceeded).toHaveBeenCalledWith("attempt-1");
    expect(mocks.bookEditOperationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "APPLIED", appliedAt: expect.any(Date) }
    });
    expect(mocks.generationJobUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("never refunds an edit operation the completion path already settled", async () => {
    // failEditOperation claims the open row before touching the charge; an
    // operation that is already APPLIED loses the claim and keeps its money.
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op" });
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 0 });

    await markStopped(job("apply-book-edit", { operationId: "op-1" }));

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });

  it("closes the attempt behind an edit that applied nothing, so success cannot commit its charge", async () => {
    await refundSkippedEditOperation(
      job("apply-book-edit", { operationId: "op-1", attemptId: "attempt-1" }),
      "Structural edit skipped: unknown_pages"
    );

    // CANCELED, not FAILED — nothing broke — and terminal, which is what stops
    // the markCompleted that follows from marking it SUCCEEDED over a spend
    // this just reversed.
    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "Structural edit skipped: unknown_pages",
      "CANCELED"
    );
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });

  it("refunds an attempt-less skipped edit through the operation's own entry", async () => {
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op" });

    await refundSkippedEditOperation(job("apply-book-edit", { operationId: "op-1" }), "skipped");

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-op", "skipped");
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
  });

  it("refunds only the pages an insert billed and did not write", async () => {
    // 5 pages at 40 credits each; two of them were written. The share the three
    // missing pages carried is exactly their share of the pages, because
    // `restructure_pages` is priced per page with no flat half.
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op", creditsCharged: 200 });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await refundUnwrittenEditPages(job("apply-book-edit", { operationId: "op-1", attemptId: "attempt-1" }), {
      billedPages: 5,
      writtenPages: 2,
      reason: "wrote 2 of 5"
    });

    expect(mocks.refundCreditLedgerEntryPortion).toHaveBeenCalledWith({
      entryId: "ledger-op",
      amountCredits: 120,
      reason: "wrote 2 of 5",
      idempotencyKey: "edit-page-shortfall:op-1"
    });
    // The attempt is left open: this edit delivered, so `markCompleted` still
    // owns it. Cancelling it here would make the whole spend reversible.
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("touches nothing when an edit wrote every page it billed, or billed none", async () => {
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op", creditsCharged: 200 });

    const delivered = job("apply-book-edit", { operationId: "op-1" });
    await refundUnwrittenEditPages(delivered, { billedPages: 5, writtenPages: 5, reason: "all written" });
    // A free delete or move: no pages billed, so there is no share to give back.
    await refundUnwrittenEditPages(delivered, { billedPages: 0, writtenPages: 0, reason: "nothing billed" });

    expect(mocks.bookEditOperationFindUnique).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntryPortion).not.toHaveBeenCalled();
  });

  it("keeps a shortfall refund out of an unbilled edit's way", async () => {
    // A structural edit that cost nothing has no entry to draw a share from,
    // and asking for one would refund against whatever the row last held.
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: null, creditsCharged: 0 });

    await refundUnwrittenEditPages(job("apply-book-edit", { operationId: "op-1" }), {
      billedPages: 3,
      writtenPages: 1,
      reason: "wrote 1 of 3"
    });

    expect(mocks.refundCreditLedgerEntryPortion).not.toHaveBeenCalled();
  });

  it("lets a failed shortfall refund throw, for the reason a skipped edit's does", async () => {
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op", creditsCharged: 200 });
    mocks.refundCreditLedgerEntryPortion.mockRejectedValue(new Error("ledger unavailable"));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      refundUnwrittenEditPages(job("apply-book-edit", { operationId: "op-1" }), {
        billedPages: 5,
        writtenPages: 2,
        reason: "wrote 2 of 5"
      })
    ).rejects.toThrow("ledger unavailable");
    logged.mockRestore();
  });

  it("lets a failed settlement of a skipped edit throw, rather than keeping the charge quietly", async () => {
    // The caller has not settled its operation yet, so the throw reaches
    // markFailed, which asks for the same refund against a row still ACTIVE.
    mocks.failGenerationAttempt.mockRejectedValue(new Error("ledger unavailable"));

    await expect(
      refundSkippedEditOperation(job("apply-book-edit", { operationId: "op-1", attemptId: "attempt-1" }), "skipped")
    ).rejects.toThrow("ledger unavailable");
  });
});

function job(name: string, data: Record<string, unknown> = {}) {
  return {
    name,
    data: { projectId: "project-1", generationJobId: `job-${name}`, ...data },
    attemptsMade: 0,
    opts: { attempts: 3 }
  } as never;
}

function structuralApplication() {
  return {
    action: "insert",
    pageOrderBefore: [{ pageId: "page-1", index: 1 }],
    insertedPageIds: ["page-2"],
    removedPages: [],
    basePlanVersionId: "plan-1",
    newPlanVersionId: "plan-2",
    previousTargetPages: 1,
    previousChapterTargetPages: {},
    appliedAt: "2026-08-18T00:00:00.000Z"
  };
}
