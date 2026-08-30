import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  operationFindMany: vi.fn(),
  operationUpdateMany: vi.fn(),
  queryRawUnsafe: vi.fn(),
  failGenerationAttempt: vi.fn(),
  generationAttemptUpdateMany: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn();
  }
}));
vi.mock("ioredis", () => ({ Redis: class { disconnect = vi.fn(); } }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, loadConfig: () => ({ REDIS_URL: "redis://test" }) };
});
vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null, PrismaClientKnownRequestError: class extends Error {} },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  prisma: {
    $transaction: mocks.transaction,
    generationJob: { findMany: mocks.generationJobFindMany },
    bookEditOperation: { findUnique: vi.fn() },
    audiobook: { updateMany: vi.fn() }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits
}));

import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  CONTINUATION_PUBLICATION_PROTOCOL_FIELD,
  PRE_EDIT_PROJECT_STATUS
} from "@book-maker/core";
import { stopProjectGenerationJobs } from "./queue.js";

type DurableContinuation = {
  id: string;
  bullJobId: null;
  status: string;
  type: "CONTINUE_BOOK";
  payload: Record<string, unknown>;
  attemptId: string;
};

function continuation(status: "QUEUED" | "ACTIVE", marked = true): DurableContinuation {
  return {
    id: "job-continue",
    bullJobId: null,
    status,
    type: "CONTINUE_BOOK",
    payload: {
      operationId: "op-continue",
      ...(marked
        ? { [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL }
        : {}),
      [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
    },
    attemptId: "attempt-continue"
  };
}

function operation(marked = true, overrides: Record<string, unknown> = {}) {
  return {
    id: "op-continue",
    projectId: "project-1",
    generationJobId: "job-continue",
    kind: "CONTINUE_BOOK",
    status: "ACTIVE",
    classifier: marked
      ? { [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL }
      : {},
    publicationRevision: null,
    ...overrides
  };
}

let durableOperation = operation();

describe("Stop compensation for continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({ status: "EDITING", contentRevision: 8 });
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    durableOperation = operation();
    mocks.operationFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.kind === "CONTINUE_BOOK" ? [durableOperation] : []
    );
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.queryRawUnsafe.mockResolvedValue([]);
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: {
          findMany: mocks.generationJobFindMany,
          updateMany: mocks.generationJobUpdateMany
        },
        bookEditOperation: { findMany: mocks.operationFindMany, updateMany: mocks.operationUpdateMany },
        generationAttempt: { updateMany: mocks.generationAttemptUpdateMany },
        $queryRawUnsafe: mocks.queryRawUnsafe
      })
    );
  });

  it.each([true, false])("restores a queued continuation (marked: %s)", async (marked) => {
    durableOperation = operation(marked, { status: "QUEUED" });
    mocks.generationJobFindMany.mockResolvedValue([continuation("QUEUED", marked)]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it.each(["during outline", "during page drafting", "during adherence", "during memory preparation"])(
    "restores a marked ACTIVE continuation paused %s",
    async () => {
      mocks.generationJobFindMany.mockResolvedValue([continuation("ACTIVE")]);

      await stopProjectGenerationJobs("project-1");

      expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
        where: { id: "project-1", status: "EDITING" },
        data: { status: "REVIEW_REQUIRED" }
      });
      expect(mocks.failGenerationAttempt).toHaveBeenCalledWith(
        "attempt-continue",
        "Stopped by user",
        "CANCELED"
      );
    }
  );

  // The classifier reads the durable `generationJobId` relation, so a row
  // created before that relation carries only the payload id and reaches no
  // disposition at all. Fail-closed is the wrong default there: it marks a
  // finished book FAILED over a continuation that never started, and nothing
  // moves it back. Those keep the rule the classifier replaced.
  it("restores a queued continuation whose operation predates the durable link", async () => {
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.generationJobFindMany.mockResolvedValue([continuation("QUEUED")]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  // A QUEUED row's markers are not evidence about the book: `markActive` claims
  // the GenerationJob before it touches the operation, the plan or the
  // manuscript, so QUEUED under Stop's own row claim proves the worker never
  // started. Failing closed on a disagreement here marks a finished, paid book
  // FAILED, and `SETTLED_PROJECT_STATUSES` is the only thing that would have
  // saved it — which EDITING is not.
  it("restores a queued continuation whose durable and payload markers disagree", async () => {
    durableOperation = operation(true, { status: "QUEUED" });
    mocks.generationJobFindMany.mockResolvedValue([continuation("QUEUED", false)]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("keeps an ACTIVE continuation with no durable link failed", async () => {
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.generationJobFindMany.mockResolvedValue([continuation("ACTIVE")]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: { notIn: ["COMPLETE", "REVIEW_REQUIRED"] } },
      data: { status: "FAILED" }
    });
  });

  it("keeps an unmarked ACTIVE rolling-deploy continuation failed", async () => {
    durableOperation = operation(false);
    mocks.generationJobFindMany.mockResolvedValue([continuation("ACTIVE", false)]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: { notIn: ["COMPLETE", "REVIEW_REQUIRED"] } },
      data: { status: "FAILED" }
    });
  });

  it("keeps repeated Stop idempotent after restoring a marked active continuation", async () => {
    const durableJob = continuation("ACTIVE");
    let projectStatus = "EDITING";
    mocks.projectUpdate.mockImplementation(async () => ({ status: projectStatus }));
    mocks.projectUpdateMany.mockImplementation(
      async ({ where, data }: { where: { status?: string | { notIn: string[] } }; data: { status: string } }) => {
        const matches =
          typeof where.status === "string"
            ? projectStatus === where.status
            : where.status
              ? !where.status.notIn.includes(projectStatus)
              : true;
        if (matches) projectStatus = data.status;
        return { count: matches ? 1 : 0 };
      }
    );
    mocks.generationJobFindMany.mockImplementation(async () =>
      durableJob.status === "ACTIVE" || durableJob.status === "QUEUED" ? [durableJob] : []
    );
    mocks.generationJobUpdateMany.mockImplementation(
      async ({ data }: { data: { status?: string } }) => {
        const open = durableJob.status === "ACTIVE" || durableJob.status === "QUEUED";
        if (open && data.status) durableJob.status = data.status;
        return { count: open ? 1 : 0 };
      }
    );

    const first = await stopProjectGenerationJobs("project-1");
    const repeated = await stopProjectGenerationJobs("project-1");

    expect([first.stoppedJobs, repeated.stoppedJobs]).toEqual([1, 0]);
    expect(projectStatus).toBe("REVIEW_REQUIRED");
    expect(durableJob.status).toBe("FAILED");
    expect(mocks.failGenerationAttempt.mock.calls).toEqual([
      ["attempt-continue", "Stopped by user", "CANCELED"]
    ]);
  });
});
