import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalBookQa, PageQualityReport } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

/**
 * The final-QA repair and a composed page's figure.
 *
 * Every per-page rewrite would otherwise come back from core figure-free, so a
 * page repaired from its raw markdown lost its chart and shipped without it.
 * The repair holds the block aside: the first revise and the loop's revises
 * pass `figures: "hold"` so they keep `[Figure: …]` stand-ins (and strip
 * invented fences), reviews still see the stand-in, and the block goes back
 * on the draft the page is published with. Kept apart from the publication
 * suite, which is near the file-size budget.
 */

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock(
  "../generation/bookHelpers.js",
  async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
);
vi.mock("../generation/finalQaPageTargets.js", async () => {
  const actual =
    await vi.importActual<typeof import("../generation/finalQaPageTargets.js")>(
      "../generation/finalQaPageTargets.js"
    );
  return (await import("./testing/compileExportMocks.js")).finalQaPageTargetsModuleMock(actual);
});
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { exportRepairOwnershipFence } from "./compileExportFence.js";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

const report = (approved: boolean): PageQualityReport =>
  ({
    approved,
    score: approved ? 90 : 40,
    issues: approved ? [] : ["Flat."],
    requiredRevisions: approved ? [] : ["Sharpen."],
    notes: "",
    checks: { repetitionOk: true, progressionOk: approved }
  }) as unknown as PageQualityReport;

const fence =
  "```figure\n" +
  JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The ledger" }) +
  "\n```";
const standIn = "[Figure: Carts by decade]";
const before = "The clerks counted the carts at the north gate.";
const after = "The towns felt the change first.";

const page = (): ExportPageForRepair =>
  ({
    id: "page-1",
    index: 1,
    title: "Page 1",
    markdown: `${before}\n\n${fence}\n\n${after}`,
    summary: "Carts and tolls.",
    imagePrompt: null,
    revision: 1,
    status: "COMPLETED",
    images: [],
    chapter: null
  }) as unknown as ExportPageForRepair;

const input = {
  title: "Book",
  prompt: "A history of tolls.",
  category: "EDUCATION",
  targetPages: 1,
  complexity: 3,
  temperature: 0.6,
  language: "en",
  mediaSettings: { finalReview: true }
};
const plan = { title: "Book", premise: "A book.", audience: "adults", chapters: [] };
const finalQa = {
  approved: false,
  score: 40,
  issues: [],
  requiredFixes: [],
  notes: "",
  repairPageIndexes: [1]
} as unknown as FinalBookQa;
const strategy = {
  executionMode: "whole-book",
  reviewPageDraft: vi.fn(),
  revisePageDraft: vi.fn(),
  repairPageBrief: vi.fn(),
  shouldIllustratePage: vi.fn(() => false)
};
const repairOptions = () =>
  ({
    projectId: "project-1",
    input,
    plan,
    providers: { text: {}, embedding: {} },
    strategy,
    quality: { enabled: isDefaultCompileQualityFeature },
    pages: [page()],
    finalQa,
    assertOwnership: exportRepairOwnershipFence("project-1", 4)!,
    generationJobId: "gj-1"
  }) as never;

/** What the model handed back: the prose it was shown, lightly rewritten, with no figure of its own. */
const rewritten = (shown: string) => shown.replace("counted the carts", "counted the carts twice");

const publishedMarkdown = (): string =>
  (mocks.prisma.page.update.mock.calls[0]![0] as { data: { markdown: string } }).data.markdown;

