import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findFirst: vi.fn() },
    imageAsset: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    page: { findUnique: vi.fn(), update: vi.fn() },
    pageEditSnapshot: { create: vi.fn() },
    project: { update: vi.fn() },
    imageAsset: { findUnique: vi.fn(), update: vi.fn() }
  },
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  generateImageBytes: vi.fn(),
  selectReferenceImagePaths: vi.fn(),
  imageCapabilities: vi.fn(),
  optimizeImageForStorage: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/img", PUBLIC_API_URL: "http://localhost:4001" }
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ image: { kind: "image" } }) }));
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: (_project: unknown, snapshot: unknown) => ({
    mediaSettings: (snapshot as { mediaSettings?: unknown })?.mediaSettings ?? {}
  })
}));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({ generateImageBytes: mocks.generateImageBytes }),
  // Imported by the real characterReferences module below; never called here.
  imageGenerationMetadata: vi.fn(),
  imageStorageMetadata: vi.fn()
}));
// The real module, so the handler exercises the one shared ownership trio
// (`resolveLibraryPortraitSeed`) and sheet matcher instead of local copies.
vi.mock("../generation/characterReferences.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/characterReferences.js")>(
    "../generation/characterReferences.js"
  );
  return {
    ...actual,
    selectReferenceImagePaths: mocks.selectReferenceImagePaths,
    imageCapabilities: mocks.imageCapabilities
  };
});
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  unlink: mocks.unlink,
  stat: mocks.stat,
  appendFile: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({}),
    optimizeImageForStorage: mocks.optimizeImageForStorage
  };
});

import {
  applyImageInsertion,
  imageAltFromSubject,
  markdownWithAppendedImage,
  markdownWithReplacedImage
} from "./applyImageInsertion.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

const plan = {
  illustrationPlan: { globalStyle: "Soft watercolor.", pageRules: ["Keep the dragon green.", "No embedded text."] },
  characters: []
};

const baseProject = {
  id: "project-1",
  userId: "user-1",
  currentPlanId: "plan-1",
  language: "en",
  mediaSettings: {},
  status: "COMPLETE"
};

const targetPage = {
  id: "page-5",
  index: 5,
  title: "Page 5",
  markdown: "The dragon sleeps.",
  summary: "Sleepy dragon.",
  revision: 3
};

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: "Add a photo of a dragon at the end of the book",
      affectedPageIndexes: [5],
      planId: "plan-1",
      intentKind: "add_image",
      imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 5 },
      generationJobId: "gen-1",
      ...data
    }
  }) as unknown as Job;

/** A previous delivery's line: same operation marker, its own unique filename. */
const PRIOR_LINE = "![a dragon](/assets/images/project-1/chat-image-op-1-11111111-2222-3333-4444-555555555555.jpg)";

const COMPILE_OPTIONS = { skipFinalReview: true, withoutQualityVerdict: true };

/** The path this delivery wrote its (delivery-unique) file to. */
const writtenImagePath = () => mocks.writeFile.mock.calls[0]?.[0] as string;
const writtenFilename = () => writtenImagePath().split("/").pop() as string;
const appendedLine = () => `![a dragon](/assets/images/project-1/${writtenFilename()})`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "APPLIED" });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.planVersion.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "plan-1" ? { id: "plan-1", inputSnapshot: {}, planningPackage: plan } : null
  );
  mocks.prisma.page.findFirst.mockResolvedValue({ ...targetPage });
  mocks.prisma.imageAsset.findMany.mockResolvedValue([]);
  mocks.prisma.imageAsset.findFirst.mockResolvedValue(null);
  mocks.tx.imageAsset.findUnique.mockResolvedValue(null);
  mocks.tx.imageAsset.update.mockResolvedValue({});
  mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ classifier: {} });
  mocks.tx.bookEditOperation.update.mockResolvedValue({});
  mocks.tx.page.findUnique.mockResolvedValue({ ...targetPage });
  mocks.tx.page.update.mockImplementation(
    async ({ data }: { data: { markdown?: string; imagePrompt?: string } }) => ({
      ...targetPage,
      ...data,
      markdown: data.markdown ?? targetPage.markdown,
      revision: targetPage.revision + 1
    })
  );
  mocks.tx.pageEditSnapshot.create.mockResolvedValue({ id: "snap-1" });
  mocks.tx.project.update.mockResolvedValue({});
  mocks.getProjectOrThrow.mockResolvedValue({ ...baseProject });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  mocks.generateImageBytes.mockResolvedValue({
    bytes: Buffer.from("img"),
    mimeType: "image/png",
    provider: "gemini",
    model: "img-model"
  });
  mocks.optimizeImageForStorage.mockResolvedValue({
    bytes: Buffer.from("optimized"),
    mimeType: "image/jpeg",
    extension: "jpg"
  });
  mocks.selectReferenceImagePaths.mockResolvedValue({ paths: [], libraryFaceNames: [] });
  mocks.imageCapabilities.mockReturnValue({ supportsReferenceImages: true, maxReferenceImages: 4 });
  mocks.stat.mockRejectedValue(new Error("ENOENT"));
});

