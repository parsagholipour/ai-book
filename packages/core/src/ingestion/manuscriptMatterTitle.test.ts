import { describe, expect, it } from "vitest";
import { parseManuscript } from "./manuscriptImport.js";

describe("title pages in scripts without letter case", () => {
  it.each([
    { language: "Japanese", title: "長い冬", byline: "著者：山田太郎", author: "山田太郎" },
    { language: "Persian", title: "زمستان طولانی", byline: "نوشتهٔ جین دو", author: "جین دو" }
  ])("extracts a plain-text $language title page with a byline and page break", async ({ title, byline, author }) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${title}\n${byline}\n\f\nChapter One\n\nBody text.`),
      format: "text"
    });

    expect(parsed.bookTitle).toBe(title);
    expect(parsed.matter).toEqual({ byline: author });
    expect(parsed.matterRemoved).toEqual(["title_page"]);
    expect(parsed.sections).toEqual([{ title: "Chapter One", text: "Body text." }]);
  });

  it.each([
    "雨が降り始めた",
    "باران شروع به باریدن کرد",
    "長い冬\n山田太郎",
    "زمستان طولانی\nجین دو"
  ])("preserves an unmarked opening page: %s", async (opening) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${opening}\n\f\nChapter One\n\nBody text.`),
      format: "text"
    });

    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.matter).toBeUndefined();
    expect(parsed.text).toContain(opening);
  });

  it.each([
    "雨が降り始めた。\n著者：山田太郎",
    "باران شروع به باریدن کرد.\nنوشتهٔ جین دو",
    "長い冬\n著者：山田太郎\n雨が降り始めた",
    "زمستان طولانی\nنوشتهٔ جین دو\nباران شروع به باریدن کرد"
  ])("preserves opening prose even beside a byline: %s", async (opening) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${opening}\n\f\nChapter One\n\nBody text.`),
      format: "text"
    });

    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.matter).toBeUndefined();
    expect(parsed.text).toContain(opening);
  });

  it.each([
    { title: "第一章", byline: "著者：山田太郎" },
    { title: "فصل اول", byline: "نوشتهٔ جین دو" }
  ])("preserves a chapter opening beside a byline: $title", async ({ title, byline }) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${title}\n${byline}\n\f\nChapter Two\n\nBody text.`),
      format: "text"
    });

    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.matter).toBeUndefined();
    expect(parsed.sections).toEqual([
      { title, text: byline },
      { title: "Chapter Two", text: "Body text." }
    ]);
  });
});
