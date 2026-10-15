import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateImageJob } from "../runtime/jobPayloads.js";

const mocks = vi.hoisted(() => ({
  project: { id: "project-1", title: "New Title", authorName: "A. Reader", status: "EDITING", currentPlanId: "plan-1", contentRevision: 6 },
  durable: { id: "job-cover", projectId: "project-1", type: "GENERATE_IMAGE", status: "ACTIVE", contentRevision: 6, payload: { assetType: "COVER" }, message: null as string | null, error: null as string | null },
  current: { value: null as null | { id: string; path: string; prompt: string; provider: string; metadata: Record<string, unknown> } },
  queryRaw: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  completeJob: vi.fn(),
  cancelStaleGenerationJob: vi.fn(),
  advanceJobStep: vi.fn(),
  updateJobProgress: vi.fn()
}));

vi.mock("@book-maker/db", () => {
  const db = {
    project: { findUnique: vi.fn(async () => ({ ...mocks.project })) },
    generationJob: {
      findUnique: vi.fn(async () => ({ ...mocks.durable })),
      update: mocks.completeJob
    },
    imageAsset: {
      findFirst: vi.fn(async () => mocks.current.value),
      deleteMany: mocks.deleteMany,
      create: mocks.create
    },
    planVersion: { findUnique: vi.fn(async () => ({
      inputSnapshot: {
        prompt: "A book about a reader watching the sea.", category: "STORY", targetPages: 10,
        mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", toneProfile: "neutral", coverArtSource: "design" }
      },
      planningPackage: {}
    })) },
    $queryRaw: mocks.queryRaw
  };
  return {
    prisma: { ...db, $transaction: async (operation: ((tx: typeof db) => Promise<unknown>) | unknown[]) =>
      typeof operation === "function" ? operation(db) : Promise.all(operation) }
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: () => ({ characters: [], premise: "p", audience: "a", illustrationPlan: {} }) },
    renderCoverPng: async () => Buffer.from("retypeset-cover"),
    optimizeImageForStorage: async ({ bytes }: { bytes: Buffer }) => ({ bytes, extension: "jpg", mimeType: "image/jpeg" })
  };
});
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ ...mocks.project }),
  coverMetadataFromProject: () => ({ title: "New Title", authorName: "A. Reader" }),
  imageStorageMetadata: () => ({ mimeType: "image/jpeg" })
}));
vi.mock("../generation/coverArtwork.js", () => ({
  coverDesignArtwork: async () => ({ bytes: Buffer.from("old-artwork"), mimeType: "image/jpeg" })
}));
vi.mock("../runtime/config.js", () => ({ config: { PUBLIC_API_URL: "http://api.test" } }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: mocks.advanceJobStep,
  updateJobProgress: mocks.updateJobProgress,
  cancelStaleGenerationJob: mocks.cancelStaleGenerationJob
}));

import { COVER_PURCHASE, COVER_RETYPESET, STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE } from "@book-maker/core";
import { objectStore } from "@book-maker/storage";
import { retypesetCover } from "./coverRetypeset.js";
import { storeTypesetCover } from "../generation/coverStore.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

function job(): GenerateImageJob {
  return {
    name: "generate-image",
    data: {
      projectId: "project-1", planId: "plan-1", generationJobId: "job-cover", assetType: "COVER",
      contentRevision: 6, exportPublicationProjectStatus: "EDITING", [COVER_RETYPESET]: true
    }
  } as unknown as GenerateImageJob;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Pause the actual candidate upload, after the handler's last progress/stop
// check, then let a competing transaction commit before publication continues.
async function duringCandidateUpload(change: () => void, delivery = job()) {
  const started = deferred();
  const release = deferred();
  const store = objectStore();
  const put = store.put.bind(store);
  const spy = vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
    started.resolve();
    await release.promise;
    return put(key, bytes, options);
  });
  const result = retypesetCover(delivery).then(() => undefined, (error: unknown) => error);
  try {
    await started.promise;
    change();
    release.resolve();
    return await result;
  } finally {
    release.resolve();
    spy.mockRestore();
  }
}