const operation = (status = "QUEUED") => ({ id: "op-1", status });

describe("applyImageInsertion", () => {
  it("renders, stores, and appends the image line under the APPLIED claim", async () => {
    await applyImageInsertion(job(), operation());

    // Own claim: op ACTIVE (never regressing APPLIED, never reviving CANCELED)
    // + project EDITING.
    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op-1", status: { notIn: ["APPLIED", "CANCELED"] } },
      data: { status: "ACTIVE" }
    });
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "EDITING" }
    });
    // File written before any markdown names it, under a delivery-unique name:
    // a render failure can never leave a dangling reference, and a losing
    // delivery can never overwrite the winner's published bytes.
    expect(writtenImagePath()).toMatch(/^\/img\/project-1\/chat-image-op-1-[0-9a-f-]{36}\.jpg$/);
    expect(mocks.writeFile).toHaveBeenCalledWith(writtenImagePath(), Buffer.from("optimized"));
    // The APPLIED claim gates the page write.
    expect(mocks.tx.bookEditOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: expect.objectContaining({ status: "APPLIED", affectedPageIndexes: [5] })
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-5" },
      data: { markdown: `The dragon sleeps.\n\n${appendedLine()}`, revision: { increment: 1 } }
    });
    // The undo snapshot is written inside the appending transaction, with the
    // before-fields from the in-tx read — never from a pre-render copy a
    // concurrent delivery may since have appended to.
    expect(mocks.tx.pageEditSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationId: "op-1",
        pageIndex: 5,
        markdownBefore: "The dragon sleeps.",
        revisionBefore: 3,
        markdownAfter: `The dragon sleeps.\n\n${appendedLine()}`,
        revisionAfter: 4
      })
    });
    // The contentRevision bump commits with the append, so no later throw can
    // refund an image that is durably on the page.
    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { contentRevision: { increment: 1 } }
    });
    expect(mocks.prisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { contentRevision: { increment: 1 } }
    });
    // Success tail: exports invalidated, recompile queued without the
    // whole-book QA pass and without claiming the book's quality verdict.
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", COMPILE_OPTIONS);
    // A compile on its way publishes the status; no premature restore.
    expect(mocks.prisma.project.updateMany).not.toHaveBeenCalled();
    // Nothing failed, so this delivery's file stays.
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("re-resolves end_of_book to the current last page, ignoring the stale target", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue({ ...targetPage, id: "page-9", index: 9 });
    mocks.tx.page.findUnique.mockResolvedValue({ ...targetPage, id: "page-9", index: 9 });

    await applyImageInsertion(
      job({ imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 3 } }),
      operation()
    );

    expect(mocks.prisma.page.findFirst).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
      orderBy: { index: "desc" }
    });
    expect(mocks.tx.bookEditOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ affectedPageIndexes: [9] }) })
    );
  });

  it("targets the named page for an explicit placement", async () => {
    await applyImageInsertion(
      job({ imageInsertion: { subject: "a dragon", placement: "page", targetPageIndex: 5 } }),
      operation()
    );

    expect(mocks.prisma.page.findFirst).toHaveBeenCalledWith({ where: { projectId: "project-1", index: 5 } });
  });

  it("fails cleanly when the explicit page no longer exists", async () => {
    mocks.prisma.page.findFirst.mockResolvedValue(null);

    await expect(
      applyImageInsertion(
        job({ imageInsertion: { subject: "a dragon", placement: "page", targetPageIndex: 9 } }),
        operation()
      )
    ).rejects.toThrow("Page 9 no longer exists");

    // Nothing was rendered or written; the refund path settles the charge.
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("skips the guaranteed-null plan lookup when the payload carries no planId", async () => {
    await applyImageInsertion(job({ planId: undefined }), operation());

    const lookedUp = mocks.prisma.planVersion.findUnique.mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id
    );
    expect(lookedUp).toEqual(["plan-1"]);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", COMPILE_OPTIONS);
  });

  it("replays only the compile tail on a redelivery of an APPLIED operation", async () => {
    await applyImageInsertion(job(), operation("APPLIED"));

    // No second render, no second markdown line, no re-claim — and no second
    // contentRevision bump: the appending transaction already versioned this
    // manuscript.
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    // The idempotent success tail is rebuilt from what the page already says.
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", COMPILE_OPTIONS);
  });

  it("replays the compile tail when the ACTIVE claim finds the operation APPLIED", async () => {
    // The pre-read raced a concurrent delivery: by the time this one claims,
    // the operation is APPLIED. Regressing it to ACTIVE would re-append.
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "APPLIED" });

    await applyImageInsertion(job(), operation());

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", COMPILE_OPTIONS);
  });

  it("does nothing at all when the operation was cancelled before the claim", async () => {
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "CANCELED" });

    await applyImageInsertion(job(), operation());

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("re-activates a FAILED operation for the paid retry lane", async () => {
    // The /resume retry re-charges and reuses the FAILED operation row, so the
    // claim must move FAILED back to ACTIVE — only APPLIED and CANCELED are
    // terminal here.
    await applyImageInsertion(job(), operation("FAILED"));

    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op-1", status: { notIn: ["APPLIED", "CANCELED"] } },
      data: { status: "ACTIVE" }
    });
    expect(mocks.generateImageBytes).toHaveBeenCalled();
    expect(mocks.tx.page.update).toHaveBeenCalled();
  });

  it("writes a delivery-unique file, so a redelivery cannot swap the winner's artwork", async () => {
    const savedMarkdown = () => {
      const call = mocks.tx.page.update.mock.calls[0]?.[0] as { data: { markdown: string } } | undefined;
      return call?.data.markdown ?? "";
    };
    await applyImageInsertion(job(), operation());
    const firstPath = writtenImagePath();
    const firstLine = savedMarkdown();

    mocks.writeFile.mockClear();
    mocks.tx.page.update.mockClear();
    await applyImageInsertion(job(), operation());
    const secondPath = writtenImagePath();
    const secondLine = savedMarkdown();

    // Two deliveries render two different images; a shared deterministic name
    // let the loser overwrite the bytes the winner's markdown references.
    expect(firstPath).not.toBe(secondPath);
    expect(firstLine).toContain(firstPath.split("/").pop());
    expect(secondLine).toContain(secondPath.split("/").pop());
  });

  it("writes nothing and keeps the winner's file when the claim was lost to an APPLIED settle", async () => {
    mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "APPLIED" });

    await applyImageInsertion(job(), operation());

    // The loser of the claim appends nothing and rebuilds nothing — whatever
    // the winner decided stands, and nothing is deleted near an APPLIED
    // operation's published image.
    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.tx.pageEditSnapshot.create).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.tx.project.update).not.toHaveBeenCalled();
  });

  it("removes its orphaned file when the claim was lost to a cancellation", async () => {
    mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "CANCELED" });

    await applyImageInsertion(job(), operation());

    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledWith(writtenImagePath());
  });

  it("removes the written file when the append transaction fails", async () => {
    mocks.tx.page.findUnique.mockResolvedValue(null);

    await expect(applyImageInsertion(job(), operation())).rejects.toThrow("disappeared");

    // The unique name is referenced by nothing until its own append commits,
    // so the failure path unlinks it instead of stranding it forever.
    expect(mocks.unlink).toHaveBeenCalledWith(writtenImagePath());
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
  });

  it("appends inside the unwrapped content of a fence-wrapped page", async () => {
    const fenced = "```markdown\nFenced prose.\n```";
    mocks.prisma.page.findFirst.mockResolvedValue({ ...targetPage, markdown: fenced });
    mocks.tx.page.findUnique.mockResolvedValue({ ...targetPage, markdown: fenced });

    await applyImageInsertion(job(), operation());

    // Appended after the closing ``` the fence would turn the prose into a
    // literal code block in both exports.
    expect(mocks.tx.page.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ markdown: `Fenced prose.\n\n${appendedLine()}` }) })
    );
  });

  it("saves a page that merely starts and ends with fences untouched, plus the appended line", async () => {
    // The compiler's whole-page pattern spans the first opener to the LAST
    // closer, so "unwrapping" this page would swap its prose into code context
    // — and this handler saves the result to Page.markdown permanently. Plain
    // append compiles this shape correctly.
    const multiFence = "```md\nformatted start\n```\n\nProse between the fences.\n\n```\ncode();\n```";
    mocks.prisma.page.findFirst.mockResolvedValue({ ...targetPage, markdown: multiFence });
    mocks.tx.page.findUnique.mockResolvedValue({ ...targetPage, markdown: multiFence });

    await applyImageInsertion(job(), operation());

    expect(mocks.tx.page.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ markdown: `${multiFence}\n\n${appendedLine()}` }) })
    );
  });

  it("skips the append and the snapshot when the page already carries this operation's image", async () => {
    mocks.tx.page.findUnique.mockResolvedValue({
      ...targetPage,
      markdown: `The dragon sleeps.\n\n${PRIOR_LINE}`,
      revision: 4
    });

    await applyImageInsertion(job(), operation());

    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    // The delivery that appended wrote the undo snapshot; a second one would
    // record a markdownBefore that already holds the image undo removes.
    expect(mocks.tx.pageEditSnapshot.create).not.toHaveBeenCalled();
    // The success tail still runs: the book holds the image and the exports
    // must be rebuilt to show it.
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", COMPILE_OPTIONS);
  });

  it("swaps the replaced marker's line in place, keeping its spot on the page", async () => {
    const oldLine = "![a dragon](/assets/images/project-1/chat-image-op-old-aaaa.jpg)";
    const pageWithOld = { ...targetPage, index: 2, id: "page-2", markdown: `Intro.\n\n${oldLine}\n\nOutro.` };
    mocks.prisma.page.findFirst.mockResolvedValue({ ...pageWithOld });
    mocks.tx.page.findUnique.mockResolvedValue({ ...pageWithOld });
    mocks.tx.page.update.mockImplementation(async ({ data }: { data: { markdown: string } }) => ({
      ...pageWithOld,
      markdown: data.markdown,
      revision: pageWithOld.revision + 1
    }));

    await applyImageInsertion(
      job({
        imageInsertion: {
          subject: "a dragon",
          placement: "page",
          targetPageIndex: 2,
          replaceMarker: "chat-image-op-old"
        }
      }),
      operation()
    );

    // The marker lookup targets the page holding the old line, wherever the
    // stale queue-time index pointed.
    expect(mocks.prisma.page.findFirst).toHaveBeenCalledWith({
      where: { projectId: "project-1", markdown: { contains: "chat-image-op-old" } }
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-2" },
      data: { markdown: `Intro.\n\n${appendedLine()}\n\nOutro.`, revision: { increment: 1 } }
    });
    // A swap is not a "swap became add": no classifier note.
    expect(mocks.tx.bookEditOperation.update).not.toHaveBeenCalled();
  });

  it("appends and records the swap-became-add when the old marker is already gone", async () => {
    // The marker lookup finds nothing; the fallback resolution finds the
    // queue-time target page.
    mocks.prisma.page.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ ...targetPage });
    mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ classifier: { imageEdit: { subject: "a castle" } } });

    await applyImageInsertion(
      job({
        imageInsertion: {
          subject: "a castle",
          placement: "page",
          targetPageIndex: 5,
          replaceMarker: "chat-image-op-old"
        }
      }),
      operation()
    );

    const line = `![a castle](/assets/images/project-1/${writtenFilename()})`;
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-5" },
      data: { markdown: `The dragon sleeps.\n\n${line}`, revision: { increment: 1 } }
    });
    // The operation records that the promised swap landed as an add — the old
    // image was already gone.
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: { classifier: { imageEdit: { subject: "a castle" }, replacedMissing: true } }
    });
  });

  it("replaces a generation ImageAsset in place and leaves the page markdown alone", async () => {
    const illustratedPage = {
      ...targetPage,
      id: "page-1",
      index: 1,
      markdown: "Mae unlocked the garden gate.",
      imagePrompt: "Mae in the garden with a fox."
    };
    const asset = {
      id: "asset-1",
      path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
      prompt: "Mae in the garden with a fox.",
      page: illustratedPage
    };
    mocks.prisma.imageAsset.findFirst.mockResolvedValue(asset);
    mocks.tx.imageAsset.findUnique.mockResolvedValue({
      id: asset.id,
      path: asset.path,
      prompt: asset.prompt
    });
    mocks.tx.page.findUnique.mockResolvedValue({ ...illustratedPage });
    mocks.tx.page.update.mockImplementation(
      async ({ data }: { data: { markdown?: string; imagePrompt?: string } }) => ({
        ...illustratedPage,
        markdown: data.markdown ?? illustratedPage.markdown,
        revision: illustratedPage.revision + 1
      })
    );

    await applyImageInsertion(
      job({
        request: "change the first image to more aggressive",
        imageInsertion: {
          subject: "a more aggressive fox",
          placement: "page",
          targetPageIndex: 1,
          replaceAssetId: "asset-1"
        }
      }),
      operation()
    );

    expect(writtenFilename()).toMatch(/^page-1-op-1-[0-9a-f-]+\.jpg$/);
    expect(mocks.tx.imageAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: {
        path: `http://localhost:4001/assets/images/project-1/${writtenFilename()}`,
        prompt: expect.stringContaining("a more aggressive fox")
      }
    });
    expect(mocks.tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { imagePrompt: "a more aggressive fox", revision: { increment: 1 } }
    });
    expect(mocks.tx.page.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ markdown: expect.any(String) }) })
    );
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: {
        classifier: {
          previousAsset: {
            id: "asset-1",
            pageId: "page-1",
            path: asset.path,
            prompt: asset.prompt,
            imagePrompt: "Mae in the garden with a fox."
          }
        }
      }
    });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", COMPILE_OPTIONS);
  });

  it("throws when the generation asset vanished before delivery", async () => {
    await expect(
      applyImageInsertion(
        job({
          imageInsertion: {
            subject: "a more aggressive fox",
            placement: "page",
            targetPageIndex: 1,
            replaceAssetId: "asset-gone"
          }
        }),
        operation()
      )
    ).rejects.toThrow(/no longer in this book/);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("throws on a provider failure instead of completing without the image", async () => {
    mocks.generateImageBytes.mockRejectedValue(new Error("image outage"));

    await expect(applyImageInsertion(job(), operation())).rejects.toThrow("image outage");

    // The page is untouched and the operation was never claimed APPLIED — the
    // attempt settlement refunds the separately paid image.
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
  });

  it("lets a stop request escape untouched", async () => {
    const stop = new StopRequestedError();
    mocks.generateImageBytes.mockRejectedValue(stop);

    await expect(applyImageInsertion(job(), operation())).rejects.toBe(stop);
  });

  it("hands the book back to the repair lane when no recompile was queued", async () => {
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await applyImageInsertion(job(), operation());

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
  });

  it("hands the applied insertion to the repair lane when the export enqueue fails", async () => {
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(applyImageInsertion(job(), operation())).resolves.toBeUndefined();

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("composes the prompt from the subject, references, style, and continuity rules", async () => {
    await applyImageInsertion(job(), operation());

    const render = mocks.generateImageBytes.mock.calls[0]?.[0] as { prompt: string } | undefined;
    const prompt = render?.prompt ?? "";
    expect(prompt).toContain("Create one interior book illustration depicting: a dragon.");
    expect(prompt).toContain("Add a photo of a dragon at the end of the book");
    expect(prompt).toContain("Global visual style: Soft watercolor.");
    expect(prompt).toContain("Continuity rules: Keep the dragon green. No embedded text.");
  });

  it("selects the current plan's sheets, falling back to any plan's", async () => {
    const currentSheet = { id: "a1", path: "p1", metadata: { planId: "plan-1", characterName: "Luna" } };
    const oldSheet = { id: "a0", path: "p0", metadata: { planId: "plan-0", characterName: "Luna" } };
    mocks.prisma.imageAsset.findMany.mockResolvedValue([oldSheet, currentSheet]);

    await applyImageInsertion(job(), operation());

    expect(mocks.selectReferenceImagePaths).toHaveBeenCalledWith(
      expect.objectContaining({ assets: [currentSheet], context: "a dragon" })
    );

    // With no sheet for the current plan, an earlier plan's cast still shows
    // the same characters.
    mocks.selectReferenceImagePaths.mockClear();
    mocks.prisma.imageAsset.findMany.mockResolvedValue([oldSheet]);
    await applyImageInsertion(job(), operation());
    expect(mocks.selectReferenceImagePaths).toHaveBeenCalledWith(
      expect.objectContaining({ assets: [oldSheet] })
    );
  });

  it("appends a matched library character's portrait when no sheet exists", async () => {
    const mediaSettings = {
      mobile: { characters: [{ id: "lc-1", name: "Luna", portraitFile: "user-1/luna.png" }] }
    };
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: { mediaSettings },
      planningPackage: plan
    });
    mocks.stat.mockResolvedValue({ isFile: () => true });

    await applyImageInsertion(
      job({ imageInsertion: { subject: "Luna riding a dragon", placement: "end_of_book", targetPageIndex: 5 } }),
      operation()
    );

    const call = mocks.generateImageBytes.mock.calls[0]?.[0] as { referenceImagePaths: string[] };
    expect(call.referenceImagePaths).toEqual([join("/img", "characters", "user-1", "luna.png")]);
  });

  it("never reads a portrait owned by another user", async () => {
    const mediaSettings = {
      mobile: { characters: [{ id: "lc-1", name: "Luna", portraitFile: "user-2/luna.png" }] }
    };
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: { mediaSettings },
      planningPackage: plan
    });
    mocks.stat.mockResolvedValue({ isFile: () => true });

    await applyImageInsertion(
      job({ imageInsertion: { subject: "Luna riding a dragon", placement: "end_of_book", targetPageIndex: 5 } }),
      operation()
    );

    const call = mocks.generateImageBytes.mock.calls[0]?.[0] as { referenceImagePaths: string[] };
    expect(call.referenceImagePaths).toEqual([]);
  });

  it("does not double-attach a character whose sheet already exists", async () => {
    const mediaSettings = {
      mobile: { characters: [{ id: "lc-1", name: "Luna", portraitFile: "user-1/luna.png" }] }
    };
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: { mediaSettings },
      planningPackage: plan
    });
    mocks.prisma.imageAsset.findMany.mockResolvedValue([
      { id: "a1", path: "p1", metadata: { planId: "plan-1", characterName: "Luna", libraryCharacterId: "lc-1" } }
    ]);
    mocks.selectReferenceImagePaths.mockResolvedValue({ paths: ["/img/project-1/sheet.jpg"], libraryFaceNames: [] });
    mocks.stat.mockResolvedValue({ isFile: () => true });

    await applyImageInsertion(
      job({ imageInsertion: { subject: "Luna riding a dragon", placement: "end_of_book", targetPageIndex: 5 } }),
      operation()
    );

    const call = mocks.generateImageBytes.mock.calls[0]?.[0] as { referenceImagePaths: string[] };
    expect(call.referenceImagePaths).toEqual(["/img/project-1/sheet.jpg"]);
  });
});

