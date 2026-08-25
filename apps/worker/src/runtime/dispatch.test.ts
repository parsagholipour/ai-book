import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => {
  class KnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(`Prisma error ${code}`);
      this.code = code;
    }
  }
  return {
    KnownRequestError,
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
        updateMany: vi.fn(),
        count: vi.fn()
      },
      bookEditOperation: { findFirst: vi.fn() }
    },
    // Mutable holder so each test can shape the resolved project input.
    input: {} as Record<string, unknown>
  };
});

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { PrismaClientKnownRequestError: mocks.KnownRequestError }
}));
vi.mock("./queue.js", () => ({ queue: { add: mocks.queueAdd, getJob: mocks.queueGetJob } }));
vi.mock("./config.js", () => ({ config: { MAX_PARALLEL_PAGE_JOBS: 3 } }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => mocks.input }));

import {
  canEnqueueProjectWork,
  compilePublicationPolicyFromPayload,
  dispatchBackoffMs,
  dispatchWorkerGenerationJob,
  enqueueNextPageIfReady,
  enqueueWorkerJob,
  maybeCompileAfterCompletedJob,
  maybeEnqueueCompile,
  maybeEnqueueCover,
  parallelPageWaveSize,
  redeliverWorkerGenerationJob,
  reconcileUndispatchedWorkerJobs,
  workerJobNameForType
} from "./dispatch.js";
import { runWithGenerationAttempt } from "./generationAttemptContext.js";

type Row = {
  id: string;
  projectId: string;
  type: string;
  status: string;
  bullJobId: string | null;
  dedupeKey?: string | null;
  payload: Record<string, unknown>;
  dispatchAttempts: number;
};

function generationRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "gj-1",
    projectId: "project-1",
    type: "GENERATE_PAGE",
    status: "QUEUED",
    bullJobId: null,
    payload: {},
    dispatchAttempts: 0,
    ...overrides
  };
}

function projectInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: "A field guide to backyard birds with enough detail to matter.",
    category: "SCIENCE",
    targetPages: 2,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    },
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.input = projectInput();
  mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 0 });
  mocks.prisma.project.findMany.mockResolvedValue([]);
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {} });
  mocks.prisma.page.findMany.mockResolvedValue([]);
  mocks.prisma.imageAsset.count.mockResolvedValue(0);
  mocks.prisma.generationJob.findMany.mockResolvedValue([]);
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.count.mockResolvedValue(0);
  mocks.prisma.bookEditOperation.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.findUnique.mockResolvedValue(null);
  mocks.prisma.generationJob.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...generationRow(),
    ...data
  }));
  mocks.queueAdd.mockResolvedValue({ id: "bull-1" });
  mocks.queueGetJob.mockResolvedValue(undefined);
});

