import { describe, expect, it } from "vitest";
import { compileBookMarkdownWithPageAnchors } from "../generation/markdown.js";
import { authorReaderChapters } from "../generation/readerChapters.js";
import { bookMatterYear, type BookMatter } from "../schemas/bookMatter.js";
import {
  analyzeManuscriptStyle,
  bookMatterForImportedManuscript,
  parseManuscript,
  segmentManuscript,
  synthesizeImportedBookPlan
} from "./manuscriptImport.js";

const CHAPTER = "The rain fell, and Ada waited by the window for the last train.";

async function importAndCompile(
  front: string,
  profile: { authorName?: string; bookMatter?: BookMatter } = {}
) {
  const parsed = await parseManuscript({
    data: Buffer.from(`${front}\n\n## Chapter One\n\n${CHAPTER}`),
    format: "text"
  });
  const book = bookMatterForImportedManuscript(profile, parsed.matter);
  const segmented = await segmentManuscript(parsed);
  const style = await analyzeManuscriptStyle({ text: parsed.text });
  const plan = synthesizeImportedBookPlan({ title: "The Last Train", segmented, style });
  let index = 0;
  const pages = segmented.chapters.flatMap((chapter, chapterIndex) => chapter.pages.map((page) => ({
    index: ++index,
    title: page.title,
    markdown: page.markdown,
    chapter: { index: chapterIndex + 1, title: chapter.title, summary: chapter.summary }
  })));
  const { copyrightYear, ...matter } = book.bookMatter ?? {};
  const { markdown } = compileBookMarkdownWithPageAnchors({
    plan,
    pages,
    readerChapters: authorReaderChapters(pages),
    language: "en",
    ...(book.authorName ? { authorName: book.authorName } : {}),
    matter: {
      ...matter,
      year: bookMatterYear(copyrightYear ? { copyrightYear } : {}, new Date("2026-10-08T00:00:00Z")),
      madeWithCredit: false
    },
    authorManuscript: true
  });
  return { parsed, book, markdown };
}

