import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const coverMocks = vi.hoisted(() => ({ findCover: vi.fn(), createJob: vi.fn(), findJob: vi.fn(), queueAdd: vi.fn() }));
vi.mock("../runtime/queue.js", () => {
  const queue = { add: coverMocks.queueAdd, getJob: vi.fn() };
  return { queue, queueNamed: () => queue, allLaneQueues: [queue] };
});
vi.mock("./compileFinalization.js", async () => (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock());
vi.mock("../generation/finalizationIllustrations.js", async () => (await import("./testing/compileExportMocks.js")).finalizationIllustrationsModuleMock());
vi.mock("@book-maker/db", async () => {
  const shared = (await import("./testing/compileExportMocks.js")).dbModuleMock();
  return { ...shared, prisma: { ...shared.prisma,
    imageAsset: { ...shared.prisma.imageAsset, findFirst: coverMocks.findCover },
    generationJob: { ...shared.prisma.generationJob, create: coverMocks.createJob, findUnique: coverMocks.findJob }
  } };
});
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);

vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock("../generation/bookHelpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../generation/bookHelpers.js")>()),
  ...(await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
}));
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { compileExport } from "./compileExport.js";
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import { mocks } from "./testing/compileExportMocks.js";
import { runWithGenerationAttempt } from "../runtime/generationAttemptContext.js";
import { objectStore } from "@book-maker/storage";
import { writeFile } from "node:fs/promises";

type Row = Record<string, any>;
const plan = { title: "The Long Walk", premise: "A walk home.", audience: "adults", chapters: [] };
const input = {
  title: plan.title, prompt: "A book about walking home.", category: "fiction",
  targetPages: 1, complexity: 3, temperature: 0.6, language: "en", mediaSettings: { finalReview: false }
};
let project: Row;
let jobs: Row[];
const job = (payload: Row = {}) => ({
  name: "compile-export",
  data: { projectId: "project-1", planId: "plan-1", generationJobId: "compile-1", contentRevision: 7,
    attemptId: "paid-attempt", skipFinalReview: true, ...payload }
}) as unknown as Job;

beforeEach(async () => {
  vi.clearAllMocks();
  await objectStore().delete("books/project-1/book.md");
  jobs = [];
  project = {
    id: "project-1", userId: "user-1", title: plan.title, subtitle: null, coverTagline: null,
    currentPlanId: "plan-1", status: "GENERATING", contentRevision: 7, authorName: "New Author",
    bookMatter: { dedication: "For my family" }, mediaSettings: {}, createdAt: new Date("2026-01-01"),
    images: [{ id: "cover-1", type: "COVER", path: "/assets/images/project-1/cover.png" }], research: [], pages: [{ id: "page-1", index: 1, title: "Home",
      markdown: "Walking home beside the quiet river.", summary: "The walk home.", imagePrompt: null,
      status: "COMPLETED", revision: 0, images: [], chapter: null }]
  };
  mocks.prisma.project.findUnique.mockImplementation(async () => structuredClone(project));
  mocks.prisma.generationJob.count.mockResolvedValue(0);
  coverMocks.findJob.mockImplementation(async ({ where }: Row) =>
    jobs.find((row) => where.id ? row.id === where.id : row.dedupeKey === where.dedupeKey) ?? null
  );
  mocks.prisma.generationJob.update.mockImplementation(async ({ where, data }: Row) => {
    const existing = jobs.find((row) => row.id === where.id);
    if (existing) Object.assign(existing, data);
    return existing;
  });
  coverMocks.findCover.mockResolvedValue({ id: "cover-1", metadata: {
    coverArtSource: "design", coverDesignId: "moonlit-sea",
    typeset: { title: plan.title, subtitle: "", authorName: "Previous Author" }
  } });
  coverMocks.createJob.mockImplementation(async ({ data }: Row) => {
    const row = { id: "retypeset-1", bullJobId: null, dispatchAttempts: 0, ...data };
    jobs.push(row);
    return row;
  });
  coverMocks.queueAdd.mockResolvedValue({ id: "bull-1" });
  mocks.inputForPlanVersion.mockReturnValue(input);
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
  mocks.strategy.compileMarkdown.mockReturnValue("# The Long Walk\n\nWalking home beside the quiet river.\n");
  mocks.createReaderChaptersForExport.mockResolvedValue({ chapters: [], source: "model" });
  mocks.pendingExportPaths.mockImplementation((directory: string) => pendingExportPaths(directory, "cover-drift-test"));
  mocks.exportPublicationSuperseded.mockResolvedValue(false);
  mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
  mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
  mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: () => false });
});

