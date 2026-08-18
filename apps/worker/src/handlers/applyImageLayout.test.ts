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
    page: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
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

/**
 * What the pages look like *inside* the transaction. The handler re-reads them
 * there rather than trusting the resolve pass, so a test that gives a page a
 * hero has to say so here and not only on the ImageAsset lookup.
 */
const txPages = new Map<string, Record<string, unknown>>();

const withTxPage = (page: Record<string, unknown>) => {
  txPages.set(page.id as string, page);
  return page;
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
  txPages.clear();
  txPages.set("page-1", { ...sourcePage });
  txPages.set("page-2", { ...destPage });
  mocks.tx.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => txPages.get(where.id) ?? null);
  // The batch reads every page it may touch in one query — the read that makes
  // one snapshot per page possible.
  mocks.tx.page.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => txPages.get(id)).filter(Boolean)
  );
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
          sources: [{ pageIndex: 1, replaceMarker: "chat-image-op-old" }],
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
    // Pages are flushed in reading order, so the snapshot rows land in a stable
    // order too rather than in whatever order the targets happened to resolve.
    expect(mocks.tx.page.update.mock.calls[0]?.[0]?.where).toEqual({ id: "page-1" });
    expect(mocks.tx.page.update.mock.calls[1]?.[0]?.where).toEqual({ id: "page-2" });
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
        imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceMarker: "chat-image-op-old" }] }
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
        imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceMarker: "chat-image-op-old" }] }
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
    // Found by the resolve pass, but the line is already gone by the time the
    // transaction re-reads the page.
    withTxPage({ ...sourcePage, markdown: "Prose.\n\nMore." });

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceMarker: "chat-image-op-old" }] }
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
        imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }] }
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
        imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceMarker: "chat-image-op-old" }] }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("reassigns a generation ImageAsset onto an empty dest page", async () => {
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
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
          sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }],
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
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
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
          sources: [{ pageIndex: 1, replaceAssetId: "asset-moved" }],
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
          affectedPageIndexes: [1, 2],
          classifier: expect.objectContaining({
            previousAssets: [
              expect.objectContaining({ id: "asset-moved", pageId: "page-1", destPageId: "page-2" })
            ],
            demotedAssets: [expect.objectContaining({ id: "asset-dest", pageId: "page-2" })]
          })
        })
      })
    );
  });

  // The demote used to skip the markdown write and unlink the asset anyway, so
  // the dest page's own illustration left the book with nothing in the
  // manuscript to show for it. Reachable in any deployment whose PUBLIC_API_URL
  // carries a path prefix: `new URL(path).pathname` is then `/api/assets/...`,
  // which the old `startsWith("/assets/images/")` rejected.
  it("demotes a hero whose stored path carries an API path prefix", async () => {
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-moved", page: assetPage });
    mocks.prisma.page.findFirst.mockResolvedValue({ ...destPage });
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: "asset-moved",
      path: "https://example.com/api/assets/images/project-1/page-1.jpg",
      prompt: "a dragon",
      pageId: "page-1"
    });
    mocks.tx.imageAsset.findFirst.mockResolvedValue({
      id: "asset-dest",
      path: "https://example.com/api/assets/images/project-1/page-2.jpg",
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
          sources: [{ pageIndex: 1, replaceAssetId: "asset-moved" }],
          dest: { placement: "page", pageIndex: 2 }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-2" },
      data: expect.objectContaining({
        markdown: expect.stringContaining("/assets/images/project-1/page-2.jpg")
      })
    });
    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-dest" },
      data: { pageId: null }
    });
  });

  it("refuses the whole move rather than unlinking a hero it cannot write a line for", async () => {
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
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
      path: "s3://bucket/opaque-object-key",
      prompt: "a fox"
    });

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          sources: [{ pageIndex: 1, replaceAssetId: "asset-moved" }],
          dest: { placement: "page", pageIndex: 2 }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.imageAsset.update).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ classifier: expect.objectContaining({ layoutMissing: true }) })
      })
    );
  });

  it("records why it skipped so the card can say the picture was already in place", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue({ ...sourcePage });

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          sources: [{ pageIndex: 1, replaceMarker: "chat-image-op-old" }],
          dest: { placement: "page", pageIndex: 1 }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          classifier: expect.objectContaining({ layoutMissing: true, layoutSkippedReason: "already_positioned" })
        })
      })
    );
  });

  // The reason the batch is planned in memory rather than applied target by
  // target. Undo replays PageEditSnapshot rows, there is no unique index on
  // (operationId, pageId), and undoLastBookEdit loads them unordered — so a
  // second snapshot for this page would carry the half-stripped markdown as its
  // `markdownBefore` and undo would restore a page missing the first picture.
  it("writes one page update and one snapshot when two pictures share a page", async () => {
    const twoPictures = withTxPage({
      ...sourcePage,
      markdown:
        "Prose.\n\n![one](/assets/images/project-1/chat-image-op-a-1.jpg)\n\nMore.\n\n![two](/assets/images/project-1/chat-image-op-b-2.jpg)"
    });
    mocks.prisma.page.findFirst.mockResolvedValue({ ...twoPictures });
    mocks.tx.page.update.mockImplementation(async ({ data }: { data: { markdown?: string } }) => ({
      ...twoPictures,
      markdown: data.markdown ?? twoPictures.markdown,
      revision: 4
    }));

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: {
          action: "remove",
          sources: [
            { pageIndex: 1, replaceMarker: "chat-image-op-a" },
            { pageIndex: 1, replaceMarker: "chat-image-op-b" }
          ]
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.pageEditSnapshot.create).toHaveBeenCalledTimes(1);
    // Both pictures gone in the single write...
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { markdown: "Prose.\n\nMore.", revision: { increment: 1 } }
    });
    // ...and the snapshot's "before" is the page as it stood before either.
    expect(mocks.tx.pageEditSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pageId: "page-1", markdownBefore: twoPictures.markdown })
      })
    );
  });

  it("applies the rest of a batch when one picture has already gone", async () => {
    const page = withTxPage({
      ...sourcePage,
      markdown: "Prose.\n\n![one](/assets/images/project-1/chat-image-op-a-1.jpg)\n\nMore."
    });
    mocks.prisma.page.findFirst.mockImplementation(
      async ({ where }: { where: { markdown?: { contains?: string } } }) =>
        where.markdown?.contains === "chat-image-op-gone" ? null : { ...page }
    );
    mocks.tx.page.update.mockResolvedValue({ ...page, markdown: "Prose.\n\nMore.", revision: 4 });

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: {
          action: "remove",
          sources: [
            { pageIndex: 1, replaceMarker: "chat-image-op-gone" },
            { pageIndex: 1, replaceMarker: "chat-image-op-a" }
          ]
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalled();
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ affectedPageIndexes: [1] })
      })
    );
  });

  it("still applies a job enqueued with the pre-bulk singular source", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue({ ...sourcePage });
    mocks.tx.page.update.mockResolvedValue({ ...sourcePage, markdown: "Prose.\n\nMore.", revision: 4 });

    await applyImageLayout(
      job({
        intentKind: "remove_image",
        imageLayout: { action: "remove", source: { pageIndex: 1, replaceMarker: "chat-image-op-old" } }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { markdown: "Prose.\n\nMore.", revision: { increment: 1 } }
    });
  });

  it("moves an inline picture to the top of its own page, under a leading heading", async () => {
    const headed = withTxPage({
      ...sourcePage,
      markdown: "# One\n\nProse.\n\n![a dragon](/assets/images/project-1/chat-image-op-old-aaaa.jpg)\n\nMore."
    });
    mocks.prisma.page.findFirst.mockResolvedValue({ ...headed });
    mocks.tx.page.update.mockImplementation(async ({ data }: { data: { markdown?: string } }) => ({
      ...headed,
      markdown: data.markdown ?? headed.markdown,
      revision: 4
    }));

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          sources: [{ pageIndex: 1, replaceMarker: "chat-image-op-old" }],
          dest: { placement: "page", pageIndex: 1, position: "top" }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    // Under the heading, never above it: the compiler only strips a page's
    // leading heading while it is still line one.
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: {
        markdown:
          "# One\n\n![a dragon](/assets/images/project-1/chat-image-op-old-aaaa.jpg)\n\nProse.\n\nMore.",
        revision: { increment: 1 }
      }
    });
  });

  it("demotes a hero to an inline line when it is moved below its own page's text", async () => {
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-1", page: assetPage });
    mocks.prisma.page.findFirst.mockResolvedValue({ ...assetPage });
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: "asset-1",
      path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
      prompt: "a dragon",
      pageId: "page-1"
    });
    mocks.tx.imageAsset.findFirst.mockResolvedValue(null);
    mocks.tx.page.update.mockImplementation(async ({ data }: { data: { markdown?: string } }) => ({
      ...assetPage,
      markdown: data.markdown ?? assetPage.markdown,
      revision: 4
    }));

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }],
          dest: { placement: "page", pageIndex: 1, position: "bottom" }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    // The compiler prints a hero above the prose, always — so "below the text"
    // means giving up hero status for an inline line.
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: {
        markdown: "Prose.\n\n![a dragon](/assets/images/project-1/page-1.jpg)",
        imagePrompt: null,
        revision: { increment: 1 }
      }
    });
    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({ where: { id: "asset-1" }, data: { pageId: null } });
  });

  it("reports a hero asked to move to the top of its own page as already in place", async () => {
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-1", page: assetPage });
    mocks.prisma.page.findFirst.mockResolvedValue({ ...assetPage });
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: "asset-1",
      path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
      prompt: "a dragon",
      pageId: "page-1"
    });

    await applyImageLayout(
      job({
        imageLayout: {
          action: "move",
          sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }],
          dest: { placement: "page", pageIndex: 1, position: "top" }
        }
      }),
      { status: "QUEUED", classifier: {} }
    );

    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          classifier: expect.objectContaining({ layoutSkippedReason: "already_positioned" })
        })
      })
    );
  });

  it("unlinks a generation ImageAsset on remove", async () => {
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
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
        imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }] }
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

