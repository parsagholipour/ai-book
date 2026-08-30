import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  CONTINUATION_PUBLICATION_PROTOCOL_FIELD,
  PRE_EDIT_PROJECT_STATUS,
  type EditAdherenceVerdict
} from "@book-maker/core";
import { EDIT_ADHERENCE_FAILED } from "@book-maker/core/editFailure";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { update: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), findFirst: vi.fn() },
    chapter: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    $executeRawUnsafe: vi.fn(),
    bookEditOperation: { update: vi.fn(), findUnique: vi.fn() },
    generationJob: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    generationAttempt: { updateMany: vi.fn() },
    page: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    chapter: { deleteMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    character: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    location: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    embedding: { deleteMany: vi.fn() },
    project: { update: vi.fn() },
    planVersion: { update: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() }
  },
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  nextPlanVersion: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  generateJsonWithRetry: vi.fn(),
  generatePageDraft: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  revisePageDraftWithRestart: vi.fn(),
  reviewAppliedBookEdit: vi.fn(),
  waitForTextEditLease: vi.fn(),
  waitForTextEditLeaseCompletion: vi.fn(),
  assertTextEditLeaseTx: vi.fn(),
  completeTextEditLease: vi.fn(),
  startTextEditLeaseHeartbeat: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn(),
  continuationFollowUpCompletion: vi.fn(),
  qualityEnabled: vi.fn((_feature: string): boolean => false),
  styleExcerptsForPage: vi.fn(
    async (options: { quality: { enabled: (feature: string) => boolean } }): Promise<string[]> =>
      options.quality.enabled("styleExcerpts") ? ["opening-voice"] : []
  )
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../generation/textEditLease.js", () => {
  class TextEditLeaseLostError extends Error {}
  return {
    assertTextEditLeaseTx: mocks.assertTextEditLeaseTx,
    completeTextEditLease: mocks.completeTextEditLease,
    isTextEditLeaseLostError: (error: unknown) => error instanceof TextEditLeaseLostError,
    startTextEditLeaseHeartbeat: mocks.startTextEditLeaseHeartbeat,
    TextEditLeaseLostError,
    waitForTextEditLease: mocks.waitForTextEditLease,
    waitForTextEditLeaseCompletion: mocks.waitForTextEditLeaseCompletion
  };
});
vi.mock("../generation/continuationFollowUp.js", () => ({
  continuationFollowUpClassifier: (classifier: unknown, identity: Record<string, unknown>) => ({
    ...(classifier && typeof classifier === "object" ? classifier : {}),
    continuationFollowUp: {
      planVersionId: identity.planVersionId,
      publicationRevision: identity.publicationRevision,
      fallbackStatus: identity.fallbackStatus,
      completedSteps: []
    }
  }),
  continuationFollowUpIdentityFromClassifier: (
    classifier: { continuationFollowUp?: Record<string, unknown> } | null,
    scope: Record<string, unknown>
  ) => classifier?.continuationFollowUp
    ? { ...scope, ...classifier.continuationFollowUp }
    : null,
  continuationFollowUpCompletion: mocks.continuationFollowUpCompletion
}));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  nextPlanVersion: mocks.nextPlanVersion,
  planInputSnapshot: (input: unknown) => input,
  strategyForInput: () => ({ generatePageDraft: mocks.generatePageDraft }),
  styleExcerptsForPage: mocks.styleExcerptsForPage,
  toPriorPageContext: (page: { index: number; title: string; summary: string }) => ({
    index: page.index,
    title: page.title,
    summary: page.summary
  })
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/pageReview.js", () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage,
  revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
}));
vi.mock("./importBookSupport.js", () => ({ importStyleProfileFromMediaSettings: () => null }));
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: (_project: unknown, snapshot: unknown) => ({
    targetPages: (snapshot as { targetPages?: number })?.targetPages ?? 10,
    temperature: 0.7,
    language: "en",
    mediaSettings: {}
  })
}));
vi.mock("../generation/qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => mocks.qualityEnabled(feature)
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({}),
    generateJsonWithRetry: mocks.generateJsonWithRetry,
    reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
  };
});

