import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: { currentPlanId: "plan-new", contentRevision: 7, status: "EDITING" },
  prisma: {
    project: { findUnique: vi.fn() },
    imageAsset: { count: vi.fn() }
  },
  countOpenCoverJobs: vi.fn(),
  enqueueWorkerJob: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
vi.mock("../runtime/dispatch.js", () => ({
  countOpenCoverJobs: mocks.countOpenCoverJobs,
  enqueueWorkerJob: mocks.enqueueWorkerJob
}));

import { maybeEnqueueRevisionOwnedReplanCover } from "./replanCoverDispatch.js";

const input = { mediaSettings: { coverArtSource: "ai" } } as never;
const scope = { contentRevision: 7, expectedProjectStatus: "EDITING" as const, requireContentRevisionMatch: true as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.project = { currentPlanId: "plan-new", contentRevision: 7, status: "EDITING" };
  mocks.prisma.project.findUnique.mockImplementation(async () => mocks.project);
  mocks.prisma.imageAsset.count.mockResolvedValue(0);
  mocks.countOpenCoverJobs.mockResolvedValue(0);
  mocks.enqueueWorkerJob.mockResolvedValue({ id: "cover-job" });
});

describe("revision-owned replan cover dispatch", () => {
  it("stamps the exact plan, revision and EDITING owner on queued cover work", async () => {
    await expect(
      maybeEnqueueRevisionOwnedReplanCover("project-1", "plan-new", input, scope)
    ).resolves.toBe(true);

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith({
      projectId: "project-1",
      type: "GENERATE_IMAGE",
      payload: {
        planId: "plan-new",
        assetType: "COVER",
        contentRevision: 7,
        exportPublicationProjectStatus: "EDITING"
      },
      dedupeKey: "generate-cover:project-1:plan-new:revision-7:status-EDITING",
      contentRevision: 7
    });
  });

  it.each([
    ["a newer revision", { currentPlanId: "plan-new", contentRevision: 8, status: "EDITING" }],
    ["a newer plan", { currentPlanId: "plan-newer", contentRevision: 7, status: "EDITING" }],
    ["a settled project", { currentPlanId: "plan-new", contentRevision: 7, status: "COMPLETE" }]
  ])("does not dispatch for %s", async (_label, project) => {
    mocks.project = project;

    await expect(
      maybeEnqueueRevisionOwnedReplanCover("project-1", "plan-new", input, scope)
    ).resolves.toBe(false);

    expect(mocks.prisma.imageAsset.count).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });
});
