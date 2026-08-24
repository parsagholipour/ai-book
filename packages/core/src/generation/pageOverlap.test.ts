import { describe, expect, it } from "vitest";
import {
  keywordsFromTokens,
  overlapKeywords,
  overlapShingles,
  overlapTokens,
  sharedRatio,
  shinglesFromTokens
} from "./pageOverlap.js";

/**
 * The measurement `pagesLocalQaRepetition.test.ts` and `pageBeatDedup.test.ts`
 * both score through: what a token is, which of them are keywords, how a
 * trigram is cut, and the ratio of the smaller set. Those suites pin the
 * verdicts; this one pins the rule, because a gate firing cannot say which
 * half of the measurement got it wrong.
 */

describe("overlapTokens", () => {
  it("folds case and punctuation and keeps only tokens longer than two characters", () => {
    expect(overlapTokens("Mira, the ice.")).toEqual(["mira", "the", "ice"]);
  });

  it("keeps a contraction under either apostrophe", () => {
    // The keep-class names both spellings for the reason every other apostrophe
    // class in this directory does: providers write U+2019 far more often than
    // ASCII, and a class that keeps only `'` splits "don’t" into a dropped
    // fragment while keeping "don't" whole.
    expect(overlapTokens("don't")).toEqual(["don't"]);
    expect(overlapTokens("don’t")).toEqual(["don’t"]);
  });
});

describe("overlap sets from tokens", () => {
  it("keeps the last trigram and drops only the summary stop words", () => {
    const tokens = ["mira", "measures", "frozen", "river", "dawn"];

    expect(shinglesFromTokens(tokens)).toEqual(
      new Set(["mira measures frozen", "measures frozen river", "frozen river dawn"])
    );
    expect(keywordsFromTokens(["mira", "page", "river", "chapter"])).toEqual(new Set(["mira", "river"]));
  });

  it("builds the same sets from a string as from its tokens", () => {
    const text = "Mira measures the frozen river at dawn.";
    const tokens = overlapTokens(text);

    expect(overlapShingles(text)).toEqual(shinglesFromTokens(tokens));
    expect(overlapKeywords(text)).toEqual(keywordsFromTokens(tokens));
  });
});

describe("sharedRatio", () => {
  it("is zero when either set is empty, and divides by the smaller side", () => {
    expect(sharedRatio(new Set(), new Set(["a"]))).toBe(0);
    expect(sharedRatio(new Set(["a", "b"]), new Set(["b", "c", "d"]))).toBe(0.5);
    expect(sharedRatio(new Set(["b", "c", "d"]), new Set(["a", "b"]))).toBe(0.5);
  });
});
