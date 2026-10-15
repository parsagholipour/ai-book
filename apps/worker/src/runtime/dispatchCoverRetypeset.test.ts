import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A cover set with words the book no longer has (`coverTypesetDrift`): a pen
 * name typed while the book was being written reaches a cover typeset minutes
 * earlier, so the cover catches up before the first compile — free, and never
 * a wait on a re-set that already ran.
 */

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  prisma: {
    project: { findUnique: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn() },
    imageAsset: { count: vi.fn(), findFirst: vi.fn() },
    generationJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn()
    },
    bookEditOperation: { findFirst: vi.fn() }
  },
  input: {} as Record<string, unknown>
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: { PrismaClientKnownRequestError: Error } }));
vi.mock("./queue.js", () => {
  const queue = { add: mocks.queueAdd, getJob: vi.fn() };
  return { queue, queueNamed: () => queue, allLaneQueues: [queue] };
});
vi.mock("./config.js", () => ({ config: { MAX_PARALLEL_PAGE_JOBS: 3 } }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => mocks.input }));

import { maybeEnqueueCompile } from "./dispatch.js";

type Row = Record<string, unknown>;

function generationRow(overrides: Row = {}): Row {
  return { id: "gj-1", projectId: "project-1", type: "GENERATE_PAGE", status: "QUEUED", bullJobId: null, payload: {}, dispatchAttempts: 0, ...overrides };
}

function createdTypes(): string[] {
  return mocks.prisma.generationJob.create.mock.calls.map((call) => (call[0] as { data: { type: string } }).data.type);
}

function createdJob(type: string): Row {
  const created = mocks.prisma.generationJob.create.mock.calls.map((call) => (call[0] as { data: Row }).data);
  return created.find((data) => data.type === type)!;
}

function coverRow(authorName: string, id: string): Row {
  return { id, metadata: { coverArtSource: "design", coverDesignId: "moonlit-sea", typeset: { title: "A Book", subtitle: "", authorName } } };
}

/** A GENERATING book whose pages are done and whose cover says `authorName`. */
function coverWearing(authorName: string, id = "cover-1"): void {
  mocks.prisma.imageAsset.count.mockResolvedValue(1);
  mocks.prisma.imageAsset.findFirst.mockResolvedValue(coverRow(authorName, id));
}

/** The byline on the book's row, which the title page prints. */
function bylineIs(authorName: string): void {
  mocks.prisma.project.findUnique.mockResolvedValue({
    status: "GENERATING",
    contentRevision: 7,
    title: "A Book",
    subtitle: null,
    authorName,
    coverTagline: null
  });
}

/** Re-sets that have already run: their dedupe keys answer with a COMPLETED row. */
function spentRetypesets(): Set<string> {
  const spent = new Set<string>();
  mocks.prisma.generationJob.findUnique.mockImplementation(async ({ where }: { where: { dedupeKey?: string } }) =>
    where.dedupeKey !== undefined && spent.has(where.dedupeKey)
      ? generationRow({ id: "gj-spent", type: "GENERATE_IMAGE", status: "COMPLETED", bullJobId: "bull-1" })
      : null
  );
  return spent;
}

/** The dedupe key of the re-set the last fan-in queued, forgetting the rows it created. */
function queuedRetypesetKey(): string {
  const key = createdJob("GENERATE_IMAGE").dedupeKey as string;
  mocks.prisma.generationJob.create.mockClear();
  return key;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.input = {
    prompt: "A field guide to backyard birds with enough detail to matter.",
    category: "SCIENCE",
    targetPages: 2,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: { fullIllustrations: true, illustrationCadence: "template-driven", includeCover: true, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" }
  };
  mocks.prisma.project.findUnique.mockResolvedValue({
    status: "GENERATING",
    contentRevision: 7,
    title: "A Book",
    subtitle: null,
    authorName: "Parsa Q.",
    coverTagline: null
  });
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ planningPackage: { title: "A Book" }, inputSnapshot: {} });
  mocks.prisma.page.findMany.mockResolvedValue([
    { id: "page-1", index: 1, status: "COMPLETED", markdown: "One.", revision: 1 },
    { id: "page-2", index: 2, status: "COMPLETED", markdown: "Two.", revision: 1 }
  ]);
  mocks.prisma.generationJob.count.mockResolvedValue(0);
  mocks.prisma.generationJob.findMany.mockResolvedValue([]);
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.findUnique.mockResolvedValue(null);
  mocks.prisma.bookEditOperation.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Row }) => generationRow({ id: "gj-new", ...data }));
  mocks.prisma.generationJob.update.mockImplementation(async ({ data }: { data: Row }) => generationRow(data));
  mocks.queueAdd.mockResolvedValue({ id: "bull-1" });
});