describe("cover replacement during a compile", () => {
  it.each(["GENERATING", "EDITING"])("binds a %s render to its cover and hands a changed cover to a successor", async (status) => {
    project.status = status;
    project.authorName = "Previous Author";
    mocks.publishCompiledExports.mockResolvedValue({
      published: false, blockedByOpenImageJobs: false, blockedByChangedCover: true, characterPreparationJobId: null
    });
    const payload = status === "EDITING" ? {
      presentationOnlyRecompile: true, presentationRecompileFallbackStatus: "REVIEW_REQUIRED", exportPublicationProjectStatus: "EDITING"
    } : {};

    const completion = await compileExport(job(payload));

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ renderedCoverId: "cover-1" }));
    expect(completion.lifecycleSettlement).toBe("defer-to-successor");
    expect(completion.afterJobCompleted).toBeTypeOf("function");
    // The completed predecessor gives the successor a fresh dedupe identity;
    // it must retain the presentation fallback and the exact revision policy.
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    const dispatch = await import("../runtime/dispatch.js");
    const fanIn = vi.spyOn(dispatch, "maybeEnqueueCompile").mockResolvedValue("compile");
    try {
      await completion.afterJobCompleted?.();
      expect(fanIn).toHaveBeenCalledWith("project-1", "plan-1", {
        review: { skipFinalReview: true, withoutQualityVerdict: false },
        expectedProjectStatus: status === "EDITING" ? "EDITING" : null,
        ownership: status === "EDITING" ? { kind: "presentation", fallbackStatus: "REVIEW_REQUIRED" } : { kind: "outcome" }
      }, { contentRevision: 7, completedPredecessorId: "compile-1" });
    } finally {
      fanIn.mockRestore();
    }
  });

  it("binds a coverless compile explicitly, so a first cover appearing during render is detected", async () => {
    project.status = "EDITING";
    project.images = [];
    await compileExport(job({ presentationOnlyRecompile: true }));
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ renderedCoverId: null }));
  });

  it("renders and binds the newest of two COVER rows, whatever order the snapshot lists them in", async () => {
    // A delete-then-create race can leave two rows. An unordered `find` took the
    // older one, publication's read under the lock took the newer, and every
    // successor deferred over the same pair. Both now go through one selector.
    project.status = "EDITING";
    project.images = [
      { id: "cover-old", type: "COVER", path: "/assets/images/project-1/cover-old.png", createdAt: new Date("2026-01-01") },
      { id: "cover-new", type: "COVER", path: "/assets/images/project-1/cover-new.png", createdAt: new Date("2026-01-02") }
    ];
    await compileExport(job({ presentationOnlyRecompile: true }));
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ renderedCoverId: "cover-new" }));
    expect(mocks.strategy.compileMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      cover: expect.objectContaining({ imagePath: expect.stringContaining("cover-new.png") })
    }));
  });

  it.each([false, true])("fences a detached repair only when it reconstructs the manuscript (published=%s)", async (published) => {
    project.status = "COMPLETE";
    if (published) await objectStore().put("books/project-1/book.md", Buffer.from("# The Long Walk\n\nWalking home beside the quiet river.\n"));
    await compileExport(job({ detachedFromProjectLifecycle: true, exportRepairFormat: "pdf" }));
    const options = mocks.publishCompiledExports.mock.calls[0]![0];
    if (published) expect(options).not.toHaveProperty("renderedCoverId");
    else expect(options).toHaveProperty("renderedCoverId", "cover-1");
  });

  it.each(["GENERATING", "EDITING"])("keeps published bytes intact when a %s cover replacement finishes during the real render/publication path", async (status) => {
    project.status = status;
    project.authorName = "Previous Author";
    const existing = Buffer.from("%PDF-published-before-cover-change");
    await objectStore().put("books/project-1/book.pdf", existing);
    const actual = await vi.importActual<typeof import("../generation/exportPublication.js")>("../generation/exportPublication.js");
    mocks.publishCompiledExports.mockImplementation(actual.publishCompiledExports);
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run({
      ...mocks.prisma,
      imageAsset: { ...mocks.prisma.imageAsset, findMany: async () => {
        const current = await coverMocks.findCover();
        return current ? [{ id: current.id, type: "COVER", createdAt: new Date("2026-01-02") }] : [];
      } },
      generationJob: { ...mocks.prisma.generationJob, findUnique: coverMocks.findJob }
    }));
    mocks.strategy.generatePdf.mockImplementation(async (_markdown, options: { outputPath: string }) => {
      // The replacement publishes under the same revision and is already
      // COMPLETED by the publication count. Only its row identity differs.
      coverMocks.findCover.mockResolvedValue({ id: "cover-new", metadata: {
        typeset: { title: plan.title, subtitle: "", authorName: "Previous Author" }
      } });
      const bytes = Buffer.from("%PDF-rendered-with-old-cover");
      await writeFile(options.outputPath, bytes);
      return bytes;
    });
    for (const render of [mocks.generateBookEpub, mocks.generateBookDocx]) {
      render.mockImplementation(async (_markdown, options: { outputPath: string }) => writeFile(options.outputPath, "companion"));
    }
    const completion = await compileExport(job(status === "EDITING" ? { presentationOnlyRecompile: true } : {}));

    expect(await objectStore().get("books/project-1/book.pdf")).toEqual(existing);
    expect(completion.lifecycleSettlement).toBe("defer-to-successor");
    expect(completion.afterJobCompleted).toBeTypeOf("function");
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });
});

