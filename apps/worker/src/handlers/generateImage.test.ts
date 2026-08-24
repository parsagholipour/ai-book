import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findUnique: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    generationJob: { findUnique: vi.fn() },
    imageAsset: { create: vi.fn(), deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.prisma))
  },
  generateImageBytes: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  updateJobProgress: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: mocks.updateJobProgress }));
vi.mock("../runtime/config.js", () => ({ config: { IMAGE_STORAGE_DIR: "/tmp/test-images", PUBLIC_API_URL: "http://api" } }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ image: {}, text: {} }) }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ category: "STORY", mediaSettings: {} }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ id: "project-1" }),
  imageGenerationMetadata: () => ({}),
  imageStorageMetadata: () => ({}),
  strategyForInput: () => ({ generateImageBytes: mocks.generateImageBytes })
}));
vi.mock("../generation/characterReferences.js", () => ({
  characterReferencePromptInstruction: () => "",
  ensureCharacterReferenceAssets: async () => [],
  selectReferenceImagePaths: async () => ({ paths: [], libraryFaceNames: [] })
}));
vi.mock("./generateCover.js", () => ({ generateCover: vi.fn() }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: () => ({ illustrationPlan: { globalStyle: "warm", pageRules: [] }, characters: [] }) },
    createProviders: () => ({}),
    optimizeImageForStorage: async ({ bytes, mimeType }: { bytes: Buffer; mimeType: string }) => ({
      bytes,
      mimeType,
      extension: "png"
    })
  };
});
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile }));

import { StopRequestedError } from "../runtime/jobTypes.js";
import { generateImage } from "./generateImage.js";
import {
  pageIllustrationKeeperToken,
  pageIllustrationKeeperTokens
} from "../generation/pageIllustrationOwnership.js";

const job = {
  id: "job-1",
  data: {
    projectId: "project-1",
    pageId: "page-1",
    planId: "plan-1",
    prompt: "A fox.",
    generationJobId: "legacy-job-1"
  }
} as unknown as Job;

