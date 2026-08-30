import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a published replan owes the book *besides* its prose: the illustrations
 * its charge priced, one story extract per page rather than two, and a chapter
 * brief repair that reaches the pages briefed from the same setup.
 *
 * `replanEditCandidates.test.ts` is the adherence/publication/ownership suite
 * over the same entry point; these tests share its harness and nothing else.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn() },
    page: { findMany: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    $executeRawUnsafe: vi.fn(),
    bookEditOperation: { update: vi.fn() },
    generationJob: { updateMany: vi.fn(), findUnique: vi.fn() },
    generationAttempt: { updateMany: vi.fn() },
    imageAsset: { deleteMany: vi.fn() },
    page: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    chapter: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    continuityNote: { deleteMany: vi.fn(), createMany: vi.fn() },
    embedding: { deleteMany: vi.fn() },
    character: { deleteMany: vi.fn(), createMany: vi.fn() },
    location: { deleteMany: vi.fn(), createMany: vi.fn() },
    researchSource: { deleteMany: vi.fn(), createMany: vi.fn() },
    planVersion: { updateMany: vi.fn(), update: vi.fn() },
    project: { update: vi.fn() }
  },
  invalidateProjectExports: vi.fn(),
  prepareChapterSetups: vi.fn(),
  ensureCharacterReferenceAssets: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  revisePageDraftWithRestart: vi.fn(),
  reviewAppliedBookEdit: vi.fn(),
  extractStoryState: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  maybeEnqueueCover: vi.fn(),
  enqueueReplanIllustrations: vi.fn(),
  generatePageDraft: vi.fn(),
  waitForReplanEditLease: vi.fn(),
  completeReplanEditLease: vi.fn(),
  releaseReplanEditTailLease: vi.fn(),
  assertReplanEditLeaseTx: vi.fn(),
  startReplanEditLeaseHeartbeat: vi.fn(),
  advanceJobStep: vi.fn(),
  qualityFeatures: new Set<string>()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  PAGE_SCOPE_PREFIX: "page:",
  pageScope: (index: number) => `page:${index}`
}));
vi.mock("./bookHelpers.js", () => ({
  invalidateProjectExports: mocks.invalidateProjectExports,
  planMediaSettingsSnapshot: (input: { mediaSettings: unknown }) => input.mediaSettings,
  styleExcerptsForPage: async () => [],
  toPriorPageContext: (page: unknown) => page
}));
vi.mock("./bookState.js", () => ({ prepareChapterSetups: mocks.prepareChapterSetups }));
vi.mock("./characterReferences.js", () => ({
  ensureCharacterReferenceAssets: mocks.ensureCharacterReferenceAssets
}));
vi.mock("./generationContext.js", () => ({
  chapterSetupForPage: (setups: Array<{ startPage: number; endPage: number }>, index: number) =>
    setups.find((setup) => setup.startPage <= index && setup.endPage >= index),
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("./pageReview.js", () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage,
  revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    enabled: (feature: string) => mocks.qualityFeatures.has(feature),
    settings: {},
    tier: "balanced"
  })
}));
vi.mock("./replanEditLease.js", () => {
  class ReplanEditLeaseLostError extends Error {}
  return {
    assertReplanEditLeaseTx: mocks.assertReplanEditLeaseTx,
    completeReplanEditLease: mocks.completeReplanEditLease,
    releaseReplanEditTailLease: mocks.releaseReplanEditTailLease,
    isReplanEditLeaseLostError: (error: unknown) => error instanceof ReplanEditLeaseLostError,
    ReplanEditLeaseLostError,
    startReplanEditLeaseHeartbeat: mocks.startReplanEditLeaseHeartbeat,
    startReplanEditTailLeaseHeartbeat: mocks.startReplanEditLeaseHeartbeat,
    waitForReplanEditLease: mocks.waitForReplanEditLease,
    waitForReplanEditLeaseCompletion: async () => "completed"
  };
});
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  maybeEnqueueCover: mocks.maybeEnqueueCover
}));
vi.mock("./replanCoverDispatch.js", () => ({
  maybeEnqueueRevisionOwnedReplanCover: mocks.maybeEnqueueCover
}));
vi.mock("./replanPageIllustrationDispatch.js", () => ({
  enqueueRevisionOwnedReplanIllustrations: mocks.enqueueReplanIllustrations
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: mocks.advanceJobStep }));
vi.mock("@book-maker/core", async () => ({
  ...(await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core")),
  extractStoryState: mocks.extractStoryState,
  reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
}));

import { generateReplannedBook } from "./replanEditCandidates.js";

const instruction = "Rewrite the whole book so Mara finds a red key and refuses to use it.";
const chapterBrief = { pages: [] };
const plan = {
  title: "Revised",
  chapters: [{ index: 1, title: "One", summary: "Chapter", targetPages: 2, keyBeats: [] }],
  characters: [],
  locations: [],
  researchNotes: [],
  promises: []
};
const input = {
  prompt: "Original prompt",
  category: "STORY",
  targetPages: 2,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {}
};
const sourcePages = [1, 2].map((index) => ({
  id: `old-${index}`,
  index,
  title: `Old ${index}`,
  markdown: `Old prose ${index}.`,
  summary: `Old summary ${index}.`,
  imagePrompt: null,
  revision: 1
}));
const storyExtract = {
  storyDelta: {
    promisesOpened: [],
    promisesPaid: [],
    promisesBroken: [],
    factsAdded: ["Mara found the red key."],
    entities: {},
    unansweredAdded: [],
    unansweredResolved: []
  },
  contradictions: []
};
let leaseStatus = "ACTIVE";
let operationClassifier: Record<string, unknown> = {};

const options = () => ({
  projectId: "project-1",
  planId: "plan-new",
  operationId: "operation-1",
  input: input as never,
  plan: plan as never,
  providers: { text: {} } as never,
  strategy: { id: "standard", generatePageDraft: mocks.generatePageDraft } as never,
  generationJobId: "generation-1",
  attemptId: "attempt-1"
});

const approvedCandidate = async ({ draft }: { draft: { index: number } }) => ({
  page: draft,
  candidate: { draft, qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" } }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.qualityFeatures.clear();
  leaseStatus = "ACTIVE";
  operationClassifier = {};
  mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => ({
    id: "operation-1",
    projectId: "project-source",
    sourceProjectId: "project-source",
    status: "ACTIVE",
    request: "stale contextual request",
    editInstruction: instruction,
    classifier: operationClassifier
  }));
  mocks.prisma.page.findMany.mockResolvedValue(sourcePages);
  mocks.prepareChapterSetups.mockResolvedValue([
    { chapter: plan.chapters[0], startPage: 1, endPage: 2, brief: chapterBrief }
  ]);
  mocks.generatePageDraft.mockImplementation(async ({ pageIndex }: { pageIndex: number }) => ({
    title: `New ${pageIndex}`,
    markdown: `New prose ${pageIndex}.`,
    summary: `New summary ${pageIndex}.`,
    continuityNotes: []
  }));
  mocks.reviewAndSaveGeneratedPage.mockImplementation(approvedCandidate);
  mocks.revisePageDraftWithRestart.mockImplementation(
    async ({ reviseOptions }: { reviseOptions: { draft: Record<string, unknown> } }) => ({
      ...reviseOptions.draft,
      markdown: "Repaired prose."
    })
  );
  mocks.reviewAppliedBookEdit.mockResolvedValue({
    satisfied: true,
    confidence: 1,
    missingRequirements: [],
    contradictions: [],
    pageIndexesToRevise: []
  });
  mocks.extractStoryState.mockResolvedValue(storyExtract);
  mocks.tx.$executeRawUnsafe.mockResolvedValue(1);
  mocks.tx.chapter.createMany.mockResolvedValue({ count: 1 });
  mocks.tx.chapter.findMany.mockResolvedValue([{ id: "chapter-new", index: 1 }]);
  mocks.tx.page.findMany.mockImplementation(async ({ where }: { where: { index: { in: number[] } } }) =>
    where.index.in.map((index) => ({ id: `new-page-${index}`, index }))
  );
  mocks.tx.generationJob.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.generationJob.findUnique.mockResolvedValue({ steps: [] });
  mocks.tx.generationAttempt.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.project.update.mockImplementation(async ({ select }: { select?: { mediaSettings?: boolean } }) =>
    select?.mediaSettings
      ? { mediaSettings: {} }
      : { contentRevision: 5, currentPlanId: "plan-new", status: "EDITING" }
  );
  mocks.tx.bookEditOperation.update.mockImplementation(
    async ({ data }: { data: { status?: string; classifier?: unknown } }) => {
      if (data.status === "APPLIED") leaseStatus = "APPLIED";
      if (data.classifier && typeof data.classifier === "object") {
        operationClassifier = data.classifier as Record<string, unknown>;
      }
      return {};
    }
  );
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
  mocks.waitForReplanEditLease.mockResolvedValue({ outcome: "acquired", phase: "draft" });
  mocks.completeReplanEditLease.mockResolvedValue(true);
  mocks.releaseReplanEditTailLease.mockResolvedValue(true);
  mocks.assertReplanEditLeaseTx.mockImplementation(async () => ({
    status: leaseStatus,
    classifier: operationClassifier
  }));
  mocks.startReplanEditLeaseHeartbeat.mockReturnValue({
    assertHeld: async () => undefined,
    stop: async () => undefined
  });
});

/**
 * A replan is priced as a whole book, images included, and its publication
 * deletes every `ImageAsset` the old manuscript owned. The deferred review
 * returns before `publishStagedGeneratedPage`, the only per-page image enqueue
 * in the codebase, so the delivery tail owes the book its pictures.
 */
describe("replanned book delivery tail", () => {
  it("stamps the export barrier in the same transaction as the revision bump", async () => {
    // No reader sees the new revision unbarriered, so a compile claiming it
    // stands down for the whole gap between this commit and the tail's unlink.
    await generateReplannedBook(options());

    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { exportInvalidationRevision: 5 }
    });
  });

  it("queues this publication's page illustrations ahead of the follow-up's own steps", async () => {
    const completion = await generateReplannedBook(options());
    expect(mocks.enqueueReplanIllustrations).not.toHaveBeenCalled();

    await completion.afterJobCompleted?.();

    expect(mocks.enqueueReplanIllustrations).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        planVersionId: "plan-new",
        publicationRevision: 5,
        input,
        plan,
        strategy: expect.objectContaining({ id: "standard" }),
        // The tail lease's own fence: this loop is one queue round trip per
        // illustrated page and runs between two heartbeats, neither of which
        // covers it.
        assertLease: expect.any(Function)
      })
    );
    // Before the compile step, so it sees those jobs open and waits for them
    // instead of exporting a book whose pictures are still being drawn.
    expect(mocks.enqueueReplanIllustrations.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.maybeEnqueueCompile.mock.invocationCallOrder[0]!
    );
  });

  /**
   * Being in front of the follow-up puts this loop outside the one heartbeat and
   * the one catch that the tail has. A queue outage part way through therefore
   * used to escape with the lease still held and nothing renewing it: no release,
   * no log, and every rival delivery waiting out the full TTL while the exports
   * stayed retired and neither the cover nor the compile was ever queued.
   */
  it("releases the tail lease when the illustration dispatch fails, under a heartbeat of its own", async () => {
    const heartbeat = { assertHeld: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    mocks.startReplanEditLeaseHeartbeat.mockReturnValue(heartbeat);
    mocks.enqueueReplanIllustrations.mockRejectedValueOnce(new Error("queue unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const completion = await generateReplannedBook(options());
    await expect(completion.afterJobCompleted?.()).rejects.toThrow("queue unavailable");

    expect(mocks.releaseReplanEditTailLease).toHaveBeenCalledTimes(1);
    expect(heartbeat.stop).toHaveBeenCalled();
    // The publication stands; only the tail is handed back for a redelivery to
    // retry from its first missing step.
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.completeReplanEditLease).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("illustration dispatch failed"),
      expect.objectContaining({ event: "generation.replan_illustration_dispatch_failed" })
    );
    logged.mockRestore();
  });
});