describe("enqueueWorkerJob", () => {
  it("persists the durable row before pushing to Redis, then stamps the dispatch", async () => {
    const order: string[] = [];
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      order.push("row");
      const row = generationRow({ payload: data.payload as Record<string, unknown> });
      mocks.prisma.generationJob.findUnique.mockResolvedValue(row);
      return row;
    });
    mocks.queueAdd.mockImplementation(async () => {
      order.push("redis");
      return { id: "bull-1" };
    });

    await enqueueWorkerJob({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      payload: { pageId: "page-1", planId: "plan-1" }
    });

    // The row-first ordering is the crash-safety property: a job persisted but
    // never pushed is re-pushed by reconciliation, the reverse strands nothing.
    expect(order).toEqual(["row", "redis"]);
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "generate-page",
      { pageId: "page-1", planId: "plan-1", projectId: "project-1", generationJobId: "gj-1" },
      expect.objectContaining({ jobId: "gj-1" })
    );
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gj-1" },
        data: expect.objectContaining({ bullJobId: "bull-1", nextDispatchAt: null })
      })
    );
  });

  it("names the BullMQ job from the durable row's type rather than from the caller", async () => {
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = generationRow({
        type: data.type as string,
        payload: data.payload as Record<string, unknown>
      });
      mocks.prisma.generationJob.findUnique.mockResolvedValue(row);
      return row;
    });

    await enqueueWorkerJob({
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      payload: { planId: "plan-1" }
    });

    // `enqueueWorkerJob` takes no `name`. It used to, as an independent literal
    // union beside `type`, so `{ type: "GENERATE_BOOK", name: "generate-page" }`
    // typechecked and pushed the wrong handler onto the queue.
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      workerJobNameForType("COMPILE_EXPORT"),
      expect.objectContaining({ planId: "plan-1", projectId: "project-1" }),
      expect.objectContaining({ jobId: "gj-1" })
    );
  });

  it("scopes descendant dedupe and queue payloads to the paid attempt", async () => {
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { ...generationRow(), ...data };
      mocks.prisma.generationJob.findUnique.mockResolvedValue(row);
      return row;
    });

    await runWithGenerationAttempt("attempt-1", () =>
      enqueueWorkerJob({
        projectId: "project-1",
        type: "GENERATE_IMAGE",
        dedupeKey: "page-image:page-1",
        payload: { pageId: "page-1", planId: "plan-1", prompt: "A moonlit harbor" }
      })
    );

    expect(mocks.prisma.generationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptId: "attempt-1",
          dedupeKey: "page-image:page-1:attempt:attempt-1"
        })
      })
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "generate-image",
      expect.objectContaining({ attemptId: "attempt-1", pageId: "page-1" }),
      expect.any(Object)
    );
  });

  it("refuses to enqueue work for a FAILED or missing project", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "FAILED" });
    await enqueueWorkerJob({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      payload: { pageId: "page-1", planId: "plan-1" }
    });

    mocks.prisma.project.findUnique.mockResolvedValue(null);
    await enqueueWorkerJob({
      projectId: "project-2",
      type: "GENERATE_PAGE",
      payload: { pageId: "page-2", planId: "plan-1" }
    });

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("returns the existing dedupe-key row and re-dispatches it only when it never reached Redis", async () => {
    const stranded = generationRow({ dedupeKey: "dk-1" });
    mocks.prisma.generationJob.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.dedupeKey === "dk-1" || where.id === "gj-1" ? stranded : null
    );

    const result = await enqueueWorkerJob({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      payload: { pageId: "page-1", planId: "plan-1" },
      dedupeKey: "dk-1"
    });

    expect(result).toBe(stranded);
    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);

    // Already dispatched: nothing to do at all.
    vi.clearAllMocks();
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING" });
    const dispatched = generationRow({ dedupeKey: "dk-1", bullJobId: "bull-1" });
    mocks.prisma.generationJob.findUnique.mockResolvedValue(dispatched);

    const second = await enqueueWorkerJob({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      payload: { pageId: "page-1", planId: "plan-1" },
      dedupeKey: "dk-1"
    });

    expect(second).toBe(dispatched);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("adopts the winner's row when the dedupe-key create loses the race", async () => {
    const winner = generationRow({ dedupeKey: "dk-1" });
    mocks.prisma.generationJob.create.mockRejectedValue(new mocks.KnownRequestError("P2002"));
    mocks.prisma.generationJob.findUnique
      // First lookup (pre-create) finds nothing; the post-conflict lookup and
      // the dispatch re-read both find the winner's row.
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);

    const result = await enqueueWorkerJob({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      payload: { pageId: "page-1", planId: "plan-1" },
      dedupeKey: "dk-1"
    });

    expect(result).toBe(winner);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("defers with backoff instead of throwing when the Redis push fails", async () => {
    const row = generationRow();
    mocks.prisma.generationJob.create.mockResolvedValue(row);
    mocks.prisma.generationJob.findUnique.mockResolvedValue(row);
    mocks.queueAdd.mockRejectedValue(new Error("redis down"));

    await enqueueWorkerJob({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      payload: { pageId: "page-1", planId: "plan-1" }
    });

    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dispatchAttempts: 1,
          nextDispatchAt: expect.any(Date),
          message: "Waiting for the generation queue"
        })
      })
    );
  });
});

