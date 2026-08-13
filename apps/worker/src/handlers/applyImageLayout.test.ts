import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    page: { findFirst: vi.fn() },
    imageAsset: { findFirst: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    page: { findUnique: vi.fn(), update: vi.fn() },
    pageEditSnapshot: { create: vi.fn() },
    project: { update: vi.fn(), findUnique: vi.fn() },
    imageAsset: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() }
  },
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports
}));

import { applyImageLayout } from "./applyImageLayout.js";

const sourcePage = {
  id: "page-1",
  index: 1,
  title: "One",
  markdown: "Prose.\n\n![a dragon](/assets/images/project-1/chat-image-op-old-aaaa.jpg)\n\nMore.",
  summary: "S",
  revision: 3,
  imagePrompt: null
};

const destPage = {
  id: "page-2",
  index: 2,
  title: "Two",
  markdown: "Later prose.",
  summary: "T",
  revision: 4,
  imagePrompt: "a fox"
};

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: "Move the picture to page 2",
      affectedPageIndexes: [1, 2],
      planId: "plan-1",
      intentKind: "move_image",
      generationJobId: "gen-1",
      ...data
    }
  }) as unknown as Job;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "QUEUED", classifier: {} });
  mocks.prisma.project.findUnique.mockResolvedValue({ status: "COMPLETE", currentPlanId: "plan-1" });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ classifier: {} });
  mocks.tx.bookEditOperation.update.mockResolvedValue({});
  mocks.tx.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === "page-1") {
      return { ...sourcePage };
    }
    if (where.id === "page-2") {
      return { ...destPage };
    }
    return null;
  });
  mocks.tx.project.update.mockResolvedValue({});
  mocks.tx.project.findUnique.mockResolvedValue({ language: "en" });
  mocks.tx.pageEditSnapshot.create.mockResolvedValue({ id: "snap-1" });
  mocks.tx.imageAsset.update.mockResolvedValue({});
  mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
});

