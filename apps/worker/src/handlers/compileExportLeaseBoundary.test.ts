import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("@book-maker/core", async () => (await import("./testing/compileExportMocks.js")).coreModuleMock(await vi.importActual("@book-maker/core")));
vi.mock("./compileFinalization.js", async () => (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock());
vi.mock("../generation/finalizationIllustrations.js", async () => (await import("./testing/compileExportMocks.js")).finalizationIllustrationsModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock("../generation/projectInput.js", async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock());
vi.mock("../generation/exportPublication.js", async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock());
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock("../runtime/jobLifecycle.js", async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock());
vi.mock("../providers/loggedAdapters.js", async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock());
vi.mock("../generation/bookHelpers.js", async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock());
vi.mock("../generation/qualitySettings.js", async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock());
import { compileExport } from "./compileExport.js";
import { mocks } from "./testing/compileExportMocks.js";

// The defect screen is the one review that opens a finalization lease, so these run a Quick Draft book.
describe("compile entry after waiting for its durable lease", () => {
  const pages = [{ id: "page-1", index: 1, title: "Opening", markdown: "Original prose.", summary: "An opening.", status: "COMPLETED", images: [], chapter: null, revision: 1 }];
  const job = { data: { projectId: "project-1", planId: "plan-1", generationJobId: "compile-1", contentRevision: 4 } } as unknown as Job;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inputForPlanVersion.mockReturnValue({ title: "Book", prompt: "A book.", category: "KIDS", targetPages: 1, mediaSettings: { modelTier: "fast" } });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: { title: "Book", chapters: [], promises: [] }, inputSnapshot: {} });
    mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", status: "GENERATING", title: "Book", contentRevision: 4, pages, images: [], research: [], mediaSettings: {} });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.loadLeasedPagesForExport.mockImplementation(async (_id, current) => current);
    mocks.checkLeasedExportOwnership.mockResolvedValue(false);
  });

  it("rereads the manuscript and stands down before provider spending when an edit landed during lease wait", async () => {
    mocks.checkLeasedExportOwnership.mockResolvedValueOnce(true);
    await expect(compileExport(job)).resolves.toEqual({});
    expect(mocks.loadLeasedPagesForExport).toHaveBeenCalledWith("project-1", pages);
    expect(mocks.checkLeasedExportOwnership).toHaveBeenCalledOnce();
    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("propagates a failed post-lease manuscript read instead of reviewing stale pages", async () => {
    mocks.loadLeasedPagesForExport.mockRejectedValueOnce(new Error("post-lease database unavailable"));
    await expect(compileExport(job)).rejects.toThrow("post-lease database unavailable");
    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });
});
