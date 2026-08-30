import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

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
  optimizeImageForStorage: vi.fn(),
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
vi.mock("../generation/characterReferences.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/characterReferences.js")>(
    "../generation/characterReferences.js"
  );
  return { ...actual, selectReferenceImagePaths: mocks.selectReferenceImagePaths };
});
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
    optimizeImageForStorage: mocks.optimizeImageForStorage
  };
});

import { applyImageInsertion } from "./applyImageInsertion.js";

const plan = {
  illustrationPlan: { globalStyle: "Soft watercolor.", pageRules: ["Keep the dragon green."] },
  characters: []
};

const targetPage = {
  id: "page-5",
  index: 5,
  title: "Page 5",
  markdown: "The dragon sleeps.",
  summary: "Sleepy dragon.",
  revision: 3
};

const request = "Add a photo of Luna at the end of the book";
const characterContext = "Mentioned character profiles:\n- Luna: a brave night-flying rabbit.";

function job(data: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: `${request}\n\n${characterContext}`,
      editInstruction: request,
      characterContext,
      affectedPageIndexes: [5],
      planId: "plan-1",
      intentKind: "add_image",
      imageInsertion: { subject: "Luna riding a dragon", placement: "end_of_book", targetPageIndex: 5 },
      generationJobId: "gen-1",
      ...data
    }
  } as unknown as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "ACTIVE" });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.planVersion.findUnique.mockResolvedValue({
    id: "plan-1",
    inputSnapshot: {},
    planningPackage: plan
  });
  mocks.prisma.page.findFirst.mockResolvedValue({ ...targetPage });
  mocks.prisma.imageAsset.findMany.mockResolvedValue([]);
  mocks.prisma.imageAsset.findFirst.mockResolvedValue(null);
  mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ classifier: {} });
  mocks.tx.bookEditOperation.update.mockResolvedValue({});
  mocks.tx.page.findUnique.mockResolvedValue({ ...targetPage });
  mocks.tx.page.update.mockResolvedValue({ ...targetPage, revision: 4 });
  mocks.tx.pageEditSnapshot.create.mockResolvedValue({ id: "snap-1" });
  mocks.tx.project.update.mockResolvedValue({ contentRevision: 8 });
  mocks.getProjectOrThrow.mockResolvedValue({
    id: "project-1",
    userId: "user-1",
    currentPlanId: "plan-1",
    language: "en",
    mediaSettings: {},
    status: "COMPLETE"
  });
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
});

function renderedPrompt(): string {
  const render = mocks.generateImageBytes.mock.calls[0]?.[0] as
    | { prompt: string; promptForReferenceImages?: (attached: readonly string[]) => string }
    | undefined;
  return render?.prompt ?? "";
}

function restatedPrompt(): string {
  const render = mocks.generateImageBytes.mock.calls[0]?.[0] as
    | { promptForReferenceImages?: (attached: readonly string[]) => string }
    | undefined;
  return render?.promptForReferenceImages?.([]) ?? "";
}

describe("applyImageInsertion character context", () => {
  it("keeps fused sheets out of the reader's request and labels them as supplemental canon", async () => {
    await applyImageInsertion(job(), { status: "QUEUED", classifier: {} });

    const prompt = renderedPrompt();
    expect(prompt).toContain(`The reader's request:\n${request}`);
    expect(prompt).not.toContain("including any character notes");
    expect(prompt).toContain(
      "Character context (supplemental canon, not an additional edit requirement):"
    );
    expect(prompt).toContain("night-flying");

    const requestBlock = prompt.slice(
      prompt.indexOf("The reader's request:"),
      prompt.indexOf("Character context")
    );
    expect(requestBlock).not.toContain("night-flying");

    const restated = restatedPrompt();
    expect(restated).toContain(`The reader's request:\n${request}`);
    expect(restated).not.toContain("including any character notes");
    expect(restated).toContain("night-flying");
    expect(restated.slice(restated.indexOf("The reader's request:"), restated.indexOf("Character context"))).not.toContain(
      "night-flying"
    );
  });
});