/**
 * `reviewAppliedBookEdit` spells a provider failure exactly like a verdict: its
 * catch returns one generic requirement over every changed page. Read as a
 * repair instruction, one blip bought two full redraft rounds of the whole book
 * and a refund anyway.
 */
describe("replanned book adherence verdicts it could not reach", () => {
  const failClosed = {
    basis: "unverified" as const,
    satisfied: false,
    confidence: 0,
    missingRequirements: ["The complete edit could not be verified against the approved instruction."],
    contradictions: [],
    pageIndexesToRevise: [1, 2]
  };
  const satisfied = {
    basis: "reviewed" as const,
    satisfied: true,
    confidence: 1,
    missingRequirements: [],
    contradictions: [],
    pageIndexesToRevise: []
  };

  it("re-asks the reviewer instead of redrafting every page", async () => {
    mocks.qualityFeatures.add("storyExtractAudit");
    mocks.reviewAppliedBookEdit.mockResolvedValueOnce(failClosed).mockResolvedValue(satisfied);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await generateReplannedBook(options());

    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(2);
    // No repaired candidate means no draft identity changed, so the drafting
    // loop's extracts are still the publication's — one per page, not two.
    expect(mocks.extractStoryState).toHaveBeenCalledTimes(2);
    expect(mocks.tx.page.createMany).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("could not be verified"),
      expect.objectContaining({ warning: "replan_adherence_unverified" })
    );
    logged.mockRestore();
  });

  it("still repairs a page the reviewer failed for prose, with nothing to repair adherence to", async () => {
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft }: { draft: { index: number } }) => ({
      page: draft,
      candidate: {
        draft,
        qualityReport: draft.index === 2
          ? { approved: false, score: 40, issues: ["Repeats page 1."], requiredRevisions: [], notes: "" }
          : { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
      }
    }));
    mocks.reviewAppliedBookEdit.mockResolvedValue(failClosed);

    await generateReplannedBook(options());

    expect(mocks.revisePageDraftWithRestart.mock.calls.map(([call]) => call.reviseOptions.pageIndex)).toEqual([2, 2]);
    for (const [call] of mocks.revisePageDraftWithRestart.mock.calls) {
      expect(call.reviseOptions.adherenceRepair).toEqual([]);
    }
    expect(mocks.tx.page.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          adherenceAudit: expect.objectContaining({
            proseApproved: false,
            verdict: expect.objectContaining({ basis: "unverified", satisfied: false })
          })
        })
      })
    );
  });

  it("keeps redrafting for a verdict the reviewer did reach", async () => {
    // `basis` is the whole of the predicate now, so this is a verdict wearing
    // every other mark of the sentinel — no confidence, one generic
    // requirement, every page flagged — that the reviewer nonetheless reached.
    // It is a repair instruction and must still be redrafted to.
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce({ ...failClosed, basis: "reviewed" as const })
      .mockResolvedValue(satisfied);

    await generateReplannedBook(options());

    expect(mocks.revisePageDraftWithRestart.mock.calls.map(([call]) => call.reviseOptions.pageIndex)).toEqual([1, 2]);
  });
});

