import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Replan figure preservation: generate is figure-free, source fences are
 * planted onto the new draft, review sees stand-ins (or the block on keep),
 * and restore runs after review. The parent file is the adherence/publication
 * suite; these share its harness and nothing else.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn() },
    page: { findMany: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    $executeRawUnsafe: vi.fn(),
    bookEditOperation: { updateMany: vi.fn(), update: vi.fn() },
    generationJob: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    generationAttempt: { updateMany: vi.fn() },
    imageAsset: { deleteMany: vi.fn() },
    page: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    chapter: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    continuityNote: { deleteMany: vi.fn(), createMany: vi.fn() },
    embedding: { deleteMany: vi.fn() },
    character: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    location: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    researchSource: { deleteMany: vi.fn(), createMany: vi.fn() },
    planVersion: { updateMany: vi.fn(), update: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() }
  },
  invalidateProjectExports: vi.fn(),
  prepareChapterSetups: vi.fn(),
  ensureCharacterReferenceAssets: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  revisePageDraftWithRestart: vi.fn(),
  reviewAppliedBookEdit: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  maybeEnqueueCover: vi.fn(),
  enqueueReplanIllustrations: vi.fn(),
  generatePageDraft: vi.fn(),
  waitForReplanEditLease: vi.fn(),
  completeReplanEditLease: vi.fn(),
  releaseReplanEditTailLease: vi.fn(),
  waitForReplanEditLeaseCompletion: vi.fn(),
  assertReplanEditLeaseTx: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn(),
  startReplanEditLeaseHeartbeat: vi.fn()
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
  loadQualityContext: async () => ({ enabled: () => false, settings: {}, tier: "balanced" })
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
    waitForReplanEditLeaseCompletion: mocks.waitForReplanEditLeaseCompletion
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
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("@book-maker/core", async () => ({
  ...(await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core")),
  reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
}));

import { generateReplannedBook } from "./replanEditCandidates.js";

const instruction = "Rewrite the whole book so Mara finds a red key and refuses to use it.";
const keepInstruction =
  "Rewrite the whole book so Mara finds a red key and refuses to use it. Give Carts by decade a caption about the tolls.";
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
const cartsFence =
  "```figure\n" +
  JSON.stringify({
    kind: "bar",
    title: "Carts by decade",
    categories: ["1500", "1510"],
    series: [{ name: "Carts", values: [120, 140] }],
    source: "The ledger"
  }) +
  "\n```";
const inventedFence =
  "```figure\n" +
  JSON.stringify({ kind: "pie", title: "Invented", categories: ["a"], series: [{ name: "S", values: [1] }], source: "nowhere" }) +
  "\n```";
let leaseStatus = "ACTIVE";
let generationJobStatus = "ACTIVE";
let attemptStatus = "ACTIVE";
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

const exportBarrier = (): number | null =>
  mocks.tx.project.updateMany.mock.calls.some((call) => (call[0] as { where?: { exportInvalidationRevision?: number } }).where?.exportInvalidationRevision === 5) ? null : 5;

function sourcePagesWithPage2Figure() {
  return sourcePages.map((page) =>
    page.index === 2 ? { ...page, markdown: `${page.markdown}\n\n${cartsFence}` } : page
  );
}

function durableOperation(editInstruction: string) {
  return {
    id: "operation-1",
    projectId: "project-source",
    sourceProjectId: "project-source",
    status: leaseStatus,
    request: "stale contextual request",
    editInstruction,
    characterContext: "Mentioned character profiles:\n- Mara: a careful navigator",
    classifier: operationClassifier,
    publicationRevision: leaseStatus === "APPLIED" ? 5 : null
  };
}

type ReviewCall = { draft: { index: number; markdown: string }; figures?: "keep" | "hold" };

function reviewCalls(): ReviewCall[] {
  return mocks.reviewAndSaveGeneratedPage.mock.calls.map((call) => call[0] as ReviewCall);
}

function publishedMarkdown(index: number): string {
  const created = mocks.tx.page.createMany.mock.calls[0]?.[0] as {
    data: Array<{ index: number; markdown: string }>;
  };
  return created.data.find((page) => page.index === index)!.markdown;
}

function flagPage2ThenSatisfy() {
  mocks.reviewAppliedBookEdit
    .mockResolvedValueOnce({
      satisfied: false,
      confidence: 0.8,
      missingRequirements: ["Mara never refuses the key."],
      contradictions: [],
      pageIndexesToRevise: [2]
    })
    .mockResolvedValue({
      satisfied: true,
      confidence: 1,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  leaseStatus = "ACTIVE";
  generationJobStatus = "ACTIVE";
  attemptStatus = "ACTIVE";
  operationClassifier = {};
  mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => durableOperation(instruction));
  mocks.prisma.page.findMany.mockResolvedValue(sourcePagesWithPage2Figure());
  mocks.prepareChapterSetups.mockResolvedValue([
    { chapter: plan.chapters[0], startPage: 1, endPage: 2, brief: { pages: [] } }
  ]);
  mocks.generatePageDraft.mockImplementation(async ({ pageIndex }: { pageIndex: number }) => ({
    title: `New ${pageIndex}`,
    markdown: `New prose ${pageIndex}.`,
    summary: `New summary ${pageIndex}.`,
    continuityNotes: []
  }));
  mocks.reviewAndSaveGeneratedPage.mockImplementation(
    async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => ({
      page: draft,
      candidate: {
        draft,
        qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "" }
      }
    })
  );
  mocks.reviewAppliedBookEdit.mockResolvedValue({
    satisfied: true,
    confidence: 1,
    missingRequirements: [],
    contradictions: [],
    pageIndexesToRevise: []
  });
  mocks.revisePageDraftWithRestart.mockImplementation(
    async ({ reviseOptions }: { reviseOptions: { draft: Record<string, unknown> } }) => ({
      ...reviseOptions.draft,
      markdown: "Repaired prose."
    })
  );
  mocks.tx.chapter.createMany.mockResolvedValue({ count: 1 });
  mocks.tx.$executeRawUnsafe.mockResolvedValue(1);
  mocks.tx.character.findMany.mockResolvedValue([]);
  mocks.tx.location.findMany.mockResolvedValue([]);
  mocks.tx.chapter.findMany.mockResolvedValue([{ id: "chapter-new", index: 1 }]);
  mocks.tx.page.findMany.mockImplementation(async ({ where }: { where: { index: { in: number[] } } }) =>
    where.index.in.map((index) => ({ id: `new-page-${index}`, index }))
  );
  mocks.tx.generationJob.updateMany.mockImplementation(async ({ where, data }) => {
    const matches =
      where.id === "generation-1" &&
      where.projectId === "project-1" &&
      where.type === "GENERATE_BOOK" &&
      where.status === "ACTIVE" &&
      where.attemptId === "attempt-1" &&
      generationJobStatus === "ACTIVE";
    if (matches && data.status === "COMPLETED") generationJobStatus = "COMPLETED";
    return { count: matches ? 1 : 0 };
  });
  mocks.tx.generationJob.findUnique.mockResolvedValue({
    steps: [{ key: "generate", label: "Generate", status: "active" }]
  });
  mocks.tx.generationAttempt.updateMany.mockImplementation(async ({ where, data }) => {
    const successor = where.jobs?.some;
    const matches =
      where.id === "attempt-1" &&
      where.projectId === "project-1" &&
      where.editOperationId === "operation-1" &&
      where.status === "ACTIVE" &&
      successor?.id === "generation-1" &&
      successor?.projectId === "project-1" &&
      successor?.type === "GENERATE_BOOK" &&
      successor?.attemptId === "attempt-1" &&
      attemptStatus === "ACTIVE";
    if (matches && data.status === "SUCCEEDED") attemptStatus = "SUCCEEDED";
    return { count: matches ? 1 : 0 };
  });
  mocks.tx.project.update.mockImplementation(async ({ select }: { select?: { mediaSettings?: boolean } }) =>
    select?.mediaSettings
      ? { mediaSettings: {} }
      : { contentRevision: 5, currentPlanId: "plan-new", status: "EDITING", exportInvalidationRevision: exportBarrier() }
  );
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    const snapshot = { leaseStatus, generationJobStatus, attemptStatus, operationClassifier };
    try {
      return await run(mocks.tx);
    } catch (error) {
      leaseStatus = snapshot.leaseStatus;
      generationJobStatus = snapshot.generationJobStatus;
      attemptStatus = snapshot.attemptStatus;
      operationClassifier = snapshot.operationClassifier;
      throw error;
    }
  });
  mocks.waitForReplanEditLease.mockResolvedValue({ outcome: "acquired", phase: "draft" });
  mocks.completeReplanEditLease.mockResolvedValue(true);
  mocks.releaseReplanEditTailLease.mockResolvedValue(true);
  mocks.waitForReplanEditLeaseCompletion.mockResolvedValue("completed");
  mocks.assertReplanEditLeaseTx.mockImplementation(async () => ({
    status: leaseStatus,
    classifier: operationClassifier
  }));
  mocks.tx.bookEditOperation.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    if (data.status === "APPLIED") leaseStatus = "APPLIED";
    if (data.classifier && typeof data.classifier === "object") {
      operationClassifier = data.classifier as Record<string, unknown>;
    }
    return {};
  });
  mocks.heartbeatAssertHeld.mockResolvedValue(undefined);
  mocks.heartbeatStop.mockResolvedValue(undefined);
  mocks.startReplanEditLeaseHeartbeat.mockReturnValue({
    assertHeld: mocks.heartbeatAssertHeld,
    stop: mocks.heartbeatStop
  });
});

