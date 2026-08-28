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
  claimAppliedEditPublication: vi.fn(async () => true),
  restoreEditProjectStatus: vi.fn(async () => true)
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/img", PUBLIC_API_URL: "http://localhost:4001" }
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ image: {} }) }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ mediaSettings: {} }) }));
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
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() }));
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

/**
 * What a replacement leaves behind about the picture it drew.
 *
 * `ImageAsset.prompt` is what the book asked for, and `metadata.copyrightRewrite`
 * is the claim about what was drawn instead when an IP filter refused the name —
 * the only IP-provenance record this product keeps. A replacement puts different
 * pixels behind a row that already exists, so both halves matter: the new
 * render's record has to arrive, and the previous render's has to leave. A false
 * one is worse than none.
 *
 * Separate from `applyImageInsertion.test.ts` because that suite is about which
 * page a picture lands on and which delivery wins; this one only ever asks what
 * the row says about where the pixels came from.
 */
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
/** The slot half of the document: ownership is decided from these. */
const SLOT_METADATA = {
  model: "gemini-2.5-flash-image",
  keeperToken: "v2-keeper-1",
  keeperPageId: "page-1",
  keeperProjectId: "project-1"
};
const COPYRIGHT_REWRITE = {
  refusalReason: "PROHIBITED_CONTENT",
  replaced: ["Spider-Man"],
  prompt: "A young masked hero in a red-and-blue suit on a rooftop."
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

/**
 * The row as the database holds it, because an update writes only the columns
 * it names — leaving `metadata` out of the patch is exactly how the previous
 * render's claim outlived the pixels it described, so asserting on the patch
 * alone cannot see the bug.
 */
const row: { id: string; path: string; prompt: string; metadata: Record<string, unknown> } = {
  id: replacement.id,
  path: replacement.path,
  prompt: replacement.prompt,
  metadata: {}
};

/** The live row the transaction re-reads, with whatever it already claimed. */
function liveAsset(metadata: Record<string, unknown>): void {
  row.metadata = metadata;
}

function storedMetadata(): Record<string, unknown> {
  return row.metadata;
}

function storedPreviousAsset(): Record<string, unknown> {
  const call = mocks.tx.bookEditOperation.update.mock.calls[0]?.[0] as
    | { data: { classifier: { previousAsset: Record<string, unknown> } } }
    | undefined;
  return call?.data.classifier.previousAsset ?? {};
}

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
  Object.assign(row, { id: replacement.id, path: replacement.path, prompt: replacement.prompt });
  liveAsset({ ...SLOT_METADATA });
  mocks.tx.imageAsset.findUnique.mockImplementation(async () => ({ ...row }));
  mocks.tx.imageAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(row, data);
    return { ...row };
  });
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

describe("applyImageInsertion asset replacement provenance", () => {
  it("records the rewrite the replacement render was drawn from", async () => {
    // "Replace page 7 with Spider-Man on a rooftop": both providers refuse, one
    // rewritten prompt is bought, and the picture is an original stand-in.
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("image"),
      mimeType: "image/png",
      copyrightRewrite: COPYRIGHT_REWRITE
    });

    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(storedMetadata()).toMatchObject({ copyrightRewrite: COPYRIGHT_REWRITE });
  });

  it("clears a previous render's rewrite claim when the redraw needed none", async () => {
    // The row already says a protected name was taken out of it. The reader
    // then replaces the picture with a lighthouse nobody objected to, and the
    // claim must not survive the bytes it described.
    liveAsset({ ...SLOT_METADATA, copyrightRewrite: COPYRIGHT_REWRITE });

    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(storedMetadata()).not.toHaveProperty("copyrightRewrite");
    expect(storedMetadata()).toMatchObject(SLOT_METADATA);
  });

  it("replaces the previous rewrite rather than merging the two", async () => {
    liveAsset({ ...SLOT_METADATA, copyrightRewrite: COPYRIGHT_REWRITE });
    const redraw = { refusalReason: "RECITATION", replaced: ["Batman"], prompt: "A caped night watchman." };
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("image"),
      mimeType: "image/png",
      copyrightRewrite: redraw
    });

    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(storedMetadata()).toMatchObject({ copyrightRewrite: redraw });
  });

  it("keeps the slot keys the row is owned by", async () => {
    // Only the render half is replaced: `keeperToken` and its siblings decide
    // which page illustration this is, and losing them orphans the picture.
    liveAsset({ ...SLOT_METADATA, copyrightRewrite: COPYRIGHT_REWRITE });

    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(storedMetadata()).toMatchObject(SLOT_METADATA);
  });

  it("writes the outgoing picture's own record onto the undo classifier", async () => {
    // Undo restores `path`, so the record that describes those bytes has to
    // travel with it or the restored picture inherits the redraw's claim.
    liveAsset({ ...SLOT_METADATA, copyrightRewrite: COPYRIGHT_REWRITE });

    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(storedPreviousAsset()).toMatchObject({
      id: "asset-1",
      path: replacement.path,
      generation: { copyrightRewrite: COPYRIGHT_REWRITE }
    });
  });

  it("records an empty provenance for a picture that never had one", async () => {
    // Not the same as no key at all: undo has to be able to tell "this picture
    // claimed nothing" from "this edit predates the record".
    await applyImageInsertion(job, { status: "QUEUED", classifier: {} });

    expect(storedPreviousAsset().generation).toEqual({});
  });
});
