import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { verifyPageClaims, withClaimVerification } from "./claimVerifier.js";
import { hasResearchIntent } from "./strategies/router.js";
import { runLocalPageQualityChecks } from "./pagesLocalQa.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { unpaidPromiseIssues, applyStoryDelta, seedStoryStateFromPromises, withStoryContradictions } from "./storyState.js";
import { qualityFeatureEnabled } from "./qualityGates.js";
import { withStyleAudit } from "./styleAuditor.js";
import type { PageQualityReport } from "../schemas/book.js";

function storyInput() {
  return {
    prompt: "A children's fable about a fox who learns to share.",
    category: "KIDS" as const,
    targetPages: 8,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "narrative" as const
    }
  };
}

function factualInput() {
  return {
    prompt: "A scientific history of vaccines with current evidence.",
    category: "SCIENCE" as const,
    targetPages: 12,
    complexity: 6,
    temperature: 0.4,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "scholarly" as const
    }
  };
}

describe("quality eval fixtures", () => {
  it("allows an unpaid promise mid-book and fails it on the last page", () => {
    const state = seedStoryStateFromPromises(["The fox will return the stolen loaf."]);
    expect(unpaidPromiseIssues(state, 4, 8)).toEqual([]);
    expect(unpaidPromiseIssues(state, 8, 8)[0]).toMatch(/Unpaid promise on the final page/);
  });

  it("does not fail the last page when that page's delta pays the promise", () => {
    const seeded = seedStoryStateFromPromises(["The fox will return the stolen loaf."]);
    const paid = applyStoryDelta(
      seeded,
      {
        promisesOpened: [],
        promisesPaid: ["The fox will return the stolen loaf."],
        promisesBroken: [],
        factsAdded: [],
        entities: {},
        unansweredAdded: [],
        unansweredResolved: []
      },
      8
    );
    expect(unpaidPromiseIssues(paid, 8, 8)).toEqual([]);
  });

  it("treats a planted contradiction as a revise reason after extract", () => {
    const merged = withStoryContradictions(
      {
        approved: true,
        issues: [],
        requiredRevisions: []
      },
      ["Ada is in the chapel, but current state places her at the river."]
    );
    expect(merged.approved).toBe(false);
    expect(merged.requiredRevisions.join(" ")).toMatch(/chapel|river/i);
  });

  it("runs the claim verifier only on research-intent books", async () => {
    expect(hasResearchIntent(storyInput())).toBe(false);
    expect(hasResearchIntent(factualInput())).toBe(true);

    const verification = await verifyPageClaims({
      textModel: new FakeTextModelAdapter(),
      pageIndex: 1,
      markdown:
        "A 2019 study in the Journal of Invented Outcomes (Smith et al.) proved that 94% of cases resolved overnight.",
      researchNotes: ["WHO: Vaccine schedules are published by national authorities; no such 2019 journal exists here."]
    });
    // The fake adapter approves dry-run JSON; the fixture still documents the
    // groundedOk field the worker folds into the existing revise loop.
    expect(verification).toEqual(expect.objectContaining({ groundedOk: expect.any(Boolean) }));
    expect(verification.unsupportedClaims).toEqual(expect.any(Array));
  });

  it("fails groundedOk when unsupported claims are present", () => {
    const merged = withClaimVerification(
      {
        approved: true,
        score: 90,
        issues: [],
        requiredRevisions: [],
        notes: "ok",
        checks: {
          placeholderFree: true,
          promptLeakFree: true,
          titleClean: true,
          repetitionOk: true,
          progressionOk: true,
          styleNatural: true
        }
      },
      {
        groundedOk: false,
        unsupportedClaims: ["Invented Journal of Invented Outcomes, Smith et al. 2019"]
      }
    );
    expect(merged.groundedOk).toBe(false);
    expect(merged.approved).toBe(false);
    expect(merged.unsupportedClaims[0]).toMatch(/Invented Journal/);
  });

  it("still fires the local slop regex", () => {
    const plan = makeFallbackPlan(storyInput());
    const report = runLocalPageQualityChecks({
      input: storyInput(),
      plan,
      pageIndex: 1,
      draft: {
        title: "The Spiritual Argument",
        markdown:
          "Maryam's story matters because the text gives her an unusual clarity. This is not a coincidence; it is a divine indication of your spiritual superiority.",
        summary: "A formulaic proof-leap.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: new FakeTextModelAdapter()
    });
    expect(report.approved).toBe(false);
    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/proof-leap/i);
    expect(report.groundedOk).toBe(true);
    expect(report.unsupportedClaims).toEqual([]);
  });

  it("rejects a page that announces the chapter's agenda instead of covering it", () => {
    const input = factualInput();
    const report = runLocalPageQualityChecks({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: 2,
      draft: {
        title: "The Long History of Inoculation",
        markdown:
          "In this chapter, we will explore how variolation traveled from folk practice into court medicine. Physicians recorded outcomes in ledgers, and the ledgers changed hands faster than the technique itself. A Boston sermon defended the method in 1721 while the town's own newspaper attacked it, and both sides quoted the same mortality counts to opposite ends. The numbers did not settle the argument, but they moved it out of the pulpit and into print, where a reader could check them.",
        summary: "Variolation's spread into court medicine and the Boston controversy.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: new FakeTextModelAdapter()
    });

    expect(report.approved).toBe(false);
    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/announces what the chapter will cover/i);
  });

  it("rejects a page built on the everyday 'not just X, it's Y' formula, but allows one instance", () => {
    // The adult input: a kids book's sentence-length gates would flip
    // styleNatural on their own and mask what this test measures.
    const input = factualInput();
    const plan = makeFallbackPlan(input);
    const base = {
      input,
      plan,
      pageIndex: 3,
      previousPages: [],
      continuityNotes: [],
      textModel: new FakeTextModelAdapter()
    };
    const overused = runLocalPageQualityChecks({
      ...base,
      draft: {
        title: "The Garden Promise",
        markdown:
          "The fox studied the little plot behind the fence and decided it mattered more than any den. The garden wasn't just a patch of soil. It was a promise the whole burrow had made to the winter. When the first carrots came up crooked, the fox laughed and kept digging anyway, because the harvest was not merely food; it was proof that staying put could feed a family better than running ever had.",
        summary: "The fox commits to the shared garden as the burrow's promise.",
        continuityNotes: []
      }
    });
    const singleUse = runLocalPageQualityChecks({
      ...base,
      draft: {
        title: "The Crooked Carrots",
        markdown:
          "The fox studied the little plot behind the fence and decided it mattered more than any den. The garden wasn't just a patch of soil to him anymore. He counted the crooked carrots twice, traded three of them to the magpie for a bent watering can, and spent the evening straightening the fence post the storm had leaned over. By dark the rows looked almost deliberate, and the fox slept beside the gate to make sure they stayed that way.",
        summary: "The fox works the garden and guards it overnight.",
        continuityNotes: []
      }
    });

    expect(overused.checks.styleNatural).toBe(false);
    expect(overused.issues.join(" ")).toMatch(/not just X, it's Y/i);
    expect(singleUse.checks.styleNatural).toBe(true);
  });

  it("catches the model apology prompt leak in Persian", () => {
    const input = storyInput();
    const report = runLocalPageQualityChecks({
      input: { ...input, language: "fa" },
      plan: makeFallbackPlan(input),
      pageIndex: 1,
      draft: {
        title: "روباه و باغ",
        markdown:
          "به عنوان یک مدل زبانی، نمی‌توانم داستان کامل را بنویسم، اما روباه هر روز صبح کنار باغ می‌نشست و به هویج‌های کج نگاه می‌کرد و به زمستان فکر می‌کرد.",
        summary: "روباه کنار باغ می‌نشیند.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: new FakeTextModelAdapter()
    });

    expect(report.approved).toBe(false);
    expect(report.checks.promptLeakFree).toBe(false);
  });

  it("counts CJK prose by characters so a normal Chinese page passes the length gate", () => {
    const input = factualInput();
    const sentence = "疫苗的历史比许多人想象的更加曲折，各地医生在没有统一标准的情况下记录接种结果，并把这些记录寄给远方的同行。";
    const report = runLocalPageQualityChecks({
      input: { ...input, language: "zh" },
      plan: makeFallbackPlan(input),
      pageIndex: 2,
      draft: {
        title: "早期接种记录",
        // ~270 characters: a normal-length page whose run count (a handful of
        // punctuation-separated clauses) used to fail the 90-word floor and
        // burn the whole revision budget on a false "too short".
        markdown: `${sentence}${sentence}${sentence}${sentence}${sentence}`,
        summary: "早期接种记录如何在医生之间流通。",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: new FakeTextModelAdapter()
    });

    expect(report.checks.progressionOk).toBe(true);
    expect(report.issues.join(" ")).not.toMatch(/too short/i);
  });

  it("withStyleAudit records its penalty beside the score while flipping approval", () => {
    const report: PageQualityReport = {
      approved: true,
      score: 90,
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
    const audited = withStyleAudit(report, {
      styleOk: false,
      styleIssues: ["Register shifts into lecture mode.", "Ignores the pinned excerpts' rhythm."]
    });

    // The penalty rides beside the score rather than inside it: only audited
    // candidates are penalized, so a lowered `score` handed the keeper's seat
    // to rejected rewrites the auditor never saw (styleAuditor.test.ts).
    expect(audited.approved).toBe(false);
    expect(audited.score).toBe(90);
    expect(audited.stylePenalty).toBe(30);
    expect(audited.checks.styleNatural).toBe(false);
  });

  it("gates the style auditor to every tier but fast, and the page-map critic to premium and ultra", () => {
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "fast")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "balanced")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "ultra")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "fast")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "balanced")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "ultra")).toBe(true);
  });
});