describe("a book holding two COVER rows", () => {
  it("publishes through the real publication instead of deferring to a successor that meets the same pair", async () => {
    project.status = "EDITING";
    const older = { id: "cover-old", type: "COVER", path: "/assets/images/project-1/cover-old.png", createdAt: new Date("2026-01-01") };
    const newer = { id: "cover-new", type: "COVER", path: "/assets/images/project-1/cover-new.png", createdAt: new Date("2026-01-02") };
    // The snapshot lists the older row first; the read under the lock returns
    // the newer first. Neither order may decide which row is the cover.
    project.images = [older, newer];
    const actual = await vi.importActual<typeof import("../generation/exportPublication.js")>("../generation/exportPublication.js");
    const outcomes: unknown[] = [];
    mocks.publishCompiledExports.mockImplementation(async (options) => {
      const outcome = await actual.publishCompiledExports(options);
      outcomes.push(outcome);
      return outcome;
    });
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run({
      ...mocks.prisma,
      imageAsset: { ...mocks.prisma.imageAsset, findMany: async () => [newer, older].map(({ id, type, createdAt }) => ({ id, type, createdAt })) },
      generationJob: { ...mocks.prisma.generationJob, findUnique: coverMocks.findJob }
    }));
    mocks.strategy.generatePdf.mockImplementation(async (_markdown, options: { outputPath: string }) => {
      await writeFile(options.outputPath, "%PDF-rendered");
      return Buffer.from("%PDF-rendered");
    });
    for (const render of [mocks.generateBookEpub, mocks.generateBookDocx]) {
      render.mockImplementation(async (_markdown, options: { outputPath: string }) => writeFile(options.outputPath, "companion"));
    }

    const completion = await compileExport(job({ presentationOnlyRecompile: true }));

    expect(outcomes).toEqual([expect.objectContaining({ published: true, blockedByChangedCover: false })]);
    expect(completion.lifecycleSettlement).not.toBe("defer-to-successor");
  });
});

describe("first compile after a byline save overtook fan-in", () => {
  it("sets the cover again before rendering and defers the paid attempt to its successor", async () => {
    // Fan-in saw Previous Author and a matching cover. The save committed
    // before insertion of this durable compile row, so its fresh snapshot
    // sees New Author; the row now prevents any further matter saves.
    const completion = await runWithGenerationAttempt("paid-attempt", () => compileExport(job()));
    expect(jobs).toEqual([expect.objectContaining({
      type: "GENERATE_IMAGE", attemptId: "paid-attempt", status: "QUEUED",
      payload: { planId: "plan-1", assetType: "COVER", coverRetypeset: true }
    })]);
    expect(completion.lifecycleSettlement).toBe("defer-to-successor");
    expect(completion.afterJobCompleted).toBeTypeOf("function");
    expect(mocks.strategy.compileMarkdown).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "COMPLETED"])("renders once a retypeset for those same words is %s", async (status) => {
    // The existing fingerprint/dedupe policy spends a failed retypeset once.
    coverMocks.findJob.mockResolvedValue({ id: "spent", status, bullJobId: "bull-spent" });
    await runWithGenerationAttempt("paid-attempt", () => compileExport(job()));
    expect(coverMocks.createJob).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
  });


  it("renders immediately when the cover already carries the saved byline", async () => {
    project.authorName = "Previous Author";
    await compileExport(job());
    expect(coverMocks.createJob).not.toHaveBeenCalled();
    expect(mocks.strategy.compileMarkdown).toHaveBeenCalledWith(expect.objectContaining({ authorName: "Previous Author" }));
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
  });

  it("does not start a cover job for a settled book's recompile", async () => {
    project.status = "EDITING";
    await compileExport(job());
    expect(coverMocks.findCover).not.toHaveBeenCalled();
    expect(coverMocks.createJob).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
  });

  it("leaves an obsolete compile to its revision fence", async () => {
    project.contentRevision = 8;
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    await compileExport(job());
    expect(coverMocks.createJob).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });
});
