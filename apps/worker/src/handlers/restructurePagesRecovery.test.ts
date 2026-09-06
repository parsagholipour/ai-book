import { describe, expect, it, vi } from "vitest";
import { mocks, insertJob, pages, application } from "./testing/restructurePagesHarness.js";
import { restructurePages } from "./restructurePages.js";

describe("restructurePages recovery", () => {
  it("puts the book back and fails the operation when drafting dies", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.generatePageDraft.mockRejectedValue(new Error("model outage"));

    await expect(restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })).rejects.toThrow(
      "model outage"
    );

    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledWith(mocks.prisma, {
      projectId: "project-1",
      operationId: "op-1",
      expectedLeaseToken: expect.any(String),
      expectedAppliedAt: "2026-08-15T00:00:00.000Z"
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000, maxWait: 10_000 });
    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1", status: "APPLIED" } })
    );
  });

  it("does not let a stale delivery roll back after another owner takes over", async () => {
    mocks.generatePageDraft.mockRejectedValue(new Error("old delivery resumed"));
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({ outcome: "lost" });

    await expect(restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} })).resolves.toEqual({});

    expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledOnce();
    expect(mocks.waitForStructuralPageLeaseCompletion).toHaveBeenCalledWith("op-1");
  });

  it("settles rather than requeueing when nothing is left to resume", async () => {
    mocks.generatePageDraft.mockRejectedValue(new Error("old delivery resumed"));
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({ outcome: "lost" });
    // Nothing settles it and no stamp is left to resume, so a requeue would only
    // reproduce this verdict forever with the charge never handed back.
    mocks.waitForStructuralPageLeaseCompletion.mockResolvedValue("abandoned");

    await expect(restructurePages(insertJob({ generationJobId: "gj-1" }), {
      id: "op-1", status: "ACTIVE", classifier: {}
    })).rejects.toThrow("old delivery resumed");
    expect(mocks.redeliverWorkerGenerationJob).not.toHaveBeenCalled();
  });
  it("hands the exact stamp and lease to the shared durable compensation", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: { structuralEdit: { action: "insert" } } })
      .mockResolvedValue({
        id: "op-1",
        status: "ACTIVE",
        classifier: { structuralEdit: { action: "insert" }, structuralApplication: application() }
      });
    mocks.generatePageDraft.mockRejectedValue(new Error("model outage"));

    await expect(restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })).rejects.toThrow(
      "model outage"
    );

    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledWith(mocks.prisma, {
      projectId: "project-1",
      operationId: "op-1",
      expectedLeaseToken: expect.any(String),
      expectedAppliedAt: "2026-08-15T00:00:00.000Z"
    });
  });

  it("keeps the stamp when the revert itself fails, because nothing was put back", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.compensateStructuralPageChangeTx.mockRejectedValueOnce(new Error("deadlock"));
    mocks.generatePageDraft.mockRejectedValue(new Error("model outage"));

    await expect(
      restructurePages(insertJob({ generationJobId: "gj-1" }), { id: "op-1", status: "QUEUED", classifier: {} })
    ).rejects.toThrow(/requeued to resume/);

    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.releaseStructuralPageLease).toHaveBeenCalledWith("op-1", expect.any(String));
    expect(mocks.redeliverWorkerGenerationJob).toHaveBeenCalledWith("gj-1");
  });

  it("keeps a delivered edit when the recompile cannot be queued", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("Redis is down"));

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.compensateStructuralPageChangeTx).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.prisma, "project-1", "op-1", "COMPLETE"
    );
  });

  it("does not fail a finished book when a redelivery cannot queue the recompile", async () => {
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("Redis is down"));

    await restructurePages(insertJob(), { id: "op-1", status: "APPLIED", classifier: {} });

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.prisma.project.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contentRevision: { increment: 1 } }) })
    );
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.prisma, "project-1", "op-1", "COMPLETE"
    );
  });

  it("rolls back a partly surviving insert instead of settling a partial page set", async () => {
    // A five-page insert whose first delivery died mid-drafting, and whose
    // interrupted attempt left only two of the five rows in the book. The
    // recorded set is indivisible: a subset is not a live stamp, and reviewing
    // or settling only the survivors would claim adherence for an edit that
    // was never fully applied.
    const partial = application({ insertedPageIds: ["new-1", "new-2", "new-3", "new-4", "new-5"] });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralApplication: partial }
    });
    mocks.applyStructuralPageChange.mockResolvedValue({
      outcome: "resumed",
      phase: "draft",
      application: partial
    });
    mocks.prisma.page.count.mockResolvedValue(2);
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "new-1" || where.id === "new-2"
        ? { id: where.id, index: where.id === "new-1" ? 4 : 5, chapterId: null, chapter: null }
        : null
    );
    mocks.prisma.page.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === undefined ? pages(6) : [{ index: 4 }, { index: 5 }]
    );
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} })
    ).rejects.toThrow("Structural insert is missing 3 of 5 recorded pages");

    // The unlocked classifier refuses the subset; the locked look answers
    // `resumed` (stamp still on the row) rather than shifting twice.
    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
    expect(mocks.applyStructuralPageChange).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledWith(mocks.prisma, {
      projectId: "project-1",
      operationId: "op-1",
      expectedLeaseToken: expect.any(String),
      expectedAppliedAt: partial.appliedAt
    });
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
    // The run log is the debugging artifact: three ids the book no longer holds
    // may not be skipped in silence, and a subset is not logged as a live stamp.
    expect(
      logged.mock.calls.filter((call) => String(call[0]).includes("no longer holds")).length
    ).toBe(3);
    expect(logged.mock.calls.some((call) => String(call[0]).includes("survives only in part"))).toBe(false);
    logged.mockRestore();
  });

  it("does not refund a second time when that settlement is redelivered", async () => {
    // The redelivery of an APPLIED insert takes the idempotent tail and nothing
    // else — no drafting, and so no second look at what the pages cost. The
    // ledger holds the same guarantee underneath (`reversesEntryId` is claimed
    // once), but the handler must not be relying on it.
    const partial = application({ insertedPageIds: ["new-1", "new-2", "new-3", "new-4", "new-5"] });

    await restructurePages(insertJob(), {
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralApplication: partial }
    });

    expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("never settles an insert as a partial delivery", async () => {
    // No shortfall to price: the recorded set is indivisible (see above), so an
    // insert delivers every page it billed or none, and the one that cannot is
    // refunded *whole* by `markFailed` rather than by the difference.
    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
  });

  it("asks again under the lock when a stamp outlived the pages it recorded", async () => {
    // Belt to the transaction's braces: a stamp whose inserted pages are gone
    // is not resumed on its own word. It goes back through the shift's own
    // transaction, where the lease CAS decides under the operation row's lock.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralApplication: application() }
    });
    mocks.prisma.page.count.mockResolvedValue(0);

    await restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} });

    expect(mocks.applyStructuralPageChange).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
  });
});