import { continueBook } from "./continueBook.js";
import { LEGACY_CHARACTER_CONTEXT_PREFIX } from "../generation/editOperationContext.js";
import { TextEditLeaseLostError } from "../generation/textEditLease.js";

const basePlan = {
  premise: "A tale.",
  voiceGuide: "Warm.",
  characters: [],
  locations: [],
  promises: [],
  chapters: [
    { index: 1, title: "One", summary: "s1", targetPages: 5, keyBeats: [] },
    { index: 2, title: "Two", summary: "s2", targetPages: 5, keyBeats: [] }
  ]
};

/** Every continuity note the publication wrote, however many statements it took. */
const writtenContinuityNotes = (): Array<Record<string, unknown>> =>
  (mocks.tx.continuityNote.createMany.mock.calls as Array<[{ data: Array<Record<string, unknown>> }]>)
    .flatMap(([call]) => call.data);

const appliedOperationUpdate = (): Record<string, unknown> | undefined =>
  (mocks.tx.bookEditOperation.update.mock.calls as Array<[{ data: Record<string, unknown> }]>).map(([call]) => call.data)
    .find((data) => data.status === "APPLIED");

const REQUEST = "Add two more chapters";
const GENERATION_JOB_ID = "generation-job-1";
const adherenceVerdict = (overrides: Partial<EditAdherenceVerdict> = {}): EditAdherenceVerdict => ({
  basis: "reviewed", satisfied: true, confidence: 1,
  missingRequirements: [], contradictions: [], pageIndexesToRevise: [],
  ...overrides
});
// The columns the API writes before the job is dispatched. `projectId`, `kind`
// and the durable job link are what `continuationDeliveryProtocol` checks
// before this handler writes anything, and the classifier marker is what
// authorizes the atomic publication path.
const baseOperation = {
  id: "op-1",
  projectId: "project-1",
  kind: "CONTINUE_BOOK",
  generationJobId: GENERATION_JOB_ID,
  status: "ACTIVE",
  request: REQUEST,
  editInstruction: REQUEST,
  classifier: { [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL }
};

/** A continuation queued before the protocol marker and the instruction/canon split. */
const legacyOperation = { ...baseOperation, editInstruction: null, classifier: {} };

const jobData = (data: Record<string, unknown> = {}) => ({
  projectId: "project-1",
  generationJobId: GENERATION_JOB_ID,
  operationId: "op-1",
  request: REQUEST,
  planId: "plan-base",
  chapterCount: 1,
  newPageCount: 2,
  [PRE_EDIT_PROJECT_STATUS]: "COMPLETE",
  ...data
});

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    data: {
      [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
      ...jobData(data)
    }
  }) as unknown as Job;

/** The same delivery as it was enqueued before the protocol marker existed. */
const legacyJob = (data: Record<string, unknown> = {}) =>
  ({ id: "job-1", data: jobData(data) }) as unknown as Job;

const baseProject = {
  id: "project-1",
  currentPlanId: "plan-base",
  targetPages: 10,
  title: "Book",
  language: "en",
  mediaSettings: {},
  status: "COMPLETE"
};

function mockTransactions() {
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
}

function trailingPage(index: number) {
  return { index, title: `Page ${index}`, markdown: "Text.", summary: `Summary ${index}.` };
}

function projectUpdateData(): Array<Record<string, unknown>> {
  return [...mocks.prisma.project.update.mock.calls, ...mocks.tx.project.update.mock.calls].map(
    (call) => (call[0] as { data: Record<string, unknown> }).data
  );
}