describe("dispatchWorkerGenerationJob", () => {
  it("leaves rows that are not QUEUED or already dispatched untouched", async () => {
    mocks.prisma.generationJob.findUnique.mockResolvedValue(generationRow({ status: "ACTIVE" }));
    await dispatchWorkerGenerationJob("gj-1");

    mocks.prisma.generationJob.findUnique.mockResolvedValue(generationRow({ bullJobId: "bull-9" }));
    await dispatchWorkerGenerationJob("gj-1");

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).not.toHaveBeenCalled();
  });

  it("leaves a row with an unmapped type undispatched instead of rejecting", async () => {
    // A rejection here would poison every reconciliation sweep that picks the
    // row up, so an unknown type must be a deferred dispatch, not an error.
    mocks.prisma.generationJob.findUnique.mockResolvedValue(generationRow({ type: "NOT_A_JOB_TYPE" }));

    await expect(dispatchWorkerGenerationJob("gj-1")).resolves.toMatchObject({ type: "NOT_A_JOB_TYPE" });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("removes a finished Bull job occupying the durable id before pushing again", async () => {
    const remove = vi.fn();
    mocks.queueGetJob.mockResolvedValue({ getState: async () => "failed", remove });
    mocks.prisma.generationJob.findUnique.mockResolvedValue(generationRow());

    await dispatchWorkerGenerationJob("gj-1");

    expect(remove).toHaveBeenCalled();
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "generate-page",
      expect.objectContaining({ generationJobId: "gj-1" }),
      expect.objectContaining({ jobId: "gj-1" })
    );
  });

  it("defers when the durable id is still held by a live Bull job", async () => {
    mocks.queueGetJob.mockResolvedValue({ getState: async () => "active", remove: vi.fn() });
    mocks.prisma.generationJob.findUnique.mockResolvedValue(generationRow());

    await dispatchWorkerGenerationJob("gj-1");

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextDispatchAt: expect.any(Date),
          message: "Waiting for the generation queue"
        })
      })
    );
  });
});

describe("redeliverWorkerGenerationJob", () => {
  it("claims an ACTIVE row back to QUEUED and dispatches it", async () => {
    mocks.prisma.generationJob.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.generationJob.findUnique.mockResolvedValue(generationRow({ type: "APPLY_BOOK_EDIT" }));

    await redeliverWorkerGenerationJob("gj-1");

    expect(mocks.prisma.generationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gj-1", status: "ACTIVE" },
        data: expect.objectContaining({ status: "QUEUED", bullJobId: null })
      })
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "apply-book-edit",
      expect.objectContaining({ generationJobId: "gj-1", projectId: "project-1" }),
      expect.objectContaining({ jobId: "gj-1" })
    );
  });

  it("does not dispatch a row that is no longer ACTIVE", async () => {
    mocks.prisma.generationJob.updateMany.mockResolvedValue({ count: 0 });

    await redeliverWorkerGenerationJob("gj-1");

    expect(mocks.prisma.generationJob.findUnique).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });
});

