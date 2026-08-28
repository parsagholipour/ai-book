import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
    getJob = vi.fn();
    close = vi.fn();
  }
}));

vi.mock("ioredis", () => ({
  Redis: class {
    quit = vi.fn();
  }
}));

vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, loadConfig: () => ({ REDIS_URL: "redis://test" }) };
});
vi.mock("@book-maker/db", () => ({
  Prisma: {
    JsonNull: null,
    // The concurrent half of a dedupe-key enqueue arrives as a P2002 that the
    // recovery branch tells apart by `instanceof`.
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      readonly code: string;
      constructor(message: string, params: { code: string }) {
        super(message);
        this.name = "PrismaClientKnownRequestError";
        this.code = params.code;
      }
    }
  },
  prisma: {
    generationJob: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update
    }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn(),
  failGenerationAttempt: vi.fn(),
  // A real subclass rather than a bare `Error`, because `enqueueGenerationJob`
  // constructs it and `sendGenerationAttemptError` tells it apart from a
  // conflict by `instanceof`.
  GenerationAttemptJobClaimError: class GenerationAttemptJobClaimError extends Error {
    readonly code = "GENERATION_JOB_NOT_CLAIMED";
    constructor(message: string) {
      super(message);
      this.name = "GenerationAttemptJobClaimError";
    }
  }
}));

import { Prisma } from "@book-maker/db";
import { enqueueGenerationJob } from "./queue.js";

/**
 * `enqueueGenerationJob`'s attempt precondition. Split from `queue.test.ts`,
 * which holds the dispatch outbox, the stop settlement and the quality-verdict
 * stamp — this file is about one question those never ask: who owns the row a
 * spent `dedupeKey` answers with.
 */

describe("a paid attempt may only claim the job its own enqueue wrote", () => {
  // The hazard is created here rather than at `startGenerationAttempt`:
  // `enqueueGenerationJob` answers a spent `dedupeKey` with whatever row already
  // stands under it, and `assertPrimaryJobBelongsToAttempt` can only ever vouch
  // for the *one* job a `create` callback names as `primaryJobId`. The confirmed
  // generation retry (`POST /api/mobile/projects/:id/resume`) loops over the
  // failed run's jobs and keeps the first, so every job after it used to be
  // neither stamped nor verified.
  const spentRow = {
    id: "job-already-standing",
    projectId: "project-1",
    type: "GENERATE_PAGE",
    status: "QUEUED",
    payload: { pageId: "page-2" },
    attemptId: "attempt-somebody-else",
    bullJobId: null,
    dispatchAttempts: 0
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "job-new", ...data }));
  });

  async function enqueueRetryJob(attemptId: string | undefined) {
    return enqueueGenerationJob({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      dedupeKey: "generation-retry:attempt-failed:job-page-2",
      payload: { pageId: "page-2" },
      dispatch: false,
      ...(attemptId ? { attemptId } : {})
    });
  }

  it("refuses a multi-job attempt's second job when another attempt already spent its key", async () => {
    // Answered with `spentRow`, the charge commits, the BullMQ payload never
    // carries this attempt's id, and `where: { attemptId }` finds one job where
    // the reader paid for two.
    mocks.findUnique.mockResolvedValue(spentRow);

    await expect(enqueueRetryJob("attempt-retry")).rejects.toMatchObject({
      code: "GENERATION_JOB_NOT_CLAIMED"
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("refuses an unbilled row a paid start would otherwise adopt", async () => {
    // `attemptId: null` is the operator approval route's free
    // `generate-book:<projectId>:<planId>` row — no tolerated middle.
    mocks.findUnique.mockResolvedValue({ ...spentRow, attemptId: null });

    await expect(enqueueRetryJob("attempt-retry")).rejects.toMatchObject({
      code: "GENERATION_JOB_NOT_CLAIMED"
    });
  });

  it("hands back the row the attempt already owns", async () => {
    mocks.findUnique.mockResolvedValue({ ...spentRow, attemptId: "attempt-retry" });

    await expect(enqueueRetryJob("attempt-retry")).resolves.toMatchObject({ id: spentRow.id });
  });

  it("leaves every attempt-less caller exactly as it was", async () => {
    // The operator routes, the export repair, the free presentation recompiles
    // and `enqueueOrRequeueGenerationJob`, whose options carry no `attemptId` to
    // disagree with. A spent key is still answered with its row.
    mocks.findUnique.mockResolvedValue(spentRow);

    await expect(enqueueRetryJob(undefined)).resolves.toMatchObject({ id: spentRow.id });
  });

  it("refuses a row the concurrent-create recovery found for somebody else", async () => {
    // Same hazard through the other door: two callers race the `create`, the
    // loser reads the winner's row back out of its own P2002.
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValue(spentRow);
    mocks.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }));

    await expect(enqueueRetryJob("attempt-retry")).rejects.toMatchObject({
      code: "GENERATION_JOB_NOT_CLAIMED"
    });
  });
});
