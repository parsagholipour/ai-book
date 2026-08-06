import { describe, expect, it } from "vitest";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { cleanText, fitCoverText } from "./coverText.js";

const persian = scriptProfileForLanguage("fa");
const chinese = scriptProfileForLanguage("zh");
const hindi = scriptProfileForLanguage("hi");

function graphemeCount(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
}

describe("fitCoverText", () => {
  it("never splits a word in a joining script", () => {
    // Half a Persian word re-shapes with isolated forms, so the cover would
    // show two words that are not the one written. Overflow is absorbed by the
    // font-size descent instead.
    const text = "کتاب ماه و ستارگان درخشان";
    const fitted = fitCoverText({
      text,
      baseFontSize: 140,
      minFontSize: 72,
      maxCharsPerLine: 8,
      maxLines: 6,
      script: persian
    });

    expect(fitted.lines.join(" ")).toBe(cleanText(text));
    for (const line of fitted.lines) {
      for (const word of line.split(" ")) {
        expect(text).toContain(word);
      }
    }
  });

  it("breaks Chinese, which is written without spaces", () => {
    const fitted = fitCoverText({
      text: "月之书与星辰的故事集",
      baseFontSize: 140,
      minFontSize: 72,
      maxCharsPerLine: 6,
      maxLines: 4,
      script: chinese
    });

    // Splitting on whitespace would yield one unbreakable line.
    expect(fitted.lines.length).toBeGreaterThan(1);
    expect(fitted.lines.join("")).toContain("月之书");
  });

  it("counts and slices in grapheme clusters", () => {
    // A UTF-16 slice severs surrogate pairs and strips combining marks.
    const emoji = "\u{1F469}‍\u{1F680}".repeat(12);
    const fitted = fitCoverText({ text: emoji, baseFontSize: 140, minFontSize: 72, maxCharsPerLine: 4, maxLines: 8 });
    expect(fitted.lines.join("")).not.toContain("�");
    expect(fitted.lines.reduce((total, line) => total + graphemeCount(line), 0)).toBe(graphemeCount(emoji));
  });

  it("keeps Devanagari conjuncts whole", () => {
    const text = "नमस्ते दुनिया";
    const fitted = fitCoverText({
      text,
      baseFontSize: 140,
      minFontSize: 72,
      maxCharsPerLine: 6,
      maxLines: 6,
      script: hindi
    });
    expect(fitted.lines.join(" ")).toBe(cleanText(text));
  });

  it("gives a non-Latin title fewer characters per line than Latin", () => {
    // Every template calibrated maxCharsPerLine against a condensed Latin
    // display face; a title that overflows slides the RTL artwork off the page.
    const options = { baseFontSize: 140, minFontSize: 72, maxCharsPerLine: 12, maxLines: 8 } as const;
    const latin = fitCoverText({ ...options, text: "aaaa bbbb cccc dddd eeee ffff" });
    const arabic = fitCoverText({ ...options, text: "aaaa bbbb cccc dddd eeee ffff", script: persian });
    expect(arabic.lines.length).toBeGreaterThanOrEqual(latin.lines.length);
  });

  it("leaves Latin fitting exactly as it was", () => {
    const fitted = fitCoverText({
      text: "The Very Long and Surprisingly Specific Chronicle of the Moon's Smallest Library",
      baseFontSize: 140,
      minFontSize: 72,
      maxCharsPerLine: 15,
      maxLines: 4
    });

    expect(fitted.lines.length).toBeLessThanOrEqual(4);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(72);
    expect(fitted.lines.join(" ")).toContain("Very");
  });

  it("returns nothing for empty text", () => {
    expect(fitCoverText({ text: "   ", baseFontSize: 140, minFontSize: 72, maxCharsPerLine: 12, maxLines: 3 })).toEqual({
      fontSize: 140,
      lines: [],
      truncated: false
    });
  });
});
