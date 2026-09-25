import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: { generationJob: { findMany } }, Prisma: {} }));
import { loadProjectFinalizationProgress } from "./projectFinalizationProgress.js";

const project = { id: "book", status: "GENERATING", currentPlanId: "plan", contentRevision: 3, targetPages: 30 };
const root = {
  id: "root", createdAt: new Date("2026-09-23T11:10:00Z"), attemptId: "attempt",
  payload: { planId: "plan", finalization: {
    version: 1, phase: "illustrations", activePageIndex: null, updatedAt: "2026-09-23T11:20:00Z",
    repairPassCompleted: true, startedPageIds: ["page-8"], targetPageIds: ["page-8"],
    pendingImageJobIds: Array.from({ length: 30 }, (_, n) => `image-${n}`)
  } }
};
const book = { createdAt: new Date("2026-09-23T11:00:00Z"), attemptId: "attempt" };

describe("authoritative finalization progress", () => {
  beforeEach(() => { findMany.mockReset(); });

  it("reads the current operation independently of thirty later illustration jobs", async () => {
    findMany.mockImplementation(async ({ where }) => where.type === "GENERATE_BOOK" ? [book] : [root]);
    const progress = await loadProjectFinalizationProgress(project);
    expect(progress).toMatchObject({ phase: "illustrations", illustrationJobsTotal: 30, repairPagesAttempted: 1, remainingRepairPages: 0 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "book", contentRevision: 3, type: "COMPILE_EXPORT", ownsQualityVerdict: true, payload: { path: ["planId"], equals: "plan" } }, take: 1
    }));
    expect(JSON.stringify(progress)).not.toMatch(/root|attempt|page-8|image-/);
  });

  it("keeps the root phase while a queued successor has not copied its checkpoint", async () => {
    findMany.mockImplementation(async ({ where }) => where.type === "GENERATE_BOOK" ? [book]
      : where.AND ? [root] : [{ ...root, id: "next", payload: { planId: "plan" } }]);
    expect(await loadProjectFinalizationProgress(project)).toMatchObject({ phase: "illustrations", illustrationJobsTotal: 30 });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ attemptId: "attempt" }) }));
  });

  it("keeps the illustration total after the successor clears its pending image list", async () => {
    const completedImages = { ...root, payload: { ...root.payload, finalization: {
      ...root.payload.finalization, pendingImageJobIds: [], illustrationJobsTotal: 30
    } } };
    findMany.mockImplementation(async ({ where }) => where.type === "GENERATE_BOOK" ? [book] : [completedImages]);
    expect(await loadProjectFinalizationProgress(project)).toMatchObject({ phase: "illustrations", illustrationJobsTotal: 30 });
  });

  it.each([
    { ...book, createdAt: new Date("2026-09-23T11:30:00Z") },
    { ...book, attemptId: "new-attempt" }
  ])("does not show an old operation after a new generation command %j", async (newBook) => {
    findMany.mockImplementation(async ({ where }) => where.type === "GENERATE_BOOK" ? [newBook] : [root]);
    expect(await loadProjectFinalizationProgress(project)).toBeNull();
  });

  it("does not query a project outside active generation", async () => {
    expect(await loadProjectFinalizationProgress({ ...project, status: "EDITING" })).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});