function revisionIncrementWrites(): Array<Record<string, unknown>> {
  return projectUpdateData().filter(
    (data) => (data.contentRevision as { increment?: number } | undefined)?.increment === 1
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.qualityEnabled.mockReturnValue(false);
  mockTransactions();
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...baseOperation });
  mocks.prisma.bookEditOperation.update.mockResolvedValue({});
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "draft" });
  mocks.waitForTextEditLeaseCompletion.mockResolvedValue("completed");
  mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "ACTIVE", classifier: {} });
  mocks.completeTextEditLease.mockResolvedValue(true);
  mocks.startTextEditLeaseHeartbeat.mockReturnValue({
    assertHeld: mocks.heartbeatAssertHeld,
    stop: mocks.heartbeatStop
  });
  mocks.heartbeatAssertHeld.mockResolvedValue(undefined);
  mocks.heartbeatStop.mockResolvedValue(undefined);
  mocks.getProjectOrThrow.mockResolvedValue(baseProject);
  mocks.prisma.planVersion.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "plan-base"
      ? { id: "plan-base", inputSnapshot: { targetPages: 10 }, planningPackage: basePlan }
      : where.id === "plan-stranded"
        ? { id: "plan-stranded", messages: [{ role: "user", content: `Continue the book: ${REQUEST}` }] }
        : null
  );
  // No stranded rows unless a test says otherwise.
  mocks.prisma.chapter.findMany.mockResolvedValue([]);
  mocks.prisma.page.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where.chapterId) {
      return [{ index: 11 }, { index: 12 }];
    }
    if (args.where.status === "COMPLETED" && !args.where.index) {
      return [trailingPage(10), trailingPage(9)];
    }
    return [];
  });
  mocks.prisma.page.findFirst.mockResolvedValue({ index: 10 });
  mocks.prisma.chapter.findFirst.mockResolvedValue({ index: 2 });
  mocks.prisma.chapter.findUnique.mockResolvedValue({ id: "ch-new" });
  mocks.prisma.chapter.update.mockResolvedValue({});
  mocks.generateJsonWithRetry.mockResolvedValue({
    data: { chapters: [{ title: "New chapter", summary: "Fresh.", keyBeats: [] }] }
  });
  mocks.nextPlanVersion.mockResolvedValue(4);
  mocks.tx.planVersion.create.mockResolvedValue({ id: "plan-new" });
  mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ publicationRevision: 1, classifier: {} });
  mocks.tx.generationJob.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.generationJob.findUnique.mockResolvedValue({ steps: null });
  mocks.tx.generationJob.update.mockResolvedValue({});
  mocks.tx.generationAttempt.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.project.update.mockImplementation(async (args: { select?: { currentPlanId?: boolean; contentRevision?: boolean } }) =>
    args.select?.currentPlanId
      ? { currentPlanId: "plan-new" }
      : args.select?.contentRevision
        ? { contentRevision: 1 }
        : {}
  );
  mocks.tx.chapter.create.mockResolvedValue({ id: "ch-new" });
  mocks.tx.$executeRawUnsafe.mockResolvedValue(1);
  mocks.tx.character.findMany.mockResolvedValue([]);
  mocks.tx.location.findMany.mockResolvedValue([]);
  mocks.tx.page.findMany.mockImplementation(async ({ where }: { where: { index: { in: number[] } } }) =>
    where.index.in.map((index) => ({ id: `new-page-${index}`, index }))
  );
  mocks.generatePageDraft.mockResolvedValue({ title: "Draft", markdown: "Draft text.", summary: "Draft summary." });
  mocks.reviewAndSaveGeneratedPage.mockImplementation(
    async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => {
      const candidate = {
        draft: { ...draft, continuityNotes: [] },
        qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
      };
      return {
        page: {
        index: draft.index,
        title: `Page ${draft.index}`,
        markdown: "Saved.",
        summary: `Saved ${draft.index}.`
        },
        candidate
      };
    }
  );
  mocks.reviewAppliedBookEdit.mockResolvedValue(adherenceVerdict());
  mocks.revisePageDraftWithRestart.mockImplementation(
    async ({ reviseOptions }: { reviseOptions: { draft: Record<string, unknown> } }) => ({
      ...reviseOptions.draft,
      markdown: "Repaired continuation."
    })
  );
  mocks.invalidateProjectExports.mockResolvedValue(undefined);
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  mocks.continuationFollowUpCompletion.mockImplementation(
    (identity: { projectId: string; planVersionId: string }) => ({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: async () => {
        await mocks.invalidateProjectExports(identity.projectId);
        await mocks.maybeEnqueueCompile(identity.projectId, identity.planVersionId);
      }
    })
  );
});

