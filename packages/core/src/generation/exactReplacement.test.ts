import { describe, expect, it } from "vitest";
import {
  applyExactReplacement,
  countExactMatches,
  exactReplacementLineDiff,
  hasExactMatch
} from "./exactReplacement.js";

describe("applyExactReplacement", () => {
  it("replaces every literal occurrence, case-sensitively", () => {
    expect(applyExactReplacement("Aranha met Aranha", { from: "Aranha", to: "Aranhinha" })).toBe(
      "Aranhinha met Aranhinha"
    );
    // Case matters: the preview shows exactly what lands, so "aranha" is a
    // different string and stays put.
    expect(applyExactReplacement("aranha and Aranha", { from: "Aranha", to: "Bea" })).toBe("aranha and Bea");
  });

  it("treats the needle as text, never as a pattern", () => {
    expect(applyExactReplacement("cost is $5.00 (net)", { from: "$5.00 (net)", to: "$6.00" })).toBe("cost is $6.00");
    expect(applyExactReplacement("a.b", { from: ".", to: "-" })).toBe("a-b");
  });

  it("leaves the text alone when there is nothing to find", () => {
    expect(applyExactReplacement("unchanged", { from: "", to: "x" })).toBe("unchanged");
    expect(countExactMatches("unchanged", { from: "", to: "x" })).toBe(0);
  });

  it("counts occurrences the same way it replaces them", () => {
    expect(countExactMatches("aa aa aa", { from: "aa", to: "b" })).toBe(3);
    expect(countExactMatches("nothing here", { from: "zzz", to: "b" })).toBe(0);
  });
});

describe("preserveCase", () => {
  const replacement = { from: "rabbit", to: "fly", preserveCase: true };

  it("carries each occurrence's capitalization onto the replacement", () => {
    // The case the fixtures actually hit: the reader types "rabbit", the book
    // says "Rabbit". A literal swap finds nothing and the edit silently becomes
    // a per-page regeneration.
    expect(applyExactReplacement("Rabbit runs. RABBIT wins. rabbit rests.", replacement)).toBe(
      "Fly runs. FLY wins. fly rests."
    );
  });

  it("counts and matches case-insensitively too", () => {
    expect(countExactMatches("Rabbit and rabbit", replacement)).toBe(2);
    expect(hasExactMatch("Rabbit", replacement)).toBe(true);
    // Without the flag the same text is a miss, which is the whole point.
    expect(hasExactMatch("Rabbit", { from: "rabbit", to: "fly" })).toBe(false);
  });

  it("does not disturb surrounding text", () => {
    expect(applyExactReplacement("The Rabbit's burrow", replacement)).toBe("The Fly's burrow");
  });
});

describe("exactReplacementLineDiff", () => {
  it("returns only the lines that change", () => {
    const text = "Aranha woke up.\nThe sun was warm.\nAranha stretched.";
    expect(exactReplacementLineDiff(text, { from: "Aranha", to: "Bea" })).toEqual([
      { before: "Aranha woke up.", after: "Bea woke up." },
      { before: "Aranha stretched.", after: "Bea stretched." }
    ]);
  });

  it("stops at the limit so a whole-book replacement cannot flood the card", () => {
    const text = Array.from({ length: 40 }, (_, index) => `Aranha line ${index}`).join("\n");
    expect(exactReplacementLineDiff(text, { from: "Aranha", to: "Bea" }, 3)).toHaveLength(3);
  });
});
