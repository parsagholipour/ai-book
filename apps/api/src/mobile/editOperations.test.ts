import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    generationJob: { count: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn()
  },
  dispatchGenerationJob: vi.fn(),
  enqueueGenerationJob: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  PLAN_REVISION_AUTOMATIC_RETRY_LIMIT: 2,
  Prisma: {},
  prisma: mocks.prisma
}));
vi.mock("@book-maker/db/billing", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {}
}));
vi.mock("../queue.js", () => ({
  dispatchGenerationJob: mocks.dispatchGenerationJob,
  enqueueGenerationJob: mocks.enqueueGenerationJob
}));
vi.mock("./bookEditIntents.js", () => ({
  affectedPagesForIntent: vi.fn(),
  busyEditReply: vi.fn(),
  continuationNewPageCount: vi.fn(),
  editProposalCardFromState: vi.fn(),
  exactReplacementFromMessage: vi.fn(),
  operationQueuedMessage: vi.fn(),
  pendingEditMetadataFromState: vi.fn()
}));
vi.mock("./bookEditPricing.js", () => ({
  billingOperationForIntent: vi.fn(),
  bookEditCreditCost: vi.fn(),
  operationKindForIntent: vi.fn()
}));
vi.mock("./exactReplacementPreview.js", () => ({ planExactReplacement: vi.fn() }));
// Cuts the add_image / layout queue branches' import subtree, which nothing
// here reaches; the core mock below carries only what the modules that survive
// that cut read at module load.
vi.mock("./addImageOperations.js", () => ({
  addImageQuotaLimit: vi.fn(),
  proposeAddImageEdit: vi.fn(),
  queueChatAddImage: vi.fn()
}));
vi.mock("./imageLayoutOperations.js", () => ({
  proposeImageLayoutEdit: vi.fn(),
  queueChatImageLayout: vi.fn()
}));
vi.mock("./projectChat.js", () => ({
  createAssistantChatMessage: vi.fn(),
  insufficientCreditsChatMessage: vi.fn()
}));
vi.mock("./projectRecords.js", () => ({ createReplanProjectCopy: vi.fn() }));
vi.mock("./support.js", () => ({
  cleanTargetLanguage: vi.fn(),
  hashString: (value: string) => value,
  isPrismaUniqueConflict: () => false,
  jsonInputValue: (value: unknown) => value,
  languageDisplayName: vi.fn()
}));
vi.mock("@book-maker/core", () => ({
  creditCostForOperation: () => 25,
  errorMessage: vi.fn(),
  // bookEditMessage.ts builds a RegExp from each of these at module load —
  // it is reached through editOperations.ts's own bookPageNumbering.js import,
  // which the addImageOperations.js mock below does not cut. Only their regex
  // syntax matters here: nothing in this suite parses a page reference or a
  // language name. Everything else this suite's graph imports from core is
  // only called inside functions the tests never reach, so the bare-object
  // mock stays bare.
  BOOK_PAGE_WORD_PATTERN: "pages?",
  languageNamePattern: () => "language",
  // The real predicate is a pure payload flag read (`jobScope.ts`, covered by
  // its own suite); mirrored here rather than imported so this factory keeps
  // pulling nothing into the mock registry.
  isDetachedFromProjectLifecycle: (payload: unknown) =>
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).detachedFromProjectLifecycle === true
}));