describe("reconcileUndispatchedWorkerJobs", () => {
  it("keeps sweeping when one row fails to dispatch", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ id: "gj-bad" }, { id: "gj-good" }]);
    mocks.prisma.generationJob.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "gj-bad") {
        throw new Error("row unreadable");
      }
      return generationRow({ id: "gj-good" });
    });

    await expect(reconcileUndispatchedWorkerJobs()).resolves.toBe(2);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("dispatch policy helpers", () => {
  it("maps every JobType to a worker job name and rejects unknown types", () => {
    expect(workerJobNameForType("PLAN_BOOK")).toBe("plan-book");
    expect(workerJobNameForType("REVISE_PLAN")).toBe("revise-plan");
    expect(workerJobNameForType("GENERATE_BOOK")).toBe("generate-book");
    expect(workerJobNameForType("GENERATE_PAGE")).toBe("generate-page");
    expect(workerJobNameForType("GENERATE_IMAGE")).toBe("generate-image");
    expect(workerJobNameForType("COMPILE_EXPORT")).toBe("compile-export");
    expect(workerJobNameForType("APPLY_BOOK_EDIT")).toBe("apply-book-edit");
    expect(workerJobNameForType("REPLAN_BOOK")).toBe("replan-book");
    expect(workerJobNameForType("PREPARE_CHARACTER_CANDIDATES")).toBe("prepare-character-candidates");
    expect(workerJobNameForType("BUILD_CHARACTER_PERSONA")).toBe("build-character-persona");
    expect(workerJobNameForType("IMPORT_BOOK")).toBe("import-book");
    expect(workerJobNameForType("CONTINUE_BOOK")).toBe("continue-book");
    expect(workerJobNameForType("GENERATE_AUDIOBOOK")).toBe("generate-audiobook");
    expect(() => workerJobNameForType("RESEARCH")).toThrow(/Unknown generation job type/);
  });

  it("doubles the dispatch backoff from 5s and caps it at 5 minutes", () => {
    expect(dispatchBackoffMs(1)).toBe(5_000);
    expect(dispatchBackoffMs(2)).toBe(10_000);
    expect(dispatchBackoffMs(3)).toBe(20_000);
    expect(dispatchBackoffMs(10)).toBe(300_000);
  });

  it("gates project work on the project existing and not being FAILED", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING" });
    await expect(canEnqueueProjectWork("project-1")).resolves.toBe(true);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "FAILED" });
    await expect(canEnqueueProjectWork("project-1")).resolves.toBe(false);
    mocks.prisma.project.findUnique.mockResolvedValue(null);
    await expect(canEnqueueProjectWork("project-1")).resolves.toBe(false);
  });

  it("keeps fiction sequential and fans non-fiction out, unless the flag overrides", () => {
    const settings = (extra: Record<string, unknown>) => ({
      ...projectInput().mediaSettings as Record<string, unknown>,
      ...extra
    });
    expect(parallelPageWaveSize(projectInput({ category: "STORY" }) as never)).toBe(1);
    expect(parallelPageWaveSize(projectInput({ category: "KIDS" }) as never)).toBe(1);
    expect(parallelPageWaveSize(projectInput({ category: "SCIENCE" }) as never)).toBe(3);
    expect(
      parallelPageWaveSize(projectInput({ category: "STORY", mediaSettings: settings({ parallelPageGeneration: true }) }) as never)
    ).toBe(3);
    expect(
      parallelPageWaveSize(projectInput({ category: "SCIENCE", mediaSettings: settings({ parallelPageGeneration: false }) }) as never)
    ).toBe(1);
  });
});

describe("maybeEnqueueCover", () => {
  const inputWithCover = (source: "ai" | "design" | "none") =>
    projectInput({
      mediaSettings: { ...(projectInput().mediaSettings as Record<string, unknown>), coverArtSource: source }
    }) as never;

  it("skips a book that explicitly has no cover, without touching the database", async () => {
    await expect(maybeEnqueueCover("project-1", "plan-1", inputWithCover("none"))).resolves.toBe(false);
    expect(mocks.prisma.imageAsset.count).not.toHaveBeenCalled();
  });

  it("does not enqueue a second cover when one exists or is being made", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    await expect(maybeEnqueueCover("project-1", "plan-1", inputWithCover("ai"))).resolves.toBe(false);

    mocks.prisma.imageAsset.count.mockResolvedValue(0);
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ payload: { assetType: "COVER" } }]);
    await expect(maybeEnqueueCover("project-1", "plan-1", inputWithCover("ai"))).resolves.toBe(false);

    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("ignores open interior-image jobs when counting cover work", async () => {
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ payload: { pageId: "page-1" } }]);
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = generationRow({ id: "gj-cover", type: data.type as string, payload: data.payload as Record<string, unknown> });
      mocks.prisma.generationJob.findUnique.mockResolvedValue(row);
      return row;
    });

    await expect(maybeEnqueueCover("project-1", "plan-1", inputWithCover("ai"))).resolves.toBe(true);
    expect(mocks.prisma.generationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "GENERATE_IMAGE",
          dedupeKey: "generate-cover:project-1:plan-1",
          payload: { planId: "plan-1", assetType: "COVER" }
        })
      })
    );
  });
});

