import { describe, expect, it } from "vitest";
import { bookPlanModelOutputSchemaWithFallback, bookPlanSchema, bookPlanSchemaWithFallback } from "./plan.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { developmentInput } from "../generation/testing/bookDevelopmentFixtures.js";

/**
 * Initial planning only: a planner that filed the book's real chapters inside
 * `authorStance` used to have them dropped and the generic fallback outline
 * published as the book's plan. Recovery lifts a misfiled book-level field, and
 * the initial schema never inherits the fallback's chapters.
 */

function fallbackPlan() {
  return makeFallbackPlan({ ...developmentInput, targetPages: 120 });
}

function authoredChapters() {
  return [
    { index: 1, title: "What Counts as Evidence?", summary: "The working distinctions.", targetPages: 3, keyBeats: ["Open on a disputed exhibit."] },
    { index: 2, title: "The Jury's Afternoon", summary: "One deliberation, hour by hour.", targetPages: 7, keyBeats: ["Follow a single vote change."] },
    { index: 3, title: "After the Appeal", summary: "What survives review.", targetPages: 2, keyBeats: ["Read the reversal itself."] }
  ];
}

function stanceFields() {
  return {
    thesis: "Verdicts are provisional until review closes.",
    positions: ["A verdict is an argument, not a fact."],
    refusals: ["No invented case law."],
    voiceSample: "A tide table is a promise the sea keeps unevenly."
  };
}

/** The root fields a planner answered beside the misfiled stance object. */
function answeredRoot() {
  return {
    title: "Provisional",
    premise: "How appeals change judgments.",
    audience: "General readers",
    writingComplexity: 6,
    voiceGuide: ["Write like a court reporter with a memory."],
    antiAiRules: ["No stock transitions."],
    questions: [],
    openingHook: "The clerk reads a verdict nobody in the room believes yet."
  };
}

describe("initial plan recovery from a misfiled authorStance", () => {
  it("lifts authored chapters and the other book-level fields out of the stance object", () => {
    const chapters = authoredChapters();
    const parsed = bookPlanModelOutputSchemaWithFallback(fallbackPlan()).parse({
      ...answeredRoot(),
      authorStance: {
        ...stanceFields(),
        chapters,
        promises: ["Say what an appeal costs."],
        characters: [{ name: "Judge Ash", role: "Presiding", description: "Reads slowly.", traits: [], visualRules: [] }],
        continuityRules: ["Dates come from the record."],
        writingMode: "analytical-history",
        styleContract: { localRules: [{ id: "no-invented-evidence", instruction: "Do not invent evidence." }] },
        nestedJunk: "not a plan field"
      }
    });

    expect(parsed.chapters).toEqual(chapters);
    expect(parsed.promises).toEqual(["Say what an appeal costs."]);
    expect(parsed.characters.map((character) => character.name)).toEqual(["Judge Ash"]);
    expect(parsed.continuityRules).toEqual(["Dates come from the record."]);
    expect(parsed.writingMode).toBe("analytical-history");
    expect(parsed.styleContract?.localRules[0]?.id).toBe("no-invented-evidence");
    expect(parsed.authorStance).toEqual(stanceFields());
    expect(JSON.stringify(parsed)).not.toContain("nestedJunk");
  });

  it("keeps a root chapters array and ignores a different nested one", () => {
    const chapters = authoredChapters();
    const parsed = bookPlanModelOutputSchemaWithFallback(fallbackPlan()).parse({
      ...answeredRoot(),
      chapters,
      authorStance: {
        ...stanceFields(),
        chapters: [{ index: 1, title: "Never used", summary: "Nested loser.", targetPages: 120, keyBeats: [] }]
      }
    });

    expect(parsed.chapters).toEqual(chapters);
  });

  it("does not rescue a root chapters answer that is empty or malformed", () => {
    const nested = { ...stanceFields(), chapters: authoredChapters() };

    expect(bookPlanModelOutputSchemaWithFallback(fallbackPlan()).safeParse({
      ...answeredRoot(),
      chapters: [],
      authorStance: nested
    }).success).toBe(false);

    expect(bookPlanModelOutputSchemaWithFallback(fallbackPlan()).safeParse({
      ...answeredRoot(),
      chapters: "one chapter per idea",
      authorStance: nested
    }).success).toBe(false);
  });

  it("fails rather than inheriting the fallback's chapters when the answer has none", () => {
    const fallback = fallbackPlan();
    expect(fallback.chapters.length).toBeGreaterThan(0);

    expect(bookPlanModelOutputSchemaWithFallback(fallback).safeParse({
      ...answeredRoot(),
      authorStance: stanceFields()
    }).success).toBe(false);

    expect(bookPlanModelOutputSchemaWithFallback(fallback).safeParse({
      ...answeredRoot(),
      chapters: [],
      authorStance: stanceFields()
    }).success).toBe(false);
  });

  it("leaves plan revisions alone: they keep prior chapters and never lift nested ones", () => {
    const currentPlan = bookPlanSchema.parse({ ...fallbackPlan(), chapters: authoredChapters() });

    const omitted = bookPlanSchemaWithFallback(currentPlan).parse({ title: "Provisional, Shorter" });
    expect(omitted.title).toBe("Provisional, Shorter");
    expect(omitted.chapters).toEqual(currentPlan.chapters);

    const nested = bookPlanSchemaWithFallback(currentPlan).parse({
      authorStance: {
        ...stanceFields(),
        chapters: [{ index: 1, title: "Nested revision", summary: "Not lifted.", targetPages: 12, keyBeats: [] }]
      }
    });
    expect(nested.chapters).toEqual(currentPlan.chapters);
  });

  it("still accepts a recognised wrapper carrying the plan", () => {
    const chapters = authoredChapters();
    const parsed = bookPlanModelOutputSchemaWithFallback(fallbackPlan()).parse({
      generationPlan: { ...answeredRoot(), chapters, authorStance: stanceFields() }
    });

    expect(parsed.chapters).toEqual(chapters);
    expect(parsed.title).toBe("Provisional");
  });

  it("does not let a nested researchNotes reach the initial model-output result", () => {
    const parsed = bookPlanModelOutputSchemaWithFallback(fallbackPlan()).parse({
      ...answeredRoot(),
      authorStance: {
        ...stanceFields(),
        chapters: authoredChapters(),
        researchNotes: [{ query: "appeals", title: "Invented source", summary: "Reproduced by the model." }]
      }
    });

    expect(parsed).not.toHaveProperty("researchNotes");
  });
});
