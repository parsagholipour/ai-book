import { beforeEach, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { planningCompletionDatabase } from "./testing/planningCompletionDatabase.js";

const mocks = vi.hoisted(() => ({ createPlan: vi.fn(), embed: vi.fn(), append: vi.fn(), refund: vi.fn(), legacyRefund: vi.fn() }));
const db = planningCompletionDatabase();
vi.mock("@book-maker/db", () => ({
  prisma: db.prisma, Prisma: {}, planRevisionRetryDelayMs: () => 1000,
  researchScope: (id: string) => `research:${id}`, RESEARCH_SCOPE_PREFIX: "research:",
  embeddingIsDegraded: () => false
}));
vi.mock("@book-maker/db/billing", () => ({
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
vi.mock("../runtime/dispatch.js", () => ({ maybeCompileAfterCompletedJob: vi.fn(), maybeCompileAfterFailedJob: vi.fn(async () => null) }));
vi.mock("../providers/runLogging.js", () => ({ createRunLogger: () => ({ append: mocks.append }), providerConfigSnapshot: () => ({}) }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {}, research: {}, embedding: { embed: mocks.embed } }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => structuredClone(db.row("project")),
  nextPlanVersion: async () => 1,
  planInputSnapshot: (value: unknown) => value,
  strategyForInput: () => ({ executionMode: "sequential-pages", createPlan: mocks.createPlan })
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
vi.mock("./importBook.js", () => ({ importBook: vi.fn() }));
vi.mock("./replanBook.js", () => ({ replanBook: vi.fn() }));
vi.mock("./writingAssist.js", () => ({ writingAssist: vi.fn() }));

// Keep the handler, processor and lifecycle real. Only their I/O boundaries
// and unrelated handlers are replaced, including transactional rollback.
const { processWorkerJob } = await import("../processJob.js");
const plan = { title: "Birds", chapters: [], characters: [], locations: [], researchNotes: [], promises: [] };
const job = { id: "gj-1", name: "plan-book", data: { projectId: "project-1", generationJobId: "gj-1", attemptId: "attempt-1" }, opts: { attempts: 1 }, attemptsMade: 0 } as Job;

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  mocks.createPlan.mockResolvedValue(plan);
  mocks.embed.mockResolvedValue([0.1, 0.2]);
  mocks.append.mockResolvedValue(undefined);
  mocks.legacyRefund.mockResolvedValue(undefined);
});

it("keeps a completed plan ready when a post-completion database write is unavailable, including redelivery", async () => {
  db.controls.failReadyOutsideTransaction = true;

  await processWorkerJob(job);
  await processWorkerJob(job);

  expect(db.row("project").status).toBe("PLAN_READY");
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(db.rows("planVersion")).toHaveLength(1);
  expect(mocks.createPlan).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(db.controls.commits[0]).toMatchObject({
    project: [expect.objectContaining({ status: "PLAN_READY" })],
    generationJob: [expect.objectContaining({ status: "COMPLETED" })],
    generationAttempt: [expect.objectContaining({ status: "SUCCEEDED" })]
  });
});

it.each(["failReady", "failAttemptSuccess"] as const)("rolls back the plan and cast when %s prevents completion", async (failure) => {
  db.controls[failure] = true;
  db.rows("character").push({ name: "Original cast" });

  await expect(processWorkerJob(job)).rejects.toThrow(/unavailable/);

  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.rows("character")).toEqual([{ name: "Original cast" }]);
  expect(db.row("project").currentPlanId).toBeNull();
  expect(db.row("generationJob").status).toBe("FAILED");
  expect(db.row("generationAttempt").status).toBe("FAILED");
  expect(mocks.refund).toHaveBeenCalledTimes(1);
});

it("survives losing the process at the publication commit and redelivers without buying another plan", async () => {
  db.controls.crashAfterCommit = true;
  await expect(processWorkerJob(job)).rejects.toThrow("process lost after commit");

  expect(db.row("project").status).toBe("PLAN_READY");
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  db.controls.crashAfterCommit = false;
  await processWorkerJob(job);

  expect(db.rows("planVersion")).toHaveLength(1);
  expect(mocks.createPlan).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
});

it("never overwrites newer project state on completed redelivery", async () => {
  await processWorkerJob(job);
  Object.assign(db.row("project"), { status: "GENERATING", currentPlanId: "new-plan", title: "Newer title", contentRevision: 2 });
  const newer = structuredClone(db.row("project"));

  await processWorkerJob(job);

  expect(db.row("project")).toEqual(newer);
  expect(mocks.createPlan).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
});

it("finishes the sole planning job after a permitted byline and matter edit", async () => {
  const metadata = {
    authorName: "Ada Rivers",
    bookMatter: { dedication: "For the backyard birdwatchers", copyrightHolder: "Ada Rivers" },
    updatedAt: new Date("2026-01-02")
  };
  mocks.createPlan.mockImplementation(async () => {
    // bookMatterEdits.applyUnderLock permits this row-only save during
    // PLANNING when no compile is open; it queues no replacement plan.
    await db.prisma.project.update({ where: { id: "project-1" }, data: metadata });
    expect(db.row("project")).toMatchObject({ status: "PLANNING", currentPlanId: null, contentRevision: 0 });
    expect(db.rows("generationJob")).toHaveLength(1);
    return plan;
  });

  await processWorkerJob(job);
  await processWorkerJob(job);

  expect(db.row("project").status).toBe("PLAN_READY");
  expect(db.rows("planVersion")).toHaveLength(1);
  expect(db.row("project")).toMatchObject({
    status: "PLAN_READY", currentPlanId: db.row("planVersion").id, contentRevision: 0,
    authorName: metadata.authorName, bookMatter: metadata.bookMatter
  });
  expect((db.row("project").updatedAt as Date).getTime()).toBeGreaterThanOrEqual(metadata.updatedAt.getTime());
  expect(db.rows("generationJob")).toHaveLength(1);
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(mocks.createPlan).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
  expect(mocks.legacyRefund).not.toHaveBeenCalled();
  expect(db.controls.commits[0]).toMatchObject({
    project: [expect.objectContaining({ status: "PLAN_READY", authorName: metadata.authorName, bookMatter: metadata.bookMatter })],
    generationJob: [expect.objectContaining({ status: "COMPLETED" })],
    generationAttempt: [expect.objectContaining({ status: "SUCCEEDED" })]
  });
});

it.each([
  { status: "GENERATING" },
  { status: "FAILED" },
  { currentPlanId: "new-plan" },
  { contentRevision: 1 }
])("stands down when project state changes during planning: %j", async (change) => {
  mocks.createPlan.mockImplementation(async () => {
    Object.assign(db.row("project"), change);
    return plan;
  });

  await processWorkerJob(job);

  expect(db.row("project")).toMatchObject(change);
  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("generationJob").status).toBe("CANCELED");
  expect(db.row("generationAttempt").status).toBe("CANCELED");
  expect(mocks.refund).toHaveBeenCalledTimes(1);
});

it("refuses an old request even if a newer planning request keeps the same project state", async () => {
  mocks.createPlan.mockImplementation(async () => {
    db.rows("generationJob").push({ ...db.row("generationJob"), id: "gj-new", createdAt: new Date("2026-02-01"), attemptId: "attempt-new", status: "QUEUED" });
    return plan;
  });

  await processWorkerJob(job);

  expect(db.row("project").status).toBe("PLANNING");
  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("generationJob").status).toBe("CANCELED");
  expect(db.rows("generationJob")[1]?.status).toBe("QUEUED");
});

