import { describe, expect, it } from "vitest";
import { bookPlanSchema, bookPlanSchemaWithFallback } from "./plan.js";

/**
 * The style-contract half of the plan schema. `book.test.ts` covers the shared
 * plan tree; these are about the one field group a patch can destroy, because
 * plan arrays replace atomically and a revision is a patch.
 */
describe("plan style-contract fallbacks", () => {
  it("keeps the current plan's contract when a revision emits empty style arrays", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());

    const revised = bookPlanSchemaWithFallback(currentPlan).parse({
      title: "Cooler Cities, Shorter",
      voiceGuide: [],
      antiAiRules: []
    });

    expect(revised.title).toBe("Cooler Cities, Shorter");
    expect(revised.voiceGuide).toEqual(currentPlan.voiceGuide);
    expect(revised.antiAiRules).toEqual(currentPlan.antiAiRules);
  });

  it("keeps it when the emitted rules clean down to nothing", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());

    const revised = bookPlanSchemaWithFallback(currentPlan).parse({
      voiceGuide: ["   ", ""],
      antiAiRules: [""]
    });

    expect(revised.voiceGuide).toEqual(currentPlan.voiceGuide);
    expect(revised.antiAiRules).toEqual(currentPlan.antiAiRules);
  });

  it("still lets a revision replace the contract with real rules", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());

    const revised = bookPlanSchemaWithFallback(currentPlan).parse({
      voiceGuide: ["Write it as a field notebook."]
    });

    expect(revised.voiceGuide).toEqual(["Write it as a field notebook."]);
    expect(revised.antiAiRules).toEqual(currentPlan.antiAiRules);
  });

  it("substitutes the generic contract only when the parse has nothing to fall back on", () => {
    const plan = bookPlanSchema.parse({ ...planWithContract(), voiceGuide: [], antiAiRules: [] });

    // A stored plan whose arrays clean down to nothing must stay readable, or
    // the book it describes cannot be compiled, revised, or continued.
    expect(plan.voiceGuide.join(" ")).toMatch(/natural, specific human voice/);
    expect(plan.antiAiRules.join(" ")).toMatch(/formulaic AI rhetoric/);
  });
});

/**
 * The cap on a style rule's length is where UTF-16 and Postgres disagree: a
 * code-unit slice can leave a lone surrogate, which is a legal JS string and an
 * illegal `jsonb` one — so the plan parsed and then failed at the write.
 */
describe("plan style-rule truncation", () => {
  it("truncates a long rule to the same visible length", () => {
    const plan = bookPlanSchema.parse({ ...planWithContract(), voiceGuide: ["x".repeat(600)] });

    expect(plan.voiceGuide).toEqual(["x".repeat(500)]);
  });

  it("keeps an emoji straddling the cap whole, so the rule is storable", () => {
    const plan = bookPlanSchema.parse({
      ...planWithContract(),
      voiceGuide: [`${"x".repeat(499)}${"\u{1F600}".repeat(4)}`]
    });

    const truncated = plan.voiceGuide[0] ?? "";
    expect(hasLoneSurrogate(truncated)).toBe(false);
    // The bytes Postgres would be handed: encoding a lone surrogate to UTF-8
    // substitutes U+FFFD, so a severed pair cannot survive this round trip.
    expect(Buffer.from(truncated, "utf8").toString("utf8")).toBe(truncated);
    expect([...truncated]).toHaveLength(500);
    expect(truncated.endsWith("\u{1F600}")).toBe(true);
  });

  it("drops a surrogate the model itself sent unpaired", () => {
    const plan = bookPlanSchema.parse({
      ...planWithContract(),
      antiAiRules: ["Never open a chapter with \ud83d a half-written glyph."]
    });

    const rule = plan.antiAiRules[0] ?? "";
    expect(hasLoneSurrogate(rule)).toBe(false);
    expect(Buffer.from(rule, "utf8").toString("utf8")).toBe(rule);
    expect(rule).toContain("Never open a chapter with");
    expect(rule).toContain("a half-written glyph.");
  });
});

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

function planWithContract() {
  return {
    title: "Cooler Cities",
    premise: "A practical science book about cities adapting to extreme heat.",
    audience: "Curious adult readers",
    writingComplexity: 6,
    voiceGuide: [
      "Explain each cooling measure through a street a reader could stand on.",
      "Name the cost of a measure before naming its benefit."
    ],
    antiAiRules: [
      "Never open a chapter with a rhetorical question.",
      "Do not call a retrofit a journey.",
      "No closing paragraph that restates the chapter."
    ],
    chapters: [
      {
        index: 1,
        title: "The Heat We Can Feel",
        summary: "Introduce the stakes.",
        targetPages: 1,
        keyBeats: ["Open with a concrete urban heat example."]
      }
    ],
    illustrationPlan: {
      cadence: "template-driven",
      globalStyle: "Editorial science illustration",
      characterReferencePrompts: [],
      pageRules: []
    }
  };
}