describe("continueBook redelivery fence", () => {
  it("cleans a crashed delivery's stranded append instead of appending on top", async () => {
    // A mid-run crash left: the continuation plan installed as current, an
    // appended chapter 3 with pages 11-12, and targetPages inflated to 12.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...legacyOperation });
    mocks.getProjectOrThrow
      .mockResolvedValueOnce({ ...baseProject, currentPlanId: "plan-stranded", targetPages: 12 })
      .mockResolvedValue(baseProject);
    mocks.prisma.chapter.findMany.mockResolvedValue([{ id: "ch-stranded" }]);

    await continueBook(legacyJob());

    // The stranded rows are removed against the payload's pre-continuation
    // plan boundary (chapter 2), and the base plan is restored as current.
    expect(mocks.tx.page.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", chapterId: { in: ["ch-stranded"] } }
    });
    expect(mocks.tx.chapter.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", index: { gt: 2 } }
    });
    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { currentPlanId: "plan-base", targetPages: 10 }
    });
    expect(mocks.tx.planVersion.deleteMany).toHaveBeenCalledWith({
      where: { id: "plan-stranded", projectId: "project-1" }
    });

    // The rebuilt continuation starts at the ORIGINAL boundary: pages 11-12
    // again, not 13-14 stacked on the stranded copy.
    const createdPages = mocks.tx.page.createMany.mock.calls[0]?.[0] as {
      data: Array<{ index: number }>;
    };
    expect(createdPages.data.map((page) => page.index)).toEqual([11, 12]);
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED", affectedPageIndexes: [11, 12] }) })
    );
  });

  it("appends normally when no stranded rows exist", async () => {
    await continueBook(job());

    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.planVersion.deleteMany).not.toHaveBeenCalled();
    const createdPages = mocks.tx.page.createMany.mock.calls[0]?.[0] as {
      data: Array<{ index: number }>;
    };
    expect(createdPages.data.map((page) => page.index)).toEqual([11, 12]);
  });

  it("appends continuity memory to the new pages without deleting existing book memory", async () => {
    mocks.reviewAndSaveGeneratedPage.mockImplementation(
      async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => ({
        page: draft,
        candidate: {
          draft: { ...draft, continuityNotes: [`Appended fact ${draft.index}.`] },
          qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
        }
      })
    );

    await continueBook(job());

    // Over the notes rather than the statements: `persistPreparedDeferredPageMemory`
    // is free to batch the appended pages' notes into one `createMany`, and what
    // this test is about is that each one is bound to its new page id.
    expect(writtenContinuityNotes()).toEqual([
      expect.objectContaining({ pageId: "new-page-11", body: "Appended fact 11." }),
      expect.objectContaining({ pageId: "new-page-12", body: "Appended fact 12." })
    ]);
    expect(mocks.tx.embedding.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses to guess when chapters past the plan belong to no known continuation", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...legacyOperation });
    mocks.getProjectOrThrow.mockResolvedValue({ ...baseProject, currentPlanId: "plan-mystery" });
    mocks.prisma.chapter.findMany.mockResolvedValue([{ id: "ch-stranded" }]);
    mocks.prisma.planVersion.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "plan-base"
        ? { id: "plan-base", inputSnapshot: { targetPages: 10 }, planningPackage: basePlan }
        : { id: "plan-mystery", messages: [{ role: "user", content: "Something else" }] }
    );

    await expect(continueBook(legacyJob())).rejects.toThrow("does not own");
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.page.createMany).not.toHaveBeenCalled();
  });

  it("re-owns a pre-separation stranded append recorded under the composed request", async () => {
    // Before the instruction/canon split the payload's `request` carried the
    // mentioned characters' sheets, and the crashed delivery wrote its plan
    // message from that composed string. Reading the marker off the separated
    // instruction alone left those chapters orphaned for good.
    const composedRequest = `${REQUEST}\n\n${LEGACY_CHARACTER_CONTEXT_PREFIX}\n- Mara: a careful navigator`;
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...legacyOperation });
    mocks.getProjectOrThrow
      .mockResolvedValueOnce({ ...baseProject, currentPlanId: "plan-stranded", targetPages: 12 })
      .mockResolvedValue(baseProject);
    mocks.prisma.chapter.findMany.mockResolvedValue([{ id: "ch-stranded" }]);
    mocks.prisma.planVersion.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "plan-base"
        ? { id: "plan-base", inputSnapshot: { targetPages: 10 }, planningPackage: basePlan }
        : { id: "plan-stranded", messages: [{ role: "user", content: `Continue the book: ${composedRequest}` }] }
    );

    await continueBook(legacyJob({ request: composedRequest }));

    expect(mocks.tx.page.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", chapterId: { in: ["ch-stranded"] } }
    });
    expect(mocks.tx.planVersion.deleteMany).toHaveBeenCalledWith({
      where: { id: "plan-stranded", projectId: "project-1" }
    });
    // The sheets stay out of the approved instruction the rebuild is written to.
    expect(mocks.generatePageDraft.mock.calls[0]![0]).toMatchObject({ editInstruction: REQUEST });
  });

  it("refuses to clean up after a crash when the delivery is protocol-marked", async () => {
    // A marked delivery keeps every candidate in memory until one publication
    // transaction, so durable pre-publication manuscript state is not its own
    // half-written append and may not be deleted on that assumption.
    mocks.getProjectOrThrow.mockResolvedValue({ ...baseProject, currentPlanId: "plan-stranded", targetPages: 12 });
    mocks.prisma.chapter.findMany.mockResolvedValue([{ id: "ch-stranded" }]);

    await expect(continueBook(job())).rejects.toThrow("pre-publication manuscript state");
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.planVersion.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.page.createMany).not.toHaveBeenCalled();
  });

  it("replays only the success tail when the operation is already APPLIED", async () => {
    // The append finished and the crash landed before the durable COMPLETED
    // write: the book already contains the continuation, so a second append
    // would deliver it twice.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...baseOperation, status: "APPLIED" });
    mocks.getProjectOrThrow.mockResolvedValue({ ...baseProject, currentPlanId: "plan-new" });
    mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "tail" });
    mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: {} });

    const completion = await continueBook(job({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }));

    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { contentRevision: { increment: 0 } },
      select: { currentPlanId: true, contentRevision: true }
    });
    expect(revisionIncrementWrites()).toHaveLength(0);
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    // Nothing is outlined, appended, or re-marked ACTIVE.
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();

    await completion.afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-new");
  });
});

