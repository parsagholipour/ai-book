import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { bookPlanSchema, type CreateProjectInput } from "../schemas/book.js";
import { authorStancePromptLines, planAuthorStance } from "./authorStance.js";

const input: CreateProjectInput = {
  prompt: "A novel about a lighthouse keeper.",
  category: "STORY",
  targetPages: 20,
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

const SAMPLE = Array.from(
  { length: 12 },
  (_, index) => `On the ${index + 1}th of March the keeper at Ardnamurchan wrote the wind in the log and the number of ships he counted.`
).join(" ");

describe("authorStance on the plan", () => {
  it("parses a well-formed stance and tolerates aliases and loose arrays", () => {
    const plan = bookPlanSchema.parse({
      ...makeFallbackPlan(input),
      author_stance: {
        thesis: " Loneliness is a skill. ",
        stands: ["Detail over summary", "The keeper never explains himself"],
        refuses: ["No scene ends on a reflection", "", 3],
        voice_sample: SAMPLE
      }
    });
    expect(plan.authorStance).toEqual({
      thesis: "Loneliness is a skill.",
      positions: ["Detail over summary", "The keeper never explains himself"],
      refusals: ["No scene ends on a reflection"],
      voiceSample: SAMPLE
    });
    expect(planAuthorStance(plan)).toEqual(plan.authorStance);
  });

  it("treats a stance with no positions or a thin sample as one to regenerate", () => {
    const noPositions = bookPlanSchema.parse({
      ...makeFallbackPlan(input),
      authorStance: { thesis: "T", positions: [], refusals: ["R"], voiceSample: SAMPLE }
    });
    expect(noPositions.authorStance?.positions).toEqual([]);
    expect(planAuthorStance(noPositions)).toBeUndefined();
    const thinSample = bookPlanSchema.parse({
      ...makeFallbackPlan(input),
      authorStance: { thesis: "T", positions: ["A", "B"], refusals: [], voiceSample: "The lamp turned. He counted." }
    });
    expect(planAuthorStance(thinSample)).toBeUndefined();
  });

  it("reads positions the planner spelled as believes/rejects objects", () => {
    const plan = bookPlanSchema.parse({
      ...makeFallbackPlan(input),
      authorStance: {
        thesis: "T",
        positions: [
          { believes: "Violence must be disaggregated before causes are assessed.", rejects: "That every use of force is one expression of aggression." },
          "A plain string position.",
          { statement: "A stand under another key." }
        ],
        refusals: [{ refusal: "No section ends by balancing both sides." }],
        voiceSample: "V"
      }
    });
    // The rejected view is dropped, never joined on: composed-6 was written
    // rebutting the "positions" because the fallback had handed it those.
    expect(plan.authorStance?.positions).toEqual([
      "Violence must be disaggregated before causes are assessed.",
      "A plain string position.",
      "A stand under another key."
    ]);
    expect(plan.authorStance?.refusals).toEqual(["No section ends by balancing both sides."]);
  });

  it("degrades a malformed stance to none rather than failing the plan", () => {
    const plan = bookPlanSchema.parse({ ...makeFallbackPlan(input), authorStance: { thesis: "Only a thesis" } });
    expect(plan.authorStance).toBeUndefined();
    expect(planAuthorStance(plan)).toBeUndefined();
    expect(bookPlanSchema.parse({ ...makeFallbackPlan(input), authorStance: "a string" }).authorStance).toBeUndefined();
  });

  it("renders prompt lines that name the story's spine for fiction and the argument otherwise", () => {
    const stance = { thesis: "T", positions: ["P"], refusals: [], voiceSample: "V" };
    expect(authorStancePromptLines(stance, "narrative")[0]).toContain("story's author");
    expect(authorStancePromptLines(stance, "analytical-history")[0]).toContain("book's author");
    expect(authorStancePromptLines(stance, "narrative").some((line) => line.includes("Habits you refuse"))).toBe(false);
  });
});

import { chapterPosition } from "./authorStance.js";

describe("chapterPosition", () => {
  it("rotates one position per chapter and shows the writer only that one", () => {
    const stance = {
      thesis: "T",
      positions: ["First lens.", "Second lens.", "Third lens."],
      refusals: [],
      voiceSample: "V"
    };
    expect([1, 2, 3, 4].map((index) => chapterPosition(stance, index))).toEqual(["First lens.", "Second lens.", "Third lens.", "First lens."]);
    const lines = authorStancePromptLines(stance, "analytical-history", { chapterIndex: 2 }).join(" ");
    expect(lines).toContain("Second lens.");
    expect(lines).not.toContain("First lens.");
    expect(authorStancePromptLines(stance, "analytical-history").join(" ")).toContain("First lens. | Second lens. | Third lens.");
  });
});
