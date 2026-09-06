import { describe, expect, it } from "vitest";

import { retainedProseFraction } from "./proseRetention.js";

const original = [
  "The test dataset had fourteen customer records, and the lookup finished quickly.",
  "With a short list, the difference between checking one record and all fourteen is easy to miss.",
  "",
  "```pseudocode",
  "search(items, target):",
  "    scan every item",
  "```",
  "",
  "The result remains correct in each case, whatever the collection's size.",
  "A test can establish the first fact while revealing very little about the second."
].join("\n");

describe("retainedProseFraction", () => {
  it("is 1 for an identical page and for one whose only change is inside a fence", () => {
    expect(retainedProseFraction(original, original)).toBe(1);
    const converted = original.replace(/```pseudocode[\s\S]*?```/, "```javascript\nconst search = () => {};\n```");
    expect(retainedProseFraction(original, converted)).toBe(1);
  });

  it("counts a reworded sentence as lost and a moved one as kept", () => {
    const reworded = original.replace(
      "The result remains correct in each case, whatever the collection's size.",
      "Correctness holds in every case regardless of size."
    );
    expect(retainedProseFraction(original, reworded)).toBeCloseTo(0.75, 5);

    const moved = [
      "A test can establish the first fact while revealing very little about the second.",
      "The test dataset had fourteen customer records, and the lookup finished quickly.",
      "With a short list, the difference between checking one record and all fourteen is easy to miss.",
      "The result remains correct in each case, whatever the collection's size."
    ].join(" ");
    expect(retainedProseFraction(original, moved)).toBe(1);
  });

  it("ignores whitespace differences and reads a from-scratch rewrite as near zero", () => {
    expect(retainedProseFraction(original, original.replace(/\n/g, " ").replace(/ +/g, "  "))).toBe(1);
    expect(retainedProseFraction(original, "A delivery service keeps pickup codes in ascending order. Nothing else survives.")).toBe(0);
  });

  it("has nothing to measure on a page with no prose sentences", () => {
    expect(retainedProseFraction("```js\ncode\n```", "```py\ncode\n```")).toBe(1);
    expect(retainedProseFraction("## Title", "## Other")).toBe(1);
  });
});