describe("enqueueNextPageIfReady", () => {
  it("enqueues the first pending page that is not already in flight", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([
      { id: "page-1", index: 1 },
      { id: "page-2", index: 2 }
    ]);
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ payload: { pageId: "page-1" } }]);
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = generationRow({ id: "gj-page", payload: data.payload as Record<string, unknown> });
      mocks.prisma.generationJob.findUnique.mockResolvedValue(row);
      return row;
    });

    await enqueueNextPageIfReady("project-1", "plan-1", projectInput() as never);

    expect(mocks.prisma.generationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "GENERATE_PAGE",
          payload: { pageId: "page-2", planId: "plan-1" },
          dedupeKey: "generate-page:page-2:plan-1"
        })
      })
    );
  });

  it("does nothing when every pending page is already claimed", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([{ id: "page-1", index: 1 }]);
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ payload: { pageId: "page-1" } }]);

    await enqueueNextPageIfReady("project-1", "plan-1", projectInput() as never);

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("refills the whole wave deficit, not a fixed one page", async () => {
    // Two pages finishing together both compute the same next page and the
    // dedupe key collapses them into one job, shrinking the wave. The next
    // completion must be able to heal that by topping the wave back to size
    // (3 under the mocked config): only the caller is in flight, so it may
    // start waveSize - 1 + 1 = 3 pages.
    mocks.prisma.page.findMany.mockResolvedValue([
      { id: "page-2", index: 2 },
      { id: "page-3", index: 3 },
      { id: "page-4", index: 4 },
      { id: "page-5", index: 5 }
    ]);
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ payload: { pageId: "page-1" } }]);
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      generationRow({ id: `gj-${(data.payload as { pageId: string }).pageId}`, payload: data.payload as Record<string, unknown> })
    );

    await enqueueNextPageIfReady("project-1", "plan-1", projectInput() as never);

    const enqueuedPages = mocks.prisma.generationJob.create.mock.calls.map(
      (call) => ((call[0] as { data: { payload: { pageId: string } } }).data.payload.pageId)
    );
    expect(enqueuedPages).toEqual(["page-2", "page-3", "page-4"]);
  });

  it("keeps a sequential book strictly one page at a time when refilling", async () => {
    // A fiction book seeds a wave of 1. The refill must size its deficit from
    // the book's own wave, not the global page-job ceiling — otherwise the
    // first completion fans a strictly-sequential book out to a full wave.
    mocks.prisma.page.findMany.mockResolvedValue([
      { id: "page-2", index: 2 },
      { id: "page-3", index: 3 },
      { id: "page-4", index: 4 }
    ]);
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ payload: { pageId: "page-1" } }]);
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      generationRow({ id: `gj-${(data.payload as { pageId: string }).pageId}`, payload: data.payload as Record<string, unknown> })
    );

    await enqueueNextPageIfReady("project-1", "plan-1", projectInput({ category: "STORY" }) as never);

    expect(mocks.prisma.generationJob.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.generationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payload: { pageId: "page-2", planId: "plan-1" } }) })
    );
  });

  it("tops up by exactly one when the wave is at full size", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([
      { id: "page-4", index: 4 },
      { id: "page-5", index: 5 }
    ]);
    mocks.prisma.generationJob.findMany.mockResolvedValue([
      { payload: { pageId: "page-1" } },
      { payload: { pageId: "page-2" } },
      { payload: { pageId: "page-3" } }
    ]);
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      generationRow({ id: "gj-next", payload: data.payload as Record<string, unknown> })
    );

    await enqueueNextPageIfReady("project-1", "plan-1", projectInput() as never);

    expect(mocks.prisma.generationJob.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.generationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payload: { pageId: "page-4", planId: "plan-1" } }) })
    );
  });
});

