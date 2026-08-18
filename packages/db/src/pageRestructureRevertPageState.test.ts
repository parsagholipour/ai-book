import { describe, expect, it, vi } from "vitest";
import { type RemovedPageRecord, type StructuralApplication } from "@book-maker/core";
import { revertStructuralPageChange } from "./pageRestructureRevert.ts";

/**
 * What a restored page is *made of*.
 *
 * The rest of the revert's behaviour lives in `pageRestructureRevert.test.ts`;
 * this file is only about the row `page.createMany` writes, because that row
 * used to be an invention: `status: "COMPLETED"` flat, and no `qualityReport`
 * or `imageFailureReason` recorded at all. Undoing the deletion of a page the
 * reviewer had refused therefore approved it, and undoing the deletion of the
 * only page whose illustration failed erased the marker
 * `projectAlreadyIllustrated` reads — letting the same month's free-tier
 * illustrated-book slot be claimed twice.
 */

/** A three-page book losing its middle page. */
const deletePageTwo = (removed: RemovedPageRecord): StructuralApplication => ({
  action: "delete",
  pageOrderBefore: [
    { pageId: "page-1", index: 1 },
    { pageId: "page-2", index: 2 },
    { pageId: "page-3", index: 3 }
  ],
  insertedPageIds: [],
  removedPages: [removed],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 3,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-19T00:00:00.000Z"
});

/** Everything the stamp carried before page state joined it. */
const legacyRecord: RemovedPageRecord = {
  id: "page-2",
  index: 2,
  chapterId: "chapter-1",
  title: "The Middle",
  markdown: "Body.",
  summary: "Summary.",
  imagePrompt: "An ink drawing of a lighthouse.",
  revision: 3,
  imageAssetIds: []
};

const transaction = () => {
  const track = <T>(result: T) => vi.fn(async () => result);
  return {
    $executeRawUnsafe: track(0),
    page: {
      createMany: track({}),
      deleteMany: track({}),
      updateMany: track({}),
      findMany: track([
        { id: "page-1", index: 1 },
        { id: "page-3", index: 2 }
      ])
    },
    pageEditSnapshot: { createMany: track({ count: 0 }) },
    archivedPageEditSnapshot: { findMany: track([]), deleteMany: track({ count: 0 }) },
    imageAsset: { updateMany: track({}) },
    continuityNote: { deleteMany: track({ count: 0 }) },
    embedding: { deleteMany: track({ count: 0 }) },
    chapter: { findMany: track([]), updateMany: track({}) },
    planVersion: { findMany: track([]), update: track({}), deleteMany: track({}) },
    project: {
      update: track({}),
      findUnique: track({ pdfPageMap: null, currentPlanId: "plan-2", targetPages: 3 })
    }
  };
};

/** The single row the revert recreated. */
const recreatedPage = (tx: ReturnType<typeof transaction>): Record<string, unknown> => {
  const call = tx.page.createMany.mock.calls.at(0)?.at(0) as { data: Record<string, unknown>[] } | undefined;
  const [row] = call?.data ?? [];
  if (!row) {
    throw new Error("the revert recreated no page");
  }
  return row;
};

describe("restoring a deleted page's own state", () => {
  it("brings a refused page back refused, with the report that refused it", async () => {
    const tx = transaction();
    const qualityReport = { approved: false, issues: ["The scene repeats page 1."], score: 42 };

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      deletePageTwo({ ...legacyRecord, status: "FAILED_QA", qualityReport })
    );

    // `COMPLETED` here would be this revert approving prose the review refused,
    // and nothing downstream would ever look at the page again.
    expect(recreatedPage(tx)).toMatchObject({ id: "page-2", status: "FAILED_QA", qualityReport });
  });

  it("brings back the image-failure marker the free-tier quota counts", async () => {
    const tx = transaction();

    await revertStructuralPageChange(
      tx as never,
      "project-1",
      deletePageTwo({ ...legacyRecord, status: "COMPLETED", imageFailureReason: "every provider refused the prompt" })
    );

    // `projectAlreadyIllustrated` reads this column: a book that loses its only
    // one stops counting as illustrated, and the next `add_image` claims a
    // second free-tier illustrated-book slot in the same month.
    expect(recreatedPage(tx)).toMatchObject({
      status: "COMPLETED",
      imageFailureReason: "every provider refused the prompt"
    });
  });

  it("writes no report and no failure reason for a page that had neither", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", deletePageTwo({ ...legacyRecord, status: "COMPLETED" }));

    const row = recreatedPage(tx);
    expect(row).toMatchObject({ status: "COMPLETED" });
    // Absent, not null: `Json?` and `String?` take their column defaults, and
    // an explicit JSON null is not the same value as no report.
    expect(row).not.toHaveProperty("qualityReport");
    expect(row).not.toHaveProperty("imageFailureReason");
  });

  it("keeps the old defaults for a stamp written before page state was recorded", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", deletePageTwo(legacyRecord));

    // Already-stored Undo history has none of the three fields, and the only
    // honest answer for it is the one this revert always gave.
    const row = recreatedPage(tx);
    expect(row).toMatchObject({ id: "page-2", index: -2, status: "COMPLETED", revision: 3 });
    expect(row).not.toHaveProperty("qualityReport");
    expect(row).not.toHaveProperty("imageFailureReason");
  });
});