describe("continueBook completion lifecycle", () => {
  it("publishes a large continuation atomically within the manuscript transaction budget", async () => {
    const newPageCount = 120;

    await continueBook(job({ newPageCount }));

    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30_000, maxWait: 10_000 }
    );
    expect(mocks.tx.page.createMany).toHaveBeenCalledTimes(1);
    expect((mocks.tx.page.createMany.mock.calls[0]![0] as { data: unknown[] }).data).toHaveLength(newPageCount);
    expect(mocks.tx.generationJob.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.page.createMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.assertTextEditLeaseTx.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mocks.tx.page.createMany.mock.invocationCallOrder[0]!
    );
    expect(revisionIncrementWrites()).toHaveLength(1);
    // Stamped in the same transaction as the bump: no reader sees the new revision unbarriered.
    expect(mocks.tx.project.update).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { exportInvalidationRevision: 1 } });
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          classifier: expect.objectContaining({
            continuationFollowUp: expect.objectContaining({
              planVersionId: "plan-new",
              publicationRevision: 1,
              fallbackStatus: "COMPLETE",
              completedSteps: []
            })
          })
        })
      })
    );
  });

  it.each(["COMPLETE", "REVIEW_REQUIRED"] as const)(
    "keeps a %s origin behind EDITING until the replayable export tail runs",
    async (origin) => {
      const completion = await continueBook(job({ [PRE_EDIT_PROJECT_STATUS]: origin }));

      expect(projectUpdateData()).toContainEqual(
        expect.objectContaining({ status: "EDITING", contentRevision: { increment: 1 } })
      );
      expect(revisionIncrementWrites()).toHaveLength(1);
      expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
      expect(completion.afterJobCompleted).toEqual(expect.any(Function));
      expect(completion.retryFollowUpOnRedelivery).toBe(true);
      expect(mocks.completeTextEditLease).not.toHaveBeenCalled();

      await completion.afterJobCompleted?.();

      expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
      expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-new");
    }
  );

  it("does not roll back an applied continuation when the post-completion enqueue fails", async () => {
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));

    const completion = await continueBook(job());

    await expect(completion.afterJobCompleted?.()).rejects.toThrow("queue unavailable");
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.chapter.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1" },
        data: expect.objectContaining({
          status: "APPLIED",
          affectedPageIndexes: [11, 12],
          appliedAt: expect.any(Date)
        })
      })
    );
    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        currentPlanId: "plan-new",
        targetPages: 12,
        status: "EDITING",
        contentRevision: { increment: 1 }
      },
      select: { contentRevision: true }
    });
    expect(revisionIncrementWrites()).toHaveLength(1);
  });

  it("replays APPLIED delivery without appending or incrementing the revision again", async () => {
    await continueBook(job({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }));
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...baseOperation, status: "APPLIED" });
    mocks.getProjectOrThrow.mockResolvedValue({ ...baseProject, currentPlanId: "plan-new" });
    mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "tail" });
    mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: {} });

    const replay = await continueBook(job({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }));

    expect(mocks.tx.page.createMany).toHaveBeenCalledTimes(1);
    expect(revisionIncrementWrites()).toHaveLength(1);
    expect(projectUpdateData()).toContainEqual(expect.objectContaining({ status: "EDITING" }));
    expect(replay.afterJobCompleted).toEqual(expect.any(Function));
  });

  // Only `publishContinuation` settles the durable job and the paid attempt
  // inside the manuscript transaction, so only its own checkpoint proves that
  // settlement happened. A continuation published by the pre-checkpoint worker
  // marked the operation APPLIED and nothing else: claiming its lifecycle skips
  // the one call that ever completes its GenerationJob and succeeds its
  // GenerationAttempt, so the project reads busy for good and the next Stop
  // refunds a delivered continuation.
  it.each<[string, Record<string, unknown>, boolean]>([
    ["a pre-checkpoint APPLIED continuation", {}, false],
    [
      "its own checkpointed publication",
      { continuationFollowUp: { planVersionId: "plan-new", publicationRevision: 3, fallbackStatus: "COMPLETE", completedSteps: [] } },
      true
    ]
  ])("claims the committed lifecycle only for %s", async (_case, classifier, durableCompletionCommitted) => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...baseOperation, status: "APPLIED" });
    mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "tail" });
    mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "APPLIED", classifier });

    await continueBook(job({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }));

    expect(mocks.continuationFollowUpCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ planVersionId: "plan-new" }),
      expect.any(String),
      { durableCompletionCommitted }
    );
  });
});