describe("cover publication after a delayed upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.project, { status: "EDITING", currentPlanId: "plan-1", contentRevision: 6 });
    Object.assign(mocks.durable, { status: "ACTIVE", type: "GENERATE_IMAGE", contentRevision: 6, message: null, error: null });
    mocks.durable.payload.assetType = "COVER";
    mocks.current.value = {
      id: "cover-old", path: "http://api.test/assets/images/project-1/old.jpg", prompt: "Old artwork", provider: "bundled-cover",
      metadata: { coverArtSource: "design", coverDesignId: "moonlit-sea" }
    };
    mocks.deleteMany.mockImplementation(async () => { mocks.current.value = null; return { count: 1 }; });
    mocks.create.mockImplementation(async ({ data }: { data: Omit<NonNullable<typeof mocks.current.value>, "id"> }) => {
      mocks.current.value = { id: "cover-retypeset", ...data };
      return mocks.current.value;
    });
    mocks.completeJob.mockImplementation(async ({ data }: { data: { status: string } }) => {
      Object.assign(mocks.durable, data);
      return { ...mocks.durable };
    });
    mocks.cancelStaleGenerationJob.mockImplementation(async () => {
      mocks.durable.status = "CANCELED";
    });
  });

  it.each(["generation", "revision"])("keeps the successful %s retypeset when two ACTIVE deliveries overlap", async (kind) => {
    const delivery = job();
    if (kind === "generation") {
      delete delivery.data.contentRevision;
      delete delivery.data.exportPublicationProjectStatus;
      delivery.data.attemptId = "paid-book-attempt";
      mocks.project.status = "GENERATING";
    }
    const started = [deferred(), deferred()] as const;
    const release = [deferred(), deferred()] as const;
    const store = objectStore();
    const put = store.put.bind(store);
    let uploads = 0;
    const spy = vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
      const index = uploads++;
      started[index]!.resolve();
      await release[index]!.promise;
      return put(key, bytes, options);
    });
    try {
      const winner = retypesetCover(delivery);
      await started[0].promise;
      const straggler = retypesetCover(delivery);
      await started[1].promise;
      expect(mocks.current.value?.id).toBe("cover-old");
      release[0].resolve();
      await winner;
      expect(mocks.current.value?.id).toBe("cover-retypeset");
      release[1].resolve();
      await straggler;

      // Stale cancellation refunds the inherited book attempt and blocks its
      // compile, even when a competing delivery already completed the row.
      expect(mocks.cancelStaleGenerationJob).not.toHaveBeenCalled();
      expect(mocks.durable.status).toBe("COMPLETED");
      expect(mocks.create).toHaveBeenCalledTimes(1);
    } finally {
      release.forEach((gate) => gate.resolve());
      spy.mockRestore();
    }
  });

  it("leaves a successfully published retypeset alone on replay before processor bookkeeping", async () => {
    await retypesetCover(job());
    const publishedCover = mocks.current.value;
    await retypesetCover(job());

    expect(mocks.durable.status).toBe("COMPLETED");
    expect(mocks.current.value).toBe(publishedCover);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.cancelStaleGenerationJob).not.toHaveBeenCalled();
  });

  it("leaves a purchased cover ACTIVE until its handler settles any artwork refund", async () => {
    const delivery = job();
    delete delivery.data[COVER_RETYPESET];
    delivery.data[COVER_PURCHASE] = true;
    delivery.data.billingLedgerEntryId = "cover-purchase";
    delivery.data.attemptId = "paid-cover-attempt";

    const publication = await storeTypesetCover({
      job: delivery, coverPng: Buffer.from("purchased-cover"), prompt: "A new picture", provider: "image-provider", metadata: {}
    });

    expect(publication).toBe("published");
    expect(mocks.current.value?.id).toBe("cover-retypeset");
    expect(mocks.durable.status).toBe("ACTIVE");
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("preserves the new upload when Stop and a cover upload commit during the old retypeset's PUT", async () => {
    const outcome = await duringCandidateUpload(() => {
      // These are the committed effects of stopProjectGenerationJobs followed
      // by commitCoverChange once the book has no open jobs.
      Object.assign(mocks.durable, { status: "FAILED", message: STOPPED_JOB_MESSAGE, error: STOPPED_JOB_ERROR });
      mocks.project.contentRevision += 1;
      mocks.current.value = {
        id: "cover-upload", path: "http://api.test/assets/images/project-1/upload.jpg", prompt: "A cover the author uploaded",
        provider: "upload", metadata: { coverArtSource: "upload" }
      };
    });

    expect(mocks.current.value?.id).toBe("cover-upload");
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(StopRequestedError);
  });

  it.each([
    ["a new cover at the same revision", () => { mocks.current.value = { ...mocks.current.value!, id: "cover-upload" }; }],
    ["a newer manuscript revision", () => { mocks.project.contentRevision = 7; }],
    ["a restored project status", () => { mocks.project.status = "COMPLETE"; }],
    ["a replaced plan", () => { mocks.project.currentPlanId = "plan-new"; }],
    ["a durable job for another revision", () => { mocks.durable.contentRevision = 5; }],
    ["a durable page image job", () => { mocks.durable.payload.assetType = "PAGE"; }]
  ] as const)("cancels the stale retypeset after %s wins during PUT", async (_label, change) => {
    const outcome = await duringCandidateUpload(change);

    expect(outcome).toBeUndefined();
    expect(mocks.current.value?.id).not.toBe("cover-retypeset");
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.cancelStaleGenerationJob).toHaveBeenCalledWith(expect.objectContaining({ data: job().data }), expect.any(String));
  });

  it.each(["CANCELED", "COMPLETED", "FAILED"])("leaves an already %s job's cover and settlement alone", async (status) => {
    const outcome = await duringCandidateUpload(() => { mocks.durable.status = status; });

    expect(outcome).toBeUndefined();
    expect(mocks.current.value?.id).toBe("cover-old");
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.cancelStaleGenerationJob).not.toHaveBeenCalled();
  });

  it("publishes an owned replacement under Project then GenerationJob locks", async () => {
    await retypesetCover(job());

    expect(mocks.current.value?.id).toBe("cover-retypeset");
    const statements = mocks.queryRaw.mock.calls.map(([parts]) => (parts as TemplateStringsArray).join("?"));
    expect(statements).toEqual([
      expect.stringMatching(/FROM "Project"[\s\S]*FOR UPDATE/),
      expect.stringMatching(/FROM "GenerationJob"[\s\S]*FOR UPDATE/)
    ]);
    expect(mocks.queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.deleteMany.mock.invocationCallOrder[0]!);
    expect(mocks.cancelStaleGenerationJob).not.toHaveBeenCalled();
  });

  it("allows a generation cover to finish after a matter save advances the revision", async () => {
    const delivery = job();
    delete delivery.data.contentRevision;
    delete delivery.data.exportPublicationProjectStatus;
    mocks.project.status = "GENERATING";
    const outcome = await duringCandidateUpload(() => { mocks.project.contentRevision = 7; }, delivery);

    expect(outcome).toBeUndefined();
    expect(mocks.current.value?.id).toBe("cover-retypeset");
    expect(mocks.cancelStaleGenerationJob).not.toHaveBeenCalled();
  });
});
