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
  extractStoryState: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: mocks.loadQualityContext
}));
vi.mock("./storyStateStore.js", () => ({
  loadProjectStoryState: mocks.loadProjectStoryState,
  persistPageStoryDelta: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    extractStoryState: mocks.extractStoryState
  };
});

import { enrichPageQualityReport, mergeEntityAndStoryStateLines } from "./qualityEnrichment.js";

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
      projectId: "project-1"
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
      projectId: "project-1"
    });

    expect(result.report.approved).toBe(false);
    expect(result.report.issues).toContain("Unpaid promise on the final page: Find the seal");
  });
});
