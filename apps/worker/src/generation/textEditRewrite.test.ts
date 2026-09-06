import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pagePipelineQualityGates } from "../testing/qualityGateFixtures.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []) }
  },
  loadStyleLockPages: vi.fn(
    async (
      _projectId?: string,
      _pageIndex?: number,
      _recencyPages?: Array<Record<string, unknown>>
    ): Promise<Array<Record<string, unknown>>> => []
  ),
  loadContinuityNotes: vi.fn(async (): Promise<string[]> => []),
  qualityEnabled: vi.fn((_feature: string): boolean => false),
  pageQualityEnabled: vi.fn((_feature: string): boolean => true),
  // The style audit's provider boundary; `withStyleAudit` above it stays real.
  auditPageStyle: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./generationContext.js", () => ({ loadContinuityNotes: mocks.loadContinuityNotes }));
vi.mock("./bookHelpers.js", async () => {
  const { pagesForStyleExcerpts, pinStyleExcerpts, sampleExcerptsFromInput } = await vi.importActual<
    typeof import("@book-maker/core")
  >("@book-maker/core");
  return {
    parseChapterBrief: () => null,
    toPriorPageContext: (page: unknown) => page,
    // Controllable: `rewritePageForUserRequest` builds its style lock — and so
    // the auditor — out of whatever this returns.
    loadStyleLockPages: mocks.loadStyleLockPages,
    styleExcerptsForPage: async (options: {
      projectId: string;
      pageIndex: number;
      recencyPages: Array<{ index: number; title: string; markdown: string; summary: string }>;
      input: Parameters<typeof sampleExcerptsFromInput>[0];
      quality: { enabled: (feature: string) => boolean };
    }) => {
      if (!options.quality.enabled("styleExcerpts")) {
        return [];
      }
      const lockPages = (await mocks.loadStyleLockPages(
        options.projectId,
        options.pageIndex,
        options.recencyPages
      )) as Array<{ index: number; title: string; markdown: string; summary: string }>;
      return pinStyleExcerpts(
        pagesForStyleExcerpts(options.recencyPages, lockPages),
        sampleExcerptsFromInput(options.input)
      );
    }
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    auditPageStyle: mocks.auditPageStyle
  };
});

import { locallyPatchedPage, rewritePageForUserRequest } from "./textEditRewrite.js";

describe("locallyPatchedPage", () => {
  it("applies the replacement to title, markdown and summary and self-approves", () => {
    const result = locallyPatchedPage(
      {
        title: "Rabbit",
        markdown: "Rabbit runs.",
        summary: "A rabbit.",
        imagePrompt: "a rabbit",
        qualityReport: null
      },
      { from: "rabbit", to: "fly", preserveCase: true }
    );
    expect(result).toMatchObject({
      title: "Fly",
      markdown: "Fly runs.",
      summary: "A fly.",
      imagePrompt: "a rabbit",
      qualityReport: { approved: true, notes: "Applied exact user-requested text replacement." }
    });
  });
});