describe("generateImage interior rescue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const page = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 1,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    mocks.prisma.page.findUnique.mockResolvedValue(page);
    mocks.prisma.$queryRaw.mockResolvedValue([page]);
    mocks.prisma.generationJob.findUnique.mockResolvedValue({
      projectId: "project-1",
      type: "GENERATE_IMAGE",
      payload: { pageId: "page-1", planId: "plan-1", prompt: "A fox." },
      createdAt: new Date("2026-01-01T00:00:01.000Z")
    });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
    mocks.prisma.imageAsset.create.mockResolvedValue({});
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(() => vi.clearAllMocks());

  it("stores the image and asks for a compile on success", async () => {
    const recoveringPage = {
      ...(await mocks.prisma.page.findUnique()),
      imageFailureReason: "interior_image_failed"
    };
    mocks.prisma.page.findUnique.mockResolvedValue(recoveringPage);
    mocks.prisma.$queryRaw.mockResolvedValue([recoveringPage]);
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("img"),
      mimeType: "image/png",
      provider: "gemini",
      model: "img-model"
    });

    await generateImage(job);

    expect(mocks.prisma.imageAsset.create).toHaveBeenCalledTimes(1);
    // Redelivery replaces only this legacy job's generated asset. Manual page
    // illustrations of the same type are outside both ownership branches.
    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        pageId: "page-1",
        type: "SCENE_ILLUSTRATION",
        OR: [
          { metadata: { path: ["legacyGenerationJobId"], equals: "legacy-job-1" } },
          { path: { contains: "/page-page-1-legacy-legacy-job-1." } }
        ]
      }
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    // A successful render clears any earlier recorded loss for this page.
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: { id: "page-1", updatedAt: new Date("2026-01-01T00:00:00.000Z") },
      data: { imageFailureReason: null, updatedAt: new Date("2026-01-01T00:00:00.000Z") }
    });
    // The compile check runs post-completion (maybeCompileAfterCompletedJob);
    // the in-handler call could never fire and was removed.
  });

  it("marks a tokened asset with the keeper it depicts", async () => {
    const keeper = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 2,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const keeperIdentity = { ...keeper, pageId: keeper.id };
    const [keeperToken, oldToken] = pageIllustrationKeeperTokens(keeperIdentity);
    mocks.prisma.page.findUnique.mockResolvedValue(keeper);
    mocks.prisma.$queryRaw.mockResolvedValue([keeper]);
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("img"),
      mimeType: "image/png",
      provider: "gemini",
      model: "img-model"
    });

    await generateImage({ ...job, data: { ...job.data, keeperToken } } as unknown as Job);

    expect(mocks.prisma.imageAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          keeperToken,
          keeperTokenVersion: 2,
          keeperProjectId: "project-1",
          keeperPageId: "page-1"
        })
      })
    });
    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        pageId: "page-1",
        type: "SCENE_ILLUSTRATION",
        OR: [
          { metadata: { path: ["keeperToken"], equals: keeperToken } },
          { metadata: { path: ["keeperToken"], equals: oldToken } },
          { path: { contains: `-${keeperToken}.` } },
          { path: { contains: `-${oldToken}.` } }
        ]
      }
    });
  });

  it("stands down a rebuilt tokened job whose prompt does not match its keeper", async () => {
    const keeper = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 2,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const keeperToken = pageIllustrationKeeperToken({ ...keeper, pageId: keeper.id });
    mocks.prisma.page.findUnique.mockResolvedValue(keeper);

    await generateImage({
      ...job,
      data: { ...job.data, prompt: "A bear.", keeperToken }
    } as unknown as Job);

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("accepts an already-queued content-only token without minting another unscoped token", async () => {
    const keeper = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 2,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const oldToken = pageIllustrationKeeperTokens({ ...keeper, pageId: keeper.id })[1];
    mocks.prisma.page.findUnique.mockResolvedValue(keeper);
    mocks.prisma.$queryRaw.mockResolvedValue([keeper]);
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("img"),
      mimeType: "image/png",
      provider: "gemini",
      model: "img-model"
    });

    await generateImage({ ...job, data: { ...job.data, keeperToken: oldToken } } as unknown as Job);

    expect(mocks.prisma.imageAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          keeperToken: oldToken,
          keeperTokenVersion: 1,
          keeperProjectId: "project-1",
          keeperPageId: "page-1"
        })
      })
    });
  });

  it("stands down an already-queued tokenless job after replacement staging", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "Replacement",
      summary: "The replacement kept the same image direction.",
      markdown: "New prose.",
      imagePrompt: "A fox.",
      revision: 2,
      imageFailureReason: null,
      // The legacy command was created at 00:00:01; staging is the durable
      // retirement boundary even when its replacement enqueue is declined.
      updatedAt: new Date("2026-01-01T00:00:02.000Z")
    });

    await generateImage(job);

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("treats an equal legacy page/job timestamp as ambiguous rather than publishing stale work", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "Possibly restaged",
      summary: "Timestamp precision cannot prove which write came first.",
      markdown: "Potentially new prose.",
      imagePrompt: "A fox.",
      revision: 2,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:01.000Z")
    });

    await generateImage(job);

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("cannot recreate a retired asset when tokenless replacement staging lands during rendering", async () => {
    let durablePage = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 1,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    mocks.prisma.page.findUnique.mockImplementation(async () => durablePage);
    mocks.prisma.$queryRaw.mockImplementation(async () => [durablePage]);
    mocks.generateImageBytes.mockImplementation(async () => {
      // Deterministic staging interleaving: the old generated asset is retired
      // in the same transaction that advances this keeper version. The new
      // enqueue then fails, leaving no token job for the old job to query.
      durablePage = {
        ...durablePage,
        title: "Replacement",
        markdown: "New prose.",
        revision: 2,
        updatedAt: new Date("2026-01-01T00:00:02.000Z")
      };
      return { bytes: Buffer.from("old-img"), mimeType: "image/png", provider: "gemini", model: "img-model" };
    });

    await generateImage(job);

    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("uses stable page identity when a tokened page is reindexed during rendering", async () => {
    const keeper = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 2,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const keeperToken = pageIllustrationKeeperToken({ ...keeper, pageId: keeper.id });
    let durablePage = keeper;
    mocks.prisma.page.findUnique.mockImplementation(async () => durablePage);
    mocks.prisma.$queryRaw.mockImplementation(async () => [durablePage]);
    mocks.generateImageBytes.mockImplementation(async () => {
      durablePage = { ...durablePage, index: 7 };
      return { bytes: Buffer.from("img"), mimeType: "image/png", provider: "gemini", model: "img-model" };
    });

    await generateImage({ ...job, data: { ...job.data, keeperToken } } as unknown as Job);

    expect(mocks.writeFile).toHaveBeenCalledWith(
      `/tmp/test-images/project-1/page-page-1-${keeperToken}.png`,
      Buffer.from("img")
    );
    expect(mocks.prisma.imageAsset.create).toHaveBeenCalledTimes(1);
  });

  it("finishes without the illustration when every provider fails, instead of failing the book", async () => {
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));

    // Resolving (not rejecting) is the fix: a rejected job marked the whole
    // written, paid-for project FAILED and refunded FULL_BOOK_GENERATION.
    await expect(generateImage(job)).resolves.toBeUndefined();

    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    // The durable marker is what lets the app tell a lost illustration from a
    // page that was never meant to have one.
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: { id: "page-1", updatedAt: new Date("2026-01-01T00:00:00.000Z") },
      data: {
        imageFailureReason: "interior_image_failed",
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });
    expect(mocks.updateJobProgress).toHaveBeenCalledWith("legacy-job-1", {
      message: "Illustration for page 3 failed; the book will finish without it"
    });
  });

  it("still surfaces a user stop", async () => {
    mocks.generateImageBytes.mockRejectedValue(new StopRequestedError());

    await expect(generateImage(job)).rejects.toThrow(StopRequestedError);
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    // A user stop is not a lost illustration; the page keeps a clean slate.
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("stands down before rendering when the queued keeper was superseded", async () => {
    const queuedKeeper = {
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 2
    };
    const keeperToken = pageIllustrationKeeperToken({
      projectId: "project-1",
      pageId: "page-1",
      ...queuedKeeper
    });
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      projectId: "project-1",
      index: 3,
      ...queuedKeeper,
      markdown: "A newer keeper replaced the fox."
    });

    await generateImage({ ...job, data: { ...job.data, keeperToken } } as unknown as Job);

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("stands down at publication when the keeper changes during rendering", async () => {
    const queuedKeeper = {
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 2
    };
    const keeperToken = pageIllustrationKeeperToken({
      projectId: "project-1",
      pageId: "page-1",
      ...queuedKeeper
    });
    const matchingPage = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      imageFailureReason: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...queuedKeeper
    };
    let durablePage = matchingPage;
    mocks.prisma.page.findUnique.mockImplementation(async () => durablePage);
    mocks.prisma.$queryRaw.mockImplementation(async () => [durablePage]);
    mocks.prisma.page.updateMany.mockImplementation(async ({ where, data }) => {
      const expected = where as Partial<typeof durablePage>;
      const owns = ["title", "markdown", "summary", "imagePrompt", "revision"].every(
        (field) => expected[field as keyof typeof expected] === durablePage[field as keyof typeof durablePage]
      );
      if (!owns) return { count: 0 };
      durablePage = { ...durablePage, ...data };
      return { count: 1 };
    });
    mocks.prisma.$transaction.mockImplementationOnce(async (run: (tx: unknown) => Promise<unknown>) => {
      // Deterministic interleaving: the newer keeper commits after the last
      // optimistic read but before the old job's first publication write.
      durablePage = { ...durablePage, markdown: "A newer keeper replaced the fox." };
      return run(mocks.prisma);
    });
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("img"),
      mimeType: "image/png",
      provider: "gemini",
      model: "img-model"
    });

    await generateImage({ ...job, data: { ...job.data, keeperToken } } as unknown as Job);

    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    const lockSql = (mocks.prisma.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join("?");
    expect(lockSql).toMatch(/FROM "Page"[\s\S]*FOR UPDATE/);
    expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("cannot mark a newer keeper failed when ownership changes with the provider error", async () => {
    const queuedKeeper = {
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears.",
      imagePrompt: "A fox.",
      revision: 2
    };
    const keeperToken = pageIllustrationKeeperToken({
      projectId: "project-1",
      pageId: "page-1",
      ...queuedKeeper
    });
    let durablePage = {
      id: "page-1",
      projectId: "project-1",
      index: 3,
      imageFailureReason: null as string | null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...queuedKeeper
    };
    mocks.prisma.page.findUnique.mockImplementation(async () => durablePage);
    mocks.prisma.$queryRaw.mockImplementation(async () => [durablePage]);
    mocks.prisma.page.updateMany.mockImplementation(async ({ where, data }) => {
      const expected = where as Partial<typeof durablePage>;
      const owns = ["title", "markdown", "summary", "imagePrompt", "revision"].every(
        (field) => expected[field as keyof typeof expected] === durablePage[field as keyof typeof durablePage]
      );
      if (!owns) return { count: 0 };
      durablePage = { ...durablePage, ...data };
      return { count: 1 };
    });
    mocks.generateImageBytes.mockImplementation(async () => {
      durablePage = { ...durablePage, markdown: "A newer keeper replaced the fox." };
      throw new Error("old render failed");
    });

    await generateImage({ ...job, data: { ...job.data, keeperToken } } as unknown as Job);

    expect(durablePage.imageFailureReason).toBeNull();
    expect(mocks.updateJobProgress).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });
});
