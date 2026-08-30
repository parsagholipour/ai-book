import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn() },
    project: { update: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn()
  },
  generatePageDraft: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  revisePageDraftWithRestart: vi.fn(),
  reviewAppliedBookEdit: vi.fn(),
  prepareEmbedding: vi.fn(),
  strategyUsesSemanticMemory: vi.fn(() => false),
  writePreparedEmbedding: vi.fn(),
  keeperStoryExtractForSave: vi.fn(),
  persistStoryExtract: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn(),
  advanceJobStep: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  pageScope: (index: number) => `page:${index}`,
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: {}
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, reviewAppliedBookEdit: mocks.reviewAppliedBookEdit };
});
vi.mock("../generation/bookHelpers.js", () => ({
  parseChapterBrief: () => undefined,
  styleExcerptsForPage: async () => [],
  toPriorPageContext: (page: { index: number; title: string; markdown: string; summary: string }) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  })
}));
vi.mock("../generation/embeddingWrites.js", () => ({
  prepareEmbedding: mocks.prepareEmbedding,
  strategyUsesSemanticMemory: mocks.strategyUsesSemanticMemory,
  writePreparedEmbedding: mocks.writePreparedEmbedding
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/qualityEnrichment.js", () => ({
  keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
  persistStoryExtract: mocks.persistStoryExtract
}));
vi.mock("../generation/pageReview.js", () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage
}));
vi.mock("../generation/pageRevision.js", () => ({
  revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
}));
vi.mock("../generation/structuralPageLease.js", () => ({
  renewStructuralPageLeaseTx: mocks.renewStructuralPageLeaseTx,
  StructuralPageLeaseLostError: class StructuralPageLeaseLostError extends Error {}
}));
vi.mock("../generation/storyStateStore.js", () => ({
  loadProjectStoryState: async () => ({ promises: [], facts: [], entities: {}, unanswered: [] })
}));
vi.mock("../generation/qualitySettings.js", () => ({
  loadQualityContext: async () => ({ enabled: () => false })
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: mocks.advanceJobStep }));
vi.mock("../runtime/durableEditCompletion.js", () => ({
  claimDurableEditCompletionTx: vi.fn(async () => true),
  settleDurableEditAttemptTx: vi.fn(async () => true)
}));

import { EDIT_ADHERENCE_FAILED } from "@book-maker/core/editFailure";
import { draftInsertedPages, publishDraftedInsertedPages } from "./restructurePagesDrafting.js";

const approvedReport = {
  approved: true,
  score: 90,
  issues: [],
  requiredRevisions: [],
  notes: "Approved",
  groundedOk: true,
  unsupportedClaims: [],
  checks: {
    placeholderFree: true,
    promptLeakFree: true,
    titleClean: true,
    repetitionOk: true,
    progressionOk: true,
    styleNatural: true
  }
};

const draft = (index: number, label: string) => ({
  title: `Page ${index}`,
  markdown: `${label} ${index}`,
  summary: `${label} summary ${index}`,
  continuityNotes: []
});

function options() {
  return {
    projectId: "project-1",
    operationId: "operation-1",
    ownerToken: "owner-1",
    planVersionId: "plan-1",
    input: {} as never,
    plan: { chapters: [], promises: [] } as never,
    strategy: { id: "fiction", generatePageDraft: mocks.generatePageDraft } as never,
    providers: { text: {}, embedding: {} } as never,
    insertedPageIds: ["new-1", "new-2"],
    editInstruction: "Add two closing pages that reveal the red key and explain what it unlocks.",
    assertLease: vi.fn(async () => undefined)
  };
}

