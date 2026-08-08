import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    imageAsset: { deleteMany: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    $transaction: vi.fn(async (operations: unknown[]) => operations)
  },
  generateImageBytes: vi.fn(),
  renderCoverPng: vi.fn(async (_options: unknown) => Buffer.from("cover-png")),
  maybeEnqueueCompile: vi.fn(),
  advanceJobStep: vi.fn(),
  updateJobProgress: vi.fn(),
  writeFile: vi.fn(),
  selectCoverDesign: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: mocks.advanceJobStep,
  updateJobProgress: mocks.updateJobProgress
}));
vi.mock("../runtime/config.js", () => ({ config: { IMAGE_STORAGE_DIR: "/tmp/images", PUBLIC_API_URL: "http://api.test" } }));
vi.mock("../providers/loggedAdapters.js", () => ({
  coverImageSelectionForInput: () => undefined,
  createImageAdapterForSelection: () => ({}),
  createLoggedProviders: () => ({ text: {}, image: {} })
}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: mocks.writeFile }));
vi.mock("../generation/bookHelpers.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/bookHelpers.js")>("../generation/bookHelpers.js");
  return {
    ...actual,
    getProjectOrThrow: async (id: string) => ({ id, title: "A Test Book", authorName: "A. Reader" }),
    strategyForInput: () => ({ generateImageBytes: mocks.generateImageBytes }),
    coverMetadataFromProject: () => ({ title: "A Test Book", authorName: "A. Reader" })
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    createProviders: () => ({}),
    bookPlanSchema: { parse: () => ({ characters: [], premise: "p", audience: "a", illustrationPlan: {} }) },
    renderCoverPng: mocks.renderCoverPng,
    optimizeImageForStorage: async ({ bytes }: { bytes: Buffer }) => ({ bytes, extension: "jpg", contentType: "image/jpeg" }),
    selectCoverDesign: mocks.selectCoverDesign
  };
});

import { coverDesign } from "@book-maker/core";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { BUNDLED_COVER_PROVIDER, coverTemplateOverrideForDesign, generateCover } from "./generateCover.js";

function job(): Job {
  return { data: { projectId: "project-1", planId: "plan-1", generationJobId: "gen-1" } } as unknown as Job;
}

function planVersion(mediaSettings: Record<string, unknown>) {
  return {
    planningPackage: {},
    inputSnapshot: {
      prompt: "A book about paying attention that is long enough to parse.",
      category: "STORY",
      targetPages: 10,
      mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", toneProfile: "neutral", ...mediaSettings }
    }
  };
}

function storedAsset() {
  const call = mocks.prisma.imageAsset.create.mock.calls[0]?.[0] as
    | { data: { provider: string; prompt: string; metadata: Record<string, unknown> } }
    | undefined;
  return call?.data;
}

describe("generateCover", () => {
  beforeEach(() => {
    mocks.selectCoverDesign.mockResolvedValue({ design: coverDesign("moonlit-sea"), selectedBy: "model" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a bundled design without calling an image model", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: false, coverArtSource: "design" }));

    await generateCover(job());

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    const asset = storedAsset();
    expect(asset?.provider).toBe(BUNDLED_COVER_PROVIDER);
    expect(asset?.prompt).toContain("Moonlit Sea");
    expect(asset?.metadata).toMatchObject({
      coverArtSource: "design",
      coverDesignId: "moonlit-sea",
      coverDesignSelectedBy: "model",
      // Free work, and saying so keeps it out of the Costs tab's unpriced bucket.
      costUsd: 0
    });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("gives a designed cover its own typography rather than the book type's", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(
      planVersion({ includeCover: false, coverArtSource: "design", coverTemplate: "business" })
    );

    await generateCover(job());

    const [render] = mocks.renderCoverPng.mock.calls[0] as [{ template?: { id: string } }];
    expect(render?.template?.id).toBe("fiction");
  });

  it("finishes the book with a designed cover when every image provider fails", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));

    await generateCover(job());

    const asset = storedAsset();
    expect(asset?.provider).toBe(BUNDLED_COVER_PROVIDER);
    expect(asset?.metadata).toMatchObject({ coverArtSource: "design", coverFallbackReason: "ai_cover_failed" });
    // The book is written and paid for; failing here would refund the whole run.
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("still surfaces a user stop instead of quietly producing a design", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockRejectedValue(new StopRequestedError());

    await expect(generateCover(job())).rejects.toThrow(StopRequestedError);
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("hands the stop predicate to the design selection so a stop there surfaces too", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: false, coverArtSource: "design" }));
    mocks.selectCoverDesign.mockImplementation(async (options: { bailOnError?: (error: unknown) => boolean }) => {
      // The real selectCoverDesign re-throws errors this predicate claims; a
      // selection wired without it swallowed the stop and compiled the book.
      const stop = new StopRequestedError();
      expect(options.bailOnError?.(stop)).toBe(true);
      throw stop;
    });

    await expect(generateCover(job())).rejects.toThrow(StopRequestedError);
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("stores the model's artwork when it succeeds", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("art"),
      mimeType: "image/png",
      provider: "gemini",
      model: "gemini-3-pro-image"
    });

    await generateCover(job());

    const asset = storedAsset();
    expect(asset?.provider).toBe("gemini");
    expect(asset?.metadata).toMatchObject({ coverArtSource: "ai", sourceImageModel: "gemini-3-pro-image" });
    expect(mocks.selectCoverDesign).not.toHaveBeenCalled();
  });

  it("writes no cover at all only when the source is none", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: false, coverArtSource: "none" }));

    await generateCover(job());

    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });
});

describe("coverTemplateOverrideForDesign", () => {
  it("carries the design's own scrim when it has one", () => {
    const linen = coverDesign("linen-minimal");
    expect(linen).toBeDefined();
    const override = coverTemplateOverrideForDesign(linen!);
    expect(override.id).toBe("minimal");
    // Light artwork needs a heavier scrim; every template sets light type.
    expect(override.overlayCss).toBeDefined();
  });

  it("leaves the template's own accent alone when the design does not override it", () => {
    expect(coverTemplateOverrideForDesign(coverDesign("moonlit-sea")!).accentColor).toBeUndefined();
  });
});
