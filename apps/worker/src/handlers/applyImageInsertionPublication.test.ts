import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    project: { update: vi.fn(), findUnique: vi.fn() },
    imageAsset: { findUnique: vi.fn(), update: vi.fn() }
  },
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  generateImageBytes: vi.fn(),
  selectReferenceImagePaths: vi.fn(),
  claimAppliedEditPublication: vi.fn(async () => true),
  restoreEditProjectStatus: vi.fn(async () => true)
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/img", PUBLIC_API_URL: "http://localhost:4001" }
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ image: { kind: "image" } }) }));
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: () => ({ mediaSettings: {} })
}));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({ generateImageBytes: mocks.generateImageBytes }),
  imageGenerationMetadata: vi.fn(),
  imageStorageMetadata: vi.fn()
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));
vi.mock("../generation/characterReferences.js", () => ({
  selectReferenceImagePaths: mocks.selectReferenceImagePaths
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
  appendFile: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({}),
    imageAdapterCapabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 4 }),
    optimizeImageForStorage: vi.fn()
  };
});

import { applyImageInsertion } from "./applyImageInsertion.js";

const COMPILE_OPTIONS = { skipFinalReview: true, withoutQualityVerdict: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "APPLIED" });
  mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: "plan-1" });
  mocks.claimAppliedEditPublication.mockResolvedValue(true);
  mocks.restoreEditProjectStatus.mockResolvedValue(true);
  mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
});

describe("applyImageInsertion APPLIED publication replay", () => {
  it("still replays an APPLIED redelivery whose payload lost the field", async () => {
    await applyImageInsertion(job({ imageInsertion: undefined }), { status: "APPLIED", classifier: {} });

    // The picture is already on the page, so the missing-subject throw may not
    // come before the redelivery fence.
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", COMPILE_OPTIONS);
  });
});

function job(data: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: "Add a photo of a dragon at the end of the book",
      affectedPageIndexes: [5],
      planId: "plan-1",
      intentKind: "add_image",
      generationJobId: "gen-1",
      ...data
    }
  } as unknown as Job;
}
