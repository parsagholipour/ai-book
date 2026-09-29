import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    manuscriptAssist: { findUnique: vi.fn(), updateMany: vi.fn() },
    manuscript: { findUnique: vi.fn() },
    libraryCharacter: { findMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    imageAsset: { findMany: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() }
  },
  append: vi.fn(),
  getProjectOrThrow: vi.fn(),
  generateImageBytes: vi.fn(),
  selectReferenceImagePaths: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ Prisma: {}, prisma: mocks.prisma, pageScope: (index: number) => `page:${index}` }));
vi.mock("../providers/loggedAdapters.js", () => ({
  createLoggedProviders: () => ({ text: { kind: "text" }, image: { kind: "image" }, embedding: {} })
}));
vi.mock("../providers/runLogging.js", () => ({ createRunLogger: () => ({ append: mocks.append }) }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  strategyForInput: () => ({ generateImageBytes: mocks.generateImageBytes, executionMode: "chaptered" })
}));
vi.mock("../generation/projectInput.js", () => ({ inputFromProject: () => ({ mediaSettings: {} }) }));
vi.mock("../generation/characterReferences.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/characterReferences.js")>(
    "../generation/characterReferences.js"
  );
  return { ...actual, selectReferenceImagePaths: mocks.selectReferenceImagePaths };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    createProviders: () => ({}),
    bookPlanSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
    imageAdapterCapabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 4 }),
    optimizeImageForStorage: async (input: { bytes: Buffer }) => ({
      bytes: input.bytes,
      mimeType: "image/webp",
      extension: "webp",
      outputBytes: input.bytes.length
    })
  };
});

import { ImageContentRefusedError, libraryCharacterObjectKey } from "@book-maker/core";
import { objectReference, objectStore } from "@book-maker/storage";
import { writingAssist } from "./writingAssist.js";

const importPlan = {
  characters: [],
  illustrationPlan: {
    globalStyle: "No illustrations. Imported manuscript preserved as the author wrote it.",
    pageRules: []
  }
};

function castRow(id: string, name: string, portraitPath: string | null) {
  return {
    id,
    name,
    description: `${name} is in the book.`,
    appearance: `${name}'s look.`,
    fields: [],
    portraitStatus: portraitPath ? "READY" : "NONE",
    portraitPath,
    portraitSource: portraitPath ? "GENERATED" : null,
    outgoingMentions: []
  };
}

function job() {
  return {
    id: "bull-1",
    name: "writing-assist",
    data: { projectId: "project-1", generationJobId: "job-1", assistId: "assist-1", attemptId: "attempt-1" }
  } as never;
}

function publishedWrite() {
  const calls = mocks.prisma.manuscriptAssist.updateMany.mock.calls;
  return calls[calls.length - 1]?.[0];
}

const lunaKey = libraryCharacterObjectKey("user-1/luna-portrait.png")!;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getProjectOrThrow.mockResolvedValue({
    id: "project-1",
    userId: "user-1",
    title: "Harbor Nights",
    language: "en",
    currentPlanId: "plan-1",
    status: "COMPLETE",
    mediaSettings: { mobile: { import: { importId: "imp-1" } } }
  });
  mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue({
    id: "assist-1",
    projectId: "project-1",
    chapterId: "ch-1",
    kind: "ILLUSTRATE",
    status: "QUEUED",
    input: { prompt: "Luna on the pier at dusk.", passage: "Luna waited on the pier while the boats came in." },
    result: null,
    error: null
  });
  mocks.prisma.manuscriptAssist.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.manuscript.findUnique.mockResolvedValue({
    id: "manuscript-1",
    settings: { layout: "flow", kind: "story", artStyle: "Ink and soft watercolor", castCharacterIds: ["char-luna", "char-bram"] },
    chapters: [{ id: "ch-1", position: 1, title: "Harbor", markdown: "Luna waited.", notes: "" }]
  });
  mocks.prisma.libraryCharacter.findMany.mockResolvedValue([
    castRow("char-luna", "Luna", "luna-portrait.png"),
    castRow("char-bram", "Bram", "bram-portrait.png")
  ]);
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ planningPackage: importPlan });
  mocks.prisma.imageAsset.findMany.mockResolvedValue([]);
  mocks.selectReferenceImagePaths.mockResolvedValue({ paths: [], libraryFaceNames: [] });
  mocks.generateImageBytes.mockResolvedValue({ bytes: Buffer.from("png"), mimeType: "image/png", provider: "fake", model: "fake" });
  await objectStore().put(lunaKey, Buffer.from("luna"), { contentType: "image/png" });
});

