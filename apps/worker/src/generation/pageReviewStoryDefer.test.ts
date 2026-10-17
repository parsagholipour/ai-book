import { beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, report, draftNamed } from "./testing/pageReviewHarness.js";
import { reviewAndSaveGeneratedPage } from "./pageReview.js";

/**
 * A generated page's save: its local checks only — no model review or rewrite
 * (`withoutPageReview`, E4 and E5) and no story extract (E6), on any tier.
 */
describe("reviewAndSaveGeneratedPage pays for nothing past its local checks", () => {
  const strategy = {
    id: "test-strategy",
    executionMode: "draft-then-polish",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    shouldIllustratePage: vi.fn()
  };
  const options = (overrides: Record<string, unknown> = {}) => ({
    projectId: "project-1",
    planId: "plan-1",
    input: { mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    providers: { text: {}, embedding: {} },
    strategy,
    draft: { ...draftNamed("First"), index: 3 },
    chapterId: null,
    previousPages: [],
    generationJobId: "gj-1",
    ...overrides
  }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma));
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.findUnique.mockResolvedValue(null);
    mocks.prisma.page.create.mockResolvedValue({ id: "page-row-1", revision: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.reviewPage.mockResolvedValue(report(90, { approved: true }));
  });

  it("saves the page as drafted, whatever the gates say", async () => {
    mocks.qualityEnabled.mockReturnValue(true);
    await reviewAndSaveGeneratedPage(options());
    expect(mocks.prisma.page.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "GENERATING" }) }));
  });

  it("asks no model to review or rewrite the page, whatever the review gates say", async () => {
    mocks.reviewPage.mockReset();
    const actual = await vi.importActual<typeof import("./pageQualityGateReview.js")>("./pageQualityGateReview.js");
    mocks.reviewPage.mockImplementation(actual.reviewPageWithQualityGates);
    mocks.qualityEnabled.mockReturnValue(true);
    strategy.reviewPageDraft.mockResolvedValue(report(10));
    await reviewAndSaveGeneratedPage(options());
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    const gates = mocks.reviewPage.mock.calls[0]![0] as { quality: { enabled: (feature: string) => boolean } };
    for (const feature of ["pageModelReview", "pageQaRewrite", "smartUnslop", "styleAuditor"]) {
      expect(gates.quality.enabled(feature), feature).toBe(false);
    }
    expect(gates.quality.enabled("pageLocalQa")).toBe(true);
  });
});
