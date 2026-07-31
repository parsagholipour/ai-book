import { describe, expect, it } from "vitest";

import { diffProse, proseChanged, splitBlocks } from "./textDiff.js";

/** Reassembles what a renderer would show for one side of the diff. */
function sideText(diff: ReturnType<typeof diffProse>, side: "before" | "after"): string {
  const skip = side === "before" ? "insert" : "delete";
  return diff.blocks
    .map((block) => block.runs.filter((run) => run.type !== skip).map((run) => run.text).join(""))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

describe("diffProse", () => {
  it("marks a one-word rewrite inline instead of replacing the paragraph", () => {
    // The whole point: changing "night" to "day" must not paint a 40-word
    // paragraph as deleted-and-re-added, leaving the reader to hunt for it.
    const diff = diffProse(
      "The city slept under a heavy night sky.",
      "The city slept under a heavy day sky."
    );

    expect(diff.blocks).toHaveLength(1);
    expect(diff.blocks[0]?.type).toBe("changed");
    expect(diff.blocks[0]?.runs).toEqual([
      { type: "equal", text: "The city slept under a heavy " },
      { type: "delete", text: "night " },
      { type: "insert", text: "day " },
      { type: "equal", text: "sky." }
    ]);
    expect(diff.addedWords).toBe(1);
    expect(diff.removedWords).toBe(1);
  });

  it("leaves untouched paragraphs alone and reports only what moved", () => {
    const before = "First stays.\n\nSecond goes away.\n\nThird stays.";
    const after = "First stays.\n\nThird stays.\n\nFourth arrives.";
    const diff = diffProse(before, after);

    expect(diff.blocks.map((block) => block.type)).toEqual([
      "unchanged",
      "removed",
      "unchanged",
      "added"
    ]);
    expect(diff.removedWords).toBe(3);
    expect(diff.addedWords).toBe(2);
  });

  it("shows two unrelated paragraphs as a replacement rather than shared filler", () => {
    // Matching "the" and "a" across paragraphs with nothing else in common
    // produces a diff that is technically minimal and useless to read.
    const diff = diffProse(
      "The rabbit ran across a field of clover.",
      "Machinery hummed in the basement of a grey tower."
    );

    expect(diff.blocks).toHaveLength(1);
    expect(diff.blocks[0]?.runs.map((run) => run.type)).toEqual(["delete", "insert"]);
  });

  it("reconstructs both sides exactly, so nothing is dropped or duplicated", () => {
    const before = "Alpha one two.\n\nBeta three four.\n\nGamma five.";
    const after = "Alpha one two.\n\nBeta three and four more.\n\nDelta six.";
    const diff = diffProse(before, after);

    expect(sideText(diff, "before")).toBe(before);
    expect(sideText(diff, "after")).toBe(after);
  });

  it("reports an empty diff for identical text", () => {
    const diff = diffProse("Nothing moved here.", "Nothing moved here.");

    expect(diff.blocks.every((block) => block.type === "unchanged")).toBe(true);
    expect(diff.addedWords).toBe(0);
    expect(diff.removedWords).toBe(0);
  });

  it("handles a page written from nothing", () => {
    const diff = diffProse("", "A brand new page.");

    expect(diff.blocks.map((block) => block.type)).toEqual(["added"]);
    expect(diff.addedWords).toBe(4);
  });
});

describe("splitBlocks", () => {
  it("splits on blank lines and drops the blanks", () => {
    expect(splitBlocks("one\n\n\n  two  \n\nthree")).toEqual(["one", "two", "three"]);
  });
});

describe("proseChanged", () => {
  it("ignores surrounding whitespace", () => {
    expect(proseChanged("same\n", "  same")).toBe(false);
    expect(proseChanged("same", "different")).toBe(true);
  });
});
