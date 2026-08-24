import { describe, expect, it, vi } from "vitest";
import type { StructuralApplication } from "@book-maker/core";
import { revertStructuralPageChange } from "./pageRestructureRevert.ts";

const application: StructuralApplication = {
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
  appliedAt: "2026-08-15T00:00:00.000Z"
};

function transaction() {
  const order: string[] = [];
  const track = <T>(name: string, result: T) =>
    vi.fn(async () => {
      order.push(name);
      return result;
    });
  const pages = [
    { id: "page-1", index: 1, chapterId: null, images: [] },
    {
      id: "page-2",
      index: 2,
      chapterId: null,
      images: [
        {
          id: "native-page-2-render",
          type: "SCENE_ILLUSTRATION",
          path: "https://api.example/assets/images/project-1/page-2.png",
          metadata: { model: "legacy" }
        },
        {
          id: "page-1-hero-moved-to-page-2",
          type: "SCENE_ILLUSTRATION",
          path: "https://api.example/assets/images/project-1/page-1.webp",
          metadata: {}
        },
        {
          id: "render-with-missing-source",
          type: "DIAGRAM",
          path: "https://api.example/assets/images/project-1/page-9.jpg",
          metadata: {}
        }
      ]
    },
    { id: "page-3", index: 3, chapterId: null, images: [] }
  ];
  return {
    order,
    $executeRawUnsafe: track("page-order", 0),
    $queryRawUnsafe: vi.fn(async () => []),
    page: {
      findMany: track("page.findMany", pages),
      createMany: track("page.createMany", {}),
      deleteMany: track("page.deleteMany", {}),
      updateMany: track("page.updateMany", {})
    },
    imageAsset: {
      update: track("imageAsset.update", {}),
      updateMany: track("imageAsset.updateMany", {})
    },
    pageEditSnapshot: { createMany: track("pageEditSnapshot.createMany", {}) },
    archivedPageEditSnapshot: {
      findMany: track("archivedPageEditSnapshot.findMany", []),
      deleteMany: track("archivedPageEditSnapshot.deleteMany", {})
    },
    continuityNote: { deleteMany: track("continuityNote.deleteMany", {}) },
    embedding: { deleteMany: track("embedding.deleteMany", {}) },
    chapter: {
      findMany: track("chapter.findMany", []),
      updateMany: track("chapter.updateMany", {})
    },
    planVersion: {
      findMany: track("planVersion.findMany", []),
      update: track("planVersion.update", {}),
      deleteMany: track("planVersion.deleteMany", {})
    },
    project: {
      findUnique: track("project.findUnique", {
        pdfPageMap: null,
        currentPlanId: "plan-2",
        targetPages: 3
      }),
      update: track("project.update", {})
    }
  };
}

describe("structural revert illustration ownership", () => {
  it("stamps native, moved, and missing numeric sources before restoring page order", async () => {
    const tx = transaction();

    await revertStructuralPageChange(tx as never, "project-1", application);

    expect(tx.page.findMany).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
      select: {
        id: true,
        index: true,
        chapterId: true,
        images: { select: { id: true, type: true, path: true, metadata: true } }
      }
    });
    expect(tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "native-page-2-render" },
      data: { metadata: { model: "legacy", legacyGeneratedPageId: "page-2" } }
    });
    expect(tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "page-1-hero-moved-to-page-2" },
      data: { metadata: { legacyGeneratedPageId: "page-1" } }
    });
    expect(tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "render-with-missing-source" },
      data: { metadata: { legacyGeneratedPageId: "migrated-legacy-source-missing:9" } }
    });
    expect(tx.order.lastIndexOf("imageAsset.update")).toBeLessThan(tx.order.indexOf("page-order"));
  });
});
