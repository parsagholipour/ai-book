import { describe, expect, it } from "vitest";
import { compactFollowingPages, compactPriorPages, type PriorPageContext } from "./pagesShared.js";

/**
 * A prior window's excerpts are cut from the front of each page, so the page
 * that follows a long one never saw where it stopped and re-narrated its last
 * beat at the seam. The nearest prior page now carries its `ending`.
 */
function page(index: number, markdown: string): PriorPageContext {
  return { index, title: `Page ${index}`, markdown, summary: `Summary ${index}` };
}

const filler = (label: string, length: number) => `${label} `.repeat(Math.ceil(length / (label.length + 1))).slice(0, length);

describe("the nearest prior page's ending", () => {
  it("is carried when the excerpt stops short of it, and starts where the excerpt stops at the earliest", () => {
    const closing = "He wiped a bead of oil from the brass, and the quay waited in the clear air.";
    const long = page(13, `${filler("Dawn", 1_400)}${closing}`);
    const [entry] = compactPriorPages([long], 1, 700);

    expect(entry!.excerpt).toHaveLength(700);
    expect(entry!.ending).toHaveLength(500);
    expect(entry!.ending!.endsWith(closing)).toBe(true);

    const justOver = page(13, `${filler("Dawn", 800)}${closing}`);
    const [short] = compactPriorPages([justOver], 1, 700);
    // No character is shown twice: the ending begins where the excerpt ends.
    expect(`${short!.excerpt}${short!.ending}`).toBe(justOver.markdown);
  });

  it("is left off a page the excerpt already shows whole, and off every page but the nearest", () => {
    const shortPage = page(13, "A page short enough to show whole.");
    expect(compactPriorPages([shortPage], 1, 700)[0]).not.toHaveProperty("ending");

    const window = compactPriorPages([page(11, filler("Eleven", 1_200)), page(12, filler("Twelve", 1_200))], 2, 700);
    expect(window[0]).not.toHaveProperty("ending");
    expect(window[1]!.ending).toMatch(/Twelve/);
  });

  it("is never given to a following page, whose opening is the hand-off", () => {
    expect(compactFollowingPages([page(14, filler("Next", 1_200))], 1, 700)[0]).not.toHaveProperty("ending");
  });
});
