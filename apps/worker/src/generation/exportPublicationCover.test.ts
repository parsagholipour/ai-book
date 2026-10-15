import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/exportPublicationMocks.js")).dbModuleMock());
vi.mock("node:fs/promises", async () => (await import("./testing/exportPublicationMocks.js")).fsModuleMock());
vi.mock("@book-maker/storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("@book-maker/storage")>(),
  objectStore: (await import("./testing/exportPublicationMocks.js")).objectStoreMock
}));

import { bookPdfCoverNumbering } from "@book-maker/core";
import { pendingExportPaths, publishCompiledExports } from "./exportPublication.js";
import { mocks, resetExportPublicationMocks } from "./testing/exportPublicationMocks.js";

const publish = (overrides: Record<string, unknown> = {}) => publishCompiledExports({
  projectId: "project-1", generationJobId: "job-1", pending: pendingExportPaths("/books/project-1", "token"),
  companionsProduced: { epub: true, docx: true }, pdfPageMap: bookPdfCoverNumbering(true), contentRevision: 7,
  expectedProjectStatus: "GENERATING", status: "COMPLETE", ownsProjectStatus: true, ...overrides
});

beforeEach(resetExportPublicationMocks);

/** The COVER rows the publication finds under its project lock, oldest first. */
const coverRows = (...ids: (string | null)[]) => ids.flatMap((id, index) =>
  id ? [{ id, type: "COVER", createdAt: new Date(Date.UTC(2026, 0, 1 + index)) }] : []);

describe("the cover owned by an export publication", () => {
  it.each(["GENERATING", "EDITING"])("declines a %s render when its cover settled after the render's snapshot", async (status) => {
    // This is the entry race: the project snapshot read cover-old, then the
    // retypeset committed and completed before the count returned no open jobs.
    // It is also the later race: the replacement can land during Chromium work.
    mocks.prisma.imageAsset.findMany.mockResolvedValue(coverRows("cover-new"));
    const result = await publish({ expectedProjectStatus: status, renderedCoverId: "cover-old" });
    expect(result).toMatchObject({ published: false, blockedByChangedCover: true, blockedByOpenImageJobs: false });
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.generationAttempt.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.updateMany.mock.calls).toHaveLength(1);
    expect(mocks.prisma.imageAsset.findMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", type: "COVER" }, select: { id: true, type: true, createdAt: true }
    });
    // Covers publish under this same Project lock. The identity read therefore
    // stays true until files commit, and runs only for this ACTIVE compile.
    expect(mocks.prisma.project.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.prisma.imageAsset.findMany.mock.invocationCallOrder[0]!);
    expect(mocks.prisma.generationJob.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.prisma.imageAsset.findMany.mock.invocationCallOrder[0]!);
  });

  it.each([
    ["a first cover appearing", null, "cover-new"],
    ["the selected cover disappearing", "cover-old", null]
  ] as const)("declines %s during render", async (_description, renderedCoverId, currentCoverId) => {
    mocks.prisma.imageAsset.findMany.mockResolvedValue(coverRows(currentCoverId));
    expect(await publish({ renderedCoverId })).toMatchObject({ published: false, blockedByChangedCover: true });
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it.each(["cover-same", null])("publishes when the selected cover is still %s", async (renderedCoverId) => {
    mocks.prisma.imageAsset.findMany.mockResolvedValue(coverRows(renderedCoverId));
    expect(await publish({ renderedCoverId })).toMatchObject({ published: true, blockedByChangedCover: false });
    expect(mocks.transfer).toHaveBeenCalled();
  });

  it.each([
    ["oldest first", "cover-new", true],
    ["newest first", "cover-new", true],
    ["oldest first", "cover-old", false],
    ["newest first", "cover-old", false]
  ] as const)("reads the newest of two COVER rows as the book's cover (%s, rendered %s)", async (order, renderedCoverId, published) => {
    // A delete-then-create race can leave two rows. The compile renders the
    // newest through the same selector, so that render publishes rather than
    // deferring to a successor that would meet the same pair forever.
    const rows = coverRows("cover-old", "cover-new");
    mocks.prisma.imageAsset.findMany.mockResolvedValue(order === "oldest first" ? rows : rows.reverse());
    expect(await publish({ renderedCoverId })).toMatchObject({ published, blockedByChangedCover: !published });
  });

  it("keeps open image jobs in charge of fan-in before checking a changed cover", async () => {
    mocks.prisma.generationJob.count.mockResolvedValue(1);
    expect(await publish({ renderedCoverId: "cover-old" })).toMatchObject({ published: false, blockedByOpenImageJobs: true });
    expect(mocks.prisma.imageAsset.findMany).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it.each(["project", "generationJob"] as const)("leaves a lost %s claim to its existing settlement", async (table) => {
    mocks.prisma[table].updateMany.mockResolvedValue({ count: 0 });
    expect(await publish({ renderedCoverId: "cover-old" })).toMatchObject({ published: false, blockedByChangedCover: false });
    expect(mocks.prisma.imageAsset.findMany).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("leaves exact historical-manuscript repairs and legacy callers outside the current-cover fence", async () => {
    expect(await publish()).toMatchObject({ published: true });
    expect(mocks.prisma.imageAsset.findMany).not.toHaveBeenCalled();
  });
});
