import { describe, expect, it, vi } from "vitest";
import { bookPdfCoverNumbering, type StructuralApplication } from "@book-maker/core";
import { revertStructuralPageChange } from "./pageRestructureRevert.ts";

const application = (overrides: Partial<StructuralApplication> = {}): StructuralApplication => ({
  action: "insert",
  pageOrderBefore: [
    { pageId: "page-1", index: 1 },
    { pageId: "page-2", index: 2 },
    { pageId: "page-3", index: 3 }
  ],
  insertedPageIds: [],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 3,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-15T00:00:00.000Z",
  ...overrides
});

/** The measured map of the book as it stands *now*, i.e. after the edit. */
const storedMap = (pages: { index: number; startPdfPage: number; endPdfPage: number }[]) => ({
  version: 2 as const,
  totalPdfPages: 12,
  hasCoverPage: true,
  contentsStartPdfPage: 2,
  contentRevision: 7,
  pages
});

const transaction = (
  options: {
    currentPages?: { id: string; index: number; chapterId?: string | null }[];
    chapters?: { id: string; index: number; targetPages: number }[];
    planVersions?: { id: string; planningPackage: unknown; inputSnapshot: unknown }[];
    pdfPageMap?: unknown;
    currentPlanId?: string | null;
    targetPages?: number;
    archivedSnapshots?: Record<string, unknown>[];
  } = {}
) => {
  const order: string[] = [];
  const track = <T>(name: string, result: T) =>
    vi.fn(async () => {
      order.push(name);
      return result;
    });
  return {
    order,
    $executeRawUnsafe: track("raw", 0),
    /** The re-point's collision probe. Untracked, and empty: a restored ordering displaces nothing. */
    $queryRawUnsafe: vi.fn(async () => []),
    page: {
      createMany: track("page.createMany", {}),
      deleteMany: track("page.deleteMany", {}),
      updateMany: track("page.updateMany", {}),
      findMany: track(
        "page.findMany",
        options.currentPages ?? [
          { id: "page-1", index: 1 },
          { id: "page-2", index: 2 },
          { id: "page-3", index: 3 }
        ]
      )
    },
    pageEditSnapshot: { createMany: track("pageEditSnapshot.createMany", { count: 0 }) },
    archivedPageEditSnapshot: {
      findMany: track("archivedPageEditSnapshot.findMany", options.archivedSnapshots ?? []),
      deleteMany: track("archivedPageEditSnapshot.deleteMany", { count: options.archivedSnapshots?.length ?? 0 })
    },
    imageAsset: { updateMany: track("imageAsset.updateMany", {}) },
    continuityNote: { deleteMany: track("continuityNote.deleteMany", { count: 0 }) },
    embedding: { deleteMany: track("embedding.deleteMany", { count: 0 }) },
    chapter: {
      findMany: track("chapter.findMany", options.chapters ?? []),
      updateMany: track("chapter.updateMany", {})
    },
    planVersion: {
      findMany: track("planVersion.findMany", options.planVersions ?? []),
      update: track("planVersion.update", {}),
      deleteMany: track("planVersion.deleteMany", {})
    },
    project: {
      update: track("project.update", {}),
      findUnique: track("project.findUnique", {
        pdfPageMap: options.pdfPageMap ?? null,
        currentPlanId: options.currentPlanId === undefined ? "plan-2" : options.currentPlanId,
        targetPages: options.targetPages ?? 3
      })
    }
  };
};

/** The `{ pageId, index }` list pass one of the ordering was handed. */
const replayedOrder = (tx: ReturnType<typeof transaction>): { pageId: string; index: number }[] => {
  // The statement, then the project id, then the flattened `(pageId, index)` pairs.
  const [, , ...params] = (tx.$executeRawUnsafe.mock.calls.at(0) as unknown[] | undefined) ?? [];
  const entries: { pageId: string; index: number }[] = [];
  for (let offset = 0; offset < params.length; offset += 2) {
    entries.push({ pageId: params[offset] as string, index: params[offset + 1] as number });
  }
  return entries;
};

const projectWriteData = (tx: ReturnType<typeof transaction>): Record<string, unknown> =>
  (tx.project.update.mock.calls.at(0)?.at(0) as { data: Record<string, unknown> } | undefined)?.data ?? {};

