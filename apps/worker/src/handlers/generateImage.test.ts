import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findUnique: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    imageAsset: { create: vi.fn() }
  },
  generateImageBytes: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  updateJobProgress: vi.fn()
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
  selectReferenceImagePaths: () => []
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
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));

import { StopRequestedError } from "../runtime/jobTypes.js";
import { generateImage } from "./generateImage.js";

const job = { id: "job-1", data: { projectId: "project-1", pageId: "page-1", planId: "plan-1", prompt: "A fox." } } as unknown as Job;

describe("generateImage interior rescue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      index: 3,
      title: "The Fox",
      summary: "Fox appears.",
      markdown: "The fox appears."
    });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
    mocks.prisma.imageAsset.create.mockResolvedValue({});
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(() => vi.clearAllMocks());

  it("stores the image and asks for a compile on success", async () => {
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("img"),
      mimeType: "image/png",
      provider: "gemini",
      model: "img-model"
    });

    await generateImage(job);

    expect(mocks.prisma.imageAsset.create).toHaveBeenCalledTimes(1);
    // A successful render clears any earlier recorded loss for this page.
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: { id: "page-1", NOT: { imageFailureReason: null } },
      data: { imageFailureReason: null }
    });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
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
      where: { id: "page-1" },
      data: { imageFailureReason: "interior_image_failed" }
    });
    expect(mocks.updateJobProgress).toHaveBeenCalledWith(undefined, {
      message: "Illustration for page 3 failed; the book will finish without it"
    });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("still surfaces a user stop", async () => {
    mocks.generateImageBytes.mockRejectedValue(new StopRequestedError());

    await expect(generateImage(job)).rejects.toThrow(StopRequestedError);
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    // A user stop is not a lost illustration; the page keeps a clean slate.
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });
});