describe("rewritePageForUserRequest style audit", () => {
  const strategy = { revisePageDraft: vi.fn(), reviewPageDraft: vi.fn() };

  const priorPage = (index: number) => ({
    index,
    title: `Page ${index}`,
    markdown: `Page ${index} prose, long enough to serve as a style anchor.`,
    summary: `Page ${index} summary.`
  });

  const draftNamed = (name: string) => ({
    title: name,
    markdown: `${name} text.`,
    summary: `${name} summary.`,
    imagePrompt: null,
    continuityNotes: [] as string[]
  });

  const report = (score: number, approved = false) => ({
    approved,
    score,
    issues: [] as string[],
    requiredRevisions: [] as string[],
    notes: "",
    checks: { repetitionOk: true, progressionOk: true }
  });

  const rewriteOptions = () =>
    ({
      projectId: "project-1",
      page: {
        id: "page-3",
        index: 3,
        title: "Page 3",
        markdown: "Page 3 prose.",
        summary: "Page 3 summary.",
        imagePrompt: null,
        chapterId: null,
        chapter: null
      },
      input: { targetPages: 12, mediaSettings: {} },
      plan: { title: "Book", chapters: [], voiceGuide: ["Warm and plain."] },
      strategy,
      providers: { text: {} },
      request: "make page 3 more dramatic",
      // Handed in by `applyBookEdit`, one context for the whole edit.
      quality: pagePipelineQualityGates({
        defaultFeatureEnabled: mocks.pageQualityEnabled,
        otherFeatureEnabled: mocks.qualityEnabled
      }),
      generationJobId: "gj-1"
    }) as never;

  /** The style lock the first rewrite was anchored to. */
  const revisedWith = () => (strategy.revisePageDraft.mock.calls[0]![0] as { styleExcerpts?: string[] }).styleExcerpts;

  const auditCalls = () =>
    mocks.auditPageStyle.mock.calls.map((call) => call[0] as unknown as { markdown: string; styleExcerpts: string[] });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.qualityEnabled.mockReturnValue(false);
    mocks.pageQualityEnabled.mockReturnValue(true);
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.loadStyleLockPages.mockResolvedValue([]);
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    // Newest first, the way the rewrite reads them before reversing.
    mocks.prisma.page.findMany.mockResolvedValue([priorPage(11)]);
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
  });
  afterEach(() => vi.clearAllMocks());

  it("audits the rewrite against the very lock it was written against", async () => {
    // A chat rewrite lands mid-book, so its excerpts come from the loaded
    // style-lock pages rather than the recency window it sits in. The auditor
    // is asserted to hold that same array by reference, which is what stops a
    // second derivation drifting from the one the rewrite used.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    const result = await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.loadStyleLockPages).toHaveBeenCalledWith("project-1", 3, [priorPage(11)]);
    expect(revisedWith()).toEqual([priorPage(1).markdown, priorPage(2).markdown]);
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]!.markdown).toBe("Rewrite text.");
    expect(auditCalls()[0]!.styleExcerpts).toBe(revisedWith());
    // Zero rather than absent: it is what marks the report as audited at all.
    expect((result.qualityReport as unknown as { stylePenalty?: number }).stylePenalty).toBe(0);
  });

  it("tells the auditor the register change was the reader's own request", async () => {
    // The excerpts are the book's *opening* pages, so "make page 3 more
    // dramatic" is a register shift by construction. Audited by the plain rules
    // it came back rejected, the reviewer's approval was flipped, the edit's
    // three-candidate budget went on pulling the page back toward the voice the
    // reader had just asked it to leave, and the edit was delivered FAILED_QA —
    // which then feeds `failedQaPageIndexes` into the next compile's repair.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    await rewritePageForUserRequest(rewriteOptions());

    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({ userRequest: "make page 3 more dramatic" });
  });

  it("holds every quality rewrite to the edit the reader paid for", async () => {
    mocks.qualityEnabled.mockReturnValue(false);
    // Rejected outright, so the loop rewrites: the requested edit is already in
    // the draft, and a revision that repairs quality by undoing it delivers the
    // page the reader started from.
    strategy.reviewPageDraft.mockResolvedValue(report(40));

    await rewritePageForUserRequest(rewriteOptions());

    const briefings = strategy.revisePageDraft.mock.calls
      .slice(1)
      .map((call) => (call[0] as { report: { requiredRevisions: string[] } }).report.requiredRevisions);
    expect(briefings.length).toBeGreaterThan(0);
    for (const briefing of briefings) {
      expect(briefing).toContain("Keep the user's requested edit applied: make page 3 more dramatic");
    }
  });

  it("keeps page guidance supplemental to the durable instruction in every revision prompt", async () => {
    strategy.reviewPageDraft.mockResolvedValue(report(40));
    const editInstruction = "Reveal the red key on page 3 and preserve the chapter's ending.";
    const pageEditGuidance = "Reveal the key in the final paragraph.";

    await rewritePageForUserRequest({
      ...(rewriteOptions() as Parameters<typeof rewritePageForUserRequest>[0]),
      request: pageEditGuidance,
      editInstruction,
      pageEditGuidance
    });

    expect(strategy.revisePageDraft.mock.calls.length).toBeGreaterThan(1);
    for (const call of strategy.revisePageDraft.mock.calls) {
      expect(call[0]).toMatchObject({ editInstruction, pageEditGuidance });
    }
  });

  it("keeps the requested rewrite but skips its post-edit review when page QA is off", async () => {
    mocks.pageQualityEnabled.mockReturnValue(false);

    const result = await rewritePageForUserRequest(rewriteOptions());

    expect(strategy.revisePageDraft).toHaveBeenCalledTimes(1);
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(result.qualityReport).toMatchObject({ approved: true, score: 100 });
  });

  it("builds no auditor with the gate off, or with nothing pinned to compare against", async () => {
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleExcerpts");
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    // Excerpts pinned, auditor gate off: the rewrite is still anchored.
    const anchored = await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
    expect(revisedWith()).toEqual([priorPage(1).markdown, priorPage(2).markdown]);
    expect(anchored.qualityReport).not.toHaveProperty("stylePenalty");

    // Auditor gate on, excerpts gate off: nothing is even loaded to pin.
    vi.clearAllMocks();
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleAuditor");
    mocks.prisma.page.findMany.mockResolvedValue([priorPage(11)]);
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.loadStyleLockPages).not.toHaveBeenCalled();
    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("carries a failed audit's penalty and issues into the report it returns", async () => {
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    // Approved once, then rejected: the audited draft stays the keeper, so its
    // report is the one the edit is saved on.
    strategy.reviewPageDraft.mockResolvedValueOnce(report(85, true)).mockResolvedValue(report(40));
    mocks.auditPageStyle.mockResolvedValue({
      styleOk: false,
      styleIssues: ["Register drifts into lecture mode.", "Rhythm ignores the opening."]
    });

    const result = await rewritePageForUserRequest(rewriteOptions());

    expect(result.qualityReport).toMatchObject({ approved: false, score: 85, stylePenalty: 30 });
    expect(result.qualityReport.issues).toContain("Register drifts into lecture mode.");
    expect(result.qualityReport.requiredRevisions).toContain("Revise style: Register drifts into lecture mode.");
  });

  it("spends at most two style audits on a page, and gives the next page a fresh budget", async () => {
    // The reviewer approves every rewrite and the audit rejects every one, so
    // nothing but the counter can stop the two gates trading provider calls.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    mocks.auditPageStyle.mockResolvedValue({ styleOk: false, styleIssues: ["Register drifts."] });

    const first = await rewritePageForUserRequest(rewriteOptions());

    // Two, then the third approval stands unaudited and ends the loop.
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);
    expect(first.qualityReport).not.toHaveProperty("stylePenalty");

    // The closure is built once per rewrite, so the next page pays its own.
    await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(4);
  });
});

