import { describe, expect, it } from "vitest";
import { paragraphShapeNotes, paragraphShapeReport } from "./chapterShape.js";

function paragraph(words: number, seed = "w"): string {
  return Array.from({ length: words }, (_, index) => `${seed}${index % 9}`).join(" ") + ".";
}

describe("paragraphShapeReport", () => {
  it("measures uniform paragraphs as uniform", () => {
    const uniform = Array.from({ length: 20 }, (_, index) => paragraph(74 + (index % 3), `p${index}`)).join("\n\n");
    const report = paragraphShapeReport(uniform);
    expect(report.paragraphs).toBe(20);
    expect(report.cv).toBeLessThan(0.05);
    expect(report.longParagraphs).toBe(0);
    expect(report.shortParagraphs).toBe(0);
  });

  it("counts list sentences and assert-then-negate couplets", () => {
    const text = [
      "The wall was built of stone, earth, timber, and bone. It can show labour. It cannot show fear.",
      "A ledger names the tax. It does not name the collector. The road ran west."
    ].join("\n\n");
    const report = paragraphShapeReport(text);
    expect(report.concessiveCouplets).toBe(1);
    expect(report.listSentenceShare).toBeGreaterThan(0);
  });
});

describe("paragraphShapeNotes", () => {
  it("returns numbered notes for a uniform chapter and nothing for a varied one", () => {
    const uniform = Array.from({ length: 24 }, (_, index) => paragraph(75, `p${index}`)).join("\n\n");
    const notes = paragraphShapeNotes(uniform);
    expect(notes.some((note) => note.includes("all about 75 words"))).toBe(true);
    expect(notes.some((note) => note.includes("No paragraph runs past"))).toBe(true);
    expect(notes.some((note) => note.includes("under 30 words"))).toBe(true);

    const varied = [
      paragraph(12, "a"),
      paragraph(210, "b"),
      paragraph(60, "c"),
      paragraph(8, "d"),
      paragraph(180, "e"),
      paragraph(40, "f"),
      paragraph(9, "g"),
      paragraph(150, "h"),
      paragraph(95, "i"),
      paragraph(20, "j")
    ].join("\n\n");
    expect(paragraphShapeNotes(varied)).toEqual([]);
  });

  it("stays silent on a chapter too short to judge", () => {
    expect(paragraphShapeNotes([paragraph(70), paragraph(70), paragraph(70)].join("\n\n"))).toEqual([]);
  });
});
