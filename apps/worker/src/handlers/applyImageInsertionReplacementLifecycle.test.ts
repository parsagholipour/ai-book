import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn() },
    project: { update: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findFirst: vi.fn() },
    imageAsset: { findMany: vi.fn(), findFirst: vi.fn() },
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
  optimizeImageForStorage: vi.fn(),
  claimAppliedEditPublication: vi.fn(
    async (_tx: unknown, _projectId: string, _operationId: string, _fallbackStatus: string) => true
  ),
  restoreEditProjectStatus: vi.fn(
    async (_tx: unknown, _projectId: string, _operationId: string, _fallbackStatus: string) => true
  )
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/img", PUBLIC_API_URL: "http://localhost:4001" }
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ image: {} }) }));
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: () => ({ mediaSettings: {} })
}));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({ generateImageBytes: mocks.generateImageBytes })
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));
vi.mock("../generation/characterReferences.js", () => ({
  characterReferencePromptInstruction: () => "",
  imageAssetPlanId: () => null,
  librarySnapshotForSheet: () => null,
  resolveLibraryPortraitSeed: vi.fn(),
  selectReferenceImagePaths: async () => ({ paths: [], libraryFaceNames: [] }),
  toWorkerImageAsset: (asset: unknown) => asset
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({}),
    imageAdapterCapabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 4 }),
    optimizeImageForStorage: mocks.optimizeImageForStorage
  };
});

import { applyImageInsertion } from "./applyImageInsertion.js";

const plan = {
  illustrationPlan: { globalStyle: "Watercolor.", pageRules: [] },
  characters: []
};
const page = {
  id: "page-1",
  index: 1,
  title: "One",
  markdown: "Prose.",
  summary: "Summary.",
  revision: 3,
  imagePrompt: "A calm fox."
};
const replacement = {
  id: "asset-1",
  path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
  prompt: "A calm fox.",
  page
};
const job = {
  id: "bull-1",
  data: {
    projectId: "project-1",
    operationId: "op-1",
    request: "Make the fox fierce",
    planId: "plan-1",
    imageInsertion: {
      subject: "a fierce fox",
      placement: "page",
      targetPageIndex: 1,
      replaceAssetId: "asset-1"
    },
    generationJobId: "generation-1"
  }
} as unknown as Job;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "APPLIED" });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.planVersion.findUnique.mockResolvedValue({
    id: "plan-1",
    inputSnapshot: {},
    planningPackage: plan
  });
  mocks.prisma.imageAsset.findMany.mockResolvedValue([]);
  mocks.prisma.imageAsset.findFirst.mockResolvedValue(replacement);
  mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ classifier: {} });
  mocks.tx.bookEditOperation.update.mockResolvedValue({});
  mocks.tx.page.findUnique.mockResolvedValue(page);
  mocks.tx.page.update.mockResolvedValue({ ...page, revision: 4, imagePrompt: "a fierce fox" });
  mocks.tx.pageEditSnapshot.create.mockResolvedValue({ id: "snapshot-1" });
  mocks.tx.project.update.mockResolvedValue({ contentRevision: 8 });
  mocks.tx.imageAsset.findUnique.mockResolvedValue({
    id: replacement.id,
    path: replacement.path,
    prompt: replacement.prompt
  });
  mocks.tx.imageAsset.update.mockResolvedValue({});
  mocks.getProjectOrThrow.mockResolvedValue({
    id: "project-1",
    userId: "user-1",
    currentPlanId: "plan-1",
    language: "en"
  });
  mocks.generateImageBytes.mockResolvedValue({ bytes: Buffer.from("image"), mimeType: "image/png" });
  mocks.optimizeImageForStorage.mockResolvedValue({
    bytes: Buffer.from("optimized"),
    mimeType: "image/jpeg",
    extension: "jpg"
  });
  mocks.claimAppliedEditPublication.mockResolvedValue(true);
  mocks.restoreEditProjectStatus.mockResolvedValue(true);
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
});

describe("applyImageInsertion replacement publication lifecycle", () => {
  it("atomically stamps APPLIED at the exact replacement revision before refresh claims and settles it", async () => {
    const lifecycle = {
      operationStatus: "ACTIVE",
      publicationRevision: null as number | null,
      projectRevision: 7,
      projectStatus: "EDITING"
    };
    mocks.tx.project.update.mockImplementation(
      async ({ data }: { data: { contentRevision: { increment: number } } }) => {
        lifecycle.projectRevision += data.contentRevision.increment;
        return { contentRevision: lifecycle.projectRevision };
      }
    );
    mocks.tx.bookEditOperation.update.mockImplementation(
      async ({ data }: { data: { status?: string; publicationRevision?: number } }) => {
        if (data.status) lifecycle.operationStatus = data.status;
        if (data.publicationRevision !== undefined) lifecycle.publicationRevision = data.publicationRevision;
        return {};
      }
    );
    mocks.claimAppliedEditPublication.mockImplementation(async () => {
      return (
        lifecycle.operationStatus === "APPLIED" &&
        lifecycle.publicationRevision === lifecycle.projectRevision
      );
    });
    mocks.restoreEditProjectStatus.mockImplementation(
      async (_tx: unknown, _projectId: string, _operationId: string, fallbackStatus: string) => {
        if (
          lifecycle.operationStatus !== "APPLIED" ||
          lifecycle.publicationRevision !== lifecycle.projectRevision ||
          lifecycle.projectStatus !== "EDITING"
        ) {
          return false;
        }
        lifecycle.projectStatus = fallbackStatus;
        return true;
      }
    );
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { contentRevision: { increment: 1 } },
      select: { contentRevision: true }
    });
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: expect.objectContaining({
        status: "APPLIED",
        publicationRevision: 8,
        affectedPageIndexes: [1]
      })
    });
    expect(mocks.tx.bookEditOperation.update.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.claimAppliedEditPublication.mock.invocationCallOrder[0]!
    );
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx,
      "project-1",
      "op-1",
      "COMPLETE"
    );
    expect(lifecycle).toEqual({
      operationStatus: "APPLIED",
      publicationRevision: 8,
      projectRevision: 8,
      projectStatus: "COMPLETE"
    });
  });

  it("keeps stale replacement ownership away from the asset and revision, then safely replays the APPLIED tail", async () => {
    mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });

    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(mocks.tx.imageAsset.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.imageAsset.update).not.toHaveBeenCalled();
    expect(mocks.tx.page.update).not.toHaveBeenCalled();
    expect(mocks.tx.project.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { contentRevision: { increment: 1 } } })
    );
    expect(mocks.tx.bookEditOperation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
    expect(mocks.claimAppliedEditPublication).toHaveBeenCalledWith(
      mocks.tx,
      "project-1",
      "op-1",
      "COMPLETE"
    );
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
  });
});