describe("rewritePageForUserRequest approval inheritance", () => {
  const strategy = { revisePageDraft: vi.fn(), reviewPageDraft: vi.fn() };
  const original = [
    "A warehouse dashboard lists outgoing packages by tracking number, and the clerk needs one of them.",
    "A sequential search inspects the packages one at a time until the number appears or the list ends.",
    "",
    "```pseudocode",
    "search(items, target):",
    "    scan every item",
    "```",
    "",
    "Each comparison discards half of what remains, which is why the ordering matters so much here.",
    "The clerk can therefore trust the answer even when the list grows to many thousands of entries."
  ].join("\n");
  const approved = {
    approved: true,
    score: 91,
    issues: [] as string[],
    requiredRevisions: [] as string[],
    notes: "Reviewer approved.",
    groundedOk: true,
    unsupportedClaims: [] as string[],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: true
    }
  };
  const options = (qualityReport: unknown = approved) =>
    ({
      projectId: "project-1",
      page: {
        id: "page-4",
        index: 4,
        title: "Halving",
        markdown: original,
        summary: "Binary search.",
        imagePrompt: null,
        qualityReport,
        chapterId: null,
        chapter: null
      },
      input: { targetPages: 12, mediaSettings: {}, category: "CUSTOM", language: "en" },
      plan: { title: "Book", chapters: [], voiceGuide: ["Warm and plain."] },
      strategy,
      providers: { text: {} },
      request: "Use JavaScript in the codes",
      editInstruction: "Rewrite every code block in JavaScript; keep the prose unchanged.",
      maxCandidates: 1,
      quality: pagePipelineQualityGates({
        defaultFeatureEnabled: mocks.pageQualityEnabled,
        otherFeatureEnabled: mocks.qualityEnabled
      }),
      generationJobId: "gj-1"
    }) as never;
  const draft = (markdown: string) => ({ title: "Halving", markdown, summary: "Binary search.", continuityNotes: [] as string[] });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.qualityEnabled.mockReturnValue(false);
    mocks.pageQualityEnabled.mockReturnValue(true);
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.loadStyleLockPages.mockResolvedValue([]);
    mocks.prisma.page.findMany.mockResolvedValue([]);
    strategy.reviewPageDraft.mockResolvedValue({ ...approved, approved: false, score: 58, issues: ["restages the previous page"] });
  });
  afterEach(() => vi.clearAllMocks());

  it("inherits the page's standing approval when the rewrite kept its prose", async () => {
    const converted = original.replace(/```pseudocode[\s\S]*?```/, "```javascript\nconst search = () => {};\n```");
    strategy.revisePageDraft.mockResolvedValue(draft(converted));

    const result = await rewritePageForUserRequest(options());

    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(result.markdown).toBe(converted);
    expect(result.qualityReport).toMatchObject({ approved: true, score: 91 });
    expect(result.qualityReport.notes).toContain("inherited");
  });

  it("reviews a rewrite that kept less than the floor, and one of a page that was not approved", async () => {
    strategy.revisePageDraft.mockResolvedValue(draft("A delivery service keeps pickup codes in order. Nothing of the old page survives here."));
    const rewritten = await rewritePageForUserRequest(options());
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
    expect(rewritten.qualityReport.approved).toBe(false);

    vi.clearAllMocks();
    strategy.revisePageDraft.mockResolvedValue(draft(original));
    strategy.reviewPageDraft.mockResolvedValue({ ...approved, approved: false, score: 58 });
    await rewritePageForUserRequest(options({ ...approved, approved: false, score: 58 }));
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
  });

  it("still reviews a faithful rewrite whose new text leaks the prompt", async () => {
    strategy.revisePageDraft.mockResolvedValue(draft(original.replace("Each comparison discards half", "This placeholder page discards half")));

    await rewritePageForUserRequest(options());

    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
  });
});