describe("copyright notices the matter sheet cannot reproduce", () => {
  it.each([
    { line: "ISBN ۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷", isbn: "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷" },
    { line: "شابک-۱۳: ۹۷۸‐۰‐۳۰۶‐۴۰۶۱۵‐۷", isbn: "۹۷۸‐۰‐۳۰۶‐۴۰۶۱۵‐۷" },
    { line: "ISBN-١٣: ٩٧٨ ٠ ٣٠٦ ٤٠٦١٥ ٧ (paperback)", isbn: "٩٧٨ ٠ ٣٠٦ ٤٠٦١٥ ٧" },
    { line: "ISBN-१३: ९७८-०-३०६-४०६१५-७", isbn: "९७८-०-३०६-४०६१५-७" },
    { line: "ISBN-１３：９７８-０-３０６-４０６１５-７", isbn: "９７８-０-３０６-４０６１５-７" },
    { line: "ISBN-۱۰: ۰-۸۰۴۴-۲۹۵۷-X", isbn: "۰-۸۰۴۴-۲۹۵۷-X" }
  ])("preserves the printed ISBN's native digits and separators: $line", async ({ line, isbn }) => {
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n${line}`);

    expect(parsed.sections).toEqual([{ title: "Chapter One", text: CHAPTER }]);
    expect(parsed.matter?.isbn).toBe(isbn);
    expect(book.bookMatter).toEqual({ isbn });
    expect(markdown.split(`ISBN ${isbn}`)).toHaveLength(2);
  });

  it("keeps a native-digit ISBN with a wrong check digit in the manuscript", async () => {
    const line = "ISBN-۱۳: ۹۷۸-۰-۳۰۶-۴۰۶۱۵-۸";
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n${line}`);

    expect(parsed.sections[0]).toEqual({ title: "Copyright", text: line });
    expect(book.bookMatter).toBeUndefined();
    expect(markdown).toContain(line);
  });

  it.each([
    "All rights reserved, with illustrations by Alice Smith.",
    "All rights reserved, except the illustrations which are public domain.",
    "All rights reserved, including the author's photographs."
  ])("keeps clauses attached to a separate rights statement: %s", async (rights) => {
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n© 2020 Jane Doe\n\n${rights}`);

    expect(parsed.sections).toEqual([
      { title: "Copyright", text: rights },
      { title: "Chapter One", text: CHAPTER }
    ]);
    expect(book.bookMatter).toEqual({ copyrightHolder: "Jane Doe", copyrightYear: "2020" });
    expect(markdown.split(rights)).toHaveLength(2);
  });

  it.each([
    "© 2020 Jane Doe, all rights reserved, with illustrations by Alice Smith.",
    "© 2020 Jane Doe, all rights reserved, except the illustrations which are public domain.",
    "© 2020 Jane Doe, tous droits réservés, sauf les illustrations.",
    "© 2020 Jane Doe، جميع الحقوق محفوظة، باستثناء الرسوم.",
    "© 2020 Jane Doe، همهٔ حقوق محفوظ است، به جز تصاویر.",
    "© 2020 Jane Doe، همه حقوق به جز تصاویر محفوظ است.",
    "© 2020 All rights reserved, Except Alice Smith.",
    "© 2020 Jane Doe、無断転載禁止、挿絵は除く。"
  ])("keeps a qualified inline notice without changing its holder: %s", async (notice) => {
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n${notice}`);

    expect(parsed.sections).toEqual([
      { title: "Copyright", text: notice },
      { title: "Chapter One", text: CHAPTER }
    ]);
    expect(book).toEqual({});
    expect(markdown.split(notice)).toHaveLength(2);
  });

  it.each([
    "Tous droits réservés, avec des illustrations par Alice Smith.",
    "جميع الحقوق محفوظة، باستثناء الرسوم التوضيحية.",
    "همهٔ حقوق محفوظ است، به جز تصاویر.",
    "همهٔ حقوق متن محفوظ است.",
    "همه حقوق به جز تصاویر محفوظ است.",
    "版权所有，插图除外。",
    "無断転載禁止、挿絵は除く。"
  ])("preserves a localized qualified or scoped rights line: %s", async (rights) => {
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n© 2020 Jane Doe\n\n${rights}`);

    expect(parsed.sections).toEqual([
      { title: "Copyright", text: rights },
      { title: "Chapter One", text: CHAPTER }
    ]);
    expect(book.bookMatter).toEqual({ copyrightHolder: "Jane Doe", copyrightYear: "2020" });
    expect(markdown.split(rights)).toHaveLength(2);
  });

  it("preserves qualifications next to a separately printed copyright statement", async () => {
    const rights = "All rights reserved, except the illustrations which are public domain.";
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n© 2020 Jane Doe. ${rights}`);

    expect(parsed.sections[0]).toEqual({ title: "Copyright", text: rights });
    expect(book.bookMatter).toEqual({ copyrightHolder: "Jane Doe", copyrightYear: "2020" });
    expect(markdown.split(rights)).toHaveLength(2);
  });

  it.each([
    "All rights reserved.",
    "Tous droits réservés.",
    "همهٔ حقوق محفوظ است.",
    "جميع الحقوق محفوظة.",
    "版权所有。",
    "無断転載禁止。"
  ])("still lifts a complete localized reservation with the page's boilerplate: %s", async (rights) => {
    const { parsed, book } = await importAndCompile(
      `## Copyright\n\n© 2020 Jane Doe\n\n${rights}\n\nNo part of this book may be reproduced without written permission.`
    );

    expect(parsed.sections).toEqual([{ title: "Chapter One", text: CHAPTER }]);
    expect(book.bookMatter).toEqual({ copyrightHolder: "Jane Doe", copyrightYear: "2020", allRightsReserved: true });
  });

  it.each([
    "© 2019.\nAll rights reserved.",
    "All rights reserved.\n© 2019.",
    "© 2019, All rights reserved.",
    "© ۲۰۱۹.\nهمهٔ حقوق محفوظ است.",
    "All rights reserved."
  ])("keeps a notice without a holder in the imported book: %s", async (notice) => {
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n${notice}`);

    expect(parsed.sections).toEqual([
      { title: "Copyright", text: notice },
      { title: "Chapter One", text: CHAPTER }
    ]);
    expect(book).toEqual({});
    for (const line of notice.split("\n")) expect(markdown.split(line)).toHaveLength(2);
    expect(markdown).not.toContain("book-matter-sheet");
  });

  it.each(["profile", "byline"])("does not attach a kept notice's year or rights to the %s", async (source) => {
    const notice = "© 2019.\nAll rights reserved.";
    const titlePage = source === "byline" ? "# The Last Train\n\nby Ada Doe\n\n" : "";
    const profile = source === "profile" ? { authorName: "Ada Doe" } : {};
    const { parsed, book, markdown } = await importAndCompile(`${titlePage}## Copyright\n\n${notice}`, profile);

    expect(parsed.sections[0]).toEqual({ title: "Copyright", text: notice });
    expect(book).toEqual({ authorName: "Ada Doe" });
    expect(markdown).toContain("© 2019.");
    expect(markdown).toContain("© 2026 Ada Doe");
    expect(markdown).not.toContain("© 2019 Ada Doe");
    expect(markdown.split("All rights reserved.")).toHaveLength(2);
  });

  it("still lifts publication details that can print without a holder", async () => {
    const notice = "© 2019.\nAll rights reserved.";
    const { parsed, book, markdown } = await importAndCompile(
      `## Copyright\n\n${notice}\nISBN 978-0-306-40615-7\nPublished by Lantern Press`
    );

    expect(parsed.sections[0]).toEqual({ title: "Copyright", text: notice });
    expect(book.bookMatter).toEqual({ isbn: "978-0-306-40615-7", imprint: "Lantern Press" });
    expect(markdown.split("© 2019.")).toHaveLength(2);
    expect(markdown.split("All rights reserved.")).toHaveLength(2);
    expect(markdown.split("ISBN 978-0-306-40615-7")).toHaveLength(2);
    expect(markdown.split("Lantern Press")).toHaveLength(2);
  });

  it.each(["\n", "\n\n## Copyright\n\n"])("still lifts a later named holder without taking the kept notice's rights: %j", async (separator) => {
    const notice = "© 2019.\nAll rights reserved.";
    const { parsed, book, markdown } = await importAndCompile(
      `## Copyright\n\n${notice}${separator}© 2020 Lantern Press`
    );

    expect(parsed.text).toContain(notice);
    expect(book.bookMatter).toEqual({ copyrightHolder: "Lantern Press", copyrightYear: "2020" });
    expect(markdown.split("© 2019.")).toHaveLength(2);
    expect(markdown.split("© 2020 Lantern Press")).toHaveLength(2);
    expect(markdown.split("All rights reserved.")).toHaveLength(2);
  });

  it("keeps an unnamed notice's rights even after a named holder was lifted", async () => {
    const notice = "© 2019.\nAll rights reserved.";
    const { parsed, book, markdown } = await importAndCompile(
      `## Copyright\n\n© 2020 Lantern Press\n\n## Copyright\n\n${notice}`
    );

    expect(parsed.text).toContain(notice);
    expect(book.bookMatter).toEqual({ copyrightHolder: "Lantern Press", copyrightYear: "2020" });
    expect(markdown.split("All rights reserved.")).toHaveLength(2);
  });

  it.each([
    "© 2019 Ada Doe.\nAll rights reserved.",
    "All rights reserved.\n© 2019 Ada Doe.",
    "© 2019 Ada Doe, All rights reserved."
  ])("continues to lift a complete notice that can print: %s", async (notice) => {
    const { parsed, book, markdown } = await importAndCompile(`## Copyright\n\n${notice}`);

    expect(parsed.sections).toEqual([{ title: "Chapter One", text: CHAPTER }]);
    expect(book.bookMatter).toEqual({ copyrightHolder: "Ada Doe", copyrightYear: "2019", allRightsReserved: true });
    expect(markdown.split("© 2019 Ada Doe")).toHaveLength(2);
    expect(markdown.split("All rights reserved.")).toHaveLength(2);
  });
});