describe("draftInsertedPages adherence publication gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      index: where.id === "new-1" ? 4 : 5,
      chapterId: null,
      title: "",
      markdown: "",
      summary: "",
      imagePrompt: null,
      status: "PENDING",
      revision: 0,
      chapter: null
    }));
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.project.update.mockResolvedValue({ contentRevision: 8 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ adherenceAudit: null });
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(0);
    mocks.strategyUsesSemanticMemory.mockReturnValue(false);
    mocks.prepareEmbedding.mockResolvedValue(null);
    mocks.writePreparedEmbedding.mockResolvedValue("stored");
    mocks.keeperStoryExtractForSave.mockResolvedValue(null);
    mocks.persistStoryExtract.mockResolvedValue(null);
    mocks.renewStructuralPageLeaseTx.mockResolvedValue({ status: "ACTIVE" });
    mocks.generatePageDraft.mockImplementation(async ({ pageIndex }: { pageIndex: number }) =>
      draft(pageIndex, "Initial")
    );
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft: candidate }: { draft: ReturnType<typeof draft> & { index: number } }) => ({
      page: candidate,
      candidate: { draft: candidate, qualityReport: approvedReport }
    }));
    mocks.revisePageDraftWithRestart.mockImplementation(async ({ reviseOptions }: { reviseOptions: { pageIndex: number } }) =>
      draft(reviseOptions.pageIndex, "Repaired")
    );
  });

  it("reviews the whole set, repairs only flagged pages, then publishes all keepers", async () => {
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce({
        satisfied: false,
        confidence: 0.95,
        missingRequirements: ["Page 5 does not explain what the key unlocks."],
        contradictions: [],
        pageIndexesToRevise: [5]
      })
      .mockResolvedValueOnce({
        satisfied: true,
        confidence: 0.99,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });

    const testOptions = {
      ...options(),
      characterContext: "Mentioned character profiles:\n- Mara: a careful navigator"
    };
    const drafted = await draftInsertedPages(testOptions);

    expect(drafted.pageIds).toEqual(["new-1", "new-2"]);

    expect(mocks.reviewAppliedBookEdit.mock.calls[0]![0].afterPages).toHaveLength(2);
    expect(JSON.stringify(mocks.reviewAppliedBookEdit.mock.calls[0]![0])).not.toContain("careful navigator");
    expect(mocks.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ characterContext: expect.stringContaining("careful navigator") })
    );
    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledOnce();
    expect(mocks.revisePageDraftWithRestart.mock.calls[0]![0]).toMatchObject({
      reviseOptions: {
        pageIndex: 5,
        editInstruction: expect.stringContaining("red key"),
        adherenceRepair: ["Page 5 does not explain what the key unlocks."]
      }
    });
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    await publishDraftedInsertedPages(testOptions, drafted, { generationJobId: "job-1" });
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.reviewAppliedBookEdit.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mocks.prisma.page.updateMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ adherenceAudit: expect.any(Object) }) })
    );
    expect(mocks.prisma.project.update.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.renewStructuralPageLeaseTx.mock.invocationCallOrder[0]!
    );
    expect(mocks.renewStructuralPageLeaseTx.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prisma.page.updateMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.prisma.page.updateMany.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mocks.prisma.bookEditOperation.update.mock.invocationCallOrder[0]!
    );
  });

  it("publishes nothing when Stop clears the exact lease after drafting but before the final fence", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.99,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });
    const insertOptions = { ...options(), insertedPageIds: ["new-1"] };
    const drafted = await draftInsertedPages(insertOptions);

    // This is the former split-publication window. Preparation has no durable
    // prose or success audit for Stop to race with.
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    mocks.renewStructuralPageLeaseTx.mockResolvedValueOnce(null);

    await expect(publishDraftedInsertedPages(insertOptions, drafted, { generationJobId: "job-1" })).rejects.toThrow();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
  });

  it("rolls prose, audit and publication revision back when final settlement aborts", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.99,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });
    const insertOptions = { ...options(), insertedPageIds: ["new-1"] };
    const drafted = await draftInsertedPages(insertOptions);
    const committed = { contentRevision: 7, markdown: "", status: "ACTIVE", adherenceAudit: null as unknown };
    mocks.prisma.$transaction.mockImplementationOnce(async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => {
      const staged = { ...committed };
      const tx = {
        ...mocks.prisma,
        project: {
          ...mocks.prisma.project,
          update: vi.fn(async () => {
            staged.contentRevision += 1;
            return { contentRevision: staged.contentRevision };
          })
        },
        page: {
          ...mocks.prisma.page,
          updateMany: vi.fn(async ({ data }: { data: { markdown: string } }) => {
            staged.markdown = data.markdown;
            return { count: 1 };
          })
        },
        bookEditOperation: {
          ...mocks.prisma.bookEditOperation,
          update: vi.fn(async ({ data }: { data: { adherenceAudit: unknown; status: string } }) => {
            staged.adherenceAudit = data.adherenceAudit;
            staged.status = data.status;
            throw new Error("settlement write failed");
          })
        }
      };
      await run(tx);
      Object.assign(committed, staged);
    });

    await expect(publishDraftedInsertedPages(insertOptions, drafted, { generationJobId: "job-1" })).rejects.toThrow(
      "settlement write failed"
    );
    expect(committed).toEqual({ contentRevision: 7, markdown: "", status: "ACTIVE", adherenceAudit: null });
  });

  it("atomically settles a legacy split publication without redrafting or rewriting its prose", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "new-1",
      index: 4,
      chapterId: null,
      title: "Recovered",
      markdown: "Already published",
      summary: "Recovered summary",
      imagePrompt: null,
      status: "COMPLETED",
      revision: 1,
      chapter: null
    });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      adherenceAudit: { verdict: { satisfied: true }, proseApproved: true }
    });
    const insertOptions = { ...options(), insertedPageIds: ["new-1"] };
    const drafted = await draftInsertedPages(insertOptions);

    expect(drafted).toMatchObject({ pageIds: ["new-1"], pageIndexes: [4], candidates: [], audit: null });
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    await expect(publishDraftedInsertedPages(insertOptions, drafted, { generationJobId: "job-1" })).resolves.toBe(8);
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPLIED", publicationRevision: 8, affectedPageIndexes: [4] })
      })
    );
  });

  it.each([[null], [undefined]])(
    "settles a split publication that predates the adherence audit (%s)",
    async (adherenceAudit) => {
      // `adherenceAudit` is newer than the rows the recovery above exists for,
      // so every one of them reads back empty. Treated as "the prose was not
      // accepted", a book that already holds its inserted pages was redrafted
      // into a review that can only answer with the settled row — no candidate,
      // then a rollback deleting prose the reader paid for and already has.
      mocks.prisma.page.findUnique.mockResolvedValue({
        id: "new-1",
        index: 4,
        chapterId: null,
        title: "Recovered",
        markdown: "Already published",
        summary: "Recovered summary",
        imagePrompt: null,
        status: "COMPLETED",
        revision: 1,
        chapter: null
      });
      mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ adherenceAudit });

      const drafted = await draftInsertedPages({ ...options(), insertedPageIds: ["new-1"] });

      expect(drafted).toMatchObject({ pageIds: ["new-1"], pageIndexes: [4], candidates: [], audit: null });
      expect(mocks.generatePageDraft).not.toHaveBeenCalled();
      expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    }
  );

  it("settles a legacy set whose last page the reviewer refused, rather than deleting it", async () => {
    // FAILED_QA is what the publication writes for a page the reviewer did not
    // approve — a terminal outcome, not an unwritten page. Counted as
    // unpublished it made a finished two-page insert look half-delivered, and
    // the partial refusal below rolls the whole set back: two pages of prose the
    // reader already received, deleted and refunded.
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      index: where.id === "new-1" ? 4 : 5,
      chapterId: null,
      title: "Recovered",
      markdown: "Already published",
      summary: "Recovered summary",
      imagePrompt: null,
      status: where.id === "new-1" ? "COMPLETED" : "FAILED_QA",
      revision: 1,
      chapter: null
    }));
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ adherenceAudit: null });

    const drafted = await draftInsertedPages(options());

    expect(drafted).toMatchObject({ pageIds: ["new-1", "new-2"], pageIndexes: [4, 5], candidates: [], audit: null });
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a split publication that stopped part way through its page set", async () => {
    // Neither half is deliverable: a COMPLETED page cannot be republished (the
    // publication claims a page that is not COMPLETED) and the rest is not an
    // edit on its own, so the set rolls back whole — before paying for a draft.
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      index: where.id === "new-1" ? 4 : 5,
      chapterId: null,
      title: "",
      markdown: "",
      summary: "",
      imagePrompt: null,
      status: where.id === "new-1" ? "COMPLETED" : "PENDING",
      revision: where.id === "new-1" ? 1 : 0,
      chapter: null
    }));
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ adherenceAudit: null });

    await expect(draftInsertedPages(options())).rejects.toThrow(
      "Structural insert already published 1 of 2 recorded pages"
    );

    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["failed prose QA", { verdict: { satisfied: true }, proseApproved: false }],
    ["missing prose QA", { verdict: { satisfied: true } }],
    ["malformed prose QA", { verdict: { satisfied: true }, proseApproved: "true" }],
    ["failed semantic review", { verdict: { satisfied: false }, proseApproved: true }],
    ["misplaced prose approval", { verdict: { satisfied: true, proseApproved: true } }],
    ["contradictory prose approval", { verdict: { satisfied: true, proseApproved: true }, proseApproved: false }],
    ["malformed verdict", { verdict: "satisfied", proseApproved: true }]
  ])("redrafts completed legacy pages when the stored audit has %s", async (_label, adherenceAudit) => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "new-1",
      index: 4,
      chapterId: null,
      title: "Recovered",
      markdown: "Previously published",
      summary: "Recovered summary",
      imagePrompt: null,
      status: "COMPLETED",
      revision: 1,
      chapter: null
    });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ adherenceAudit });
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.99,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });

    const drafted = await draftInsertedPages({ ...options(), insertedPageIds: ["new-1"] });

    expect(mocks.generatePageDraft).toHaveBeenCalledOnce();
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledOnce();
    expect(drafted).toMatchObject({
      pageIds: ["new-1"],
      pageIndexes: [4],
      audit: { verdict: { satisfied: true }, proseApproved: true }
    });
    expect(drafted.candidates).toHaveLength(1);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
  });

  it("publishes an inserted page the reviewer never approved as FAILED_QA", async () => {
    // Page QA is not the adherence gate: the insert delivered the pages the
    // reader paid for, and the one the reviewer would not pass is flagged for
    // the restructure recompile's repair pass rather than rolled back whole.
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft: candidate }: {
      draft: ReturnType<typeof draft> & { index: number };
    }) => ({
      page: candidate,
      candidate: {
        draft: candidate,
        qualityReport:
          candidate.index === 5
            ? { ...approvedReport, approved: false, score: 43, issues: ["Repeats page 4."] }
            : approvedReport
      }
    }));
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.99,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });

    const insertOptions = options();
    const drafted = await draftInsertedPages(insertOptions);

    expect(drafted.audit).toMatchObject({ verdict: { satisfied: true }, proseApproved: false });
    expect(drafted.pageIds).toEqual(["new-1", "new-2"]);

    await publishDraftedInsertedPages(insertOptions, drafted, { generationJobId: "job-1" });

    const published = mocks.prisma.page.updateMany.mock.calls as Array<
      [{ where: { id: string }; data: { status: string } }]
    >;
    expect(published.map(([call]) => [call.where.id, call.data.status])).toEqual([
      ["new-1", "COMPLETED"],
      ["new-2", "FAILED_QA"]
    ]);
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
  });

  it("publishes an insert whose adherence review could never be run", async () => {
    // The reviewer was never reached, so the verdict is not a refusal — it is
    // the absence of one. Redrafting to its generic requirement spent a revise
    // and a review on every page, twice, and could not help; failing on it then
    // discarded both drafted pages, reverted the shift that made room for them
    // and refunded, over a provider blip. Publishing is what the recompile's
    // repair pass can still act on.
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      basis: "unverified",
      satisfied: false,
      confidence: 0,
      missingRequirements: ["The complete edit could not be verified against the approved instruction."],
      contradictions: [],
      pageIndexesToRevise: [4, 5]
    });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const drafted = await draftInsertedPages(options());

    expect(drafted.candidates).toHaveLength(2);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    // Re-asked on each of the two rounds it would otherwise have redrafted in.
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    // No failure-path audit write, because there is no failure.
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    // The basis rides the stored audit, so the settle gate cannot read it as a
    // refusal on a later delivery either.
    expect(drafted.audit).toMatchObject({ verdict: { basis: "unverified" }, proseApproved: true });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("could not be verified"),
      expect.objectContaining({ warning: "structural_insert_adherence_unverified" })
    );
    logged.mockRestore();
  });

  it("settles a legacy set whose stored audit records a review that never ran", async () => {
    // The third answer in that column. A missing audit already settles, because
    // reading absence as refusal redrafts a set that can never be republished
    // and then deletes it — and an `unverified` audit is that same absence
    // written down by the loop above.
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "new-1",
      index: 4,
      chapterId: null,
      title: "Recovered",
      markdown: "Already published",
      summary: "Recovered summary",
      imagePrompt: null,
      status: "COMPLETED",
      revision: 1,
      chapter: null
    });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      adherenceAudit: { verdict: { satisfied: false, basis: "unverified" }, proseApproved: true }
    });

    const drafted = await draftInsertedPages({ ...options(), insertedPageIds: ["new-1"] });

    expect(drafted).toMatchObject({ pageIds: ["new-1"], pageIndexes: [4], candidates: [], audit: null });
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
  });

  it("stores the exhausted verdict and publishes no prose", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: false,
      confidence: 0.9,
      missingRequirements: ["The red key is absent."],
      contradictions: [],
      pageIndexesToRevise: [4, 5]
    });

    await expect(draftInsertedPages(options())).rejects.toThrow(EDIT_ADHERENCE_FAILED);

    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledTimes(4);
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adherenceAudit: expect.objectContaining({ attempts: 3, missingRequirements: ["The red key is absent."] })
        })
      })
    );
  });

  it("fails closed when deferred review omits its unpublished candidate", async () => {
    mocks.reviewAndSaveGeneratedPage.mockResolvedValueOnce({
      page: { index: 4, title: "Page 4", markdown: "Initial 4", summary: "Initial summary 4" }
    });

    await expect(draftInsertedPages(options())).rejects.toThrow(
      "Deferred review for inserted page 4 returned no candidate"
    );

    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
  });

  it.each([
    { label: "none", remainingIds: [] as string[], missing: 2 },
    { label: "only part", remainingIds: ["new-1"], missing: 1 }
  ])("fails before review or publication when $label of the recorded inserted pages remain", async ({
    remainingIds,
    missing
  }) => {
    const remaining = new Set(remainingIds);
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      remaining.has(where.id)
        ? {
            id: where.id,
            index: where.id === "new-1" ? 4 : 5,
            chapterId: null,
            title: "",
            markdown: "",
            summary: "",
            imagePrompt: null,
            status: "PENDING",
            revision: 0,
            chapter: null
          }
        : null
    );
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.99,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });

    await expect(draftInsertedPages(options())).rejects.toThrow(
      `Structural insert is missing ${missing} of 2 recorded pages`
    );

    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
  });

  it.each(["embedding", "story"] as const)(
    "publishes the page and audit when the %s SQL write aborts its best-effort block",
    async (failedMemory) => {
      mocks.reviewAppliedBookEdit.mockResolvedValue({
        satisfied: true,
        confidence: 0.99,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });
      mocks.strategyUsesSemanticMemory.mockReturnValue(true);
      mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1]", error: null });
      mocks.keeperStoryExtractForSave.mockResolvedValue({
        storyDelta: {
          promisesOpened: [],
          promisesPaid: [],
          promisesBroken: [],
          factsAdded: [],
          entities: {},
          unansweredAdded: [],
          unansweredResolved: []
        },
        contradictions: []
      });

      const aborted = new Error("current transaction is aborted (25P02)");
      const failSqlAndSwallow = async (client: { $executeRawUnsafe: (sql: string) => Promise<unknown> }) => {
        await client.$executeRawUnsafe("FAIL OPTIONAL MEMORY").catch(() => undefined);
        return null;
      };
      if (failedMemory === "embedding") {
        mocks.writePreparedEmbedding.mockImplementation(async (_target, _prepared, client) => {
          await failSqlAndSwallow(client);
          return "degraded";
        });
      } else {
        mocks.persistStoryExtract.mockImplementation(async ({ client }) => failSqlAndSwallow(client));
      }

      const committedMarkdown: string[] = [];
      let transactionClient: typeof mocks.prisma | undefined;
      mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => {
        let transactionAborted = false;
        const stagedMarkdown: string[] = [];
        const tx = {
          ...mocks.prisma,
          page: {
            ...mocks.prisma.page,
            updateMany: vi.fn(async (args: { data: { markdown?: string } }) => {
              if (transactionAborted) throw aborted;
              const saved = await mocks.prisma.page.updateMany(args);
              if (args.data.markdown) stagedMarkdown.push(args.data.markdown);
              return saved;
            })
          },
          bookEditOperation: {
            ...mocks.prisma.bookEditOperation,
            update: vi.fn(async (args: unknown) => {
              if (transactionAborted) throw aborted;
              return mocks.prisma.bookEditOperation.update(args);
            })
          },
          $executeRawUnsafe: vi.fn(async (sql: string) => {
            if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
              transactionAborted = false;
              return 0;
            }
            if (transactionAborted) throw aborted;
            if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE SAVEPOINT")) return 0;
            transactionAborted = true;
            throw new Error("optional memory SQL failed");
          })
        };
        transactionClient = tx;
        const result = await run(tx);
        if (transactionAborted) throw aborted;
        committedMarkdown.push(...stagedMarkdown);
        return result;
      });

      const insertOptions = { ...options(), insertedPageIds: ["new-1"] };
      const drafted = await draftInsertedPages(insertOptions);
      expect(drafted.pageIds).toEqual(["new-1"]);
      await expect(publishDraftedInsertedPages(insertOptions, drafted, { generationJobId: "job-1" })).resolves.toBe(8);

      expect(committedMarkdown).toEqual(["Initial 4"]);
      expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ adherenceAudit: expect.any(Object) }) })
      );
      expect(transactionClient?.$executeRawUnsafe).toHaveBeenCalledWith(
        'ROLLBACK TO SAVEPOINT "best_effort_page_memory"'
      );
      expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), transactionClient);
      expect(mocks.persistStoryExtract).toHaveBeenCalledWith(expect.objectContaining({ client: transactionClient }));
    }
  );
});