describe("markdownWithReplacedImage", () => {
  const newLine = "![new](/assets/images/p/chat-image-op-new-bbbb.jpg)";

  it("swaps only the line carrying the marker and keeps everything around it", () => {
    const markdown = "Intro.\n\n![old](/assets/images/p/chat-image-op-old-aaaa.jpg)\n\nOutro.";
    expect(markdownWithReplacedImage(markdown, "chat-image-op-old", newLine)).toBe(
      `Intro.\n\n${newLine}\n\nOutro.`
    );
  });

  it("returns null when no line carries the marker — the caller's cue to append", () => {
    expect(markdownWithReplacedImage("Just prose.", "chat-image-op-old", newLine)).toBeNull();
  });
});

describe("markdownWithAppendedImage", () => {
  it("separates prose and image with a blank line", () => {
    expect(markdownWithAppendedImage("Prose.", "![x](/a/b/c.jpg)")).toBe("Prose.\n\n![x](/a/b/c.jpg)");
  });

  it("unwraps a whole-page fence before appending", () => {
    expect(markdownWithAppendedImage("```md\nProse.\n```", "![x](/a.jpg)")).toBe("Prose.\n\n![x](/a.jpg)");
    expect(markdownWithAppendedImage("```\nProse.\n```", "![x](/a.jpg)")).toBe("Prose.\n\n![x](/a.jpg)");
  });

  it("leaves an interior fence alone", () => {
    const markdown = "Before.\n\n```js\ncode();\n```\n\nAfter.";
    expect(markdownWithAppendedImage(markdown, "![x](/a.jpg)")).toBe(`${markdown}\n\n![x](/a.jpg)`);
  });

  it("never unwraps a page that merely starts and ends with fences", () => {
    // The whole-page pattern spans the first opener to the LAST closer, so
    // unwrapping here would strip the outer markers and swap the prose between
    // the fences into code context — saved to Page.markdown permanently.
    const markdown = "```md\nformatted start\n```\n\nProse between the fences.\n\n```\ncode();\n```";
    expect(markdownWithAppendedImage(markdown, "![x](/a.jpg)")).toBe(`${markdown}\n\n![x](/a.jpg)`);
  });

  it("never unwraps a whole-page fence whose body holds an inner fence", () => {
    const markdown = "```md\nProse.\n\n```js\ncode();\n```\n\nMore prose.\n```";
    expect(markdownWithAppendedImage(markdown, "![x](/a.jpg)")).toBe(`${markdown}\n\n![x](/a.jpg)`);
  });

  it("yields just the image line for an empty page", () => {
    expect(markdownWithAppendedImage("", "![x](/a.jpg)")).toBe("![x](/a.jpg)");
  });
});

describe("imageAltFromSubject", () => {
  it("strips the characters that break the exporters' image regex", () => {
    expect(imageAltFromSubject("a [green] dragon (flying)\nover hills", "Illustration")).toBe(
      "a green dragon flying over hills"
    );
  });

  it("caps the alt at 120 characters", () => {
    const long = "d".repeat(200);
    expect(imageAltFromSubject(long, "Illustration")).toHaveLength(120);
  });

  it("falls back to the generic label when stripping empties the subject", () => {
    expect(imageAltFromSubject("()[]", "Illustration")).toBe("Illustration");
  });

  it("never emits the generation-artifact alt shape", () => {
    expect(imageAltFromSubject("Illustration for page 5", "Illustration")).toBe("Illustration");
  });
});
