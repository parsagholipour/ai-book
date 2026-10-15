import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { generateBookEpub } from "../generation/epub.js";
import { compileBookMarkdown, compileBookMarkdownWithPageAnchors, markdownLabels } from "../generation/markdown.js";
import { originalDevelopmentPlan } from "../generation/testing/bookDevelopmentFixtures.js";
import { parseManuscript } from "./manuscriptImport.js";
import { bookMatterForImportedManuscript } from "./manuscriptMatter.js";

const TITLE = "The Long Winter";
const AUTHOR = "Jane Doe";
const DEDICATION = "For my mother, who taught me to read.";
const BIO = "Jane Doe lives in Maine with two dogs and a stubborn garden.";
const LOCALIZED_AUTHORS = [
  { language: "en", nativeAuthor: "Jane Doe" },
  { language: "ar", nativeAuthor: "ليلى منصور" },
  { language: "zh", nativeAuthor: "王小明" },
  { language: "fr", nativeAuthor: "Élodie Martin" },
  { language: "de", nativeAuthor: "Jürgen Müller" },
  { language: "hi", nativeAuthor: "आशा शर्मा" },
  { language: "it", nativeAuthor: "Giulia Rossi" },
  { language: "ja", nativeAuthor: "山田太郎" },
  { language: "ko", nativeAuthor: "김민수" },
  { language: "fa", nativeAuthor: "لیلا نوری" },
  { language: "pt", nativeAuthor: "João da Silva" },
  { language: "ru", nativeAuthor: "Анна Иванова" },
  { language: "es", nativeAuthor: "María García" },
  { language: "tr", nativeAuthor: "Ayşe Yılmaz" },
  { language: "ur", nativeAuthor: "عائشہ خان" },
  { language: "da", nativeAuthor: "Søren Kierkegaard" },
  { language: "nl", nativeAuthor: "Annie de Vries" },
  { language: "el", nativeAuthor: "Ελένη Παπαδοπούλου" },
  { language: "he", nativeAuthor: "דוד כהן" },
  { language: "no", nativeAuthor: "Ingrid Hansen" },
  { language: "pl", nativeAuthor: "Anna Nowak" },
  { language: "sv", nativeAuthor: "Astrid Lindqvist" },
  { language: "th", nativeAuthor: "สมชาย ใจดี" },
  { language: "uk", nativeAuthor: "Олена Шевченко" },
  { language: "vi", nativeAuthor: "Nguyễn Văn An" }
];
const pages = Array.from({ length: 8 }, (_, index) => ({
  index: index + 1,
  title: `Page ${index + 1}`,
  markdown: `Snow fell on the valley on day ${index + 1}. The river slept under the ice and the wind kept its own counsel.`
}));
const chapters = [
  { index: 1, title: "Snow", summary: "Snow falls", startPageIndex: 1, endPageIndex: 4 },
  { index: 2, title: "River", summary: "The river freezes", startPageIndex: 5, endPageIndex: 8 }
];

