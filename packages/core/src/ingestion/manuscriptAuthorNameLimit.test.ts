import { describe, expect, it } from "vitest";
import { generateBookDocx } from "../generation/docx.js";
import { generateBookEpub } from "../generation/epub.js";
import { compileBookMarkdown } from "../generation/markdown.js";
import { originalDevelopmentPlan } from "../generation/testing/bookDevelopmentFixtures.js";
import { BOOK_MATTER_LIMITS } from "../schemas/bookMatter.js";
import { parseManuscript } from "./manuscriptImport.js";

const TITLE = "The Long Winter";
const BODY = "Snow fell on the valley. The river slept under the ice and the wind kept its own counsel.";
const LONG_AUTHOR = Array.from({ length: 9 }, () => "Alexanderson").join(" ");

describe("imported author-name limits", () => {
  it.each((["epub", "docx"] as const).flatMap((format) => ["en", "ja"].flatMap((language) =>
    [101, LONG_AUTHOR.length, BOOK_MATTER_LIMITS.authorName].map((length) => ({ format, language, length }))
  )))("restores a $length-character author from a $language $format export", async ({ format, language, length }) => {
    const author = LONG_AUTHOR.padEnd(length, "x").slice(0, length);
    const markdown = compileBookMarkdown({
      plan: { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" },
      pages: [{ index: 1, title: "Snow", markdown: BODY }],
      readerChapters: [], authorName: author, language,
      matter: { year: 2019, madeWithCredit: false }
    });
    const options = { title: TITLE, author, language, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test" };
    const data = await (format === "epub" ? generateBookEpub(markdown, options) : generateBookDocx(markdown, options));
    const parsed = await parseManuscript({ data, format });

    expect(parsed.bookTitle).toBe(TITLE);
    expect(parsed.matter?.byline).toBe(author);
    expect(parsed.matter?.subtitle).toBeUndefined();
    expect(parsed.matterRemoved).toContain("title_page");
    expect(parsed.text).toBe(BODY);
  });

  it("preserves an over-limit author as manuscript text instead of importing a truncated byline", async () => {
    const author = LONG_AUTHOR.padEnd(BOOK_MATTER_LIMITS.authorName + 1, "x");
    const byline = `Author: ${author}`;
    const parsed = await parseManuscript({
      data: Buffer.from(`${TITLE}\n${byline}\n\f\nChapter One\n\n${BODY}`),
      format: "text", knownAuthors: [author]
    });

    expect(parsed.matter?.byline).toBeUndefined();
    expect(parsed.text).toContain(byline);
    expect(parsed.text).toContain(BODY);
  });
});
