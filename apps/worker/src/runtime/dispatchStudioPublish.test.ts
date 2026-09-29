import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A Studio publish, from the worker's side of the handoff. The publish
 * transaction writes two rows — its skip-review compile and, for a book with no
 * cover yet, a revision-owned designed cover — and the compile stands down
 * while the cover is open (`compileExport.ts`). What this suite pins is the
 * other half: the cover's completion fan-in re-queues the compile under the
 * compile row's own policy, so the book ends COMPLETE or REVIEW_REQUIRED from a
 * skip-review compile, never from full QA and never left EDITING.
 */

const mocks = vi.hoisted(() => {
  class KnownRequestError extends Error {
    code = "P2002";
  }
  return {
    KnownRequestError,
    createdJobs: [] as Array<Record<string, unknown>>,
    queueAdd: vi.fn(),
    queueGetJob: vi.fn(),
    prisma: {
      project: { findUnique: vi.fn(), findMany: vi.fn() },
      planVersion: { findUnique: vi.fn() },
      page: { findMany: vi.fn() },
      imageAsset: { count: vi.fn() },
      generationJob: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn()
      },
      bookEditOperation: { findFirst: vi.fn() }
    }
  };
});

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { PrismaClientKnownRequestError: mocks.KnownRequestError }
}));
vi.mock("./queue.js", () => ({ queue: { add: mocks.queueAdd, getJob: mocks.queueGetJob } }));
vi.mock("./config.js", () => ({ config: { MAX_PARALLEL_PAGE_JOBS: 3 } }));

const studioMediaSettings = {
  finalReview: false,
  fullIllustrations: false,
  coverArtSource: "design",
  mobile: { studio: { layout: "flow", kind: "story", createdAt: "2026-09-29T00:00:00.000Z" } }
};
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: () => ({
    title: "Harbour Lights",
    prompt: "Author-written manuscript: Harbour Lights",
    category: "STORY",
    targetPages: 2,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: studioMediaSettings
  })
}));

import {
  compilePolicyPayload,
  compilePublicationDedupeKey,
  compilePublicationPolicyFromPayload,
  EXPORT_PUBLICATION_PROJECT_STATUS
} from "@book-maker/core";
import type { Job } from "bullmq";
import { maybeCompileAfterCompletedJob, maybeCompileAfterFailedJob, maybeEnqueueCompile } from "./dispatch.js";
import { runWithGenerationAttempt } from "./generationAttemptContext.js";

const REVISION = 5;
const publishPolicy = compilePublicationPolicyFromPayload({ skipFinalReview: true, [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING" });
/** The compile row the publish transaction writes, after it stood down for the open cover. */
const standDownPublishCompile = {
  id: "gj-publish-compile",
  projectId: "project-1",
  type: "COMPILE_EXPORT",
  status: "COMPLETED",
  contentRevision: REVISION,
  attemptId: null,
  dedupeKey: compilePublicationDedupeKey({
    projectId: "project-1", planId: "plan-1", contentRevision: REVISION, policy: publishPolicy, projectStatus: "EDITING"
  }),
  payload: { planId: "plan-1", contentRevision: REVISION, ...compilePolicyPayload(publishPolicy, "EDITING") }
};

let openImageJobs = 0;
let compileRows: Array<Record<string, unknown>> = [];
/** GENERATE_IMAGE rows of the current revision that ended FAILED or CANCELED. */
let settledCoverRows: Array<{ payload: unknown }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createdJobs = [];
  openImageJobs = 0;
  compileRows = [standDownPublishCompile];
  settledCoverRows = [];
  mocks.prisma.project.findUnique.mockResolvedValue({
    id: "project-1", status: "EDITING", contentRevision: REVISION, currentPlanId: "plan-1", mediaSettings: studioMediaSettings
  });
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {} });
  mocks.prisma.page.findMany.mockResolvedValue([
    { id: "page-1", index: 1, status: "COMPLETED", markdown: "One.", revision: 2 },
    { id: "page-2", index: 2, status: "COMPLETED", markdown: "Two.", revision: 1 }
  ]);
  mocks.prisma.imageAsset.count.mockResolvedValue(1);
  mocks.prisma.generationJob.count.mockImplementation(async ({ where }: { where: { type: string } }) =>
    where.type === "GENERATE_IMAGE" ? openImageJobs : 0);
  mocks.prisma.generationJob.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.type === "COMPILE_EXPORT" && where.status === undefined
      ? compileRows
      : where.type === "GENERATE_IMAGE" && where.contentRevision === REVISION ? settledCoverRows : []);
  mocks.prisma.bookEditOperation.findFirst.mockResolvedValue({ kind: "MANUSCRIPT_PUBLISH", status: "APPLIED" });
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.id ? mocks.createdJobs.find((row) => row.id === where.id) ?? null : null);
  mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `gj-${mocks.createdJobs.length + 1}`, status: "QUEUED", bullJobId: null, dispatchAttempts: 0, ...data };
    mocks.createdJobs.push(row);
    return row;
  });
  mocks.prisma.generationJob.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
    ({ ...mocks.createdJobs.find((row) => row.id === where.id), ...data }));
  mocks.queueAdd.mockResolvedValue({ id: "bull-1" });
  mocks.queueGetJob.mockResolvedValue(undefined);
});

