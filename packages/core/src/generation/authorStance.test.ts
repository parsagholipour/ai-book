import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { bookPlanSchema, type CreateProjectInput } from "../schemas/book.js";
import { authorStancePromptLines, generateAuthorStance, planAuthorStance, PLANNER_AUTHOR_STANCE_GUIDANCE, STANCE_RESEARCH_RULE } from "./authorStance.js";
import { sourceResearchFits, supportsBookDevelopment } from "./bookDevelopment.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";

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

  it("accepts a populated stance whose thesis and positions are about evidence", () => {
    // A fresh run used to refuse this on a keyword and shape regex and pay
    // for a regenerated stance. It is schema-valid and populated, so the
    // only questions asked of it are structural.
    const evidenceFocused = bookPlanSchema.parse({
      ...makeFallbackPlan(input),
      authorStance: {
        thesis: "Archaeological evidence shows that organized violence has deep roots, but it does not establish that warfare was constant.",
        positions: [
          "The historical record contains both violence and cooperation, so neither permanent brutality nor an originally peaceful humanity explains the whole past.",
          "The sources for Nataruk are one excavation report and its critics, rather than a settled consensus.",
          "The offices that police a state's own subjects build harm on a scale no feud reaches."
        ],
        refusals: [],
        voiceSample: SAMPLE
      }
    });
    expect(planAuthorStance(evidenceFocused)).toEqual(evidenceFocused.authorStance);
    const flat = bookPlanSchema.parse({
      ...makeFallbackPlan(input),
      authorStance: {
        thesis: "Violence in history is organised before it is felt: someone decides who may be harmed.",
        positions: [
          "The offices that police a state's own subjects build harm on a scale no feud reaches.",
          "Every weapon in this book was pointed by an institution, and the institution is the subject."
        ],
        refusals: [],
        voiceSample: SAMPLE
      }
    });
    expect(planAuthorStance(flat)).toEqual(flat.authorStance);
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

describe("whether a book is written from sources", () => {
  const stanceFor = (research: unknown) => ({ thesis: "Loneliness is a skill.", positions: ["Detail over summary", "The keeper never explains himself"], refusals: [], voiceSample: SAMPLE, research });
  const planWith = (from: CreateProjectInput, research: unknown) => bookPlanSchema.parse({ ...makeFallbackPlan(from), authorStance: stanceFor(research) });

  it("keeps the stance's answer, under its aliases, and reads an unusable one as no answer", () => {
    expect(planWith(input, "none").authorStance?.research).toBe("none");
    expect(planWith(input, " Sources ").authorStance?.research).toBe("sources");
    expect(bookPlanSchema.parse({ ...makeFallbackPlan(input), authorStance: { ...stanceFor(undefined), source_research: "none" } }).authorStance?.research).toBe("none");
    // An answer nobody can use costs the book its research decision, never its stance.
    for (const junk of ["maybe", 3, ["sources"], null]) {
      const plan = planWith(input, junk);
      expect(plan.authorStance?.thesis).toBe("Loneliness is a skill.");
      expect(plan.authorStance?.research).toBeUndefined();
    }
  });

  it("follows the stance over the category, and the writing mode when the stance did not say", () => {
    // A fantasy novel the cue words read as a history (2026-09-30): "era" and "dynasty".
    const fantasy: CreateProjectInput = { ...input, category: "CUSTOM", prompt: "A fantasy novel about the last era of a dying dynasty of dragon riders." };
    expect(supportsBookDevelopment(fantasy, makeFallbackPlan(fantasy))).toBe(true);
    expect(sourceResearchFits(fantasy, planWith(fantasy, "none"))).toBe(false);
    // A fable filed under a nonfiction category.
    const fable: CreateProjectInput = { ...input, category: "BUSINESS", prompt: "A fable about a fox who learns to delegate." };
    expect(sourceResearchFits(fable, planWith(fable, "none"))).toBe(false);
    // A true story filed under Story.
    const trueStory: CreateProjectInput = { ...input, prompt: "The true story of the Apollo 13 rescue." };
    expect(sourceResearchFits(trueStory, planWith(trueStory, "sources"))).toBe(true);
    // No answer: a plan from before the stance was asked.
    expect(sourceResearchFits(input, planWith(input, undefined))).toBe(false);
    expect(sourceResearchFits(fable, planWith(fable, undefined))).toBe(true);
    expect(sourceResearchFits(fable, makeFallbackPlan(fable), { ...stanceFor(undefined), research: "none" })).toBe(false);
    // A picture book is never researched, whatever a stance says.
    const kids: CreateProjectInput = { ...input, category: "KIDS" };
    expect(sourceResearchFits(kids, planWith(kids, "sources"))).toBe(false);
  });

  it("asks the stance call and the planner the same question, doubtful cases answering sources", async () => {
    expect(STANCE_RESEARCH_RULE).toContain('when in doubt, "sources"');
    expect(PLANNER_AUTHOR_STANCE_GUIDANCE.join(" ")).toContain(STANCE_RESEARCH_RULE);
    const seen: GenerateJsonOptions<unknown>[] = [];
    const fake = new FakeTextModelAdapter(input);
    const recording = { ...fake, generateJson: (options: GenerateJsonOptions<unknown>) => { seen.push(options); return fake.generateJson(options); } } as unknown as FakeTextModelAdapter;
    await generateAuthorStance({ input, plan: makeFallbackPlan(input), textModel: recording });
    expect(seen[0]!.messages[0]!.content).toContain(STANCE_RESEARCH_RULE);
    expect(JSON.parse(seen[0]!.messages[1]!.content).outputContract.research).toBe("sources or none");
  });
});