describe("exported EPUB matter re-import", () => {
  it.each([
    { language: "en", author: AUTHOR, biography: "Jane Doe writes stories." },
    { language: "fa", author: "لیلا نوری", biography: "لیلا نوری برای کودکان داستان می‌نویسد." }
  ])("keeps a story's $language biography separate from Sources when re-importing", async ({ language, author, biography }) => {
    const plan = { ...originalDevelopmentPlan(), title: "Fox", subtitle: "" };
    const compiled = compileBookMarkdownWithPageAnchors({
      plan, pages: [{ index: 1, title: "Home", markdown: "A fox walks home." }],
      readerChapters: [], storyPageLayout: "separate", language, authorName: author,
      includeSources: true, researchSources: [{ title: "Source", url: "https://example.test/fox", summary: "Facts" }],
      matter: { year: 2020, madeWithCredit: false, aboutAuthor: biography }
    });
    const data = await generateBookEpub(compiled.markdown, {
      title: plan.title, author, language, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test", pageMapPlan: compiled
    });
    const zip = await JSZip.loadAsync(data);
    expect(zip.file(/chapter-\d+\.xhtml$/)).toHaveLength(4);
    const navigation = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(navigation).toContain(`<a href="chapter-3.xhtml">${markdownLabels(language).sources}</a>`);
    expect(navigation).toContain(`<a href="chapter-4.xhtml">${markdownLabels(language).aboutAuthor}</a>`);
    const parsed = await parseManuscript({ data, format: "epub" });

    expect(parsed.matter?.aboutAuthor).toBe(biography);
    expect(parsed.matterRemoved).toContain("about_author");
    expect(parsed.text).toContain("A fox walks home.");
    expect(parsed.text).toContain("Source");
    expect(parsed.text).not.toContain(biography);
    const matter = bookMatterForImportedManuscript({ authorName: "Profile Author", bookMatter: { aboutAuthor: "My profile biography." } }, parsed.matter);
    const recompiled = compileBookMarkdown({
      plan, pages: [{ index: 1, title: "Imported", markdown: parsed.text }], readerChapters: [], language,
      authorName: matter.authorName, matter: { ...matter.bookMatter, year: 2020, madeWithCredit: false }
    });
    const reexported = await JSZip.loadAsync(await generateBookEpub(recompiled, {
      title: plan.title, author: matter.authorName, language, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
    }));
    const xhtml = (await Promise.all(reexported.file(/chapter-\d+\.xhtml$/).map((file) => file.async("string")))).join("\n");
    expect(xhtml.split(biography)).toHaveLength(2);
    expect(xhtml).not.toContain("My profile biography.");
  });

  it.each([
    { language: "es", author: "maría garcía" },
    { language: "en", author: "bell hooks" }
  ])("preserves a metadata-confirmed lowercase $language author over the profile", async ({ language, author }) => {
    const markdown = compileBookMarkdown({
      plan: { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" },
      pages: pages.slice(0, 1), readerChapters: [], language, authorName: author,
      matter: { year: 2019, madeWithCredit: false }
    });
    const data = await generateBookEpub(markdown, {
      title: TITLE, author, language, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
    });
    const parsed = await parseManuscript({ data, format: "epub" });

    expect(parsed.matter?.byline).toBe(author);
    expect(parsed.matter?.subtitle).toBeUndefined();
    expect(bookMatterForImportedManuscript({ authorName: "Profile Author" }, parsed.matter).authorName).toBe(author);
    expect(parsed.text).toBe(pages[0]!.markdown);
  });

  it.each([
    { language: "fa", isbn: "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷" },
    { language: "ar", isbn: "٩٧٨-٠-٣٠٦-٤٠٦١٥-٧" }
  ])("preserves the printed $language ISBN when re-importing the copyright page", async ({ language, isbn }) => {
    const markdown = compileBookMarkdown({
      plan: { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" },
      pages: pages.slice(0, 1), readerChapters: [], language, authorName: AUTHOR,
      matter: { year: 2019, madeWithCredit: false, isbn }
    });
    const data = await generateBookEpub(markdown, {
      title: TITLE, author: AUTHOR, language, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
    });
    const parsed = await parseManuscript({ data, format: "epub" });

    expect(parsed.matter?.isbn).toBe(isbn);
    expect(parsed.matterRemoved).toContain("copyright");
    expect(parsed.text).toBe(pages[0]!.markdown);
  });

  it.each(LOCALIZED_AUTHORS.flatMap(({ language, nativeAuthor }) => [true, false].map((contents) => ({
    language, contents, author: contents ? nativeAuthor : AUTHOR, subtitle: contents ? "A tale of snow and rivers" : ""
  }))))(
    "separates combined matter in $language, Contents: $contents", async ({ language, contents, author, subtitle }) => {
    const bodyPages = contents ? pages : pages.slice(0, 1);
    const markdown = compileBookMarkdown({
      plan: { ...originalDevelopmentPlan(), title: TITLE, subtitle },
      pages: bodyPages,
      readerChapters: contents ? chapters : [],
      authorName: author,
      language,
      matter: { year: 2019, madeWithCredit: false, dedication: DEDICATION, aboutAuthor: BIO, allRightsReserved: true }
    });
    const data = await generateBookEpub(markdown, {
      title: TITLE, author, language, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
    });
    const parsed = await parseManuscript({ data, format: "epub" });
    expect(parsed.matter).toEqual({
      byline: author, ...(subtitle ? { subtitle } : {}), dedication: DEDICATION, copyrightHolder: author, copyrightYear: "2019",
      allRightsReserved: true, aboutAuthor: BIO
    });
    expect(new Set(parsed.matterRemoved)).toEqual(new Set(["title_page", "dedication", "copyright", "contents", "about_author"]));
    expect(parsed.sections).toHaveLength(contents ? 2 : 1);
    expect(parsed.text.split(/\n+/)).toEqual(bodyPages.map((page) => page.markdown));
  });

  it.each([true, false])("regenerates only marked platform credit, author: %s", async (byline) => {
    const website = "https://jane.example";
    const markdown = compileBookMarkdown({
      plan: { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" },
      pages: pages.slice(0, 1), readerChapters: [], language: "en",
      ...(byline ? { authorName: AUTHOR } : {}),
      matter: { year: 2019, madeWithCredit: true, aboutAuthor: BIO, authorWebsite: website }
    });
    const data = await generateBookEpub(markdown, {
      title: TITLE, ...(byline ? { author: AUTHOR } : {}), language: "en",
      imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
    });
    const parsed = await parseManuscript({ data, format: "epub" });
    expect(parsed.matter?.byline).toBe(byline ? AUTHOR : undefined);
    expect(parsed.matter?.aboutAuthor).toBe(`${BIO}\n\n${website}`);
    expect(parsed.text).toBe(pages[0]!.markdown);
    expect(JSON.stringify(parsed.matter)).not.toContain("Tomeza");
  });

  it("keeps a dedication's paragraphs and literal publication-like words in the dedication", async () => {
    const dedication = "For the archivists: © 1980 is where our story began.\n\nFor my mother.\nAnd for my father.";
    const markdown = compileBookMarkdown({
      plan: { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" }, pages: pages.slice(0, 1),
      readerChapters: [], language: "en", authorName: AUTHOR,
      matter: { year: 2019, madeWithCredit: false, dedication }
    });
    const data = await generateBookEpub(markdown, {
      title: TITLE, author: AUTHOR, language: "en", imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
    });
    const parsed = await parseManuscript({ data, format: "epub" });
    expect(parsed.matter?.dedication).toBe(dedication);
    expect(parsed.matter?.copyrightYear).toBe("2019");
    expect(parsed.text).toBe(pages[0]!.markdown);
  });

  it("separates explicitly marked nested matter in third-party XHTML without splitting body subsections", async () => {
    const source = `<article><section epub:type="frontmatter">
      <section epub:type="titlepage"><h1>${TITLE}</h1><p>by ${AUTHOR}</p></section>
      <div role="doc-dedication"><p>For the ones who stayed.</p></div>
      <section epub:type="copyright-page"><div><p>© 2019 ${AUTHOR}</p></div><p>Cover illustrated by Alice.</p></section>
      </section><section epub:type="bodymatter"><h1>Snow</h1><p>${pages[0]!.markdown}</p>
      <div><h2>The thaw</h2><p>${pages[1]!.markdown}</p></div></section></article>`;
    const parsed = await parseManuscript({ data: await thirdPartyEpub(source), format: "epub" });
    expect(parsed.matter).toEqual({ byline: AUTHOR, dedication: "For the ones who stayed.", copyrightHolder: AUTHOR, copyrightYear: "2019" });
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]!.text).toBe("Cover illustrated by Alice.");
    expect(parsed.sections[1]!.title).toBe("Snow");
    expect(parsed.sections[1]!.text.split(/\n+/).map((line) => line.trim())).toEqual([pages[0]!.markdown, "The thaw", pages[1]!.markdown]);
  });

  it("retains unmarked XHTML as one chapter with its H2 subsection", async () => {
    const source = `<h1>Snow</h1><p>${pages[0]!.markdown}</p><h2>The thaw</h2><p>${pages[1]!.markdown}</p>`;
    const parsed = await parseManuscript({ data: await thirdPartyEpub(source), format: "epub" });
    expect(parsed.sections).toEqual([{ title: "Snow", text: `${pages[0]!.markdown}\n The thaw\n ${pages[1]!.markdown}` }]);
    expect(parsed.matter).toBeUndefined();
  });

  it.each([
    { language: "en", marker: "book-about-author" },
    { language: "fa", marker: "book-about-author book-about-author--compact" }
  ])("recovers the biography from an older combined $language back-matter file", async ({ language, marker }) => {
    const labels = markdownLabels(language);
    const body = `<h2>${labels.sources}</h2><ul><li>Source</li></ul>
      <h2>${labels.aboutAuthor}</h2><div class="${marker}"></div><p>${BIO}</p>`;
    const parsed = await parseManuscript({ data: await thirdPartyEpub(body), format: "epub" });

    expect(parsed.matter?.aboutAuthor).toBe(BIO);
    expect(parsed.matterRemoved).toContain("about_author");
    expect(parsed.sections).toEqual([{ title: labels.sources, text: "Source" }]);
    expect(bookMatterForImportedManuscript({ bookMatter: { aboutAuthor: "My profile biography." } }, parsed.matter).bookMatter?.aboutAuthor).toBe(BIO);
  });
});

async function thirdPartyEpub(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>');
  zip.file("content.opf", `<package><metadata><dc:title>${TITLE}</dc:title><dc:creator>${AUTHOR}</dc:creator></metadata>
    <manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="book"/></spine></package>`);
  zip.file("book.xhtml", `<html xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${TITLE}</title></head><body>${body}</body></html>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