/**
 * `applyBookEdit` forks here on the operation's `kind`, so a job whose payload
 * was rebuilt without `imageLayout` still arrives — and the Apply wrote the
 * resolved intent onto the classifier for exactly that delivery.
 */
describe("applyImageLayout with no imageLayout on the payload", () => {
  it("removes the picture the classifier's target names", async () => {
    const assetPage = withTxPage({ ...sourcePage, markdown: "Prose.", imagePrompt: "a dragon" });
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-1", page: assetPage });
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: "asset-1",
      path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
      prompt: "a dragon",
      pageId: "page-1"
    });
    mocks.tx.imageAsset.findFirst.mockResolvedValue(null);
    mocks.tx.page.update.mockResolvedValue({ ...assetPage, imagePrompt: null, revision: 4 });

    await applyImageLayout(job({ intentKind: "remove_image", imageLayout: undefined }), {
      status: "QUEUED",
      classifier: {
        kind: "remove_image",
        imageLayout: { action: "remove", targets: [{ operationId: "", assetId: "asset-1", pageIndex: 1 }] }
      }
    });

    // The stored target is an asset id, so the picture is found the same way the
    // payload's own `replaceAssetId` would have found it.
    expect(mocks.prisma.imageAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "asset-1" }) })
    );
    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({ where: { id: "asset-1" }, data: { pageId: null } });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
  });

  it("rebuilds a chat-added picture's marker from the operation id that made it", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue({ ...sourcePage });
    mocks.tx.page.update.mockResolvedValue({ ...sourcePage, markdown: "Prose.\n\nMore.", revision: 4 });

    await applyImageLayout(job({ intentKind: "remove_image", imageLayout: undefined }), {
      status: "QUEUED",
      classifier: {
        imageLayout: { action: "remove", targets: [{ operationId: "op-old", pageIndex: 1 }] }
      }
    });

    // `chat-image-<operationId>` is the marker the insertion wrote and the one
    // the API's own re-resolution rebuilds; disagreeing would act on a different
    // picture than the card named.
    expect(mocks.prisma.page.findFirst).toHaveBeenCalledWith({
      where: { projectId: "project-1", markdown: { contains: "chat-image-op-old" } }
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { markdown: "Prose.\n\nMore.", revision: { increment: 1 } }
    });
  });

  it("moves to the classifier's destination page", async () => {
    mocks.prisma.page.findFirst.mockResolvedValueOnce({ ...sourcePage }).mockResolvedValueOnce({ ...destPage });
    mocks.tx.page.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { markdown?: string } }) =>
      where.id === "page-1"
        ? { ...sourcePage, markdown: data.markdown ?? sourcePage.markdown, revision: 4 }
        : { ...destPage, markdown: data.markdown ?? destPage.markdown, revision: 5 }
    );

    await applyImageLayout(job({ imageLayout: undefined }), {
      status: "QUEUED",
      classifier: {
        imageLayout: {
          action: "move",
          targets: [{ operationId: "op-old", pageIndex: 1 }],
          destPlacement: "page",
          destPageIndex: 2
        }
      }
    });

    expect(mocks.prisma.page.findFirst).toHaveBeenCalledWith({ where: { projectId: "project-1", index: 2 } });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-2" },
      data: {
        markdown: "Later prose.\n\n![a dragon](/assets/images/project-1/chat-image-op-old-aaaa.jpg)",
        revision: { increment: 1 }
      }
    });
  });

  it("settles as a delivered no-op when neither copy carries a request", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await applyImageLayout(job({ imageLayout: undefined }), { status: "QUEUED", classifier: { kind: "move_image" } });

    // The same settlement a vanished picture gets: APPLIED with nothing done and
    // the book put back where it was found. Throwing would fail a finished book
    // over a request no retry could find, and a move is free, so there is
    // nothing to hand back.
    expect(mocks.prisma.page.findFirst).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          affectedPageIndexes: [],
          classifier: expect.objectContaining({ layoutMissing: true })
        })
      })
    );
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("replays an already-applied layout edit rather than reading either copy", async () => {
    await applyImageLayout(job({ imageLayout: undefined }), { status: "APPLIED", classifier: {} });

    // The redelivery fence comes first: the pages already moved, and only the
    // export refresh is owed.
    expect(mocks.prisma.bookEditOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
  });
});