/**
 * A replan drafts and reviews every page and may walk the set twice more. It
 * reported once, at zero, under a step key this job's template does not
 * have — which `advanceJobStep` answers by marking every step done and dropping
 * the counters.
 */
describe("replanned book drafting progress", () => {
  it("reports completed pages monotonically through both repair rounds", async () => {
    const heartbeat = { assertHeld: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    mocks.startReplanEditLeaseHeartbeat.mockReturnValue(heartbeat);
    const needsRepair = {
      satisfied: false,
      confidence: 0.9,
      missingRequirements: ["Mara never refuses the key."],
      contradictions: [],
      pageIndexesToRevise: [2]
    };
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce(needsRepair)
      .mockResolvedValueOnce(needsRepair)
      .mockResolvedValue({
        satisfied: true,
        confidence: 1,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });

    await generateReplannedBook(options());

    const reports = mocks.advanceJobStep.mock.calls.map(([, key, progress, , counters]) => ({ key, progress, counters }));
    expect(reports.every((report) => report.key === "setup")).toBe(true);
    expect(reports).toEqual([
      { key: "setup", progress: 35, counters: { done: 0, total: 2, phase: "draft", pageIndex: 1 } },
      { key: "setup", progress: 50, counters: { done: 1, total: 2, phase: "draft", pageIndex: 2 } },
      { key: "setup", progress: 65, counters: { done: 2, total: 2, phase: "draft" } },
      { key: "setup", progress: 65, counters: { done: 0, total: 1, phase: "revise", pageIndex: 2 } },
      { key: "setup", progress: 70, counters: { done: 1, total: 1, phase: "revise" } },
      { key: "setup", progress: 70, counters: { done: 0, total: 1, phase: "revise", pageIndex: 2 } },
      { key: "setup", progress: 75, counters: { done: 1, total: 1, phase: "revise" } }
    ]);
    expect(reports.map((report) => report.progress)).toEqual(
      [...reports].map((report) => report.progress).sort((left, right) => left - right)
    );

    // A progress write is diagnostic, but a stale delivery still must not
    // overwrite the winning delivery's current page. Every report is preceded
    // by a successful assertion from the drafting heartbeat.
    let previousReportOrder = 0;
    for (const reportOrder of mocks.advanceJobStep.mock.invocationCallOrder) {
      expect(
        heartbeat.assertHeld.mock.invocationCallOrder.some(
          (assertOrder) => assertOrder > previousReportOrder && assertOrder < reportOrder
        )
      ).toBe(true);
      previousReportOrder = reportOrder;
    }
  });
});

describe("replanned book deferred page memory", () => {
  it("asks for one story extract per page instead of re-buying every keeper's", async () => {
    mocks.qualityFeatures.add("storyExtractAudit");

    await generateReplannedBook(options());

    expect(mocks.extractStoryState).toHaveBeenCalledTimes(2);
    expect(mocks.extractStoryState.mock.calls.map(([call]) => call.pageIndex)).toEqual([1, 2]);
  });

  it("re-asks for a page an adherence repair rewrote, and for the page behind it", async () => {
    mocks.qualityFeatures.add("storyExtractAudit");
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce({
        satisfied: false,
        confidence: 0.6,
        missingRequirements: ["The red key is absent."],
        contradictions: [],
        pageIndexesToRevise: [1]
      })
      .mockResolvedValue({
        satisfied: true,
        confidence: 1,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });

    await generateReplannedBook(options());

    // Two from drafting, then page 1's repaired draft and page 2 behind it,
    // whose incoming story state that repair moved.
    expect(mocks.extractStoryState).toHaveBeenCalledTimes(4);
  });
});

describe("replanned book chapter brief repair", () => {
  it("briefs the chapter's later pages, and the published chapter row, from a repair the page kept", async () => {
    const repaired = { pages: [{ pageIndex: 1, beat: "Mara refuses the key." }] };
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async (call: { draft: { index: number } }) => ({
      ...(await approvedCandidate(call)),
      ...(call.draft.index === 1 ? { repairedChapterBrief: repaired } : {})
    }));

    await generateReplannedBook(options());

    expect(mocks.generatePageDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pageIndex: 1, chapterBrief })
    );
    expect(mocks.generatePageDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageIndex: 2, chapterBrief: repaired })
    );
    // `Chapter.productionBrief` is what every later drafting job reads back as
    // `previousChapterPageBriefs`, and this path has no other route to it:
    // `chapterId` is null, so the loop's durable CAS never runs.
    expect(mocks.tx.chapter.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ productionBrief: repaired })]
    });
  });
});