describe("applyImageLayout", () => {
  it("cuts a markdown image from the source page and appends it on the dest page", async () => {
    mocks.prisma.page.findFirst.mockResolvedValueOnce({ ...sourcePage }).mockResolvedValueOnce({ ...destPage });
    mocks.tx.page.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { markdown?: string } }) =>
      where.id === "page-1"
        ? { ...sourcePage, markdown: data.markdown ?? sourcePage.markdown, revision: 4 }
        : { ...destPage, markdown: data.markdown ?? destPage.markdown, revision: 5 }
    );

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          source: { pageIndex: 1, replaceMarker: "chat-image-op-old" },
          dest: { placement: "page", pageIndex: 2 }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: {
        markdown: "Prose.\n\nMore.",
        revision: { increment: 1 }
      }
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-2" },
      data: {
        markdown: "Later prose.\n\n![a dragon](/assets/images/project-1/chat-image-op-old-aaaa.jpg)",
        revision: { increment: 1 }
      }
    });
    expect(mocks.tx.page.update.mock.calls[0]?.[0]?.where).toEqual({ id: "page-2" });
    expect(mocks.tx.page.update.mock.calls[1]?.[0]?.where).toEqual({ id: "page-1" });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
  });

  it("removes a markdown image and does not append it anywhere", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue({ ...sourcePage });
    mocks.tx.page.update.mockResolvedValue({ ...sourcePage, markdown: "Prose.\n\nMore.", revision: 4 });

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceMarker: "chat-image-op-old" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { markdown: "Prose.\n\nMore.", revision: { increment: 1 } }
    });
  });

  it("skips without appending when the marker is gone at delivery", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue(null);

    await applyImageLayout(
      job({
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceMarker: "chat-image-op-old" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          classifier: expect.objectContaining({ layoutMissing: true })
        })
      })
    );
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("skips without compiling when the marker is on the page but the image line is already gone", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue({ ...sourcePage });
    mocks.tx.page.findUnique.mockResolvedValue({ ...sourcePage, markdown: "Prose.\n\nMore." });

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceMarker: "chat-image-op-old" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.tx.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          classifier: expect.objectContaining({ layoutMissing: true })
        })
      })
    );
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("skips without compiling when the ImageAsset vanishes after queue", async () => {
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      page: { ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" }
    });
    mocks.tx.imageAsset.findUnique.mockResolvedValue(null);

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceAssetId: "asset-1" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ classifier: expect.objectContaining({ layoutMissing: true }) })
      })
    );
  });

  it("restores REVIEW_REQUIRED when a skipped layout edit never compiled", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "REVIEW_REQUIRED", currentPlanId: "plan-1" });
    mocks.prisma.page.findFirst.mockResolvedValue(null);

    await applyImageLayout(
      job({
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceMarker: "chat-image-op-old" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("skips without compiling when the marker is on the page but the image line is already gone", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue({ ...sourcePage });
    mocks.tx.page.findUnique.mockResolvedValue({ ...sourcePage, markdown: "Prose.\n\nMore." });

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceMarker: "chat-image-op-old" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.tx.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          classifier: expect.objectContaining({ layoutMissing: true })
        })
      })
    );
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("skips without compiling when the ImageAsset vanishes after queue", async () => {
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      page: { ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" }
    });
    mocks.tx.imageAsset.findUnique.mockResolvedValue(null);

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceAssetId: "asset-1" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ classifier: expect.objectContaining({ layoutMissing: true }) })
      })
    );
  });

  it("restores REVIEW_REQUIRED when a skipped layout edit never compiled", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "REVIEW_REQUIRED", currentPlanId: "plan-1" });
    mocks.prisma.page.findFirst.mockResolvedValue(null);

    await applyImageLayout(
      job({
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceMarker: "chat-image-op-old" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("reassigns a generation ImageAsset onto an empty dest page", async () => {
    const assetPage = { ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" };
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-1", page: assetPage });
    mocks.prisma.page.findFirst.mockResolvedValue({ ...destPage, imagePrompt: null });
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: "asset-1",
      path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
      prompt: "a dragon",
      pageId: "page-1"
    });
    mocks.tx.imageAsset.findFirst.mockResolvedValue(null);
    mocks.tx.page.update.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "page-1" ? { ...assetPage, revision: 4 } : { ...destPage, revision: 5 }
    );

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          source: { pageIndex: 1, replaceAssetId: "asset-1" },
          dest: { placement: "page", pageIndex: 2 }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: { pageId: "page-2" }
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { imagePrompt: null, revision: { increment: 1 } }
    });
  });

  it("demotes the dest page's existing hero to markdown when moving another hero onto it", async () => {
    const assetPage = { ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" };
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-moved", page: assetPage });
    mocks.prisma.page.findFirst.mockResolvedValue({ ...destPage });
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: "asset-moved",
      path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
      prompt: "a dragon",
      pageId: "page-1"
    });
    mocks.tx.imageAsset.findFirst.mockResolvedValue({
      id: "asset-dest",
      path: "http://localhost:4001/assets/images/project-1/page-2.jpg",
      prompt: "a fox"
    });
    mocks.tx.page.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { markdown?: string } }) =>
      where.id === "page-2"
        ? { ...destPage, markdown: data.markdown ?? destPage.markdown, revision: 5 }
        : { ...assetPage, revision: 4 }
    );

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          source: { pageIndex: 1, replaceAssetId: "asset-moved" },
          dest: { placement: "page", pageIndex: 2 }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-dest" },
      data: { pageId: null }
    });
    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-moved" },
      data: { pageId: "page-2" }
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-2" },
      data: expect.objectContaining({
        markdown: expect.stringContaining("/assets/images/project-1/page-2.jpg")
      })
    });
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          classifier: expect.objectContaining({
            previousAsset: expect.objectContaining({ id: "asset-moved", pageId: "page-1", destPageId: "page-2" }),
            demotedAsset: expect.objectContaining({ id: "asset-dest", pageId: "page-2" })
          })
        })
      })
    );
  });

  it("unlinks a generation ImageAsset on remove", async () => {
    const assetPage = { ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" };
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-1", page: assetPage });
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: "asset-1",
      path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
      prompt: "a dragon",
      pageId: "page-1"
    });
    mocks.tx.imageAsset.findFirst.mockResolvedValue(null);
    mocks.tx.page.update.mockResolvedValue({ ...assetPage, imagePrompt: null, revision: 4 });

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceAssetId: "asset-1" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: { pageId: null }
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { imagePrompt: null, revision: { increment: 1 } }
    });
  });
});