it("does not complete a stopped job even if its project snapshot is unchanged", async () => {
  const { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE } = await import("../runtime/jobTypes.js");
  mocks.createPlan.mockImplementation(async () => {
    Object.assign(db.row("generationJob"), { status: "FAILED", message: STOPPED_JOB_MESSAGE, error: STOPPED_JOB_ERROR });
    return plan;
  });

  await expect(processWorkerJob(job)).rejects.toThrow(STOPPED_JOB_ERROR);

  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("project").currentPlanId).toBeNull();
  expect(db.row("generationJob")).toMatchObject({ status: "FAILED", error: STOPPED_JOB_ERROR });
  expect(db.row("generationAttempt").status).toBe("CANCELED");
});

it("propagates an embedding Stop before publishing any plan or successful attempt", async () => {
  const { StopRequestedError } = await import("../runtime/jobTypes.js");
  mocks.createPlan.mockResolvedValue({ ...plan, researchNotes: [{ query: "birds", title: "Birds", summary: "Facts", url: null, publishedAt: null }] });
  mocks.embed.mockRejectedValue(new StopRequestedError());

  await expect(processWorkerJob(job)).rejects.toThrow("Stopped");

  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.rows("researchSource")).toHaveLength(0);
  expect(db.row("project").currentPlanId).toBeNull();
  expect(db.row("generationAttempt").status).toBe("CANCELED");
  expect(mocks.refund).toHaveBeenCalledTimes(1);
});

