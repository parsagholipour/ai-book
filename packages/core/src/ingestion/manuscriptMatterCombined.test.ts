import { describe, expect, it } from "vitest";
import { generateBookDocx } from "../generation/docx.js";
import { generateBookEpub } from "../generation/epub.js";
import { compileBookMarkdown } from "../generation/markdown.js";
import { originalDevelopmentPlan } from "../generation/testing/bookDevelopmentFixtures.js";
import { bookMatterYear, type BookMatter } from "../schemas/bookMatter.js";
import { bookMatterForImportedManuscript, parseManuscript } from "./manuscriptImport.js";

const TITLE = "The Long Winter";
const BODY = "Snow fell on the valley. The river slept under the ice and the wind kept its own counsel.";
const pages = [{ index: 1, title: "Snow", markdown: BODY }];
const plan = { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" };
const exportOptions = { title: TITLE, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test" };

describe("combined dedication and publication sheets", () => {
  it.each([
    { language: "en", author: "Jane Doe", dedication: "For my mother", year: "2019", details: false },
    { language: "fa", author: "لیلا نوری", dedication: "تقدیم به مادرم", year: "۲۰۱۹", details: true }
  ])("round-trips a Word sheet and reprints each part once in $language", async ({ language, author, dedication, year, details }) => {
    const copyrightHolder = details ? "Lantern House" : author;
    const matter: BookMatter = {
      dedication,
      ...(details ? { copyrightHolder, allRightsReserved: true, imprint: "Published by Lantern Press", isbn: "978-0-306-40615-7" } : {})
    };
    const markdown = compileBookMarkdown({
      plan, pages, readerChapters: [], language, authorName: author,
      matter: { ...matter, year: 2019, madeWithCredit: false }
    });
    const data = await generateBookDocx(markdown, { ...exportOptions, author, language });
    const parsed = await parseManuscript({ data, format: "docx", knownAuthors: [author] });

    expect(parsed.matter).toEqual({
      byline: author, dedication, copyrightHolder, copyrightYear: "2019",
      ...(details ? { allRightsReserved: true, imprint: "Lantern Press", isbn: "978-0-306-40615-7" } : {})
    });
    expect(parsed.matterRemoved).toEqual(["title_page", "dedication", "copyright"]);
    expect(parsed.text).toBe(BODY);

    const imported = bookMatterForImportedManuscript({}, parsed.matter);
    const { copyrightYear, ...printMatter } = imported.bookMatter ?? {};
    const recompiled = compileBookMarkdown({
      plan, pages: [{ ...pages[0]!, markdown: parsed.text }], readerChapters: [], language, authorName: imported.authorName,
      matter: { ...printMatter, year: bookMatterYear(copyrightYear ? { copyrightYear } : {}, new Date("2026-10-08T00:00:00Z")), madeWithCredit: false }
    });
    expect(recompiled.split(dedication)).toHaveLength(2);
    expect(recompiled.split(`© ${year} ${copyrightHolder}`)).toHaveLength(2);
    expect(recompiled.match(/©/g)).toHaveLength(1);
    if (details) {
      expect(recompiled.split("Lantern Press")).toHaveLength(2);
      expect(recompiled.split("ISBN 978-0-306-40615-7")).toHaveLength(2);
    }
  });

  it("keeps literal publication-like wording inside the Word dedication", async () => {
    const dedication = "For the archivists: © 1980 is where our story began.";
    const markdown = compileBookMarkdown({
      plan, pages, readerChapters: [], language: "en", authorName: "Jane Doe",
      matter: { dedication, year: 2019, madeWithCredit: false }
    });
    const data = await generateBookDocx(markdown, { ...exportOptions, author: "Jane Doe", language: "en" });
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.matter?.dedication).toBe(dedication);
    expect(parsed.matter?.copyrightYear).toBe("2019");
    expect(parsed.text).toBe(BODY);
  });

  it("leaves unknown publication text and unreproducible copyright notices in the book", async () => {
    const remainder = "© 2018.\nAll rights reserved.\nCover illustrated by Alice.\nLantern Press";
    const source = `For my mother\n${remainder}\n\f\nChapter One\n${BODY}`;
    const parsed = await parseManuscript({ data: Buffer.from(source), format: "text" });
    expect(parsed.matter).toEqual({ dedication: "For my mother" });
    expect(parsed.sections).toEqual([{ title: null, text: remainder }, { title: "Chapter One", text: BODY }]);
  });

  it("keeps unmatched text after lifting supported publication fields", async () => {
    const credit = "Cover illustrated by Alice.";
    const source = `For my mother\n© 2019 Jane Doe\nAll rights reserved.\nISBN 978-0-306-40615-7\n${credit}\n\f\nChapter One\n${BODY}`;
    const parsed = await parseManuscript({ data: Buffer.from(source), format: "text" });
    expect(parsed.matter).toEqual({
      dedication: "For my mother", copyrightHolder: "Jane Doe", copyrightYear: "2019", allRightsReserved: true, isbn: "978-0-306-40615-7"
    });
    expect(parsed.sections).toEqual([{ title: null, text: credit }, { title: "Chapter One", text: BODY }]);
  });

  it.each([
    "For three days it rained, and the village waited.",
    "To reach the village, Alice crossed the river before dawn."
  ])("retains an unbounded narrative opening and its following copyright line: %s", async (opening) => {
    const source = `${opening}\n© 2019 Jane Doe\n\nChapter One\n${BODY}`;
    const parsed = await parseManuscript({ data: Buffer.from(source), format: "text" });
    expect(parsed.matter).toBeUndefined();
    expect(parsed.sections).toEqual([
      { title: null, text: `${opening}\n© 2019 Jane Doe` }, { title: "Chapter One", text: BODY }
    ]);
  });

  it("keeps a second dedication and its publication lines when the dedication field is already occupied", async () => {
    const second = "For my father\n© 2019 Jane Doe";
    const source = `For my mother\n\f\n${second}\n\f\nChapter One\n${BODY}`;
    const parsed = await parseManuscript({ data: Buffer.from(source), format: "text" });
    expect(parsed.matter).toEqual({ dedication: "For my mother" });
    expect(parsed.sections).toEqual([{ title: null, text: second }, { title: "Chapter One", text: BODY }]);
  });

  it("does not split an EPUB dedication's explicit boundary at a literal copyright line", async () => {
    const dedication = "For the archivists.\n© 1980 Jane Doe\nThe inscription that brought us together.";
    const markdown = compileBookMarkdown({
      plan, pages, readerChapters: [], language: "en", authorName: "Jane Doe",
      matter: { dedication, year: 2019, madeWithCredit: false }
    });
    const data = await generateBookEpub(markdown, { ...exportOptions, author: "Jane Doe", language: "en" });
    const parsed = await parseManuscript({ data, format: "epub" });
    expect(parsed.matter?.dedication).toBe(dedication);
    expect(parsed.matter?.copyrightYear).toBe("2019");
    expect(parsed.text).toBe(BODY);
  });
});
