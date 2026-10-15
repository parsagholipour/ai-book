import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { generateBookDocx } from "../generation/docx.js";
import { compileBookMarkdown } from "../generation/markdown.js";
import { originalDevelopmentPlan } from "../generation/testing/bookDevelopmentFixtures.js";
import { bookMatterForImportedManuscript, parseManuscript } from "./manuscriptImport.js";

const TITLE = "The Long Winter";
const BODY = "Snow fell on the valley. The river slept under the ice and the wind kept its own counsel.";
const PLAN = { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" };
const EXPORT_OPTIONS = { title: TITLE, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test" };
const LANGUAGES = [
  { language: "en", author: "Jane Doe", credit: "Made with Tomeza" },
  { language: "fa", author: "لیلا نوری", credit: "ساخته‌شده با Tomeza" },
  { language: "ja", author: "山田太郎", credit: "Tomezaで制作" }
];

function compile(language: string, authorName: string | undefined, madeWithCredit: boolean, body = BODY): string {
  return compileBookMarkdown({
    plan: PLAN, pages: [{ index: 1, title: "Snow", markdown: body }], readerChapters: [],
    language, authorName, matter: { year: 2019, madeWithCredit }
  });
}

describe("Word compiler credit round-trip", () => {
  it.each(LANGUAGES.flatMap((item) => [true, false].map((byline) => ({ ...item, byline }))))(
    "regenerates only the current tier's credit in $language, byline: $byline", async ({ language, author, credit, byline }) => {
      const authorName = byline ? author : undefined;
      const markdown = compile(language, authorName, true);
      expect(markdown).toContain(credit);
      const data = await generateBookDocx(markdown, { ...EXPORT_OPTIONS, language, author: authorName });
      const parsed = await parseManuscript({ data, format: "docx" });
      expect(parsed.text).toBe(BODY);
      expect(parsed.matter?.byline).toBe(authorName);
      expect(JSON.stringify(parsed.matter ?? {})).not.toContain("Tomeza");

      const imported = bookMatterForImportedManuscript({}, parsed.matter);
      for (const madeWithCredit of [false, true]) {
        const recompiled = compile(language, imported.authorName, madeWithCredit, parsed.text);
        expect(recompiled.split(credit)).toHaveLength(madeWithCredit ? 2 : 1);
        const reexported = await generateBookDocx(recompiled, { ...EXPORT_OPTIONS, language, author: imported.authorName });
        expect((await parseManuscript({ data: reexported, format: "docx" })).text).toBe(BODY);
      }
    }
  );

  it.each(LANGUAGES)("retains the author's identical credit words in $language", async ({ language, author, credit }) => {
    const body = `${BODY}\n\n${credit}\n\nThe inscription was still visible beneath the snow.`;
    const data = await generateBookDocx(compile(language, author, true, body), { ...EXPORT_OPTIONS, language, author });
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.text.split(/\n+/)).toEqual(body.split(/\n+/));
    expect(compile(language, author, false, parsed.text).split(credit)).toHaveLength(2);
    expect(compile(language, author, true, parsed.text).split(credit)).toHaveLength(3);
  });

  it.each(LANGUAGES)("retains identical user-supplied publication text in $language", async ({ language, author, credit }) => {
    const markdown = compileBookMarkdown({
      plan: PLAN, pages: [{ index: 1, title: "Snow", markdown: BODY }], readerChapters: [], language, authorName: author,
      matter: { year: 2019, madeWithCredit: true, imprint: credit }
    });
    const data = await generateBookDocx(markdown, { ...EXPORT_OPTIONS, language, author });
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.text.split(/\n+/)).toEqual([credit, BODY]);
  });

  it.each(["before", "inside", "section"])("keeps a %s page boundary carried by the credit paragraph", async (boundary) => {
    const zip = await JSZip.loadAsync(await generateBookDocx(compile("en", undefined, true), { ...EXPORT_OPTIONS, language: "en" }));
    const xml = await zip.file("word/document.xml")!.async("string");
    let credit = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)!.find((paragraph) => paragraph.includes("Made with Tomeza"))!;
    if (boundary === "before") credit = credit.replace("<w:pPr>", "<w:pPr><w:pageBreakBefore/>");
    if (boundary === "inside") credit = credit.replace("</w:t>", '</w:t><w:br w:type="page"/>');
    if (boundary === "section") credit = credit.replace("<w:pPr>", '<w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr>');
    const body = `<w:p><w:r><w:t>For my mother.</w:t></w:r></w:p>${credit}<w:p><w:r><w:t>${BODY}</w:t></w:r></w:p>`;
    zip.file("word/document.xml", xml.replace(/<w:body>[\s\S]*?<\/w:body>/, `<w:body>${body}</w:body>`));
    const parsed = await parseManuscript({ data: await zip.generateAsync({ type: "nodebuffer" }), format: "docx" });
    expect(parsed.matter?.dedication).toBe("For my mother.");
    expect(parsed.text).toBe(BODY);
  });

  it("keeps text added outside the credit bookmark in the same paragraph", async () => {
    const zip = await JSZip.loadAsync(await generateBookDocx(compile("en", undefined, true), { ...EXPORT_OPTIONS, language: "en" }));
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) =>
      paragraph.includes("Made with Tomeza")
        ? paragraph.replace("</w:p>", "<w:r><w:t>Cover illustrated by Alice.</w:t></w:r></w:p>") : paragraph
    ));
    const parsed = await parseManuscript({ data: await zip.generateAsync({ type: "nodebuffer" }), format: "docx" });
    expect(parsed.text.split(/\n+/)).toEqual(["Cover illustrated by Alice.", BODY]);
  });

  it("retains an older export's unmarked credit because its origin is ambiguous", async () => {
    const zip = await JSZip.loadAsync(await generateBookDocx(compile("en", undefined, true), { ...EXPORT_OPTIONS, language: "en" }));
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.replace(/<w:bookmark(?:Start|End)\b[^>]*\/>/g, ""));
    const parsed = await parseManuscript({ data: await zip.generateAsync({ type: "nodebuffer" }), format: "docx" });
    expect(parsed.text).toContain("Made with Tomeza");
    expect(parsed.text).toContain(BODY);
  });
});