describe("writing-assist ILLUSTRATE", () => {
  it("draws in the author's art style with the named cast attached, and stores the assist's own file", async () => {
    await writingAssist(job());

    const request = mocks.generateImageBytes.mock.calls[0]![0];
    expect(request.prompt).toContain("Create one interior book illustration depicting: Luna on the pier at dusk.\n");
    expect(request.prompt).toContain("Global visual style: Ink and soft watercolor");
    // Never the imported plan's style, which tells every picture not to exist.
    expect(request.prompt).not.toContain("No illustrations");
    expect(request.prompt).toContain("Luna waited on the pier while the boats came in.");
    expect(request.prompt).toContain("- Luna: Luna's look.");
    expect(request.prompt).not.toContain("Bram");
    expect(request.referenceImagePaths).toEqual([objectReference(lunaKey)]);
    expect(request.promptForReferenceImages([])).not.toContain("attached character reference");
    expect(request.projectId).toBe("project-1");

    const stored = await objectStore().get("images/project-1/studio-image-assist-1.webp");
    expect(stored?.toString()).toBe("png");
    expect(publishedWrite()).toEqual({
      where: { id: "assist-1", status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        status: "READY",
        result: { type: "image", url: "/assets/images/project-1/studio-image-assist-1.webp", alt: "Luna on the pier at dusk." },
        error: null
      }
    });
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("draws a never-published book with no plan, attaching its only cast member and the default style", async () => {
    mocks.getProjectOrThrow.mockResolvedValue({
      id: "project-1",
      userId: "user-1",
      title: "Harbor Nights",
      language: "en",
      currentPlanId: null,
      status: "DRAFT",
      mediaSettings: { mobile: { studio: { layout: "picture", kind: "picture", createdAt: "2026-09-29" } } }
    });
    mocks.prisma.manuscript.findUnique.mockResolvedValue({
      id: "manuscript-1",
      settings: { layout: "picture", kind: "picture", castCharacterIds: ["char-luna"] },
      chapters: []
    });
    mocks.prisma.libraryCharacter.findMany.mockResolvedValue([castRow("char-luna", "Luna", "luna-portrait.png")]);
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue({
      id: "assist-1",
      projectId: "project-1",
      chapterId: null,
      kind: "ILLUSTRATE",
      status: "QUEUED",
      input: { prompt: "She finds a shell on the sand" },
      result: null,
      error: null
    });

    await writingAssist(job());

    expect(mocks.prisma.planVersion.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.findMany).not.toHaveBeenCalled();
    expect(mocks.selectReferenceImagePaths).not.toHaveBeenCalled();
    const request = mocks.generateImageBytes.mock.calls[0]![0];
    expect(request.prompt).toContain("Global visual style: Warm, detailed book illustration");
    expect(request.referenceImagePaths).toEqual([objectReference(lunaKey)]);
    expect(publishedWrite().data.status).toBe("READY");
  });

  it("lets a final refusal fail the job, storing nothing and writing no result", async () => {
    mocks.generateImageBytes.mockRejectedValue(
      new ImageContentRefusedError({ provider: "gemini", model: "m", reason: "IMAGE_SAFETY" })
    );

    await expect(writingAssist(job())).rejects.toBeInstanceOf(ImageContentRefusedError);

    expect(await objectStore().head("images/project-1/studio-image-assist-1.webp")).toBeNull();
    expect(mocks.prisma.manuscriptAssist.updateMany).toHaveBeenCalledTimes(1);
  });

  it("asks for a description before drawing anything", async () => {
    mocks.prisma.manuscriptAssist.findUnique.mockResolvedValue({
      id: "assist-1",
      projectId: "project-1",
      chapterId: null,
      kind: "ILLUSTRATE",
      status: "QUEUED",
      input: { prompt: "   " },
      result: null,
      error: null
    });

    await expect(writingAssist(job())).rejects.toThrow("Describe the picture you’d like, then try again.");
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
  });

  it("removes its picture when the author dismissed the request while it was drawing", async () => {
    mocks.prisma.manuscriptAssist.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.prisma.manuscriptAssist.findUnique
      .mockResolvedValueOnce({
        id: "assist-1",
        projectId: "project-1",
        chapterId: "ch-1",
        kind: "ILLUSTRATE",
        status: "QUEUED",
        input: { prompt: "Luna on the pier at dusk." },
        result: null,
        error: null
      })
      .mockResolvedValueOnce({ result: null });

    await writingAssist(job());

    expect(await objectStore().head("images/project-1/studio-image-assist-1.webp")).toBeNull();
    expect(mocks.append).toHaveBeenCalledWith("writing_assist.superseded", { assistId: "assist-1", kind: "ILLUSTRATE" });
  });

  it("keeps the picture a winning delivery's result points at", async () => {
    mocks.prisma.manuscriptAssist.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.prisma.manuscriptAssist.findUnique
      .mockResolvedValueOnce({
        id: "assist-1",
        projectId: "project-1",
        chapterId: "ch-1",
        kind: "ILLUSTRATE",
        status: "RUNNING",
        input: { prompt: "Luna on the pier at dusk." },
        result: null,
        error: null
      })
      .mockResolvedValueOnce({ result: { type: "image", url: "/assets/images/project-1/studio-image-assist-1.webp" } });

    await writingAssist(job());

    expect(await objectStore().head("images/project-1/studio-image-assist-1.webp")).not.toBeNull();
  });
});
