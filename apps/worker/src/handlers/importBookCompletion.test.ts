import { beforeEach, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { objectKey, objectStore } from "@book-maker/storage";
import { retryJobOptions } from "@book-maker/core";
import { importCompletionDatabase } from "./testing/importCompletionDatabase.js";

const mocks = vi.hoisted(() => ({ compile: vi.fn(), embed: vi.fn(), releaseQuota: vi.fn(), append: vi.fn(), refund: vi.fn(), legacyRefund: vi.fn() }));
const db = importCompletionDatabase();
vi.mock("@book-maker/db", () => ({
  prisma: db.prisma, Prisma: {}, planRevisionRetryDelayMs: () => 1000,
  researchScope: (id: string) => `research:${id}`, RESEARCH_SCOPE_PREFIX: "research:",
  embeddingIsDegraded: () => false, pageScope: (index: number) => `page:${index}`
}));
vi.mock("@book-maker/db/billing", () => ({
  releaseManuscriptImportUse: mocks.releaseQuota,
  refundLatestProjectOperationCredits: vi.fn(),
  refundCreditLedgerEntry: mocks.legacyRefund,
  markGenerationAttemptActive: async () => {
    if (db.row("generationAttempt").status === "QUEUED") db.row("generationAttempt").status = "ACTIVE";
  },
  markGenerationAttemptSucceeded: async () => {
    await db.prisma.generationAttempt.updateMany({
      where: { id: "attempt-1", status: { in: ["ACTIVE", "QUEUED"] } }, data: { status: "SUCCEEDED" }
    });
  },
  failGenerationAttempt: async (_id: string, _reason: string, status = "FAILED") => {
    if (["QUEUED", "ACTIVE"].includes(String(db.row("generationAttempt").status))) {
      db.row("generationAttempt").status = status;
      mocks.refund();
    }
  }
}));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: true } }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.compile, maybeCompileAfterCompletedJob: vi.fn(), maybeCompileAfterFailedJob: vi.fn(async () => null) }));
vi.mock("../providers/runLogging.js", () => ({ createRunLogger: () => ({ append: mocks.append }), providerConfigSnapshot: () => ({}) }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {}, research: {}, embedding: { embed: mocks.embed } }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => structuredClone(db.row("project")),
  nextPlanVersion: async () => 1,
  planInputSnapshot: (value: unknown) => value,
  strategyForInput: () => ({ executionMode: "sequential-pages" })
}));
vi.mock("../generation/qualitySettings.js", () => ({ loadQualityContext: async () => ({ enabled: () => false }), applyPlanThinkingBoost: vi.fn() }));
vi.mock("./applyBookEdit.js", () => ({ applyBookEdit: vi.fn() }));
vi.mock("./characters.js", () => ({ buildCharacterPersona: vi.fn(), prepareCharacterCandidates: vi.fn() }));
vi.mock("./compileExport.js", () => ({ compileExport: vi.fn() }));
vi.mock("./continueBook.js", () => ({ continueBook: vi.fn() }));
vi.mock("./generateAudiobook.js", () => ({ generateAudiobook: vi.fn() }));
vi.mock("./characterPortrait.js", () => ({ generateCharacterPortrait: vi.fn() }));
vi.mock("./generateBook.js", () => ({ generateBook: vi.fn(), stagedReplanSuccessorOperationId: vi.fn() }));
vi.mock("./generateImage.js", () => ({ generateImage: vi.fn() }));
vi.mock("./generatePage.js", () => ({ generatePage: vi.fn() }));
vi.mock("./planning.js", () => ({ planBook: vi.fn(), revisePlan: vi.fn() }));
vi.mock("./replanBook.js", () => ({ replanBook: vi.fn() }));
vi.mock("./writingAssist.js", () => ({ writingAssist: vi.fn() }));

vi.mock("../generation/embeddingWrites.js", () => ({ storeEmbedding: mocks.embed, strategyUsesSemanticMemory: () => true }));

// Keep the handler, processor and lifecycle real. Only their I/O boundaries
// and unrelated handlers are replaced, including transactional rollback.
const { processWorkerJob } = await import("../processJob.js");
const job = { id: "gj-1", name: "import-book", data: {
  projectId: "project-1", generationJobId: "gj-1", importId: "import-1", knownAuthors: [], attemptId: "attempt-1",
  importQuota: { userId: "user-1", periodKey: "2026-10" }
}, opts: retryJobOptions("import-book") ?? {}, attemptsMade: 0 } as Job;

beforeEach(async () => {
  vi.clearAllMocks();
  db.reset();
  mocks.compile.mockResolvedValue("compile");
  mocks.embed.mockResolvedValue(undefined);
  mocks.append.mockResolvedValue(undefined);
  mocks.releaseQuota.mockResolvedValue(undefined);
  await objectStore().put(objectKey("attachments", "import-1", "source"), Buffer.from("# Chapter One\n\nThe author's own manuscript text."));
});

