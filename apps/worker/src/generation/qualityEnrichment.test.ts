import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BookPlan,
  CreateProjectInput,
  PageDraft,
  PageQualityReport,
  TextModelAdapter
} from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  loadQualityContext: vi.fn(),
  loadProjectStoryState: vi.fn(),
  rebuildStoryStateFromPages: vi.fn(),
  verifyPageClaims: vi.fn(),
  auditPageStyle: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: mocks.loadQualityContext
}));
vi.mock("./storyStateStore.js", () => ({
  loadProjectStoryState: mocks.loadProjectStoryState,
  rebuildStoryStateFromPages: mocks.rebuildStoryStateFromPages
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  mocks.verifyPageClaims.mockImplementation(actual.verifyPageClaims);
  return {
    ...actual,
    verifyPageClaims: mocks.verifyPageClaims,
    auditPageStyle: mocks.auditPageStyle
  };
});

import {
  mergeEntityAndStoryStateLines,
  revisedDraftStyleAuditor
} from "./qualityEnrichment.js";
import { pageQualityAdvisoryIssues } from "./pageQualityAdvisories.js";

const TARGET_PAGES = 8;

const input: CreateProjectInput = {
  prompt: "A story about Jack.",
  category: "STORY",
  targetPages: TARGET_PAGES,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const plan = {
  title: "The Seal",
  premise: "Jack must find the seal.",
  chapters: [],
  promises: ["Find the seal"]
} as unknown as BookPlan;

const draft: PageDraft = {
  title: "The Seal is Found",
  markdown: "Jack found the seal and closed the vault.",
  summary: "Jack pays the promise.",
  continuityNotes: []
};

const figureFence =
  "```figure\n" +
  JSON.stringify({
    kind: "bar",
    title: "Carts by decade",
    categories: ["1500", "1510"],
    series: [{ name: "Carts", values: [120, 140] }],
    source: "The ledger"
  }) +
  "\n```";

const approvedReport: PageQualityReport = {
  approved: true,
  score: 92,
  issues: [],
  requiredRevisions: [],
  notes: "ok",
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

function styleAuditorEnabled() {
  return {
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => feature === "styleAuditor"
  };
}

function draftWithFigureFence(): PageDraft {
  return {
    ...draft,
    markdown: `Jack found the seal.\n\n${figureFence}\n\nHe closed the vault.`
  };
}

describe("mergeEntityAndStoryStateLines", () => {
  it("keeps both entity-state and story-state lines", () => {
    expect(
      mergeEntityAndStoryStateLines(
        ["Jack (protagonist) — as of page 3: at Oakhaven"],
        ["Promise p1 [open]: Find the seal"]
      )
    ).toEqual([
      "Jack (protagonist) — as of page 3: at Oakhaven",
      "Promise p1 [open]: Find the seal"
    ]);
  });

  it("drops identical lines after the first and skips blanks", () => {
    expect(mergeEntityAndStoryStateLines(["same", "  "], ["same", "other"])).toEqual(["same", "other"]);
  });

  it("returns the other list when one is empty", () => {
    expect(mergeEntityAndStoryStateLines(["a"], [])).toEqual(["a"]);
    expect(mergeEntityAndStoryStateLines([], ["b"])).toEqual(["b"]);
  });
});

describe("revisedDraftStyleAuditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when the gate is off or there is nothing to compare against", () => {
    const base = {
      projectId: "project-1",
      plan,
      textModel: {} as TextModelAdapter,
      quality: styleAuditorEnabled()
    };

    expect(revisedDraftStyleAuditor({ ...base, styleExcerpts: [] })).toBeUndefined();
    expect(
      revisedDraftStyleAuditor({ ...base, styleExcerpts: ["excerpt"], quality: { enabled: () => false } })
    ).toBeUndefined();
  });

  it("stops calling the provider after its per-page budget and lets the approval stand", async () => {
    mocks.auditPageStyle.mockResolvedValue({ styleOk: false, styleIssues: ["Register drifts."] });
    const auditor = revisedDraftStyleAuditor({
      projectId: "project-1",
      plan,
      textModel: {} as TextModelAdapter,
      styleExcerpts: ["excerpt"],
      quality: styleAuditorEnabled()
    });

    // `maxCandidates` bounds revise/review pairs, not these calls: a page the
    // reviewer keeps approving and this audit keeps rejecting would otherwise
    // spend one uncounted provider call per approved revision.
    const first = await auditor!(3, draft, approvedReport);
    const second = await auditor!(3, draft, approvedReport);
    expect(first.approved).toBe(false);
    expect(second.approved).toBe(false);

    const third = await auditor!(3, draft, approvedReport);
    expect(third).toBe(approvedReport);
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);
  });

  it("tells the auditor when the page's change was the reader's own request", async () => {
    // On a paid chat edit a register shift is what was bought, so the audit is
    // told the excerpts are allowed to be departed from exactly that far.
    // Without it "make page 12 more dramatic" is drift against the book's
    // opening pages, and the edit ships FAILED_QA.
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    const auditor = revisedDraftStyleAuditor({
      projectId: "project-1",
      plan,
      textModel: {} as TextModelAdapter,
      styleExcerpts: ["excerpt"],
      quality: styleAuditorEnabled(),
      userRequest: "make page 12 more dramatic"
    });

    await auditor!(12, draft, approvedReport);

    expect(mocks.auditPageStyle).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "make page 12 more dramatic", styleExcerpts: ["excerpt"] })
    );
  });

  it("says nothing about a request on a page nobody asked to change", async () => {
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    const auditor = revisedDraftStyleAuditor({
      projectId: "project-1",
      plan,
      textModel: {} as TextModelAdapter,
      styleExcerpts: ["excerpt"],
      quality: styleAuditorEnabled()
    });

    await auditor!(12, draft, approvedReport);

    expect(mocks.auditPageStyle.mock.calls[0]![0]).not.toHaveProperty("userRequest");
  });

  it("gives every page its own audit budget", async () => {
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    const makeAuditor = () =>
      revisedDraftStyleAuditor({
        projectId: "project-1",
        plan,
        textModel: {} as TextModelAdapter,
        styleExcerpts: ["excerpt"],
        quality: styleAuditorEnabled()
      });

    const pageThree = makeAuditor();
    await pageThree!(3, draft, approvedReport);
    await pageThree!(3, draft, approvedReport);
    await pageThree!(3, draft, approvedReport);
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);

    const pageFour = makeAuditor();
    await pageFour!(4, draft, approvedReport);
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(3);
  });

  it("audits a revised draft from figure-free prose while the stored draft still has the fence", async () => {
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    const storedDraft = draftWithFigureFence();
    const auditor = revisedDraftStyleAuditor({
      projectId: "project-1",
      plan,
      textModel: {} as TextModelAdapter,
      styleExcerpts: ["excerpt"],
      quality: styleAuditorEnabled()
    });

    await auditor!(3, storedDraft, approvedReport);

    expect(mocks.auditPageStyle).toHaveBeenCalledOnce();
    const audited = mocks.auditPageStyle.mock.calls[0]![0] as { markdown: string };
    expect(audited.markdown).toBe("Jack found the seal.\n\nHe closed the vault.");
    expect(audited.markdown).not.toContain("```figure");
    expect(storedDraft.markdown).toContain("```figure");
    expect(storedDraft.markdown).toContain('"kind":"bar"');
  });
});