import { hasOpenProjectWork } from "./editOperations.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hasOpenProjectWork", () => {
  type JobRow = { id: string; type: string; status: string; payload: Record<string, unknown> };
  type OpenWorkQuery = {
    where: { projectId: string; status: { in: string[] }; type: { notIn: string[] } } & Record<string, unknown>;
    select: object;
  };

  const editJob = (over: Partial<JobRow> = {}): JobRow => ({
    id: "job-edit",
    type: "APPLY_BOOK_EDIT",
    status: "QUEUED",
    payload: { operationId: "operation-1" },
    ...over
  });
  const repairJob = (over: Partial<JobRow> = {}): JobRow => ({
    id: "job-repair",
    type: "COMPILE_EXPORT",
    status: "ACTIVE",
    payload: { planId: "plan-1", skipFinalReview: true, detachedFromProjectLifecycle: true },
    ...over
  });

  /**
   * A generation-job table that moves the instant it has been read, which is
   * what these rows do all day: the worker claims and settles them, and every
   * status read of a settled book whose PDF is missing queues a repair.
   *
   * A query returns the rows that match its `where` at the moment it runs, and
   * `move` is applied as it resolves — so a *second* query is a second snapshot
   * and sees a table that has changed under it, exactly as each statement of a
   * Read Committed connection does in production. An implementation that reads
   * once cannot be torn; one that reads twice mixes two instants.
   */
  function installMovingJobTable(rows: JobRow[], move: (table: JobRow[]) => void = () => {}) {
    const table = [...rows];
    mocks.prisma.generationJob.findMany.mockImplementation(async (query: OpenWorkQuery) => {
      const snapshot = table
        .filter((row) => query.where.status.in.includes(row.status) && !query.where.type.notIn.includes(row.type))
        .map((row) => ({ payload: row.payload }));
      move(table);
      return snapshot;
    });
    return table;
  }

  it("reports nothing open when no job row is", async () => {
    installMovingJobTable([editJob({ status: "COMPLETED" })]);

    expect(await hasOpenProjectWork("project-1")).toBe(false);
  });

  it("counts an open edit job as work, queued or active", async () => {
    installMovingJobTable([editJob({ status: "QUEUED" })]);
    expect(await hasOpenProjectWork("project-1")).toBe(true);

    installMovingJobTable([editJob({ status: "ACTIVE" })]);
    expect(await hasOpenProjectWork("project-1")).toBe(true);
  });

  it("ignores the derivative jobs a book can make alongside itself", async () => {
    installMovingJobTable([editJob({ type: "PREPARE_CHARACTER_CANDIDATES" })]);

    expect(await hasOpenProjectWork("project-1")).toBe(false);
  });

  // Merely reading a settled project queues an export repair when a compiled
  // file is missing, so counting one turned "open the book" into "you cannot
  // edit the book" — a 409 PROJECT_BUSY against a project the app is drawing
  // as COMPLETE with nothing in flight.
  it("ignores a detached export repair", async () => {
    installMovingJobTable([repairJob()]);

    expect(await hasOpenProjectWork("project-1")).toBe(false);
  });

  it("still reports work when a real compile runs alongside a repair", async () => {
    installMovingJobTable([repairJob(), editJob({ type: "COMPILE_EXPORT", payload: { planId: "plan-1" } })]);

    expect(await hasOpenProjectWork("project-1")).toBe(true);
  });

  // One statement is one snapshot at any isolation level. Two were not: the
  // open rows and the detached rows were counted by separate queries, so a
  // repair queued in the gap was missing from the total and present in the
  // subtrahend — `1 > 1` on a project whose real edit job was open the whole
  // time, and the second edit walked straight through the guard.
  it("is not fooled by a repair queued the moment after it read", async () => {
    installMovingJobTable([editJob()], (table) => table.push(repairJob()));

    expect(await hasOpenProjectWork("project-1")).toBe(true);
    expect(mocks.prisma.generationJob.findMany).toHaveBeenCalledTimes(1);
  });

  // The same tear in the other direction: the repair was counted as open work
  // and then left QUEUED/ACTIVE before it could be subtracted back out, so a
  // finished book with nothing but a repair in flight answered "busy" — a 409
  // PROJECT_BUSY on the manual save and the undo this exclusion exists for.
  it("is not fooled by a repair that settles the moment after it read", async () => {
    installMovingJobTable([repairJob()], (table) => {
      for (const row of table) row.status = "COMPLETED";
    });

    expect(await hasOpenProjectWork("project-1")).toBe(false);
    expect(mocks.prisma.generationJob.findMany).toHaveBeenCalledTimes(1);
  });

  // Both transitions at once, which is the ordinary case rather than a corner:
  // the edit's own job finishes and the status read that follows it queues a
  // repair for the file the recompile has not published yet. The answer must
  // describe the instant that was read — the edit was open then — and not a
  // total from before it settled minus a repair from after.
  it("is not fooled by an edit settling while a repair takes its place", async () => {
    installMovingJobTable([editJob({ status: "ACTIVE" })], (table) => {
      for (const row of table) row.status = "COMPLETED";
      table.push(repairJob());
    });

    expect(await hasOpenProjectWork("project-1")).toBe(true);
    expect(mocks.prisma.generationJob.findMany).toHaveBeenCalledTimes(1);
  });

  // The detached flag lives in the payload and must be excluded in JavaScript:
  // `NOT (payload->>flag = true)` in SQL is null for every row that never
  // carried the key, which is every job but the repairs, so pushing the
  // exclusion into the `where` would hide the real work this guard is for.
  it("asks for the open rows themselves, with no payload predicate", async () => {
    installMovingJobTable([]);

    await hasOpenProjectWork("project-1");

    const [call] = mocks.prisma.generationJob.findMany.mock.calls as [[OpenWorkQuery]];
    expect(call[0].where).toEqual({
      projectId: "project-1",
      status: { in: ["QUEUED", "ACTIVE"] },
      type: { notIn: ["PREPARE_CHARACTER_CANDIDATES", "BUILD_CHARACTER_PERSONA", "RESEARCH"] }
    });
    expect(call[0].where.payload).toBeUndefined();
    expect(call[0].where.NOT).toBeUndefined();
    // Only the flag is read back, so the open row count is what this costs.
    expect(call[0].select).toEqual({ payload: true });
  });
});
