/**
 * `generate-page`: what becomes of the draft.
 *
 * Everything from the candidate-count decision onwards — how many drafts the
 * two best-of gates ask for, which of the review loop's candidates is kept and
 * on what report, what the style audit does to that report, and the save that
 * follows it: the FAILED_QA and COMPLETED writes, the continuity notes, the
 * illustration enqueued strictly before the page goes terminal, and the fan-out
 * to the next page.
 *
 * The other half — the context the page is drafted *from* — is
 * `generatePageContext.test.ts`. Both suites stand the same modules up through
 * `testing/generatePageMocks.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/generatePageMocks.js")).dbModuleMock());
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/generatePageMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/generatePageMocks.js")).jobLifecycleModuleMock()
);
vi.mock("../runtime/config.js", async () => (await import("./testing/generatePageMocks.js")).configModuleMock());
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/generatePageMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingRepair.js",
  async () => (await import("./testing/generatePageMocks.js")).embeddingRepairModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/generatePageMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/generatePageMocks.js")).entityStateModuleMock()
);
vi.mock(
  "../generation/researchMemory.js",
  async () => (await import("./testing/generatePageMocks.js")).researchMemoryModuleMock()
);
vi.mock(
  "../generation/semanticRecall.js",
  async () => (await import("./testing/generatePageMocks.js")).semanticRecallModuleMock()
);
vi.mock(
  "../generation/generationContext.js",
  async () => (await import("./testing/generatePageMocks.js")).generationContextModuleMock()
);
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/generatePageMocks.js")).projectInputModuleMock()
);
vi.mock("../generation/bookHelpers.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/bookHelpers.js")>(
    "../generation/bookHelpers.js"
  );
  return (await import("./testing/generatePageMocks.js")).bookHelpersModuleMock(actual);
});
vi.mock("../generation/tuning.js", async () => (await import("./testing/generatePageMocks.js")).tuningModuleMock());
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/generatePageMocks.js")).qualitySettingsModuleMock()
);
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/generatePageMocks.js")).storyStateStoreModuleMock()
);
vi.mock("../generation/qualityEnrichment.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/qualityEnrichment.js")>(
    "../generation/qualityEnrichment.js"
  );
  return (await import("./testing/generatePageMocks.js")).qualityEnrichmentModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/generatePageMocks.js")).coreModuleMock(actual);
});

import { generatePage } from "./generatePage.js";
// Real via the partial mock above: the audited-initial-draft test applies the
// same transform `enrichPageQualityReport` does, not a restatement of it.
import { withStyleAudit } from "@book-maker/core";
import {
  completedPage,
  draftNamed,
  job,
  mocks,
  report,
  resetGeneratePageMocks
} from "./testing/generatePageMocks.js";

describe("generatePage quality loop", () => {
  beforeEach(() => resetGeneratePageMocks());
  afterEach(() => vi.clearAllMocks());

  it("saves the highest-scoring draft when no rewrite is approved, not the last one", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraft
      .mockResolvedValueOnce(draftNamed("Second"))
      .mockResolvedValueOnce(draftNamed("Third"));
    // Scores 40 → 70 → 55: the sixth-rewrite-worse-than-second shape in miniature.
    mocks.reviewPageDraft
      .mockResolvedValueOnce(report(40))
      .mockResolvedValueOnce(report(70))
      .mockResolvedValueOnce(report(55));

    await generatePage(job);

    const failedSave = mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "FAILED_QA");
    expect(failedSave).toMatchObject({
      title: "Second",
      markdown: "Second text.",
      revision: 2
    });
    expect((failedSave!.qualityReport as { score: number }).score).toBe(70);
    expect(mocks.enqueueNextPageIfReady).toHaveBeenCalledWith("project-1", "plan-1", expect.anything());
  });

  it("keeps a style-audited initial draft over an unaudited rejected rewrite that scores lower", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraft
      .mockResolvedValueOnce(draftNamed("Second"))
      .mockResolvedValueOnce(draftNamed("Third"));
    // The reproduction: the initial draft reviews at 80 and the style audit
    // flags two issues; both rewrites are rejected by the reviewer, so they
    // are never audited. A penalty folded into `score` (80 → 50) made the
    // worse rewrite at 60 the keeper.
    mocks.reviewPageDraft
      .mockResolvedValueOnce(
        withStyleAudit(
          { ...report(80), checks: { styleNatural: true } },
          { styleOk: false, styleIssues: ["Register drifts.", "Rhythm ignored."] }
        )
      )
      .mockResolvedValueOnce(report(60))
      .mockResolvedValueOnce(report(55));

    await generatePage(job);

    const failedSave = mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "FAILED_QA");
    expect(failedSave).toMatchObject({ title: "First", revision: 1 });
    const savedReport = failedSave!.qualityReport as { score: number; stylePenalty?: number };
    expect(savedReport.score).toBe(80);
    expect(savedReport.stylePenalty).toBe(30);
  });

  it("saves an approved draft as-is", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    const completedSave = mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "COMPLETED");
    expect(completedSave).toMatchObject({ title: "First", revision: 1 });
    expect(mocks.revisePageDraft).not.toHaveBeenCalled();
  });

  it("owns new continuity notes by the stable page id", async () => {
    mocks.generatePageDraft.mockResolvedValue({
      ...draftNamed("First"),
      continuityNotes: ["Pip keeps the brass key."]
    });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ pageId: "page-1", scope: "page:1", body: "Pip keeps the brass key." })]
    });
  });

  it("queues the illustration before saving the page as COMPLETED", async () => {
    // A sibling page's maybeEnqueueCompile call must never observe this page
    // as terminal with no open image job behind it — the image job has to
    // exist strictly before the COMPLETED write lands.
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A robin on a branch" });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });
    const callOrder: string[] = [];
    mocks.enqueueWorkerJob.mockImplementation(async () => callOrder.push("enqueue-image"));
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.status === "COMPLETED") {
        callOrder.push("save-completed");
      }
      return {};
    });

    await generatePage(job);

    expect(callOrder).toEqual(["enqueue-image", "save-completed"]);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GENERATE_IMAGE",
        payload: { pageId: "page-1", planId: "plan-1", prompt: "A robin on a branch" }
      })
    );
  });

  it("does not enqueue an illustration for a page the strategy won't illustrate", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => false;
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A robin on a branch" });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });

  it("does not best-of sequential drafts when quality bestOfPolish is off even if draftCandidates is 2", async () => {
    // Page 2, not the fixture's page 1: the first page best-ofs by tier on its
    // own, and this test is about the operator draftCandidates gate.
    mocks.prisma.page.findUnique.mockResolvedValue({ id: "page-1", index: 2, chapterId: null, chapter: null });
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 2 } });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).not.toHaveBeenCalled();
    expect(mocks.generatePageDraft).toHaveBeenCalled();
  });

  it("best-ofs page 1 by the tier gate alone when the operator gate is off", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValue({ ...report(88), approved: true });

    await generatePage(job);

    // bestOfPolish is off, so this 2 is the balanced tier's first-page gate alone.
    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(expect.objectContaining({ candidateCount: 2 }));
  });

  it("takes the larger of the tier and operator gates on page 1", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValue({ ...report(88), approved: true });

    // Operator gate on and higher: `Math.max` takes its 3, never the tier's 2 and never 6.
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "bestOfPolish");
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 3 } });
    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).toHaveBeenLastCalledWith(expect.objectContaining({ candidateCount: 3 }));
  });

  it("best-ofs sequential drafts when bestOfPolish is on and draftCandidates is 2", async () => {
    // Page 2 again: on page 1 the tier gate alone answers 2, so this count
    // would prove nothing about the operator gate this test is named for.
    mocks.prisma.page.findUnique.mockResolvedValue({ id: "page-1", index: 2, chapterId: null, chapter: null });
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "bestOfPolish");
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 2 } });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(expect.objectContaining({ candidateCount: 2 }));
    expect(mocks.generatePageDraft).toHaveBeenCalled();
  });

  /** A page whose recency window already carries the book's opening pages. */
  const withStyleLock = () => {
    mocks.prisma.page.findUnique.mockResolvedValue({ id: "page-5", index: 5, chapterId: null, chapter: null });
    mocks.prisma.page.findMany.mockResolvedValue([
      completedPage(1, "opening-voice"),
      completedPage(2, "second-voice"),
      completedPage(3, "third"),
      completedPage(4, "fourth")
    ]);
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraft.mockResolvedValue(draftNamed("Second"));
  };

  /** The quality report the page was finally saved on. */
  const savedQualityReport = () =>
    mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "COMPLETED" || data.status === "FAILED_QA")!.qualityReport as Record<
      string,
      unknown
    >;

  it("audits an approved rewrite against the same pin the draft was written from", async () => {
    mocks.qualityEnabled.mockImplementation(
      (feature?: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });

    await generatePage(job);

    // One pin, three readers: the draft, the enrichment pass whose answer the
    // auditor is built out of, and the audit itself. Asserted by reference, so
    // deriving the auditor's excerpts a second way fails here.
    const pinned = (mocks.generatePageDraft.mock.calls[0]![0] as { styleExcerpts: string[] }).styleExcerpts;
    expect(pinned).toHaveLength(2);
    expect(
      (mocks.enrichPageQualityReport.mock.calls[0]![0] as { styleExcerpts?: string[] }).styleExcerpts
    ).toBe(pinned);
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(1);
    const audited = mocks.auditPageStyle.mock.calls[0]![0] as { markdown: string; styleExcerpts: string[] };
    expect(audited.markdown).toBe("Second text.");
    expect(audited.styleExcerpts).toBe(pinned);
    // Zero rather than absent: it is what marks the report as audited at all.
    expect(savedQualityReport().stylePenalty).toBe(0);
  });

  it("builds no auditor with the gate off, or with nothing pinned to compare against", async () => {
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "styleExcerpts");
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
    expect(savedQualityReport()).not.toHaveProperty("stylePenalty");

    // Auditor gate on, excerpts gate off: nothing is pinned to audit against.
    vi.clearAllMocks();
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "styleAuditor");
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });
    await generatePage(job);

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("carries a failed audit's penalty and issues into the report it saves", async () => {
    mocks.qualityEnabled.mockImplementation(
      (feature?: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });
    mocks.auditPageStyle.mockResolvedValue({
      styleOk: false,
      styleIssues: ["Register drifts into lecture mode.", "Rhythm ignores the opening."]
    });

    await generatePage(job);

    // The reviewer approved both rewrites and the audit rejected both, so the
    // page is saved flagged on the audited report rather than shipping.
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);
    expect(savedQualityReport()).toMatchObject({ score: 88, stylePenalty: 30 });
    expect(savedQualityReport().issues).toContain("Register drifts into lecture mode.");
  });
});
