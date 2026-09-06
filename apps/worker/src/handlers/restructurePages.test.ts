import { describe, expect, it, vi } from "vitest";
import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { mocks, job, insertJob, pages, application, unshiftedClaim, expectSettled } from "./testing/restructurePagesHarness.js";
import { restructurePages } from "./restructurePages.js";

describe("restructurePages", () => {
  it("never shifts twice when a redelivery finds the stamp already committed", async () => {
    // The dangerous case. The stamp is written in the same transaction as the
    // shift, so finding it means the shift landed — and shifting again would
    // scatter the pages with nothing able to work out where they belonged.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralApplication: application() }
    });
    mocks.leaseClaim = { outcome: "acquired", phase: "draft", application: application() };

    await restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    // It resumes at drafting, against the page *ids* the stamp recorded.
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalled();
  });

  it("waits for the winning delivery instead of drafting or settling its pages", async () => {
    // The concurrent half of the fence, which the read above cannot answer: two
    // deliveries in flight, both past the ACTIVE claim (ACTIVE matches ACTIVE),
    // both having read a classifier with no stamp on it. The loser blocks on the
    // operation row inside `applyStructuralPageChange`'s transaction and comes
    // back `already-applied` rather than shifting the book a second time — which
    // for "add 2 pages" would have moved the tail down four and left four blanks.
    mocks.applyStructuralPageChange.mockResolvedValue({
      outcome: "already-applied",
      application: application(),
      retryAt: new Date("2026-08-18T00:03:00.000Z")
    });
    mocks.leaseClaim = { outcome: "completed" };

    await restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} });

    expect(mocks.waitForStructuralPageLease).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("hands the book to the recompile when the shift's claim finds the operation settled", async () => {
    // The other thing that claim can report: the row went APPLIED or CANCELED
    // while this delivery was resolving its plan. Nothing was shifted here, so
    // the only thing owed is whatever the winner may have died before doing.
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "settled" });
    // Unstamped when this delivery looked, settled by the time its claim ran.
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: {} })
      .mockResolvedValue({
        id: "op-1",
        status: "APPLIED",
        classifier: { structuralApplication: application() },
        publicationRevision: 7
      });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("leaves a delivered no-op alone when the shift's claim finds it settled", async () => {
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "settled" });
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: {} })
      .mockResolvedValue({
        id: "op-1",
        status: "APPLIED",
        classifier: { structuralSkipped: "unknown_pages" }
      });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("re-runs only the idempotent tail for an operation that already finished", async () => {
    await restructurePages(insertJob(), { id: "op-1", status: "APPLIED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("leaves a delivered no-op exactly where it found it when the job comes back", async () => {
    // The other row that wears APPLIED. This one shifted nothing — the resolver
    // refused, the charge went back, the book was put down as it was found — so
    // the tail above is not idempotent here, it is the only thing in the whole
    // delivery that would change the book.
    await restructurePages(insertJob(), {
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralSkipped: "unknown_pages" }
    });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    // The published PDF still describes this manuscript and the map measured
    // from it still describes that PDF: deleting one and bumping past the other
    // costs a full unbilled compile whose review can hand a COMPLETE book back
    // as REVIEW_REQUIRED.
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("stands down when a racing delivery settled the operation as a no-op", async () => {
    // The reachable door: two deliveries in flight, the first settles the skip
    // while the second is still between its own read and its ACTIVE claim.
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralSkipped: "unknown_pages" }
    });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("still refreshes the exports when the redelivered edit really moved pages", async () => {
    // The contrast the marker draws: a stamped operation shifted the book, so
    // its exports are gone and the recompile the first delivery may have died
    // before queueing has to be queued again.
    await restructurePages(insertJob(), {
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralApplication: application() }
    });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("puts the book back in the same transaction that marks a skipped edit APPLIED", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // What makes the stand-down above safe: the marker a redelivery reads as
    // "settled, nothing left to finish" may not land before the write that
    // takes the book out of EDITING, or the pair would strand a project no
    // sweep reaches behind a marker telling its own retry to do nothing.
    mocks.prisma.page.findMany.mockResolvedValue([]);

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bookEditOperation.update.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.prisma.$transaction.mock.invocationCallOrder[0]!
    );
    expect(mocks.prisma.project.update.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { status: "COMPLETE" }
    });
  });

  it("stands down when another actor already settled the operation", async () => {
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "CANCELED", classifier: {} });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("settles for free when the book changed out from under the card", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // "Delete page 9" of a book that now has six pages. Failing here would mark
    // a finished book FAILED; the edit simply has nothing to do.
    const stale = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Delete page 9",
      planId: "plan-1",
      structuralEdit: { action: "delete", anchorPageIndex: 0, pageIndexes: [9], pageCount: 0 }
    });

    await restructurePages(stale, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expectSettled("unknown_pages");
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETE" } })
    );
    // Asked for even though a delete is free: the settlement is a no-op on an
    // operation with no ledger entry, and closing the attempt is what stops a
    // redelivery re-running an edit nobody is paying for.
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(stale, expect.stringContaining("unknown_pages"));
  });

  it("settles a skipped edit back to REVIEW_REQUIRED rather than finishing the book", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // The same no-op settlement for a book the reader still has to look at. This
    // is the path where the handler writes the terminal status itself, with no
    // compile coming to correct it.
    const stale = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Delete page 9",
      planId: "plan-1",
      structuralEdit: { action: "delete", anchorPageIndex: 0, pageIndexes: [9], pageCount: 0 },
      [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
    });

    await restructurePages(stale, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "REVIEW_REQUIRED" } })
    );
  });

  it("hands the credits back before settling a skipped insert", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // The one insert refusal that can survive a card: the pages the anchor was
    // resolved against are gone. Nothing will be written, and the pages were
    // paid for when the edit was queued — so the refund has to be made here,
    // because returning normally is what marks the attempt SUCCEEDED and
    // commits the charge for good.
    mocks.prisma.page.findMany.mockResolvedValue([]);
    const insert = insertJob();

    await restructurePages(insert, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(insert, expect.stringContaining("no_pages"));
    // Refunded *before* the operation is claimed APPLIED: a settlement that
    // throws has to leave behind the ACTIVE row `failEditOperation` claims.
    expect(mocks.refundSkippedEditOperation.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prisma.bookEditOperation.update.mock.invocationCallOrder[0]!
    );
    expectSettled("no_pages");
  });

  it("refunds nothing and skips nothing when the winning delivery already applied the edit", async () => {
    // The pre-flight read is taken outside every claim, and a book the winner
    // has just shifted answers the resolver exactly as a book that moved under
    // the card does: the pages the request names are gone because the winner
    // deleted them. Settling on that read handed the charge back, marked the row
    // APPLIED with `structuralSkipped` and put the book down in its pre-edit
    // status — under a delivery that had already shifted it, whose own APPLIED
    // write then failed (`markStructuralPageLeaseApplied` claims ACTIVE) and
    // whose rollback could not run either, because it opens by renewing the
    // lease this settlement had just cleared. The claim is asked first now.
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.leaseClaim = { outcome: "completed" };
    const insert = insertJob();

    await restructurePages(insert, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.waitForStructuralPageLease).toHaveBeenCalledTimes(1);
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("drafts the pages a dead winner's stamp recorded instead of settling its refusal", async () => {
    // The same stale refusal, and a winner that shifted and then died: the claim
    // hands its expired stamp to this delivery, so what read as "nothing to do"
    // is a paid insert whose pages are still blank.
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.leaseClaim = { outcome: "acquired", phase: "draft", application: application() };

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-2", undefined, {
      contentRevision: 8,
      requireContentRevisionMatch: true
    });
  });

  it("settles for free when the claim finds a book the plan no longer fits", async () => {
    // The refusal the pre-flight read cannot give. `resolveStructuralPageEdit`
    // answered against a read taken before the plan-version reads, the provider
    // construction and the transaction's own start, so a page created or deleted
    // in that window leaves the ordering naming a book that is not there — a
    // `23505` when a parked row lands on an index a live page still holds, and a
    // hole in `1..N` a later compile refuses when it misses. The shift asks the
    // resolver's question again under the operation row's lock, writes nothing,
    // and reports `stale`; that settles exactly as the refusal above does rather
    // than failing a book that is fine.
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "stale", reason: "nothing_to_do" });
    const raced = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Delete page 2",
      planId: "plan-1",
      structuralEdit: { action: "delete", anchorPageIndex: 0, pageIndexes: [2], pageCount: 0 }
    });

    await restructurePages(raced, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(raced, expect.stringContaining("nothing_to_do"));
    expectSettled("nothing_to_do");
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETE" } })
    );
  });

  it("reads the request off the classifier when the payload arrives without one", async () => {
    // `applyBookEdit` forks on the operation's `kind`, so this delivery is
    // reachable: a requeue or a reconciler can rebuild the payload without
    // `structuralEdit`, and the Apply wrote the same request onto the classifier
    // for exactly that case.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralEdit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 } }
    });
    const payloadless = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Add 2 pages after page 3",
      planId: "plan-1"
    });

    await restructurePages(payloadless, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).toHaveBeenCalledTimes(1);
    expect(mocks.applyStructuralPageChange.mock.calls[0]?.[0].plan).toMatchObject({
      action: "insert",
      insertAfterIndex: 3,
      newPageIndexes: [4, 5]
    });
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
  });

  it("refunds and settles a structural job that carries no request at all", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // Both copies gone. There is nothing to resolve and nothing a retry could
    // find, so it settles like a refusal rather than throwing — a throw fails a
    // book that is otherwise finished and leaves the row recoverable, so the
    // retry lane would charge again for a request that is still not there.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { kind: "restructure_pages" }
    });
    const requestless = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Add 2 pages after page 3",
      planId: "plan-1",
      [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await restructurePages(requestless, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(
      requestless,
      expect.stringContaining("missing_request")
    );
    expect(mocks.refundSkippedEditOperation.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prisma.bookEditOperation.update.mock.invocationCallOrder[0]!
    );
    expectSettled("missing_request");
    // The marker and the status restore land together, and the status comes off
    // the payload — a book still asking for attention is not quietly finished.
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.project.update.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("leaves a skipped edit unsettled when the refund itself fails", async () => {
    mocks.leaseClaim = unshiftedClaim;
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.refundSkippedEditOperation.mockRejectedValue(new Error("ledger unavailable"));

    await expect(restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })).rejects.toThrow(
      "ledger unavailable"
    );

    // Never APPLIED: markFailed must still be able to claim and refund ACTIVE.
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
  });

});