describe("generateReplannedBook figure preservation", () => {
  it("plants a source fence onto figure-free generate and holds it for the first review", async () => {
    const completion = await generateReplannedBook(options());
    await completion.afterJobCompleted?.();

    const page2 = reviewCalls().find((call) => call.draft.index === 2);
    expect(page2?.figures).toBe("hold");
    expect(page2?.draft.markdown).toContain("[Figure: Carts by decade]");
    expect(page2?.draft.markdown).not.toContain("```figure");
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(publishedMarkdown(2)).toContain("```figure");
    expect(publishedMarkdown(2)).toContain('"kind":"bar"');
    expect(publishedMarkdown(2)).toContain("Carts by decade");
  });

  it("holds a figure aside on an adherence revise that does not name it", async () => {
    flagPage2ThenSatisfy();

    const completion = await generateReplannedBook(options());
    await completion.afterJobCompleted?.();

    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        reviseOptions: expect.objectContaining({
          figures: "hold",
          draft: expect.objectContaining({
            markdown: expect.stringContaining("[Figure: Carts by decade]")
          })
        })
      })
    );
    const lastReview = reviewCalls().at(-1);
    expect(lastReview?.figures).toBe("hold");
    expect(lastReview?.draft.markdown).toContain("[Figure: Carts by decade]");
    expect(lastReview?.draft.markdown).not.toContain("```figure");
    expect(publishedMarkdown(2)).toContain("```figure");
    expect(publishedMarkdown(2)).toContain("Carts by decade");
  });

  it("keeps a named figure on an adherence revise and drops a second fence the model invented", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => durableOperation(keepInstruction));
    mocks.revisePageDraftWithRestart.mockImplementation(
      async ({ reviseOptions }: { reviseOptions: { draft: Record<string, unknown> } }) => ({
        ...reviseOptions.draft,
        markdown: `Mara found the key.\n\n${cartsFence}\n\n${inventedFence}\n\nShe would not use it.`
      })
    );
    flagPage2ThenSatisfy();

    const completion = await generateReplannedBook(options());
    await completion.afterJobCompleted?.();

    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        reviseOptions: expect.objectContaining({
          figures: "keep",
          editInstruction: keepInstruction,
          draft: expect.objectContaining({
            markdown: expect.stringContaining("```figure")
          })
        })
      })
    );
    const lastReview = reviewCalls().at(-1);
    expect(lastReview?.figures).toBe("keep");
    expect(publishedMarkdown(2)).toContain("```figure");
    expect(publishedMarkdown(2)).toContain("Carts by decade");
    expect(publishedMarkdown(2)).toContain('"kind":"bar"');
    expect(publishedMarkdown(2)).not.toContain("Invented");
    expect(publishedMarkdown(2)).not.toContain('"kind":"pie"');
  });

  it("drops unreadable figure JSON from a named-figure adherence revise", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => durableOperation(keepInstruction));
    mocks.revisePageDraftWithRestart.mockImplementation(
      async ({ reviseOptions }: { reviseOptions: { draft: Record<string, unknown> } }) => ({
        ...reviseOptions.draft,
        markdown: "Mara found the key.\n\n```figure\n{\"kind\":\"bar\",\"title\":\"x\"\n```\n\nShe would not use it."
      })
    );
    flagPage2ThenSatisfy();

    const completion = await generateReplannedBook(options());
    await completion.afterJobCompleted?.();

    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        reviseOptions: expect.objectContaining({ figures: "keep" })
      })
    );
    expect(reviewCalls().at(-1)?.figures).toBe("keep");
    expect(publishedMarkdown(2)).not.toContain("```figure");
  });

  it("does not replant a named source figure after a keep revise omits it", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => durableOperation(keepInstruction));
    mocks.revisePageDraftWithRestart.mockImplementation(
      async ({ reviseOptions }: { reviseOptions: { draft: Record<string, unknown> } }) => ({
        ...reviseOptions.draft,
        markdown: "Mara found the key."
      })
    );
    flagPage2ThenSatisfy();

    const completion = await generateReplannedBook(options());
    await completion.afterJobCompleted?.();

    const lastReview = reviewCalls().at(-1);
    expect(lastReview).not.toHaveProperty("figures");
    expect(publishedMarkdown(2)).not.toContain("```figure");
    expect(publishedMarkdown(2)).not.toContain("Carts by decade");
    expect(publishedMarkdown(2)).not.toContain('"kind":"bar"');
  });
});
