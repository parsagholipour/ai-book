import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reviewPageWithQualityGates: vi.fn(),
  updateJobProgress: vi.fn(),
  qualityEnabled: vi.fn()
}));

vi.mock("./pageReview.js", () => ({ reviewPageWithQualityGates: mocks.reviewPageWithQualityGates }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: mocks.qualityEnabled
  })
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));

import { reviewWholeBookDraftPages } from "./wholeBookPageReview.js";

const page = {
  index: 1,
  title: "The first page",
  markdown: "Draft prose.",
  summary: "A summary.",
  continuityNotes: [] as string[]
};

const baseOptions = (revisePageDraft: ReturnType<typeof vi.fn>) =>
  ({
    input: { targetPages: 1, temperature: 0.8, mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    strategy: { revisePageDraft },
    textModel: {},
    pages: [page],
    generationJobId: "job-1"
  }) as never;

describe("reviewWholeBookDraftPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the first failed report without revising when page QA rewrites are disabled", async () => {
    const failedReport = { approved: false, score: 42, feedback: ["Repeated phrasing."] };
    const revisePageDraft = vi.fn();
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "pageLocalQa");
    mocks.reviewPageWithQualityGates.mockResolvedValue(failedReport);

    const reviewed = await reviewWholeBookDraftPages(baseOptions(revisePageDraft));

    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledWith(
      expect.objectContaining({ allowModelReview: false })
    );
    expect(revisePageDraft).not.toHaveBeenCalled();
    expect(reviewed).toEqual([{ draft: page, qualityReport: failedReport, revision: 1 }]);
  });

  it("attempts at most one revision when page QA rewrites are enabled", async () => {
    const firstReport = { approved: false, score: 42, feedback: ["Repeated phrasing."] };
    const secondReport = { approved: false, score: 55, feedback: ["Still repetitive."] };
    const revisedPage = { ...page, index: 99, markdown: "Revised prose." };
    const revisePageDraft = vi.fn().mockResolvedValue(revisedPage);
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "pageLocalQa" || feature === "pageQaRewrite"
    );
    mocks.reviewPageWithQualityGates.mockResolvedValueOnce(firstReport).mockResolvedValueOnce(secondReport);

    const reviewed = await reviewWholeBookDraftPages(baseOptions(revisePageDraft));

    expect(revisePageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledTimes(2);
    expect(reviewed).toEqual([
      {
        draft: { ...revisedPage, index: page.index },
        qualityReport: secondReport,
        revision: 2
      }
    ]);
  });
});
