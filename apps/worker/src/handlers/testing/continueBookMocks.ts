import { vi } from "vitest";
import type { EditAdherenceVerdict } from "@book-maker/core";
import { dbScopeMocks } from "../../testing/dbScopeMocks.js";

/**
 * Module mocks and fixtures shared by the `continueBook*.test.ts` suites.
 *
 * This file keeps its runtime imports to `vitest` and the dependency-free
 * helpers under `src/testing`. Vitest calls the factories below from inside
 * `vi.mock(...)`, and reaching any module that transitively imports a mocked
 * module from there deadlocks the mock registry — which is why the fixtures
 * that need a constant off the mocked core barrel (`baseOperation`, the job
 * payloads) stay in the test file and are handed to `resetContinueBookMocks`.
 */

export const mocks = {
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
};

export const dbModuleMock = () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  ...dbScopeMocks()
});

export const dispatchModuleMock = () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile });

export const jobLifecycleModuleMock = () => ({ advanceJobStep: vi.fn() });

export const textEditLeaseModuleMock = () => {
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
};

export const continuationFollowUpModuleMock = () => ({
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
});

export const configModuleMock = () => ({ config: {} });

export const loggedAdaptersModuleMock = () => ({ createLoggedProviders: () => ({ text: {} }) });

export const bookHelpersModuleMock = () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  nextPlanVersion: mocks.nextPlanVersion,
  planInputSnapshot: (input: unknown) => input,
  strategyForInput: () => ({ generatePageDraft: mocks.generatePageDraft }),
  styleExcerptsForPage: mocks.styleExcerptsForPage,
  toPriorPageContext: (page: { index: number; title: string; summary: string; markdown?: string }) => ({
    index: page.index,
    title: page.title,
    summary: page.summary,
    markdown: page.markdown ?? ""
  })
});

export const generationContextModuleMock = () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
});

export const pageReviewModuleMock = () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage,
  revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
});

export const importBookSupportModuleMock = () => ({ importStyleProfileFromMediaSettings: () => null });

export const projectInputModuleMock = () => ({
  inputForPlanVersion: (_project: unknown, snapshot: unknown) => ({
    targetPages: (snapshot as { targetPages?: number })?.targetPages ?? 10,
    temperature: 0.7,
    language: "en",
    mediaSettings: {}
  })
});

export const qualitySettingsModuleMock = () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => mocks.qualityEnabled(feature)
  }),
  applyPlanThinkingBoost: vi.fn()
});

/** Spread over `vi.importActual("@book-maker/core")` by the test file's own factory. */
export const coreModuleOverrides = () => ({
  bookPlanSchema: { parse: (value: unknown) => value },
  createProviders: () => ({}),
  generateJsonWithRetry: mocks.generateJsonWithRetry,
  reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
});

export const basePlan = {
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
export const writtenContinuityNotes = (): Array<Record<string, unknown>> =>
  (mocks.tx.continuityNote.createMany.mock.calls as Array<[{ data: Array<Record<string, unknown>> }]>)
    .flatMap(([call]) => call.data);

export const appliedOperationUpdate = (): Record<string, unknown> | undefined =>
  (mocks.tx.bookEditOperation.update.mock.calls as Array<[{ data: Record<string, unknown> }]>).map(([call]) => call.data)
    .find((data) => data.status === "APPLIED");

export const REQUEST = "Add two more chapters";
export const GENERATION_JOB_ID = "generation-job-1";
export const adherenceVerdict = (overrides: Partial<EditAdherenceVerdict> = {}): EditAdherenceVerdict => ({
  basis: "reviewed", satisfied: true, confidence: 1,
  missingRequirements: [], contradictions: [], pageIndexesToRevise: [],
  ...overrides
});

export const baseProject = {
  id: "project-1",
  currentPlanId: "plan-base",
  targetPages: 10,
  title: "Book",
  language: "en",
  mediaSettings: {},
  status: "COMPLETE"
};

export function mockTransactions() {
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
}

export function trailingPage(index: number) {
  return { index, title: `Page ${index}`, markdown: "Text.", summary: `Summary ${index}.` };
}

export function projectUpdateData(): Array<Record<string, unknown>> {
  return [...mocks.prisma.project.update.mock.calls, ...mocks.tx.project.update.mock.calls].map(
    (call) => (call[0] as { data: Record<string, unknown> }).data
  );
}

export function revisionIncrementWrites(): Array<Record<string, unknown>> {
  return projectUpdateData().filter(
    (data) => (data.contentRevision as { increment?: number } | undefined)?.increment === 1
  );
}

/** The `beforeEach` every suite runs: a clean, ordinary two-page continuation on a ten-page book. */
export function resetContinueBookMocks(baseOperation: Record<string, unknown>) {
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
}
