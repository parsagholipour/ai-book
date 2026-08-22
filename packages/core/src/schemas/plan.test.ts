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

describe("plan openingHook", () => {
  it("round-trips the field and accepts the snake_case and bare-hook aliases", () => {
    const hook = "Open on the surveyor standing in a dry reservoir that should be forty feet deep.";
    expect(bookPlanSchema.parse({ ...planWithContract(), openingHook: hook }).openingHook).toBe(hook);
    expect(bookPlanSchema.parse({ ...planWithContract(), opening_hook: hook }).openingHook).toBe(hook);
    expect(bookPlanSchema.parse({ ...planWithContract(), hook }).openingHook).toBe(hook);
  });

  it("parses a stored plan without the field and degrades a non-string hook to none", () => {
    expect(bookPlanSchema.parse(planWithContract()).openingHook).toBeUndefined();
    // A model answering the hook as a list must cost the hook, not the plan.
    expect(bookPlanSchema.parse({ ...planWithContract(), openingHook: ["a", "b"] }).openingHook).toBeUndefined();
  });

  it("stores the trimmed hook and reads a blank one as no hook", () => {
    const hook = "Open on the surveyor standing in a dry reservoir that should be forty feet deep.";

    expect(bookPlanSchema.parse({ ...planWithContract(), openingHook: `  ${hook}  ` }).openingHook).toBe(hook);
    // Every consumer gates on truthiness, so a blank hook is a hook nobody can
    // use; it may as well not have been sent.
    expect(bookPlanSchema.parse({ ...planWithContract(), openingHook: "   " }).openingHook).toBeUndefined();
  });

  it("keeps the current plan's hook when a revision omits it", () => {
    const hook = "Open on the surveyor standing in a dry reservoir that should be forty feet deep.";
    const currentPlan = bookPlanSchema.parse({ ...planWithContract(), openingHook: hook });

    const revised = bookPlanSchemaWithFallback(currentPlan).parse({ title: "Cooler Cities, Shorter" });

    expect(revised.openingHook).toBe(hook);
  });
});

/**
 * A revision is merged onto the plan it patches, and a parsed plan always spells
 * its fields canonically — so an aliased answer used to lose the first-match
 * lookup to the very value it was sent to replace.
 */
describe("plan revision aliases against a fallback", () => {
  const currentHook = "Open on the surveyor standing in a dry reservoir that should be forty feet deep.";
  const newHook = "Open on the night the grid held and the heat did not.";

  function planWithHook() {
    return bookPlanSchema.parse({ ...planWithContract(), openingHook: currentHook });
  }

  it("lets an aliased hook replace the current plan's hook", () => {
    for (const revision of [{ opening_hook: newHook }, { hook: newHook }]) {
      expect(bookPlanSchemaWithFallback(planWithHook()).parse(revision).openingHook).toBe(newHook);
    }
  });

  it("keeps the current hook when the revision says nothing about it", () => {
    const revised = bookPlanSchemaWithFallback(planWithHook()).parse({ title: "Cooler Cities, Shorter" });

    expect(revised.openingHook).toBe(currentHook);
  });

  it("keeps the current hook rather than lose it to a non-string answer, under any spelling", () => {
    // The canonical spelling is the one the planner prompt asks for, so it is
    // the one a bad answer arrives under most often.
    for (const revision of [{ openingHook: ["a", "b"] }, { opening_hook: ["a", "b"] }, { hook: { text: newHook } }]) {
      expect(bookPlanSchemaWithFallback(planWithHook()).parse(revision).openingHook).toBe(currentHook);
    }
  });

  it("keeps the current hook rather than let a blank answer wipe it", () => {
    for (const revision of [{ openingHook: "" }, { opening_hook: "   " }, { hook: "" }]) {
      expect(bookPlanSchemaWithFallback(planWithHook()).parse(revision).openingHook).toBe(currentHook);
    }
  });

  it("lets an aliased writing complexity replace the current plan's level", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());
    expect(currentPlan.writingComplexity).toBe(6);

    for (const revision of [{ complexity: 9 }, { writing_complexity: 9 }, { writingLevel: "9" }, { readingLevel: 9 }]) {
      expect(bookPlanSchemaWithFallback(currentPlan).parse(revision).writingComplexity).toBe(9);
    }
  });

  it("keeps the current level when the revision says nothing about it", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());

    const revised = bookPlanSchemaWithFallback(currentPlan).parse({ title: "Cooler Cities, Shorter" });

    expect(revised.writingComplexity).toBe(6);
  });

  it("keeps the current level when the aliased answer is not a level at all", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());

    // "grade 5" coerces to NaN. Promoting it would cost the revision its whole
    // parse; the field the model could not spell a value for stays as it was.
    const revised = bookPlanSchemaWithFallback(currentPlan).parse({ readingLevel: "grade 5" });

    expect(revised.writingComplexity).toBe(6);
  });

  it("keeps the current level when the canonical key carries the unusable answer", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());

    // `writingComplexity` is required, so an answer the object schema rejects
    // does not merely lose the field — it loses the whole revision.
    for (const revision of [{ writingComplexity: "grade 5" }, { writingComplexity: 0 }, { writingComplexity: 12 }]) {
      expect(bookPlanSchemaWithFallback(currentPlan).parse(revision).writingComplexity).toBe(6);
    }
  });

  it("promotes exactly the levels the object schema would accept", () => {
    const currentPlan = bookPlanSchema.parse(planWithContract());

    for (const level of [1, 10]) {
      expect(bookPlanSchemaWithFallback(currentPlan).parse({ complexity: level }).writingComplexity).toBe(level);
    }
    for (const level of [0, 11, 6.5]) {
      expect(bookPlanSchemaWithFallback(currentPlan).parse({ complexity: level }).writingComplexity).toBe(6);
    }
  });

  it("still reads an alias on the path with no fallback", () => {
    const plan = bookPlanSchema.parse({ ...planWithContract(), writingComplexity: undefined, complexity: 4 });

    expect(plan.writingComplexity).toBe(4);
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
