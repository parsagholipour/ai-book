import { describe, expect, it } from "vitest";
import { bookFontSetForLanguage } from "./bookFonts.js";
import { codePointsOf, embedFontFaceCss, parseUnicodeRange } from "./fontEmbedding.js";

function faceBlocks(css: string): string[] {
  return [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((match) => match[0]);
}

function coversCodePoint(block: string, codePoint: number): boolean {
  const range = block.match(/unicode-range:\s*([^;]+);/i)?.[1] ?? "";
  return parseUnicodeRange(range).some((entry) => codePoint >= entry.start && codePoint <= entry.end);
}

async function cssFor(language: string, text: string): Promise<string> {
  const set = bookFontSetForLanguage(language);
  const codePoints = codePointsOf(text);
  return embedFontFaceCss([
    { family: "SourceSerifBook", packages: set.body, codePoints },
    { family: "InterBook", packages: set.display, codePoints }
  ]);
}

describe("embedFontFaceCss", () => {
  it("gives every face a unicode-range", async () => {
    // This is the bug the whole registry exists to fix: a face declared without
    // a range claims all of Unicode, so Chrome stops falling back and a Persian
    // book renders as tofu in a Latin font.
    for (const language of ["en", "fa", "zh", "hi"]) {
      const blocks = faceBlocks(await cssFor(language, "Sample متن 文字 पाठ"));
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block, `${language}: face without a unicode-range`).toMatch(/unicode-range:/);
      }
    }
  });

  it("blocks rather than swaps, so no fallback glyph can be printed", async () => {
    const css = await cssFor("fa", "سلام");
    expect(css).not.toContain("swap");
    for (const block of faceBlocks(css)) {
      expect(block).toContain("font-display: block");
    }
  });

  it("embeds the woff2 inline", async () => {
    const css = await cssFor("en", "Hello");
    expect(css).toContain('src: url("data:font/woff2;base64,');
    expect(css).not.toContain("./files/");
  });

  it("keeps the faces a document needs and drops the rest", async () => {
    const css = await cssFor("fa", "سلام dunya");
    const blocks = faceBlocks(css);
    // Arabic seen (U+0633 س) and Latin seen, but nothing wrote Cyrillic.
    expect(blocks.some((block) => coversCodePoint(block, 0x0633))).toBe(true);
    expect(blocks.some((block) => coversCodePoint(block, 0x0041))).toBe(true);
    expect(blocks.some((block) => coversCodePoint(block, 0x0410))).toBe(false);
  });

  it("keeps a Latin face even for a document with no ASCII", async () => {
    // Page numbers and the running footer are always Latin.
    const blocks = faceBlocks(await cssFor("fa", "سلام"));
    expect(blocks.some((block) => coversCodePoint(block, 0x0041))).toBe(true);
  });

  it("limits a script package to its own script", async () => {
    // Vazirmatn ships Latin subsets too; Source Serif keeps the Latin role.
    const css = await cssFor("fa", "سلام dunya");
    const arabicFaces = faceBlocks(css).filter((block) => coversCodePoint(block, 0x0633));
    expect(arabicFaces.length).toBeGreaterThan(0);
    for (const face of arabicFaces) {
      expect(coversCodePoint(face, 0x0041)).toBe(false);
    }
  });

  it("does not embed a CJK library for a book with no CJK", async () => {
    const latin = await cssFor("en", "Hello world");
    const chinese = await cssFor("zh", "这是一个测试");
    expect(faceBlocks(chinese).length).toBeGreaterThan(faceBlocks(latin).length);
    // Noto Serif SC ships 101 subsets; a short book must not carry them all.
    expect(faceBlocks(chinese).length).toBeLessThan(101);
  });
});

describe("parseUnicodeRange", () => {
  it("reads single points, spans and wildcards", () => {
    expect(parseUnicodeRange("U+0041")).toEqual([{ start: 0x41, end: 0x41 }]);
    expect(parseUnicodeRange("U+0600-06FF")).toEqual([{ start: 0x600, end: 0x6ff }]);
    expect(parseUnicodeRange("U+04??")).toEqual([{ start: 0x400, end: 0x4ff }]);
    expect(parseUnicodeRange("U+0041,U+0600-06FF")).toEqual([
      { start: 0x41, end: 0x41 },
      { start: 0x600, end: 0x6ff }
    ]);
  });

  it("reads lowercase hex", () => {
    // The Latin packages write uppercase and the CJK packages lowercase.
    expect(parseUnicodeRange("U+1f1e9-1f1f5")).toEqual([{ start: 0x1f1e9, end: 0x1f1f5 }]);
  });
});

describe("codePointsOf", () => {
  it("always includes printable ASCII", () => {
    const points = codePointsOf("سلام");
    expect(points.has(0x20)).toBe(true);
    expect(points.has(0x7e)).toBe(true);
    expect(points.has(0x0633)).toBe(true);
  });

  it("counts astral characters as one code point", () => {
    expect(codePointsOf("😀").has(0x1f600)).toBe(true);
  });
});