const coverJob = () => ({
  name: "generate-image",
  data: {
    projectId: "project-1", planId: "plan-1", generationJobId: "gj-cover", assetType: "COVER",
    contentRevision: REVISION, [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING"
  }
}) as unknown as Job;

describe("a Studio publish's cover and compile", () => {
  it("re-queues the publish's skip-review compile when its designed cover completes", async () => {
    await maybeCompileAfterCompletedJob(coverJob() as never);

    expect(mocks.createdJobs).toHaveLength(1);
    const compile = mocks.createdJobs[0]!;
    expect(compile).toMatchObject({
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      contentRevision: REVISION,
      ownsQualityVerdict: true,
      payload: { planId: "plan-1", contentRevision: REVISION, skipFinalReview: true, [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING" }
    });
    expect(compile.dedupeKey).toMatch(new RegExp(`^${standDownPublishCompile.dedupeKey}:pages-[0-9a-f]{24}$`));
    expect(compile).not.toHaveProperty("attemptId");
    expect(mocks.queueAdd).toHaveBeenCalledWith("compile-export", expect.anything(), expect.anything());
  });

  it("recovers the same skip-review policy from the publish operation when no compile row survived", async () => {
    compileRows = [];

    await maybeCompileAfterCompletedJob(coverJob() as never);

    expect(mocks.createdJobs[0]).toMatchObject({
      type: "COMPILE_EXPORT",
      payload: { skipFinalReview: true, [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING" }
    });
  });

  it("waits while the cover is still open, and queues nothing the stood-down compile could race", async () => {
    openImageJobs = 1;

    await expect(maybeEnqueueCompile("project-1", "plan-1", publishPolicy, {
      contentRevision: REVISION, completedPredecessorId: standDownPublishCompile.id
    })).resolves.toBe("waiting");

    expect(mocks.createdJobs).toEqual([]);
  });

  it("queues a designed cover itself when a ready Studio book reaches fan-in without one", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(0);

    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");

    expect(mocks.createdJobs).toEqual([
      expect.objectContaining({ type: "GENERATE_IMAGE", payload: { planId: "plan-1", assetType: "COVER" } })
    ]);
  });
});

describe("a Studio cover that fails outright", () => {
  const failedPublishCover = { payload: coverJob().data };

  it("releases the publish's compile, which prints the book coverless rather than asking for another cover", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(0);
    settledCoverRows = [failedPublishCover];

    await expect(maybeCompileAfterFailedJob(coverJob() as never)).resolves.toBe("compile");

    expect(mocks.createdJobs).toEqual([
      expect.objectContaining({
        type: "COMPILE_EXPORT",
        contentRevision: REVISION,
        payload: expect.objectContaining({ skipFinalReview: true, [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING" })
      })
    ]);
    expect(mocks.createdJobs[0]).not.toHaveProperty("attemptId");
  });

  it("keeps the stranded sweep from turning a failed revision cover into a generation cover that owns the book", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(0);
    settledCoverRows = [failedPublishCover];

    await expect(maybeEnqueueCompile("project-1", "plan-1", publishPolicy, { contentRevision: REVISION })).resolves.toBe("compile");

    expect(mocks.createdJobs.map((row) => row.type)).toEqual(["COMPILE_EXPORT"]);
  });

  it("still asks for a cover when the settled row is a page picture, not this revision's cover", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(0);
    settledCoverRows = [{ payload: { planId: "plan-1", pageId: "page-1", prompt: "a harbour", contentRevision: REVISION } }];

    await expect(maybeEnqueueCompile("project-1", "plan-1")).resolves.toBe("waiting");

    expect(mocks.createdJobs.map((row) => row.type)).toEqual(["GENERATE_IMAGE"]);
  });

  it("stands down when the author has already published again", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1", status: "EDITING", contentRevision: REVISION + 1, currentPlanId: "plan-1", mediaSettings: studioMediaSettings
    });

    await expect(maybeCompileAfterFailedJob(coverJob() as never)).resolves.toBe("settled");

    expect(mocks.createdJobs).toEqual([]);
  });

  it("stands down when the book is no longer the EDITING the cover was queued under", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1", status: "COMPLETE", contentRevision: REVISION, currentPlanId: "plan-1", mediaSettings: studioMediaSettings
    });

    await expect(maybeCompileAfterFailedJob(coverJob() as never)).resolves.toBe("settled");

    expect(mocks.createdJobs).toEqual([]);
  });

  it("releases nothing for a page picture or a generation-time cover, whose failure is not this path's", async () => {
    const generationCover = { name: "generate-image", data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-c", assetType: "COVER" } };

    await expect(maybeCompileAfterFailedJob(generationCover as never)).resolves.toBeNull();

    expect(mocks.prisma.project.findUnique).not.toHaveBeenCalled();
    expect(mocks.createdJobs).toEqual([]);
  });

  it("never hands a purchased cover's attempt to the compile it releases, or to the one its completion queues", async () => {
    const purchase = {
      name: "generate-image",
      data: { ...coverJob().data, coverPurchase: true, billingLedgerEntryId: "ledger-cover", attemptId: "attempt-cover" }
    };
    compileRows = [{ ...standDownPublishCompile, dedupeKey: "compile-export:presentation-reprint" }];

    await runWithGenerationAttempt("attempt-cover", () => maybeCompileAfterFailedJob(purchase as never));
    await runWithGenerationAttempt("attempt-cover", () => maybeCompileAfterCompletedJob(purchase as never));

    expect(mocks.createdJobs.length).toBeGreaterThan(0);
    for (const row of mocks.createdJobs) {
      expect(row).not.toHaveProperty("attemptId");
      expect(String(row.dedupeKey)).not.toContain("attempt-cover");
    }
  });
});