describe("maybeEnqueueCompile", () => {
  const completedPages = [
    { id: "page-1", index: 1, status: "COMPLETED", markdown: "One.", revision: 1 },
    { id: "page-2", index: 2, status: "COMPLETED", markdown: "Two.", revision: 1 }
  ];

  function countsByType(counts: Record<string, number>) {
    mocks.prisma.generationJob.count.mockImplementation(
      async ({ where }: { where: { type: string } }) => counts[where.type] ?? 0
    );
  }

  function expectCreatedJobOfType(type: string) {
    const created = mocks.prisma.generationJob.create.mock.calls.map(
      (call) => (call[0] as { data: { type: string } }).data
    );
    expect(created.map((data) => data.type)).toContain(type);
    return created.find((data) => data.type === type) as Record<string, unknown>;
  }

  beforeEach(() => {
    mocks.prisma.page.findMany.mockResolvedValue(completedPages);
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = generationRow({ id: "gj-new", type: data.type as string, payload: data.payload as Record<string, unknown> });
      mocks.prisma.generationJob.findUnique.mockResolvedValue(row);
      return row;
    });
  });

  it("does nothing for a missing or FAILED project", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue(null);
    await maybeEnqueueCompile("project-1", "plan-1");

    mocks.prisma.project.findUnique.mockResolvedValue({ status: "FAILED", contentRevision: 0 });
    await maybeEnqueueCompile("project-1", "plan-1");

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("queues the cover before the compile when the book still needs one", async () => {
    await maybeEnqueueCompile("project-1", "plan-1");

    const cover = expectCreatedJobOfType("GENERATE_IMAGE");
    expect(cover.dedupeKey).toBe("generate-cover:project-1:plan-1");
    expect(mocks.prisma.generationJob.create).toHaveBeenCalledTimes(1);
  });

  it("queues the compile once every page is terminal and the cover exists", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 7 });

    await maybeEnqueueCompile("project-1", "plan-1", { skipFinalReview: true });

    const compile = expectCreatedJobOfType("COMPILE_EXPORT");
    expect(compile.payload).toEqual({
      planId: "plan-1",
      contentRevision: 7,
      skipFinalReview: true,
      exportPublicationProjectStatus: "GENERATING"
    });
    expect(compile.contentRevision).toBe(7);
    expect(compile.dedupeKey).toMatch(
      /^compile-export:project-1:plan-1:revision-7:policy-r1v0sgoo:pages-[0-9a-f]{24}$/
    );
    // Promoted out of the payload beside `contentRevision`, so the API can read
    // the compile that owns the book's quality verdict with one indexed lookup
    // rather than sifting it out of however many recent jobs it happens to hold.
    expect(compile.ownsQualityVerdict).toBe(true);
  });

  it("keeps a fan-out job that reports no manuscript verdict out of the verdict column", async () => {
    await maybeEnqueueCompile("project-1", "plan-1");

    expect(expectCreatedJobOfType("GENERATE_IMAGE").ownsQualityVerdict).toBe(false);
  });

  it("stamps an add_image recompile as not owning the quality verdict", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });

    await maybeEnqueueCompile("project-1", "plan-1", { skipFinalReview: true, withoutQualityVerdict: true });

    const compile = expectCreatedJobOfType("COMPILE_EXPORT");
    expect(compile.payload).toEqual({
      planId: "plan-1",
      contentRevision: 7,
      exportPublicationProjectStatus: "EDITING",
      skipFinalReview: true,
      markdownRecompileWithoutVerdict: true
    });
    // The appended image line moved the markdown but not the prose, so the
    // book's earned model-QA verdict stays with the compile that wrote it.
    expect(compile.ownsQualityVerdict).toBe(false);
  });

  it.each([
    [
      "outcome",
      { skipFinalReview: true, markdownRecompileWithoutVerdict: true, exportPublicationProjectStatus: "EDITING" },
      { skipFinalReview: true, markdownRecompileWithoutVerdict: true, exportPublicationProjectStatus: "EDITING" }
    ],
    [
      "presentation",
      {
        skipFinalReview: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
        exportPublicationProjectStatus: "EDITING"
      },
      {
        skipFinalReview: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
        exportPublicationProjectStatus: "EDITING"
      }
    ],
    [
      "detached repair",
      {
        skipFinalReview: true,
        detachedFromProjectLifecycle: true,
        exportRepairFormat: "epub",
        exportPublicationProjectStatus: "REVIEW_REQUIRED"
      },
      {
        skipFinalReview: true,
        detachedFromProjectLifecycle: true,
        exportRepairFormat: "epub",
        exportPublicationProjectStatus: "REVIEW_REQUIRED"
      }
    ]
  ])("round-trips the complete %s publication policy", async (_kind, source, expected) => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 7 });

    await maybeEnqueueCompile("project-1", "plan-1", compilePublicationPolicyFromPayload(source));

    const compile = expectCreatedJobOfType("COMPILE_EXPORT");
    expect(compile.payload).toEqual({ planId: "plan-1", contentRevision: 7, ...expected });
    expect(compile.ownsQualityVerdict).toBe(false);
  });

  it("inherits the latest current-revision policy when image fan-in has no explicit options", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 7 });
    mocks.prisma.generationJob.findMany.mockImplementation(
      async ({ where }: { where: { status?: unknown } }) => where.status
        ? []
        : [{
            contentRevision: 7,
            payload: {
              skipFinalReview: true,
              detachedFromProjectLifecycle: true,
              exportRepairFormat: "pdf",
              exportPublicationProjectStatus: "COMPLETE"
            }
          }]
    );

    await maybeEnqueueCompile("project-1", "plan-1");

    expect(expectCreatedJobOfType("COMPILE_EXPORT").payload).toEqual({
      planId: "plan-1",
      contentRevision: 7,
      skipFinalReview: true,
      detachedFromProjectLifecycle: true,
      exportRepairFormat: "pdf",
      exportPublicationProjectStatus: "COMPLETE"
    });
  });

  it("counts a FAILED_QA page that kept a draft as terminal", async () => {
    // One stubborn page must not hold the export hostage; the final review
    // pass repairs it after compile is queued.
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.page.findMany.mockResolvedValue([
      completedPages[0],
      { id: "page-2", index: 2, status: "FAILED_QA", markdown: "Kept draft.", revision: 3 }
    ]);

    await maybeEnqueueCompile("project-1", "plan-1");

    expectCreatedJobOfType("COMPILE_EXPORT");
  });

  it("waits while page, image, or compile jobs are still open", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    for (const type of ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"]) {
      vi.clearAllMocks();
      mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 0 });
      mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {} });
      mocks.prisma.page.findMany.mockResolvedValue(completedPages);
      mocks.prisma.imageAsset.count.mockResolvedValue(1);
      mocks.prisma.generationJob.findMany.mockResolvedValue([]);
      countsByType({ [type]: 1 });
      if (type === "COMPILE_EXPORT") {
        mocks.prisma.generationJob.findMany.mockResolvedValue([
          {
            contentRevision: 0,
            payload: { exportPublicationProjectStatus: "GENERATING" }
          }
        ]);
      }

      await maybeEnqueueCompile("project-1", "plan-1");

      expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
    }
  });

  it("waits while pages are missing or not yet terminal", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.page.findMany.mockResolvedValue([
      completedPages[0],
      { id: "page-2", index: 2, status: "PENDING", markdown: "", revision: 0 }
    ]);

    expect(await maybeEnqueueCompile("project-1", "plan-1")).toBe("not-ready");

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("still compiles when the only open compile was queued for a superseded manuscript", async () => {
    // An export repair is queued while the book is COMPLETE, then an edit lands
    // under it: the repair stands down at publish time, so counting it as "a
    // compile is already coming" left the edit with no recompile at all.
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });
    mocks.prisma.generationJob.findMany.mockResolvedValue([
      {
        // The in-flight repair compiles revision 6; the edit has moved to 7.
        contentRevision: 6,
        payload: {
          skipFinalReview: true,
          detachedFromProjectLifecycle: true,
          exportRepairFormat: "pdf",
          exportPublicationProjectStatus: "COMPLETE"
        }
      }
    ]);

    expect(await maybeEnqueueCompile("project-1", "plan-1", { skipFinalReview: true })).toBe("compile");

    const compile = expectCreatedJobOfType("COMPILE_EXPORT");
    expect(compile.contentRevision).toBe(7);
  });

  it("does not double-compile while one is in flight for the same manuscript", async () => {
    mocks.prisma.imageAsset.count.mockResolvedValue(1);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 7 });
    mocks.prisma.generationJob.findMany.mockResolvedValue([
      {
        contentRevision: 7,
        payload: { exportPublicationProjectStatus: "GENERATING" }
      }
    ]);

    expect(await maybeEnqueueCompile("project-1", "plan-1")).toBe("compile");

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

});

describe("maybeCompileAfterCompletedJob", () => {
  it("only reacts to page and image completions that carry both ids", async () => {
    await maybeCompileAfterCompletedJob({ name: "plan-book", data: { projectId: "p", planId: "pl" } } as unknown as Job);
    await maybeCompileAfterCompletedJob({ name: "generate-page", data: { projectId: "p" } } as unknown as Job);
    expect(mocks.prisma.project.findUnique).not.toHaveBeenCalled();

    await maybeCompileAfterCompletedJob({
      name: "generate-page",
      data: { projectId: "project-1", planId: "plan-1" }
    } as unknown as Job);
    expect(mocks.prisma.project.findUnique).toHaveBeenCalled();
  });
});