describe("final-QA repair and a page's figure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.parseChapterBrief.mockReturnValue(undefined);
    mocks.loadPagesForExport.mockResolvedValue([page()]);
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.revisePageDraftWithRestart.mockImplementation(
      async ({ reviseOptions }: { reviseOptions: { draft: { markdown: string } } }) => ({
        title: "Page 1",
        markdown: rewritten(reviseOptions.draft.markdown),
        summary: "Carts and tolls, twice.",
        imagePrompt: null,
        continuityNotes: []
      })
    );
    strategy.revisePageDraft.mockImplementation(async ({ draft }: { draft: { markdown: string } }) => ({
      title: "Page 1",
      markdown: rewritten(draft.markdown),
      summary: "Carts and tolls, twice.",
      imagePrompt: null,
      continuityNotes: []
    }));
    strategy.reviewPageDraft.mockResolvedValue(report(true));
    strategy.repairPageBrief.mockReset();
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...page(),
      ...data,
      revision: 2,
      updatedAt: new Date("2026-01-01T00:00:00.001Z")
    }));
  });

  it("shows the rewrite and the reviewer a stand-in, and publishes the page with its figure back beside its paragraph", async () => {
    await repairPagesFromFinalQa(repairOptions());

    const firstRevise = mocks.revisePageDraftWithRestart.mock.calls[0]![0] as {
      reviseOptions: { draft: { markdown: string }; figures?: string };
    };
    expect(firstRevise.reviseOptions.draft.markdown).toBe(`${before}\n\n${standIn}\n\n${after}`);
    expect(firstRevise.reviseOptions.figures).toBe("hold");
    for (const call of strategy.reviewPageDraft.mock.calls as Array<[{ draft: { markdown: string } }]>) {
      expect(call[0].draft.markdown).not.toContain("```figure");
      expect(call[0].draft.markdown).toContain(standIn);
    }
    // The story extract reads the prose without the block, like the finalize path.
    const extractCalls = mocks.keeperStoryExtractForSave.mock.calls as unknown as Array<[{ draft: { markdown: string } }]>;
    const extracted = extractCalls[0]![0].draft.markdown;
    expect(extracted).not.toContain("```figure");

    expect(publishedMarkdown()).toBe(`${before.replace("counted the carts", "counted the carts twice")}\n\n${fence}\n\n${after}`);
    expect(publishedMarkdown().match(/```figure/g)).toHaveLength(1);
    expect(publishedMarkdown()).not.toContain("[Figure:");
  });

  it("keeps one figure when the loop's rewrite invents another", async () => {
    const invented = "```figure\n" + JSON.stringify({ kind: "pie", title: "Invented", categories: ["a"], series: [{ name: "S", values: [1] }], source: "nowhere" }) + "\n```";
    strategy.reviewPageDraft.mockResolvedValueOnce(report(false)).mockResolvedValue(report(true));
    strategy.revisePageDraft.mockImplementationOnce(async ({ draft }: { draft: { markdown: string } }) => ({
      title: "Page 1",
      markdown: `${draft.markdown}\n\n${invented}`,
      summary: "Carts and tolls, twice.",
      imagePrompt: null,
      continuityNotes: []
    }));

    await repairPagesFromFinalQa(repairOptions());

    const firstRevise = mocks.revisePageDraftWithRestart.mock.calls[0]![0] as { reviseOptions: { figures?: string } };
    expect(firstRevise.reviseOptions.figures).toBe("hold");
    const loopRevises = strategy.revisePageDraft.mock.calls.map((call) => call[0] as { draft: { markdown: string }; figures?: string });
    expect(loopRevises.length).toBeGreaterThanOrEqual(1);
    expect(loopRevises.every((call) => call.figures === "hold")).toBe(true);
    const loopRewrite = loopRevises[0]!.draft.markdown;
    expect(loopRewrite).toContain(standIn);
    expect(loopRewrite).not.toContain("```figure");
    expect(publishedMarkdown().match(/```figure/g)).toHaveLength(1);
    expect(publishedMarkdown()).toContain(fence);
    expect(publishedMarkdown()).not.toContain("Invented");
  });

  it("omits figures: hold on a page that never had a figure", async () => {
    const options = repairOptions();
    const plain = page();
    (plain as { markdown: string }).markdown = `${before}\n\n${after}`;
    (options as { pages: ExportPageForRepair[] }).pages = [plain];
    await repairPagesFromFinalQa(options);
    const firstRevise = mocks.revisePageDraftWithRestart.mock.calls[0]![0] as {
      reviseOptions: { draft: { markdown: string }; figures?: string };
    };
    expect(firstRevise.reviseOptions.draft.markdown).toBe(`${before}\n\n${after}`);
    expect(firstRevise.reviseOptions).not.toHaveProperty("figures");
  });
});