it("publishes a ready plan and its research when an embedding provider is unavailable", async () => {
  mocks.createPlan.mockResolvedValue({ ...plan, researchNotes: [{ query: "birds", title: "Birds", summary: "Facts", url: null, publishedAt: null }] });
  mocks.embed.mockRejectedValue(new Error("embedding outage"));

  await processWorkerJob(job);

  expect(db.row("project").status).toBe("PLAN_READY");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(db.rows("researchSource")).toHaveLength(1);
  expect(mocks.refund).not.toHaveBeenCalled();
});

function legacyJob(): Job {
  db.row("generationJob").attemptId = null;
  db.rows("generationAttempt").length = 0;
  return { ...job, data: { projectId: "project-1", generationJobId: "gj-1", billingLedgerEntryId: "legacy-plan-charge" } } as Job;
}

it("publishes a legacy plan without requiring a paid-attempt row", async () => {
  await processWorkerJob(legacyJob());

  expect(db.row("project").status).toBe("PLAN_READY");
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(mocks.legacyRefund).not.toHaveBeenCalled();
});

it("refunds only the superseded legacy plan's own charge, including a canceled redelivery", async () => {
  const delivery = legacyJob();
  mocks.createPlan.mockImplementation(async () => {
    Object.assign(db.row("project"), { status: "GENERATING", currentPlanId: "new-plan" });
    return plan;
  });

  await processWorkerJob(delivery);
  expect(mocks.legacyRefund).toHaveBeenCalledWith("legacy-plan-charge", expect.any(String));
  await processWorkerJob(delivery);

  expect(mocks.legacyRefund.mock.calls.map((call) => call[0])).toEqual(["legacy-plan-charge", "legacy-plan-charge"]);
  expect(db.row("project")).toMatchObject({ status: "GENERATING", currentPlanId: "new-plan" });
  expect(db.rows("planVersion")).toHaveLength(0);
});

it("does not refund a legacy plan another delivery already completed", async () => {
  const delivery = legacyJob();
  mocks.createPlan.mockImplementation(async () => {
    Object.assign(db.row("project"), { status: "PLAN_READY", currentPlanId: "winner-plan" });
    db.row("generationJob").status = "COMPLETED";
    return plan;
  });

  await processWorkerJob(delivery);

  expect(db.row("project")).toMatchObject({ status: "PLAN_READY", currentPlanId: "winner-plan" });
  expect(db.row("generationJob").status).toBe("COMPLETED");
  expect(mocks.legacyRefund).not.toHaveBeenCalled();
});

it("keeps an atomically published plan paid when later completion bookkeeping fails", async () => {
  db.prisma.generationJob.update.mockRejectedValueOnce(new Error("bookkeeping unavailable"));

  await processWorkerJob(job);
  await processWorkerJob(job);

  expect(db.row("project").status).toBe("PLAN_READY");
  expect(db.row("generationAttempt").status).toBe("SUCCEEDED");
  expect(mocks.createPlan).toHaveBeenCalledTimes(1);
  expect(mocks.refund).not.toHaveBeenCalled();
});

it("cannot publish over a paid attempt canceled while the provider was running", async () => {
  mocks.createPlan.mockImplementation(async () => {
    db.row("generationAttempt").status = "CANCELED";
    return plan;
  });

  await processWorkerJob(job);

  expect(db.rows("planVersion")).toHaveLength(0);
  expect(db.row("generationJob").status).toBe("CANCELED");
  expect(db.row("generationAttempt").status).toBe("CANCELED");
  expect(db.row("project").status).toBe("PLANNING");
});