describe("continueBook compensation", () => {
  it("does not flip an operation that never reached APPLIED", async () => {
    mocks.reviewAndSaveGeneratedPage.mockRejectedValue(new Error("model outage"));

    await expect(continueBook(job())).rejects.toThrow("model outage");

    expect(mocks.prisma.bookEditOperation.updateMany).not.toHaveBeenCalled();
  });
});

describe("continueBook delivery lease", () => {
  it("publishes nothing when cancellation owns the durable job before the final transaction", async () => {
    mocks.tx.generationJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(continueBook(job())).resolves.toEqual({});

    expect(mocks.tx.planVersion.create).not.toHaveBeenCalled();
    expect(mocks.tx.chapter.create).not.toHaveBeenCalled();
    expect(mocks.tx.page.createMany).not.toHaveBeenCalled();
    expect(mocks.tx.bookEditOperation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("op-1");
  });

  it("stands down without durable staging when the heartbeat reports lease loss during generation", async () => {
    mocks.heartbeatAssertHeld.mockRejectedValueOnce(new TextEditLeaseLostError());

    await expect(continueBook(job())).resolves.toEqual({});

    expect(mocks.tx.planVersion.create).not.toHaveBeenCalled();
    expect(mocks.tx.page.createMany).not.toHaveBeenCalled();
    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("op-1");
    expect(mocks.heartbeatStop).toHaveBeenCalledTimes(1);
  });

  it("lets one competing delivery publish while the completed-lease loser does no work", async () => {
    const winner = await continueBook(job());
    const providerCalls = mocks.generatePageDraft.mock.calls.length;
    const publicationCalls = mocks.tx.page.createMany.mock.calls.length;
    mocks.waitForTextEditLease.mockResolvedValue({ outcome: "completed" });

    const loser = await continueBook(job());

    expect(winner.afterJobCompleted).toEqual(expect.any(Function));
    expect(loser).toEqual({});
    expect(mocks.generatePageDraft).toHaveBeenCalledTimes(providerCalls);
    expect(mocks.tx.page.createMany).toHaveBeenCalledTimes(publicationCalls);
  });

  it("gives one APPLIED-tail claimant the replay while its completed loser runs no callback", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ ...baseOperation, status: "APPLIED" });
    mocks.waitForTextEditLease
      .mockResolvedValueOnce({ outcome: "acquired", phase: "tail" })
      .mockResolvedValueOnce({ outcome: "completed" });
    mocks.assertTextEditLeaseTx.mockResolvedValue({
      status: "APPLIED",
      classifier: {
        continuationFollowUp: {
          planVersionId: "plan-new",
          publicationRevision: 1,
          fallbackStatus: "COMPLETE",
          completedSteps: []
        }
      }
    });

    const winner = await continueBook(job());
    const loser = await continueBook(job());

    expect(winner).toMatchObject({
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: expect.any(Function)
    });
    expect(loser).toEqual({});
    expect(mocks.continuationFollowUpCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
  });

  it("asserts and renews ownership around long provider-backed drafting", async () => {
    let releaseDraft: ((draft: { title: string; markdown: string; summary: string }) => void) | undefined;
    mocks.generatePageDraft.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseDraft = resolve;
      })
    );
    const running = continueBook(job());
    await vi.waitFor(() => expect(mocks.generatePageDraft).toHaveBeenCalledTimes(1));

    expect(mocks.startTextEditLeaseHeartbeat).toHaveBeenCalledWith("op-1", expect.any(String));
    expect(mocks.heartbeatStop).not.toHaveBeenCalled();
    releaseDraft?.({ title: "Draft", markdown: "Draft text.", summary: "Draft summary." });
    await running;

    expect(mocks.heartbeatAssertHeld.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.generatePageDraft.mock.invocationCallOrder[0]!
    );
    expect(mocks.heartbeatAssertHeld.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mocks.tx.generationJob.updateMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.heartbeatAssertHeld.mock.calls.length).toBeGreaterThan(4);
    expect(mocks.heartbeatStop).toHaveBeenCalledTimes(1);
  });
});

