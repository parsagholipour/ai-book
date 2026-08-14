import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { verifyPageClaims, withClaimVerification } from "./claimVerifier.js";
import { hasResearchIntent } from "./strategies/router.js";
import { runLocalPageQualityChecks } from "./pagesLocalQa.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { unpaidPromiseIssues, applyStoryDelta, seedStoryStateFromPromises, withStoryContradictions } from "./storyState.js";
import { qualityFeatureEnabled } from "./qualityGates.js";

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

  it("gates style and page-map critics to premium and ultra under compiled defaults", () => {
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "fast")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "balanced")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "ultra")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "fast")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "balanced")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "ultra")).toBe(true);
  });
});
