import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BookPlan,
  CreateProjectInput,
  PageDraft,
  PageQualityReport,
  StoryDelta,
  StoryExtractResult,
  StoryState,
  TextModelAdapter
} from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  loadQualityContext: vi.fn(),
  loadProjectStoryState: vi.fn(),
  rebuildStoryStateFromPages: vi.fn(),
  persistPageStoryDelta: vi.fn(),
  extractStoryState: vi.fn(),
  auditPageStyle: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: mocks.loadQualityContext
}));
vi.mock("./storyStateStore.js", () => ({
  loadProjectStoryState: mocks.loadProjectStoryState,
  rebuildStoryStateFromPages: mocks.rebuildStoryStateFromPages,
  persistPageStoryDelta: mocks.persistPageStoryDelta
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    extractStoryState: mocks.extractStoryState,
    auditPageStyle: mocks.auditPageStyle
  };
});

import {
  enrichPageQualityReport,
  mergeEntityAndStoryStateLines,
  persistKeeperStoryDelta,
  revisedDraftStyleAuditor
} from "./qualityEnrichment.js";

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

const factualInput: CreateProjectInput = {
  ...input,
  prompt: "A scientific history of vaccines with current evidence.",
  category: "SCIENCE",
  mediaSettings: {
    ...input.mediaSettings,
    toneProfile: "scholarly"
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

const openPromiseState: StoryState = {
  promises: [
    {
      id: "p1",
      text: "Find the seal",
      status: "open",
      openedAtPage: 1
    }
  ],
  facts: [],
  entities: {},
  unanswered: []
};

const emptyDelta = (overrides: Partial<StoryDelta> = {}): StoryDelta => ({
  promisesOpened: [],
  promisesPaid: [],
  promisesBroken: [],
  factsAdded: [],
  entities: {},
  unansweredAdded: [],
  unansweredResolved: [],
  ...overrides
});

const extractPayingP1: StoryExtractResult = {
  storyDelta: emptyDelta({ promisesPaid: ["p1"] }),
  contradictions: []
};

function storyExtractEnabled() {
  return {
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => feature === "storyExtractAudit"
  };
}

function claimVerifierEnabled() {
  return {
    settings: {},
    tier: "premium",
    enabled: (feature: string) => feature === "claimVerifier"
  };
}

describe("enrichPageQualityReport claim grounding", () => {
  it("records claim verification as not applicable for a story", async () => {
    const generateJson = vi.fn();

    const result = await enrichPageQualityReport({
      input,
      plan,
      pageIndex: 1,
      draft,
      report: { ...approvedReport, groundedOk: false },
      previousPages: [],
      researchNotes: ["Archive note: A source-backed detail."],
      textModel: { generateJson } as unknown as TextModelAdapter,
      projectId: "project-1",
      quality: claimVerifierEnabled(),
      storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
      styleExcerpts: []
    });

    expect(generateJson).not.toHaveBeenCalled();
    expect(result.report).toMatchObject({
      approved: true,
      groundedOk: true,
      groundingStatus: "not_applicable"
    });
  });

  it("records missing evidence without calling the verifier or creating a rewrite reason", async () => {
    const generateJson = vi.fn();

    const result = await enrichPageQualityReport({
      input: factualInput,
      plan,
      pageIndex: 1,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: [],
      textModel: { generateJson } as unknown as TextModelAdapter,
      projectId: "project-1",
      quality: claimVerifierEnabled(),
      storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
      styleExcerpts: []
    });

    expect(generateJson).not.toHaveBeenCalled();
    expect(result.report).toMatchObject({
      approved: true,
      groundedOk: true,
      groundingStatus: "unverified_no_sources",
      unsupportedClaims: [],
      issues: [],
      requiredRevisions: []
    });
  });

  it("does not treat blank research notes as source-backed evidence", async () => {
    const generateJson = vi.fn();

    const result = await enrichPageQualityReport({
      input: factualInput,
      plan,
      pageIndex: 1,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: ["   "],
      textModel: { generateJson } as unknown as TextModelAdapter,
      projectId: "project-1",
      quality: claimVerifierEnabled(),
      storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
      styleExcerpts: []
    });

    expect(generateJson).not.toHaveBeenCalled();
    expect(result.report.groundingStatus).toBe("unverified_no_sources");
  });

  it("keeps verifying factual pages when source-backed evidence is available", async () => {
    const generateJson = vi.fn().mockResolvedValue({
      data: { groundedOk: true, unsupportedClaims: [] },
      text: "{}",
      model: "test-model",
      provider: "test"
    });

    const result = await enrichPageQualityReport({
      input: factualInput,
      plan,
      pageIndex: 1,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: ["WHO vaccine history: Source-backed chronology."],
      textModel: { generateJson } as unknown as TextModelAdapter,
      projectId: "project-1",
      quality: claimVerifierEnabled(),
      storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
      styleExcerpts: []
    });

    expect(generateJson).toHaveBeenCalledOnce();
    expect(result.report).toMatchObject({
      approved: true,
      groundedOk: true,
      groundingStatus: "verified",
      unsupportedClaims: []
    });
  });

  it("keeps rejecting unsupported claims when source-backed evidence is available", async () => {
    const generateJson = vi.fn().mockResolvedValue({
      data: { groundedOk: false, unsupportedClaims: ["The invented 94% result."] },
      text: "{}",
      model: "test-model",
      provider: "test"
    });

    const result = await enrichPageQualityReport({
      input: factualInput,
      plan,
      pageIndex: 1,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: ["WHO vaccine history: Source-backed chronology."],
      textModel: { generateJson } as unknown as TextModelAdapter,
      projectId: "project-1",
      quality: claimVerifierEnabled(),
      storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
      styleExcerpts: []
    });

    expect(generateJson).toHaveBeenCalledOnce();
    expect(result.report).toMatchObject({
      approved: false,
      groundedOk: false,
      groundingStatus: "failed",
      unsupportedClaims: ["The invented 94% result."]
    });
    expect(result.report.requiredRevisions).toContain("Ground or remove: The invented 94% result.");
  });

  it("records verifier outages as unavailable without rejecting the page", async () => {
    const generateJson = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await enrichPageQualityReport({
      input: factualInput,
      plan,
      pageIndex: 1,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: ["WHO vaccine history: Source-backed chronology."],
      textModel: { generateJson } as unknown as TextModelAdapter,
      projectId: "project-1",
      quality: claimVerifierEnabled(),
      storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
      styleExcerpts: []
    });
    warn.mockRestore();

    expect(generateJson).toHaveBeenCalledOnce();
    expect(result.report).toMatchObject({
      approved: true,
      groundedOk: true,
      groundingStatus: "unavailable",
      unsupportedClaims: []
    });
  });
});

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

describe("enrichPageQualityReport unpaid promises", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadQualityContext.mockResolvedValue(storyExtractEnabled());
    mocks.loadProjectStoryState.mockResolvedValue(openPromiseState);
    mocks.rebuildStoryStateFromPages.mockResolvedValue(openPromiseState);
  });

  it("does not block the last page when this page's extract pays the open promise", async () => {
    mocks.extractStoryState.mockResolvedValue(extractPayingP1);

    const result = await enrichPageQualityReport({
      input,
      plan,
      pageIndex: TARGET_PAGES,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: [],
      textModel: {} as TextModelAdapter,
      projectId: "project-1",
      styleExcerpts: []
    });

    expect(result.report.approved).toBe(true);
    expect(result.report.issues.join(" ")).not.toMatch(/Unpaid promise/);
    expect(mocks.extractStoryState).toHaveBeenCalledOnce();
  });

  it("still flags an unpaid promise on the last page when the extract does not pay it", async () => {
    mocks.extractStoryState.mockResolvedValue({
      storyDelta: emptyDelta(),
      contradictions: []
    });

    const result = await enrichPageQualityReport({
      input,
      plan,
      pageIndex: TARGET_PAGES,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: [],
      textModel: {} as TextModelAdapter,
      projectId: "project-1",
      styleExcerpts: []
    });

    expect(result.report.approved).toBe(false);
    expect(result.report.issues).toContain("Unpaid promise on the final page: Find the seal");
  });

  it("does not flag unpaid after rebuild-from-pages when a sibling page already paid it", async () => {
    mocks.extractStoryState.mockResolvedValue({
      storyDelta: emptyDelta(),
      contradictions: []
    });
    mocks.rebuildStoryStateFromPages.mockResolvedValue({
      promises: [
        {
          id: "p1",
          text: "Find the seal",
          status: "paid",
          openedAtPage: 1,
          paidAtPage: 7
        }
      ],
      facts: [],
      entities: {},
      unanswered: []
    });

    const result = await enrichPageQualityReport({
      input,
      plan,
      pageIndex: TARGET_PAGES,
      draft,
      report: approvedReport,
      previousPages: [],
      researchNotes: [],
      textModel: {} as TextModelAdapter,
      projectId: "project-1",
      quality: storyExtractEnabled(),
      storyState: openPromiseState,
      styleExcerpts: []
    });

    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
    expect(mocks.loadProjectStoryState).not.toHaveBeenCalled();
    expect(mocks.rebuildStoryStateFromPages).toHaveBeenCalledWith("project-1", ["Find the seal"]);
    expect(result.report.approved).toBe(true);
    expect(result.report.issues.join(" ")).not.toMatch(/Unpaid promise/);
  });
});

describe("revisedDraftStyleAuditor", () => {
  const styleAuditorEnabled = () => ({
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => feature === "styleAuditor"
  });

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
      revisedDraftStyleAuditor({ ...base, styleExcerpts: ["excerpt"], quality: storyExtractEnabled() })
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
});

describe("persistKeeperStoryDelta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadQualityContext.mockResolvedValue(storyExtractEnabled());
    mocks.persistPageStoryDelta.mockResolvedValue(openPromiseState);
  });

  it("does not reload quality when the caller already passed it", async () => {
    mocks.extractStoryState.mockResolvedValue(extractPayingP1);

    await persistKeeperStoryDelta({
      projectId: "project-1",
      pageIndex: 1,
      draft,
      textModel: {} as TextModelAdapter,
      plan,
      input,
      previousExtract: extractPayingP1,
      keeperWasRevised: false,
      currentState: openPromiseState,
      quality: storyExtractEnabled()
    });

    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
    expect(mocks.persistPageStoryDelta).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", pageIndex: 1 })
    );
  });
});