describe("reverting a structural page change", () => {
  it("removes the pages the edit created and restores the old order", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", application({ insertedPageIds: ["new-1", "new-2"] }));

    expect(tx.page.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", id: { in: ["new-1", "new-2"] } }
    });
    // Two passes for the ordering, one for continuity scopes, then two more for
    // the embedding scopes: `Embedding` carries `@@unique([projectId, scope])`,
    // so that re-point parks and lands for the same reason the ordering does.
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(5);
  });

  it("takes inserted-page continuity notes before Undo reuses their indexes", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", application({ insertedPageIds: ["new-1"] }));

    expect(tx.continuityNote.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { projectId: "project-1", pageId: null, scope: { startsWith: "page:" } }
    });
    expect(tx.continuityNote.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { projectId: "project-1", pageId: { in: ["new-1"] } }
    });
    expect(tx.order.indexOf("continuityNote.deleteMany")).toBeLessThan(tx.order.indexOf("page.deleteMany"));
  });

  it("takes the semantic memory of the pages it removes, before the survivors move onto their scopes", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", application({ insertedPageIds: ["new-1", "new-2"] }));

    // `Embedding` cascades on `Project`, not on `Page`, so deleting the row the
    // insert created leaves a `page:<index>` summary behind — and the reverse
    // renumber immediately below puts a surviving page on that index. Keyed on
    // `sourceId`, which is what survives a renumber, and held to `page:%` so a
    // research row sharing the id is left alone.
    expect(tx.embedding.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", sourceId: { in: ["new-1", "new-2"] }, scope: { startsWith: "page:" } }
    });
    expect(tx.order.indexOf("embedding.deleteMany")).toBeLessThan(tx.order.indexOf("raw"));
  });

  it("brings deleted pages back with their own ids, before the ordering names them", async () => {
    const tx = transaction();
    const removed = {
      id: "page-2",
      index: 2,
      chapterId: "chapter-1",
      title: "The Middle",
      markdown: "Body.",
      summary: "Summary.",
      imagePrompt: null,
      revision: 3,
      imageAssetIds: ["asset-1"]
    };

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({ action: "delete", removedPages: [removed] })
    );

    // The original id is what lets the unlinked illustration be pointed back,
    // and the negative index parks the row until the ordering runs.
    expect(tx.page.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ id: "page-2", index: -2, markdown: "Body.", revision: 3 })],
        skipDuplicates: true
      })
    );
    expect(tx.imageAsset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["asset-1"] }, projectId: "project-1" },
      data: { pageId: "page-2" }
    });
    // Recreate, then reorder — the other way round leaves the restored page
    // sitting at a negative index the ordering never mentions.
    expect(tx.order.indexOf("page.createMany")).toBeLessThan(tx.order.indexOf("raw"));
  });

  it("restores archived snapshots with their original ids and fields before retiring the archive", async () => {
    const createdAt = new Date("2026-08-14T10:30:00.000Z");
    const archived = {
      id: "snapshot-old",
      projectId: "project-1",
      pageId: "page-2",
      operationId: "operation-old",
      archiveKey: "operation-delete",
      pageIndex: 2,
      titleBefore: "Before title",
      markdownBefore: "Before body",
      summaryBefore: "Before summary",
      revisionBefore: 4,
      storyDeltaBefore: { factsAdded: ["Before fact"] },
      titleAfter: "After title",
      markdownAfter: "After body",
      summaryAfter: "After summary",
      revisionAfter: 5,
      createdAt,
      archivedAt: new Date("2026-08-15T00:00:00.000Z")
    };
    const tx = transaction({ archivedSnapshots: [archived] });
    const removed = {
      id: "page-2",
      index: 2,
      chapterId: "chapter-1",
      title: "The Middle",
      markdown: "Body.",
      summary: "Summary.",
      imagePrompt: null,
      revision: 3,
      imageAssetIds: []
    };

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({
        action: "delete",
        removedPages: [removed],
        snapshotArchive: { key: "operation-delete", snapshotCount: 1 }
      })
    );

    expect(tx.pageEditSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: archived.id,
          projectId: archived.projectId,
          pageId: archived.pageId,
          operationId: archived.operationId,
          pageIndex: archived.pageIndex,
          titleBefore: archived.titleBefore,
          markdownBefore: archived.markdownBefore,
          summaryBefore: archived.summaryBefore,
          revisionBefore: archived.revisionBefore,
          storyDeltaBefore: archived.storyDeltaBefore,
          titleAfter: archived.titleAfter,
          markdownAfter: archived.markdownAfter,
          summaryAfter: archived.summaryAfter,
          revisionAfter: archived.revisionAfter,
          createdAt
        }
      ],
      skipDuplicates: true
    });
    expect(tx.archivedPageEditSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", archiveKey: "operation-delete" }
    });
    expect(tx.order.indexOf("page.createMany")).toBeLessThan(tx.order.indexOf("pageEditSnapshot.createMany"));
    expect(tx.order.indexOf("pageEditSnapshot.createMany")).toBeLessThan(
      tx.order.indexOf("archivedPageEditSnapshot.deleteMany")
    );
  });

  it("refuses a partial snapshot archive before changing a page", async () => {
    const tx = transaction({ archivedSnapshots: [] });

    await expect(
      revertStructuralPageChange(
        tx as never,
        "project-1",
        application({ snapshotArchive: { key: "operation-delete", snapshotCount: 2 } })
      )
    ).rejects.toThrow("expected 2 rows, found 0");

    expect(tx.page.createMany).not.toHaveBeenCalled();
    expect(tx.page.deleteMany).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("does not retire archived history when snapshot restoration fails", async () => {
    const archived = {
      id: "snapshot-old",
      projectId: "project-1",
      pageId: "page-2",
      operationId: "operation-old",
      archiveKey: "operation-delete",
      pageIndex: 2,
      titleBefore: "Before",
      markdownBefore: "Before body",
      summaryBefore: "Before summary",
      revisionBefore: 1,
      storyDeltaBefore: null,
      titleAfter: "After",
      markdownAfter: "After body",
      summaryAfter: "After summary",
      revisionAfter: 2,
      createdAt: new Date("2026-08-14T10:30:00.000Z")
    };
    const tx = transaction({ archivedSnapshots: [archived] });
    tx.pageEditSnapshot.createMany.mockRejectedValueOnce(new Error("snapshot restore failed"));

    await expect(
      revertStructuralPageChange(
        tx as never,
        "project-1",
        application({
          action: "delete",
          removedPages: [
            {
              id: "page-2",
              index: 2,
              chapterId: null,
              title: "Page 2",
              markdown: "Body",
              summary: "Summary",
              imagePrompt: null,
              revision: 2,
              imageAssetIds: []
            }
          ],
          snapshotArchive: { key: "operation-delete", snapshotCount: 1 }
        })
      )
    ).rejects.toThrow("snapshot restore failed");

    // In production the surrounding transaction rolls the recreated Page back
    // too. The durable archive is not deleted first, so a failed compensation
    // still has the complete earlier Undo record for the next delivery.
    expect(tx.archivedPageEditSnapshot.deleteMany).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("puts the plan, the length and the page map back", async () => {
    const tx = transaction();

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({ previousChapterTargetPages: { "chapter-1": 4 } })
    );

    expect(tx.chapter.updateMany).toHaveBeenCalledWith({
      where: { id: "chapter-1", projectId: "project-1" },
      data: { targetPages: 4 }
    });
    expect(tx.planVersion.update).toHaveBeenCalledWith({ where: { id: "plan-1" }, data: { status: "APPROVED" } });
    expect(tx.planVersion.deleteMany).toHaveBeenCalledWith({ where: { id: "plan-2" } });
    // targetPages must go back on the *snapshot's* terms too, which is what the
    // restored plan version carries; the project row is the other half.
    expect(tx.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1" },
        data: expect.objectContaining({ currentPlanId: "plan-1", targetPages: 3 })
      })
    );
    // Nothing stored to carry, and nothing to clear either: a blank column and
    // the cover-skip stub are both left exactly as they are.
    expect(projectWriteData(tx)).not.toHaveProperty("pdfPageMap");
  });

  it("answers with the plan version it restored, not the one it deleted", async () => {
    const tx = transaction();

    const restored = await revertStructuralPageChange(tx as never, "project-1", application());

    // This is what the reader's Undo names in the recompile it queues. Reusing
    // the id it was holding — `plan-2`, deleted just above — points
    // `compile-export` at a row that is gone, and that job owns the book's
    // outcome: a finished, paid book marked FAILED and its generation refunded.
    expect(restored).toEqual({ currentPlanId: "plan-1" });
  });

  it("answers with nothing when the deleted version was all the project had", async () => {
    const tx = transaction({ currentPlanId: "plan-2" });

    const restored = await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({ basePlanVersionId: null })
    );

    // Nothing to restore, and the foreign key is ON DELETE SET NULL, so the
    // book is left on no plan at all rather than on a deleted one.
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ currentPlanId: null, targetPages: 3 })
    });
    expect(restored).toEqual({ currentPlanId: null });
  });

  it("leaves an untouched plan alone when the stamp created no version", async () => {
    const tx = transaction({ currentPlanId: "plan-1" });

    const restored = await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({ action: "move", basePlanVersionId: null, newPlanVersionId: null })
    );

    expect(tx.planVersion.deleteMany).not.toHaveBeenCalled();
    expect(restored).toEqual({ currentPlanId: "plan-1" });
  });

  it("writes no page rows at all for a plain reorder", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", application({ action: "move" }));

    expect(tx.page.createMany).not.toHaveBeenCalled();
    expect(tx.page.deleteMany).not.toHaveBeenCalled();
    // This fixture is deliberately a legacy stamp: no recorded chapter means
    // no chapter write, rather than treating the missing value as null.
    expect(tx.page.updateMany).not.toHaveBeenCalled();
    // No page is going away, so no memory is either — the reorder only moves
    // the scopes it already has.
    expect(tx.embedding.deleteMany).not.toHaveBeenCalled();
    // Two ordering passes, the continuity re-point, then the embedding
    // re-point's own park-and-land pair.
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(5);
    const [continuitySql, ...continuityParams] = tx.$executeRawUnsafe.mock.calls[2] as unknown[];
    expect(continuitySql).toContain('UPDATE "ContinuityNote"');
    expect(continuityParams).toEqual(["project-1", "page-1", 1, "page-2", 2, "page-3", 3]);
    expect(tx.continuityNote.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", pageId: null, scope: { startsWith: "page:" } }
    });
  });

  it("restores the chapter membership a cross-chapter move changed", async () => {
    const tx = transaction({
      currentPages: [
        { id: "page-1", index: 1, chapterId: "chapter-1" },
        { id: "page-3", index: 2, chapterId: "chapter-2" },
        // The move put page 2 under chapter 2 as well as moving its index.
        { id: "page-2", index: 3, chapterId: "chapter-2" }
      ]
    });

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({
        action: "move",
        pageOrderBefore: [
          { pageId: "page-1", index: 1, chapterId: "chapter-1" },
          { pageId: "page-2", index: 2, chapterId: "chapter-1" },
          { pageId: "page-3", index: 3, chapterId: "chapter-2" }
        ]
      })
    );

    expect(replayedOrder(tx)).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 },
      { pageId: "page-3", index: 3 }
    ]);
    expect(tx.page.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.page.updateMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", id: { in: ["page-2"] } },
      data: { chapterId: "chapter-1" }
    });
  });

  it("replays the recorded order untouched when the book still has exactly those pages", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", application({ action: "move" }));

    expect(replayedOrder(tx)).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 },
      { pageId: "page-3", index: 3 }
    ]);
  });

  it("keeps a continuation plan current and removes only the structural target delta", async () => {
    // The reader continued the book after the insert and then undid the insert.
    // `CONTINUE_BOOK` is not an undoable kind, so `undoLastBookEdit` reaches
    // straight past it to the structural stamp — whose `pageOrderBefore` names
    // three pages of a book that now has six.
    const tx = transaction({
      currentPlanId: "plan-3",
      targetPages: 6,
      currentPages: [
        { id: "page-1", index: 1, chapterId: "chapter-1" },
        { id: "new-1", index: 2, chapterId: "chapter-1" },
        { id: "page-2", index: 3, chapterId: "chapter-1" },
        { id: "page-3", index: 4, chapterId: "chapter-1" },
        { id: "continued-1", index: 5, chapterId: "chapter-2" },
        { id: "continued-2", index: 6, chapterId: "chapter-2" }
      ],
      chapters: [
        { id: "chapter-1", index: 1, targetPages: 4 },
        { id: "chapter-2", index: 2, targetPages: 2 }
      ],
      planVersions: [
        {
          id: "plan-1",
          planningPackage: {
            title: "Book",
            chapters: [{ index: 1, title: "Opening", summary: "Start", targetPages: 3 }]
          },
          inputSnapshot: { prompt: "Book", targetPages: 3 }
        },
        {
          id: "plan-2",
          planningPackage: {
            title: "Book",
            chapters: [{ index: 1, title: "Opening", summary: "Start", targetPages: 4 }]
          },
          inputSnapshot: { prompt: "Book", targetPages: 4 }
        },
        {
          id: "plan-3",
          planningPackage: {
            title: "Book",
            chapters: [
              { index: 1, title: "Opening", summary: "Start", targetPages: 4 },
              { index: 2, title: "Continuation", summary: "More", targetPages: 2 }
            ]
          },
          inputSnapshot: { prompt: "Book", targetPages: 6 }
        }
      ]
    });

    const restored = await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({
        pageOrderBefore: [
          { pageId: "page-1", index: 1, chapterId: "chapter-1" },
          { pageId: "page-2", index: 2, chapterId: "chapter-1" },
          { pageId: "page-3", index: 3, chapterId: "chapter-1" }
        ],
        insertedPageIds: ["new-1"],
        previousChapterTargetPages: { "chapter-1": 3 }
      })
    );

    // Replaying the recorded three alone leaves the continuation stranded at 5
    // and 6 with a hole at 4 — invisible until a compile refuses the book for
    // not being contiguous from 1 — and a delete's undo would instead land a
    // restored page on an index the continuation still holds.
    expect(replayedOrder(tx)).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 },
      { pageId: "page-3", index: 3 },
      { pageId: "continued-1", index: 4 },
      { pageId: "continued-2", index: 5 }
    ]);
    // P3 is a compatible descendant of P2, so undo must not orphan it by
    // restoring P1 or delete the P2 it was built from. Only the +1 target-page
    // delta introduced by P2 is removed; P3's continuation chapter survives.
    expect(restored).toEqual({ currentPlanId: "plan-3" });
    expect(tx.planVersion.update).toHaveBeenCalledTimes(1);
    expect(tx.planVersion.update).toHaveBeenCalledWith({
      where: { id: "plan-3" },
      data: {
        planningPackage: {
          title: "Book",
          chapters: [
            { index: 1, title: "Opening", summary: "Start", targetPages: 3 },
            { index: 2, title: "Continuation", summary: "More", targetPages: 2 }
          ]
        },
        inputSnapshot: { prompt: "Book", targetPages: 5 }
      }
    });
    expect(tx.planVersion.deleteMany).not.toHaveBeenCalled();
    expect(tx.chapter.updateMany).toHaveBeenCalledWith({
      where: { id: "chapter-1", projectId: "project-1" },
      data: { targetPages: 3 }
    });
    expect(projectWriteData(tx)).toMatchObject({ currentPlanId: "plan-3", targetPages: 5 });
  });

  it("refuses an unrelated later plan before changing any page", async () => {
    const tx = transaction({
      currentPlanId: "plan-3",
      targetPages: 5,
      currentPages: [
        { id: "page-1", index: 1, chapterId: "chapter-1" },
        { id: "new-1", index: 2, chapterId: "chapter-1" },
        { id: "page-2", index: 3, chapterId: "chapter-1" },
        { id: "page-3", index: 4, chapterId: "chapter-1" },
        { id: "later-1", index: 5, chapterId: "chapter-2" }
      ],
      chapters: [
        { id: "chapter-1", index: 1, targetPages: 4 },
        { id: "chapter-2", index: 2, targetPages: 1 }
      ],
      planVersions: [
        {
          id: "plan-1",
          planningPackage: { title: "Book", chapters: [{ index: 1, title: "One", targetPages: 3 }] },
          inputSnapshot: { targetPages: 3 }
        },
        {
          id: "plan-2",
          planningPackage: { title: "Book", chapters: [{ index: 1, title: "One", targetPages: 4 }] },
          inputSnapshot: { targetPages: 4 }
        },
        {
          id: "plan-3",
          // Not a continuation: it revised the plan itself, so subtracting P2's
          // delta by chapter position would be a guess about unrelated work.
          planningPackage: {
            title: "Retold Book",
            chapters: [
              { index: 1, title: "Rewritten", targetPages: 4 },
              { index: 2, title: "Later", targetPages: 1 }
            ]
          },
          inputSnapshot: { targetPages: 5 }
        }
      ]
    });

    await expect(
      revertStructuralPageChange(
        tx as never,
        "project-1",
        application({ insertedPageIds: ["new-1"], previousChapterTargetPages: { "chapter-1": 3 } })
      )
    ).rejects.toThrow("compatible continuation");

    // Lineage validation is part of the transaction's read phase. An unsafe
    // undo cannot remove an inserted page and only then discover it has no plan
    // that can compile the pages left behind.
    expect(tx.page.deleteMany).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("closes the gap a page the stamp names but the book has lost would leave", async () => {
    const tx = transaction({
      currentPlanId: null,
      currentPages: [
        { id: "page-1", index: 1 },
        { id: "page-3", index: 2 }
      ]
    });

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({ action: "move", basePlanVersionId: null, newPlanVersionId: null })
    );

    // `page-2` went with something this stamp does not restore, so naming it
    // would only reserve index 2 for a row that is not coming back.
    expect(replayedOrder(tx)).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-3", index: 2 }
    ]);
  });

  it("numbers a restored page the recorded order does not name", async () => {
    // The two lists agree by construction — the shift reads both out of one
    // `findMany` — so this is the stamp that disagrees anyway. The row is
    // recreated from `removedPages` at `-2` whatever the ordering says, and the
    // un-park is by sign: leaving it out of the list lands it back on its
    // pre-edit index while `page-3` is being renumbered onto the same one.
    const tx = transaction({
      currentPages: [
        { id: "page-1", index: 1 },
        { id: "page-3", index: 2 }
      ]
    });

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({
        action: "delete",
        pageOrderBefore: [
          { pageId: "page-1", index: 1 },
          { pageId: "page-3", index: 3 }
        ],
        removedPages: [
          {
            id: "page-2",
            index: 2,
            chapterId: null,
            title: "The Middle",
            markdown: "Body.",
            summary: "Summary.",
            imagePrompt: null,
            revision: 1,
            imageAssetIds: []
          }
        ]
      })
    );

    expect(tx.page.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ id: "page-2", index: -2 })] })
    );
    // Its recorded `index` is the same pre-edit number its `pageOrderBefore`
    // twin would have carried, so it slots back where it was rather than at the
    // tail — and the list runs 1..3 with nothing left parked.
    expect(replayedOrder(tx)).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 },
      { pageId: "page-3", index: 3 }
    ]);
  });

  it("does not call a page it folded in drift, so the base plan is still restored", async () => {
    const tx = transaction({
      currentPages: [
        { id: "page-1", index: 1 },
        { id: "page-3", index: 2 }
      ]
    });

    const restored = await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({
        action: "delete",
        pageOrderBefore: [
          { pageId: "page-1", index: 1 },
          { pageId: "page-3", index: 3 }
        ],
        removedPages: [
          {
            id: "page-2",
            index: 2,
            chapterId: null,
            title: "The Middle",
            markdown: "Body.",
            summary: "Summary.",
            imagePrompt: null,
            revision: 1,
            imageAssetIds: []
          }
        ]
      })
    );

    // Drift means the *book* gained or lost a page since the stamp, and this
    // book did neither: the page is recorded, just in the stamp's other list.
    // Counting it as drift would refuse the undo outright — P1 is restorable
    // only for a book the stamp still describes.
    expect(restored).toEqual({ currentPlanId: "plan-1" });
    expect(tx.planVersion.deleteMany).toHaveBeenCalledWith({ where: { id: "plan-2" } });
    expect(projectWriteData(tx)).toMatchObject({ currentPlanId: "plan-1", targetPages: 3 });
  });

  it("names a removed page once when the stamp records it in both lists", async () => {
    const tx = transaction({
      currentPages: [
        { id: "page-1", index: 1 },
        { id: "page-3", index: 2 }
      ]
    });

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({
        action: "delete",
        removedPages: [
          {
            id: "page-2",
            index: 2,
            chapterId: null,
            title: "The Middle",
            markdown: "Body.",
            summary: "Summary.",
            imagePrompt: null,
            revision: 1,
            imageAssetIds: []
          }
        ]
      })
    );

    // The ordinary stamp: folding is a no-op on it, and a second entry for
    // `page-2` would park the same row twice at two different indexes.
    expect(replayedOrder(tx)).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 },
      { pageId: "page-3", index: 3 }
    ]);
  });
});