describe("rewritePageForUserRequest with a figure on the page", () => {
  const strategy = { revisePageDraft: vi.fn(), reviewPageDraft: vi.fn() };
  const fence =
    "```figure\n" +
    JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The ledger" }) +
    "\n```";
  const pageMarkdown = `The clerks counted the carts.\n\n${fence}\n\nThe towns felt it first.`;
  const options = (request: string) =>
    ({
      projectId: "project-1",
      page: { id: "page-3", index: 3, title: "Page 3", markdown: pageMarkdown, summary: "Carts.", imagePrompt: null, chapterId: null, chapter: null },
      input: { targetPages: 12, mediaSettings: {} },
      plan: { title: "Book", chapters: [], voiceGuide: ["Warm and plain."] },
      strategy,
      providers: { text: {} },
      request,
      quality: pagePipelineQualityGates({ defaultFeatureEnabled: mocks.pageQualityEnabled, otherFeatureEnabled: mocks.qualityEnabled }),
      generationJobId: "gj-1"
    }) as never;
  const sent = () => strategy.revisePageDraft.mock.calls[0]![0] as { draft: { markdown: string }; report: { requiredRevisions: string[] } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.qualityEnabled.mockReturnValue(false);
    mocks.pageQualityEnabled.mockReturnValue(true);
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.loadStyleLockPages.mockResolvedValue([]);
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    mocks.prisma.page.findMany.mockResolvedValue([]);
    strategy.reviewPageDraft.mockResolvedValue({ approved: true, score: 85, issues: [], requiredRevisions: [], notes: "", checks: { repetitionOk: true, progressionOk: true } });
  });
  afterEach(() => vi.clearAllMocks());

  it("keeps the figure out of a rewrite that is not about it and puts it back beside its paragraph", async () => {
    strategy.revisePageDraft.mockResolvedValue({
      title: "Page 3",
      markdown: "The clerks counted the carts, slowly and twice.\n\nThe towns felt it first, then the farms.",
      summary: "Carts.",
      imagePrompt: null,
      continuityNotes: []
    });
    const result = await rewritePageForUserRequest(options("make page 3 more dramatic"));
    expect(sent().draft.markdown).toContain("[Figure: Carts by decade]");
    expect(sent().draft.markdown).not.toContain("```figure");
    expect((sent() as { figures?: string }).figures).toBe("hold");
    expect(sent().report.requiredRevisions.join(" ")).not.toContain("fenced figure");
    expect(result.markdown).toBe(`The clerks counted the carts, slowly and twice.\n\n${fence}\n\nThe towns felt it first, then the farms.`);
  });

  it("keeps a request that merely says plot or figure figure-blind, and puts the block back unchanged", async () => {
    // "the plot twist" is a story, not a chart: the exception is for a request
    // that names the chart or diagram, so this one sees the stand-in only.
    strategy.revisePageDraft.mockResolvedValue({
      title: "Page 3",
      markdown: "The clerks counted the carts, and one of them was lying.\n\n[Figure: Carts by decade]\n\nThe towns felt it first.",
      summary: "Carts.",
      imagePrompt: null,
      continuityNotes: []
    });
    const result = await rewritePageForUserRequest(options("strengthen the plot twist on page 3"));
    expect(sent().draft.markdown).toContain("[Figure: Carts by decade]");
    expect(sent().draft.markdown).not.toContain("```figure");
    expect((sent() as { figures?: string }).figures).toBe("hold");
    expect(sent().report.requiredRevisions.join(" ")).not.toContain("fenced figure");
    expect(result.markdown).toBe(`The clerks counted the carts, and one of them was lying.\n\n${fence}\n\nThe towns felt it first.`);
  });

  it("shows the block to a rewrite that quotes the figure's own title", async () => {
    strategy.revisePageDraft.mockResolvedValue({
      title: "Page 3",
      markdown: `The clerks counted the carts.\n\n${fence}\n\nThe towns felt it first.`,
      summary: "Carts.",
      imagePrompt: null,
      continuityNotes: []
    });
    await rewritePageForUserRequest(options("give Carts by Decade a caption about the tolls"));
    expect(sent().draft.markdown).toContain("```figure");
    expect((sent() as { figures?: string }).figures).toBe("keep");
  });

  it("shows the block to a rewrite that names the figure and accepts its absence", async () => {
    strategy.revisePageDraft.mockResolvedValue({
      title: "Page 3",
      markdown: "The clerks counted the carts.\n\nThe towns felt it first.",
      summary: "Carts.",
      imagePrompt: null,
      continuityNotes: []
    });
    const result = await rewritePageForUserRequest(options("drop the chart"));
    expect(sent().draft.markdown).toContain("```figure");
    expect(sent().report.requiredRevisions.join(" ")).toContain("fenced figure JSON block");
    expect(result.markdown).not.toContain("```figure");
    expect(result.markdown).not.toContain("[Figure:");
  });

  it("drops a second figure the model invented beside the one it puts back", async () => {
    // The model saw a stand-in only, so a fence in its reply is an invention;
    // the reinsert used to store the original and the invention side by side.
    const invented = "```figure\n" + JSON.stringify({ kind: "pie", title: "Invented", categories: ["a"], series: [{ name: "S", values: [1] }], source: "nowhere" }) + "\n```";
    strategy.revisePageDraft.mockResolvedValue({
      title: "Page 3",
      markdown: `The clerks counted the carts, slowly.\n\n[Figure: Carts by decade]\n\n${invented}\n\nThe towns felt it first.`,
      summary: "Carts.",
      imagePrompt: null,
      continuityNotes: []
    });
    const result = await rewritePageForUserRequest(options("make page 3 more dramatic"));
    expect(result.markdown).toBe(`The clerks counted the carts, slowly.\n\n${fence}\n\nThe towns felt it first.`);
    expect((sent() as { figures?: string }).figures).toBe("hold");
  });

  it("asks core to keep figures only on the rewrite that names one, on every revise the loop spends", async () => {
    strategy.revisePageDraft.mockResolvedValue({
      title: "Page 3",
      markdown: `The clerks counted the carts.\n\n${fence}\n\nThe towns felt it first.`,
      summary: "Carts.",
      imagePrompt: null,
      continuityNotes: []
    });
    const rejected = { approved: false, score: 40, issues: ["Flat."], requiredRevisions: ["Sharpen."], notes: "", checks: { repetitionOk: true, progressionOk: false } };
    const approved = { approved: true, score: 85, issues: [], requiredRevisions: [], notes: "", checks: { repetitionOk: true, progressionOk: true } };
    strategy.reviewPageDraft.mockResolvedValueOnce(rejected).mockResolvedValue(approved);
    await rewritePageForUserRequest(options("redraw the chart as a pie"));
    const revises = strategy.revisePageDraft.mock.calls.map((call) => (call[0] as { figures?: string }).figures);
    expect(revises.length).toBeGreaterThanOrEqual(2);
    expect(revises.every((figures) => figures === "keep")).toBe(true);

    // A page that never had a figure asks for nothing: core strips whatever the model invents.
    strategy.revisePageDraft.mockClear();
    strategy.reviewPageDraft.mockResolvedValue(approved);
    const plain = options("make page 3 more dramatic");
    (plain as { page: { markdown: string } }).page.markdown = "The clerks counted the carts.\n\nThe towns felt it first.";
    await rewritePageForUserRequest(plain);
    expect(sent()).not.toHaveProperty("figures");
    expect(sent().report.requiredRevisions.join(" ")).not.toContain("fenced figure");
  });

  it("asks core to hold figures on the unnamed rewrite, on every revise the loop spends", async () => {
    strategy.revisePageDraft.mockResolvedValue({
      title: "Page 3",
      markdown: "The clerks counted the carts.\n\n[Figure: Carts by decade]\n\nThe towns felt it first.",
      summary: "Carts.",
      imagePrompt: null,
      continuityNotes: []
    });
    const rejected = { approved: false, score: 40, issues: ["Flat."], requiredRevisions: ["Sharpen."], notes: "", checks: { repetitionOk: true, progressionOk: false } };
    const approved = { approved: true, score: 85, issues: [], requiredRevisions: [], notes: "", checks: { repetitionOk: true, progressionOk: true } };
    strategy.reviewPageDraft.mockResolvedValueOnce(rejected).mockResolvedValue(approved);
    await rewritePageForUserRequest(options("make page 3 more dramatic"));
    const revises = strategy.revisePageDraft.mock.calls.map((call) => (call[0] as { figures?: string }).figures);
    expect(revises.length).toBeGreaterThanOrEqual(2);
    expect(revises.every((figures) => figures === "hold")).toBe(true);
  });
});
