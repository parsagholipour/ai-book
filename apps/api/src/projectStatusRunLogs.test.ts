import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendRunLog } from "@book-maker/storage";
import { buildProjectStatus } from "./projectStatus.js";

const mocks = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  generationJob: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  generationAttempt: { findMany: vi.fn(async () => []) },
  bookEditOperation: { findMany: vi.fn(async () => []) },
  imageAsset: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
  providerCallLog: { findMany: vi.fn(async () => []) },
  $queryRaw: vi.fn(async () => []),
  $queryRawUnsafe: vi.fn(async () => [])
}));
vi.mock("@book-maker/db", () => ({ prisma: mocks, Prisma: { DbNull: "DbNull" } }));

const primary = { provider: "primary", model: "image-a" };
const fallback = { provider: "fallback", model: "image-b" };

beforeEach(() => {
  mocks.project.findUnique.mockResolvedValue({
    id: "project-1", status: "COMPLETE", targetPages: 1, currentPlanId: null, currentPlan: null,
    _count: { pages: 1, images: 1, research: 0 },
    jobs: [{ id: "job-1", type: "GENERATE_IMAGE", status: "COMPLETED", bullJobId: null, payload: {},
      createdAt: new Date(), updatedAt: new Date(), steps: [] }]
  });
});

describe("status run log objects", () => {
  it("assembles image fallback diagnostics from ordered event objects", async () => {
    const key = "books/project-1/runs/job-1-generate-image.jsonl";
    await appendRunLog(key, { event: "image.generate.fallback.start", primary, fallback });
    await appendRunLog(key, { event: "image.generate.fallback.success", result: fallback });
    const status = await buildProjectStatus("project-1");
    expect(status?.project.jobs[0]?.imageFallbacks).toEqual([{ status: "used", primary, fallback, result: fallback }]);
  });

  it("keeps another project's diagnostic objects outside the status response", async () => {
    await appendRunLog("books/project-2/runs/job-1-generate-image.jsonl", {
      event: "image.generate.fallback.start", primary, fallback
    });
    const status = await buildProjectStatus("project-1");
    expect(status?.project.jobs[0]?.imageFallbacks).toEqual([]);
  });
});