describe("the page map a revert leaves behind", () => {
  it("moves a reorder's indexes back and keeps the ranges", async () => {
    // The reader moved page 3 to the front, so the compiled PDF the map was
    // measured from — and which the reader is still looking at — holds the old
    // page 3 first. Undoing puts the indexes back; the sheets do not move.
    const tx = transaction({
      currentPages: [
        { id: "page-3", index: 1 },
        { id: "page-1", index: 2 },
        { id: "page-2", index: 3 }
      ],
      pdfPageMap: storedMap([
        { index: 1, startPdfPage: 3, endPdfPage: 4 },
        { index: 2, startPdfPage: 5, endPdfPage: 6 },
        { index: 3, startPdfPage: 7, endPdfPage: 9 }
      ])
    });

    await revertStructuralPageChange(tx as never, "project-1", application({ action: "move" }));

    expect(projectWriteData(tx).pdfPageMap).toEqual(
      expect.objectContaining({
        totalPdfPages: 12,
        hasCoverPage: true,
        contentsStartPdfPage: 2,
        // The stamp names the publication the ranges were measured from, and
        // that is what keeps the map in force while the exports rebuild.
        contentRevision: 7,
        pages: [
          { index: 3, startPdfPage: 3, endPdfPage: 4 },
          { index: 1, startPdfPage: 5, endPdfPage: 6 },
          { index: 2, startPdfPage: 7, endPdfPage: 9 }
        ]
      })
    );
  });

  it("keeps the map when undoing a delete, because the restored page is on no sheet", async () => {
    const tx = transaction({
      currentPages: [
        { id: "page-1", index: 1 },
        { id: "page-3", index: 2 }
      ],
      pdfPageMap: storedMap([
        { index: 1, startPdfPage: 3, endPdfPage: 4 },
        { index: 2, startPdfPage: 5, endPdfPage: 6 }
      ])
    });

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      application({
        action: "delete",
        removedPages: [
          {
            id: "page-2",
            index: 2,
            chapterId: null,
            title: "The Middle",
            markdown: "Body.",
            summary: "Summary.",
            imagePrompt: null,
            revision: 1,
            imageAssetIds: []
          }
        ]
      })
    );

    // Page 2 comes back at an index the PDF on screen has never printed, which
    // `displayPages` already answers with the raw index. Every range the map
    // does hold still names a page that exists.
    expect(projectWriteData(tx).pdfPageMap).toEqual(
      expect.objectContaining({
        pages: [
          { index: 1, startPdfPage: 3, endPdfPage: 4 },
          { index: 3, startPdfPage: 5, endPdfPage: 6 }
        ]
      })
    );
  });

  it("drops the ranges when undoing an insert, keeping the cover numbering", async () => {
    const tx = transaction({
      currentPages: [
        { id: "page-1", index: 1 },
        { id: "new-1", index: 2 },
        { id: "page-2", index: 3 },
        { id: "page-3", index: 4 }
      ],
      pdfPageMap: storedMap([
        { index: 1, startPdfPage: 3, endPdfPage: 4 },
        { index: 2, startPdfPage: 5, endPdfPage: 5 },
        { index: 3, startPdfPage: 6, endPdfPage: 7 },
        { index: 4, startPdfPage: 8, endPdfPage: 9 }
      ])
    });

    await revertStructuralPageChange(tx as never, "project-1", application({ insertedPageIds: ["new-1"] }));

    // PDF page 5 holds prose that is about to leave the book, and a map with a
    // gap reads that sheet as furniture — worse than no map at all. The cover
    // skip under those ranges survives them: the file is unchanged, so chrome
    // must keep matching its footer.
    expect(projectWriteData(tx).pdfPageMap).toEqual({ ...bookPdfCoverNumbering(true), contentRevision: 7 });
  });
});
