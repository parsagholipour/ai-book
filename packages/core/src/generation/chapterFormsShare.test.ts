import { describe, expect, it } from "vitest";
import { formPaletteFor, normalizeChapterCompositions, type ChapterFormRange } from "./chapterForms.js";

/**
 * A section the planner gave `share: 0` used to fail `chapterSectionSchema`,
 * and a failed section fails its chapter: the q2 workbook's last chapter was
 * drafted from the keyBeat fallback (no headings, forms rotated from the
 * palette) over one `"share": 0.0`. Every mode parses the same schema.
 */
const chapter = { index: 1, title: "The appeal", summary: "What the appeal changed", keyBeats: ["A keyBeat the fallback would use"], targetPages: 3 };
const ranges: ChapterFormRange[] = [{ chapter, startPage: 1, endPage: 3, words: 1710 }];

function reply(share: unknown) {
  return {
    chapters: [
      {
        chapterIndex: 1,
        throughLine: "The appeal reopened the verdict.",
        sections: [
          { form: "scene", subject: "The clerk files the appeal", share: 0.5, owns: ["The appeal roll"] },
          { form: "argument", subject: "Why the first verdict was provisional", share: 0.4, owns: [] },
          { form: "quiet-transition", subject: "The court rises", share, owns: [] }
        ],
        landing: "The appeal made the verdict a stage, not an end.",
        avoid: []
      }
    ]
  };
}

describe("a zero share is no share, never a lost chapter", () => {
  for (const share of [0, 0.0, -0.2, Number.NaN]) {
    it(`keeps the planned sections when one says share ${share}`, () => {
      const [composition] = normalizeChapterCompositions(reply(share), ranges, formPaletteFor("analytical-history"));
      expect(composition!.sections.map((section) => section.subject)).toEqual([
        "The clerk files the appeal",
        "Why the first verdict was provisional",
        "The court rises"
      ]);
      expect(composition!.landing).toBe("The appeal made the verdict a stage, not an end.");
      // A missing share splits the chapter evenly, as it always did.
      expect(composition!.sections.every((section) => Math.abs(section.share! - 1 / 3) < 1e-9)).toBe(true);
    });
  }

  it("still renormalises a chapter whose every share is positive", () => {
    const [composition] = normalizeChapterCompositions(reply(10), ranges, formPaletteFor("analytical-history"));
    expect(composition!.sections.map((section) => Math.round(section.share! * 1000) / 1000)).toEqual([0.046, 0.037, 0.917]);
  });

  it("drops a toolkit's heading and covers from every plan that is not one", () => {
    const withHeadings = reply(0.1);
    withHeadings.chapters[0]!.sections[0] = { ...withHeadings.chapters[0]!.sections[0]!, heading: "A volunteered heading", covers: ["R1"] } as never;
    const [legacy] = normalizeChapterCompositions(withHeadings, ranges, formPaletteFor("analytical-history"));
    expect(legacy!.sections[0]).not.toHaveProperty("heading");
    expect(legacy!.sections[0]).not.toHaveProperty("covers");
  });
});