describe("a cover set with words the book no longer has", () => {
  it("is set again, free, before the book compiles", async () => {
    coverWearing("");

    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");

    const cover = createdJob("GENERATE_IMAGE");
    expect(cover.payload).toEqual({ planId: "plan-1", assetType: "COVER", coverRetypeset: true });
    expect(cover.dedupeKey).toMatch(/^retypeset-cover:project-1:plan-1:cover-1:[0-9a-f]{16}$/);
    expect(createdTypes()).not.toContain("COMPILE_EXPORT");
  });

  it("compiles with the cover it has once a re-set for the same change ran and left it as it was", async () => {
    const spent = spentRetypesets();
    coverWearing("");

    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");
    spent.add(queuedRetypesetKey());

    // It could not change the cover (its artwork gone, say): still "" → "Parsa Q.".
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("compile");
    expect(createdTypes()).toContain("COMPILE_EXPORT");
    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
  });

  it("is set back when the byline returns to words an earlier re-set already aimed at", async () => {
    const spent = spentRetypesets();

    // The cover was drawn before the name was given, and the name is A.
    coverWearing("");
    bylineIs("Parsa Q.");
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");
    const toA = queuedRetypesetKey();
    spent.add(toA);

    // That re-set ran — the cover says A — and the byline became X.
    coverWearing("Parsa Q.");
    bylineIs("P. Quill");
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");
    const toX = queuedRetypesetKey();
    spent.add(toX);

    // That one ran too — the cover says X — and the byline went back to A.
    coverWearing("P. Quill");
    bylineIs("Parsa Q.");
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");
    expect(createdTypes()).not.toContain("COMPILE_EXPORT");
    const backToA = queuedRetypesetKey();
    expect(new Set([toA, toX, backToA]).size).toBe(3);
    spent.add(backToA);

    // The cover says A, as the title page will.
    coverWearing("Parsa Q.");
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("compile");
    expect(createdTypes()).toContain("COMPILE_EXPORT");
    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
  });

  it("sets the byline again when successful re-sets repeat the same word transition", async () => {
    const spent = spentRetypesets();
    const queuedKeys: string[] = [];

    // Every successful re-set replaces the cover row, even when its words
    // return to an earlier state. The third request repeats A → X.
    for (const [coverId, stored, target] of [
      ["cover-a-first", "Parsa Q.", "P. Quill"],
      ["cover-x-first", "P. Quill", "Parsa Q."],
      ["cover-a-second", "Parsa Q.", "P. Quill"]
    ] as const) {
      coverWearing(stored, coverId);
      bylineIs(target);
      await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");
      expect(createdTypes()).not.toContain("COMPILE_EXPORT");
      const key = queuedRetypesetKey();
      queuedKeys.push(key);
      spent.add(key);
    }

    expect(new Set(queuedKeys).size).toBe(3);
    coverWearing("P. Quill", "cover-x-second");
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("compile");
    expect(createdTypes()).toContain("COMPILE_EXPORT");
    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
  });

  it("reads the cover once, so the key names the row and words the drift check compared", async () => {
    coverWearing("");
    await maybeEnqueueCompile("project-1", "plan-1");
    expect(mocks.prisma.imageAsset.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.imageAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, metadata: true }
    }));
  });

  it("is left alone when its words still match", async () => {
    coverWearing("Parsa Q.");

    await maybeEnqueueCompile("project-1", "plan-1");

    expect(createdTypes()).toContain("COMPILE_EXPORT");
    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
  });

  it("is a question only while the book is first being written", async () => {
    coverWearing("");
    mocks.prisma.project.findUnique.mockResolvedValue({
      status: "EDITING",
      contentRevision: 7,
      title: "A Book",
      subtitle: null,
      authorName: "Parsa Q.",
      coverTagline: null
    });

    await maybeEnqueueCompile("project-1", "plan-1", { skipFinalReview: true });

    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
    expect(mocks.prisma.imageAsset.findFirst).not.toHaveBeenCalled();
  });
});

describe("a cover from before covers recorded their words", () => {
  /**
   * The shapes `bookMatterRoutes.test.ts` answers `cover: "retypeset"` for on a
   * book still being written: the API has told the reader the cover takes the
   * pen name, so the fan-in has to make that true even with no record of what
   * the pixels say.
   */
  function unrecordedCover(metadata: Row, id = "cover-old"): void {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.imageAsset.findFirst.mockResolvedValue({ id, metadata });
  }

  it.each([
    ["a design", { coverArtSource: "design", coverDesignId: "night-sky" }],
    ["a drawn cover that kept its artwork", { coverArtSource: "ai", artworkObjectKey: "images/book-1/cover-art.jpg" }]
  ])("is set again once from the row: %s", async (_name, metadata) => {
    const spent = spentRetypesets();
    unrecordedCover(metadata);

    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");
    const cover = createdJob("GENERATE_IMAGE");
    expect(cover.payload).toEqual({ planId: "plan-1", assetType: "COVER", coverRetypeset: true });
    expect(cover.dedupeKey).toMatch(/^retypeset-cover:project-1:plan-1:cover-old:[0-9a-f]{16}$/);
    expect(createdTypes()).not.toContain("COMPILE_EXPORT");
    spent.add(queuedRetypesetKey());

    // A re-set that could not change it (its design gone from the catalog,
    // say) leaves the same row behind and finds its own key spent.
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("compile");
    expect(createdTypes()).toContain("COMPILE_EXPORT");
    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
  });

  it("compiles once the re-set row records the row's words", async () => {
    unrecordedCover({ coverArtSource: "design", coverDesignId: "night-sky" });
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");
    queuedRetypesetKey();

    coverWearing("Parsa Q.", "cover-new");
    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("compile");
    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
  });

  it.each([
    ["an uploaded cover", { source: "upload" }],
    ["a drawn cover from before artwork was kept", { coverArtSource: "ai", model: "imagen" }]
  ])("is left alone when nothing could set it again for free: %s", async (_name, metadata) => {
    unrecordedCover(metadata);

    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("compile");

    expect(createdTypes()).toContain("COMPILE_EXPORT");
    expect(createdTypes()).not.toContain("GENERATE_IMAGE");
  });
});