describe("continueBook style excerpts", () => {
  it("passes the style lock into the page draft when the excerpts gate is on", async () => {
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleExcerpts");

    await continueBook(job());

    expect(mocks.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ styleExcerpts: ["opening-voice"] })
    );
  });

  it("omits style excerpts from the page draft when the gate is off", async () => {
    await continueBook(job());

    expect(mocks.generatePageDraft.mock.calls[0]![0]).not.toHaveProperty("styleExcerpts");
  });
});

describe("continueBook instruction adherence", () => {
  it("keeps the durable instruction authoritative through outline, drafting, and whole-set review", async () => {
    const durable = "Add one chapter in which Mara finds the red key and refuses to use it.";
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      ...baseOperation,
      request: "add more",
      editInstruction: durable,
      characterContext: "Mentioned character profiles:\n- Mara: a careful navigator"
    });

    await continueBook(job({ editInstruction: "stale queue instruction", request: "add more" }));

    const outlinePayload = JSON.parse(
      (mocks.generateJsonWithRetry.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[1]!.content
    ) as Record<string, unknown>;
    expect(outlinePayload).toMatchObject({
      approvedEditInstruction: durable,
      originalRequestContext: "add more",
      characterContext: expect.stringContaining("careful navigator")
    });
    for (const call of mocks.generatePageDraft.mock.calls) {
      expect(call[0]).toMatchObject({
        editInstruction: durable,
        characterContext: expect.stringContaining("careful navigator")
      });
    }
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: durable, beforePages: [], afterPages: expect.arrayContaining([]) })
    );
    expect((mocks.reviewAppliedBookEdit.mock.calls[0]![0] as { afterPages: unknown[] }).afterPages).toHaveLength(2);
    expect(JSON.stringify(mocks.reviewAppliedBookEdit.mock.calls[0]![0])).not.toContain("careful navigator");
  });

  it("repairs only reviewer-flagged pages and passes concrete omissions into the retry", async () => {
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce(adherenceVerdict({
        satisfied: false,
        confidence: 0.8,
        missingRequirements: ["Mara must refuse to use the key."],
        pageIndexesToRevise: [11]
      }))
      .mockResolvedValue(adherenceVerdict());

    await continueBook(job());

    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledTimes(1);
    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "Continuation page 11",
        reviseOptions: expect.objectContaining({
          editInstruction: REQUEST,
          adherenceRepair: ["Mara must refuse to use the key."]
        })
      })
    );
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(2);
  });

  it("publishes with an unverified audit when the adherence review never ran", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue(adherenceVerdict({
      basis: "unverified",
      satisfied: false,
      confidence: 0,
      missingRequirements: ["The complete edit could not be verified against the approved instruction."],
      pageIndexesToRevise: [11, 12]
    }));

    await continueBook(job());

    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.tx.page.createMany).toHaveBeenCalled();
    expect(appliedOperationUpdate()).toMatchObject({
      adherenceAudit: { attempts: 3, verdict: { basis: "unverified", satisfied: false } }
    });
  });

  it("publishes a continuation page the reviewer never approved as FAILED_QA", async () => {
    // Page QA is not the adherence gate. The reader paid for these chapters and
    // received them; one page the reviewer would not pass is flagged for the
    // recompile's repair pass, not a refund of the whole continuation.
    mocks.reviewAndSaveGeneratedPage.mockImplementation(
      async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => ({
        page: { index: draft.index, title: `Page ${draft.index}`, markdown: "Saved.", summary: `Saved ${draft.index}.` },
        candidate: {
          draft: { ...draft, continuityNotes: [] },
          qualityReport:
            draft.index === 12
              ? { approved: false, score: 44, issues: ["Repeats page 11."], requiredRevisions: [], notes: "" }
              : { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
        }
      })
    );
    mocks.reviewAppliedBookEdit.mockResolvedValue(adherenceVerdict());

    await continueBook(job());

    const createdPages = mocks.tx.page.createMany.mock.calls[0]?.[0] as {
      data: Array<{ index: number; status: string }>;
    };
    expect(createdPages.data.map((page) => [page.index, page.status])).toEqual([
      [11, "COMPLETED"],
      [12, "FAILED_QA"]
    ]);
    expect(appliedOperationUpdate()).toMatchObject({ adherenceAudit: { proseApproved: false } });
  });

  it("rolls the append back and never reaches APPLIED after three rejected candidates", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue(adherenceVerdict({
      satisfied: false,
      confidence: 0.9,
      missingRequirements: ["The red key is absent."],
      pageIndexesToRevise: [11]
    }));

    await expect(continueBook(job())).rejects.toThrow(EDIT_ADHERENCE_FAILED);

    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.page.createMany).not.toHaveBeenCalled();
    expect(appliedOperationUpdate()).toBeUndefined();
  });
});