describe("unavailable page quality checks", () => {
  const options = { input, plan, pageIndex: 3, draft, report: approvedReport, previousPages: [], researchNotes: [],
    textModel: {} as TextModelAdapter, projectId: "project-1", styleExcerpts: ["Opening voice."] };
  it("publishes a revised style check failure as a warning without forcing another rewrite", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.auditPageStyle.mockRejectedValueOnce(new Error("Provider unavailable"));
      const audit = revisedDraftStyleAuditor({ ...options, quality: styleAuditorEnabled() })!;
      const result = await audit(3, draft, approvedReport);
      expect(result.approved).toBe(true);
      expect(result.requiredRevisions).toEqual([]);
      expect(pageQualityAdvisoryIssues([{ index: 3, qualityReport: result }])).toEqual([
        expect.objectContaining({ code: "STYLE_REVIEW_UNVERIFIED", severity: "warning", affectedPageIndexes: [3] })
      ]);
    } finally { warning.mockRestore(); }
  });
  it("propagates AbortError through the revised-draft style audit", async () => {
    const aborted = new DOMException("Cancelled", "AbortError");
    mocks.auditPageStyle.mockRejectedValueOnce(aborted);
    const result = revisedDraftStyleAuditor({ ...options, quality: styleAuditorEnabled() })!(3, draft, approvedReport);
    await expect(result).rejects.toBe(aborted);
  });
});
