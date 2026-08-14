import { describe, expect, it } from "vitest";
import { mergePageMapCriticPatch } from "./pageMapCritic.js";
import type { ChapterBrief } from "../schemas/book.js";

const briefs: ChapterBrief[] = [
  {
    chapterIndex: 1,
    title: "Opening",
    summary: "Ada leaves town.",
    continuityFocus: [],
    pages: [
      {
        pageIndex: 1,
        chapterIndex: 1,
        purpose: "Establish Ada",
        beat: "Ada packs the lantern.",
        requiredContinuity: [],
        endingPressure: ""
      },
      {
        pageIndex: 2,
        chapterIndex: 1,
        purpose: "Establish Ada",
        beat: "Ada packs again.",
        requiredContinuity: [],
        endingPressure: "Ask why she delayed."
      }
    ]
  }
];

describe("mergePageMapCriticPatch", () => {
  it("patches duplicate purpose and fills missing endingPressure", () => {
    const merged = mergePageMapCriticPatch(briefs, {
      beatPatches: [
        {
          pageIndex: 2,
          purpose: "Ada decides to leave",
          beat: "Ada chooses the river road."
        }
      ],
      duplicatePurposeWarnings: ["Pages 1 and 2 shared a purpose."],
      missingEndingPressure: [1],
      unscheduledPromises: ["The lantern will be lit."]
    });

    expect(merged[0]?.pages[0]?.endingPressure).toMatch(/consequence/i);
    expect(merged[0]?.pages[1]?.purpose).toBe("Ada decides to leave");
    expect(merged[0]?.continuityFocus.some((line) => line.includes("lantern"))).toBe(true);
  });
});
