import { describe, expect, it } from "vitest";
import { range, uniqueStrings } from "./collections.js";

describe("uniqueStrings", () => {
  it("trims, drops empty values, and preserves first-occurrence ordering", () => {
    expect(uniqueStrings([" beta ", "", "Alpha", "  ", "beta", "gamma", " Alpha "])).toEqual([
      "beta",
      "Alpha",
      "gamma"
    ]);
  });

  it("treats differently cased values as distinct", () => {
    expect(uniqueStrings(["Ada", "ada", "ADA", "Ada"])).toEqual(["Ada", "ada", "ADA"]);
  });
});

describe("range", () => {
  it("includes both endpoints", () => {
    expect(range(2, 5)).toEqual([2, 3, 4, 5]);
    expect(range(3, 3)).toEqual([3]);
  });

  it("returns an empty range when the end precedes the start", () => {
    expect(range(3, 1)).toEqual([]);
  });
});