it("keeps the committed import paid and retries a failed compile enqueue without inserting twice", async () => {
  mocks.compile.mockRejectedValueOnce(new Error("compile database unavailable"));

  await expect(processWorkerJob(job)).rejects.toThrow("compile database unavailable");

  expect(db.row("bookImport").status).toBe("COMPLETE");
  expect(db.row("project").status).toBe("COMPLETE");
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
  expect(retryJobOptions("import-book")).toMatchObject({ attempts: 2 });

  await objectStore().delete(objectKey("attachments", "import-1", "source"));
  await processWorkerJob({ ...job, attemptsMade: 1 } as Job);

  expect(db.rows("chapter")).toHaveLength(1);
  expect(db.rows("page")).toHaveLength(1);
  expect(db.rows("planVersion")).toHaveLength(1);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
  expect(db.controls.commits[0]).toMatchObject({
    bookImport: [expect.objectContaining({ status: "COMPLETE" })],
    project: [expect.objectContaining({ status: "COMPLETE" })],
    generationJob: [expect.objectContaining({ status: "COMPLETED" })],
    generationAttempt: [expect.objectContaining({ status: "SUCCEEDED" })]
  });
});

it.each(["read", "write"])("keeps optional embedding %s failures outside import failure settlement", async (failure) => {
  if (failure === "read") db.prisma.page.findMany.mockRejectedValueOnce(new Error("embedding read unavailable"));
  else mocks.embed.mockRejectedValueOnce(new Error("embedding write unavailable"));

  await processWorkerJob(job);
  await processWorkerJob(job);

  expect(db.row("bookImport").status).toBe("COMPLETE");
  expect(db.row("project").status).toBe("COMPLETE");
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(db.rows("chapter")).toHaveLength(1);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it("still rolls back, fails and refunds an actual pre-commit page write failure", async () => {
  db.prisma.page.createMany.mockRejectedValueOnce(new Error("page write unavailable"));

  await expect(processWorkerJob(job)).rejects.toThrow("page write unavailable");

  expect(db.rows("chapter")).toHaveLength(0);
  expect(db.rows("page")).toHaveLength(0);
  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("bookImport").status).toBe("FAILED");
  expect(db.row("project")).toMatchObject({ status: "FAILED", currentPlanId: null, contentRevision: 0 });
  expect(db.row("generationJob").status).toBe("FAILED");
  expect(db.row("generationAttempt").status).toBe("FAILED");
  expect(mocks.refund).toHaveBeenCalledTimes(1);
  expect(mocks.releaseQuota).toHaveBeenCalledTimes(1);
  expect(mocks.compile).not.toHaveBeenCalled();
});

it("recovers a lost commit acknowledgement without clearing the receipt or inserting again", async () => {
  db.controls.crashAfterCommit = true;
  await expect(processWorkerJob(job)).rejects.toThrow("process lost after commit");

  expect(db.row("bookImport").status).toBe("COMPLETE");
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  db.controls.crashAfterCommit = false;
  await processWorkerJob(job);

  expect(db.rows("chapter")).toHaveLength(1);
  expect(mocks.compile).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it.each([
  { status: "EDITING" },
  { status: "GENERATING" },
  { status: "FAILED" },
  { currentPlanId: "new-plan" },
  { contentRevision: 2 }
])("never overwrites or compiles newer state from a completed redelivery: %j", async (change) => {
  await processWorkerJob(job);
  Object.assign(db.row("project"), change);
  const newer = structuredClone(db.row("project"));
  mocks.compile.mockClear();

  await processWorkerJob(job);

  expect(db.row("project")).toEqual(newer);
  expect(db.rows("chapter")).toHaveLength(1);
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it.each([
  { status: "EDITING" },
  { currentPlanId: "new-plan" },
  { contentRevision: 1 }
])("refuses publication when parsing outlasts its project ownership: %j", async (change) => {
  db.controls.beforeTransaction = () => {
    Object.assign(db.row("project"), change);
  };

  await processWorkerJob(job);

  expect(db.row("project")).toMatchObject(change);
  expect(db.rows("chapter")).toHaveLength(0);
  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("generationJob").status).toBe("CANCELED");
  expect(mocks.compile).not.toHaveBeenCalled();
});

it("does not publish a job stopped while the manuscript was being parsed", async () => {
  const { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE } = await import("../runtime/jobTypes.js");
  db.controls.beforeTransaction = () => {
    Object.assign(db.row("generationJob"), { status: "FAILED", message: STOPPED_JOB_MESSAGE, error: STOPPED_JOB_ERROR });
  };

  await expect(processWorkerJob(job)).rejects.toThrow("Stopped");

  expect(db.rows("chapter")).toHaveLength(0);
  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("generationAttempt").status).toBe("CANCELED");
  expect(mocks.compile).not.toHaveBeenCalled();
});

it("replays the compile hook even when lifecycle bookkeeping fails after the atomic commit", async () => {
  db.controls.failCompletedBookkeeping = true;

  await processWorkerJob(job);

  expect(db.row("bookImport").status).toBe("COMPLETE");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(mocks.compile).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it("does not import into a project already superseded before this delivery started", async () => {
  Object.assign(db.row("project"), { currentPlanId: "new-plan", contentRevision: 3 });

  await processWorkerJob(job);

  expect(db.row("project")).toMatchObject({ status: "GENERATING", currentPlanId: "new-plan", contentRevision: 3 });
  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.rows("chapter")).toHaveLength(0);
  expect(mocks.compile).not.toHaveBeenCalled();
});

it("keeps newer state that lands between the import commit and its first compile hook", async () => {
  mocks.embed.mockImplementationOnce(async () => {
    Object.assign(db.row("project"), { status: "EDITING", currentPlanId: "new-plan", contentRevision: 2 });
  });

  await processWorkerJob(job);

  expect(db.row("project")).toMatchObject({ status: "EDITING", currentPlanId: "new-plan", contentRevision: 2 });
  expect(db.row("bookImport").status).toBe("COMPLETE");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it("retries a receipt-read outage on completed redelivery without failing the delivered lifecycle", async () => {
  await processWorkerJob(job);
  db.prisma.bookImport.findUnique.mockRejectedValueOnce(new Error("receipt unavailable"));

  await expect(processWorkerJob(job)).rejects.toThrow("receipt unavailable");
  await processWorkerJob(job);

  expect(db.row("bookImport").status).toBe("COMPLETE");
  expect(db.rows("chapter")).toHaveLength(1);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it("replays a COMPLETE receipt even when a legacy delivery has not completed its durable job yet", async () => {
  await processWorkerJob(job);
  db.row("generationJob").status = "ACTIVE";
  db.row("generationAttempt").status = "ACTIVE";
  db.row("bookImport").stats = {};
  await objectStore().delete(objectKey("attachments", "import-1", "source"));

  await processWorkerJob(job);

  expect(db.rows("chapter")).toHaveLength(1);
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(mocks.compile).toHaveBeenCalledTimes(2);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it("stands down on the in-lock receipt when another delivery already committed the import", async () => {
  db.controls.beforeTransaction = () => {
    Object.assign(db.row("project"), { status: "COMPLETE", currentPlanId: "winner-plan", contentRevision: 1 });
    Object.assign(db.row("bookImport"), { status: "COMPLETE", stats: { completion: { planVersionId: "winner-plan", contentRevision: 1 } } });
    db.row("generationJob").status = "COMPLETED";
    db.row("generationAttempt").status = "SUCCEEDED";
    db.rows("chapter").push({ projectId: "project-1", index: 1 });
  };

  await processWorkerJob(job);

  expect(db.rows("chapter")).toHaveLength(1);
  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("project").currentPlanId).toBe("winner-plan");
  expect(mocks.compile).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
});

it("preserves a quota-backed import without a paid attempt across compile failure and retry", async () => {
  const { attemptId: _attemptId, ...data } = job.data;
  const delivery = { ...job, data } as Job;
  db.row("generationJob").attemptId = null;
  mocks.compile.mockRejectedValueOnce(new Error("compile unavailable"));

  await expect(processWorkerJob(delivery)).rejects.toThrow("compile unavailable");
  await processWorkerJob(delivery);

  expect(db.row("bookImport").status).toBe("COMPLETE");
  expect(db.row("project").status).toBe("COMPLETE");
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.rows("chapter")).toHaveLength(1);
  expect(mocks.releaseQuota).not.toHaveBeenCalled();
  expect(mocks.compile).toHaveBeenCalledTimes(2);
});

it("refuses a newer import job even if the project still has the original blank state", async () => {
  db.controls.beforeTransaction = () => {
    db.rows("generationJob").push({ ...db.row("generationJob"), id: "gj-new", status: "QUEUED", createdAt: new Date("2026-02-01") });
  };

  await processWorkerJob(job);

  expect(db.row("project")).toMatchObject({ status: "GENERATING", currentPlanId: null, contentRevision: 0 });
  expect(db.rows("chapter")).toHaveLength(0);
  expect(db.row("generationJob").status).toBe("CANCELED");
  expect(db.rows("generationJob")[1]?.status).toBe("QUEUED");
  expect(mocks.compile).not.toHaveBeenCalled();
});
