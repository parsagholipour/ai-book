import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { generateBookDocx } from "../generation/docx.js";
import { compileBookMarkdown } from "../generation/markdown.js";
import { originalDevelopmentPlan } from "../generation/testing/bookDevelopmentFixtures.js";
import { bookMatterForImportedManuscript, parseManuscript } from "./manuscriptImport.js";

const TITLE = "The Long Winter";
const BODY = "Snow fell on the valley. The river slept under the ice and the wind kept its own counsel.";
const PROFILE_AUTHOR = "Someone Else";
const LOCALIZED_AUTHORS = [
  { language: "tr", author: "Ayşe Yılmaz" },
  { language: "ru", author: "Анна Иванова" },
  { language: "hi", author: "आशा शर्मा" },
  { language: "zh", author: "王小明" },
  { language: "ja", author: "山田太郎" },
  { language: "ko", author: "김민수" },
  { language: "el", author: "Ελένη Παπαδοπούλου" },
  { language: "pl", author: "Anna Nowak" },
  { language: "th", author: "สมชาย ใจดี" },
  { language: "uk", author: "Олена Шевченко" },
  { language: "vi", author: "Nguyễn Văn An" }
];

async function exportedWord(language: string, author: string): Promise<Buffer> {
  const markdown = compileBookMarkdown({
    plan: { ...originalDevelopmentPlan(), title: TITLE, subtitle: "" },
    pages: [{ index: 1, title: "Snow", markdown: BODY }],
    readerChapters: [], authorName: author, language,
    matter: { year: 2019, madeWithCredit: false, allRightsReserved: true }
  });
  return generateBookDocx(markdown, {
    title: TITLE, author, language, imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
  });
}

async function withCoreMetadata(data: Buffer, xml: string | null): Promise<Buffer> {
  const zip = await JSZip.loadAsync(data);
  if (xml === null) zip.remove("docProps/core.xml");
  else zip.file("docProps/core.xml", xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

function coreMetadata(creator: string): string {
  return `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${creator}</dc:creator></cp:coreProperties>`;
}

describe("DOCX creator metadata", () => {
  it.each(LOCALIZED_AUTHORS.flatMap((item) => [false, true].map((profile) => ({ ...item, profile }))))(
    "restores exported $language matter with profile: $profile", async ({ language, author, profile }) => {
      const parsed = await parseManuscript({
        data: await exportedWord(language, author), format: "docx",
        ...(profile ? { knownAuthors: [PROFILE_AUTHOR] } : {})
      });
      expect(parsed.bookTitle).toBe(TITLE);
      expect(parsed.text).toBe(BODY);
      expect(parsed.matter).toEqual({ byline: author, copyrightHolder: author, copyrightYear: "2019", allRightsReserved: true });
      expect(bookMatterForImportedManuscript(profile ? { authorName: PROFILE_AUTHOR } : {}, parsed.matter).authorName).toBe(author);
    }
  );

  it("matches XML-escaped creator names from a real export", async () => {
    const author = "Ayşe & O'Neil";
    const parsed = await parseManuscript({ data: await exportedWord("tr", author), format: "docx" });
    expect(parsed.matter?.byline).toBe(author);
    expect(parsed.text).toBe(BODY);
  });

  it.each([
    { name: "numeric entities", xml: coreMetadata("&#x5C71;&#30000;太郎") },
    { name: "CDATA", xml: coreMetadata("<![CDATA[山田太郎]]>") },
    { name: "a renamed namespace prefix", xml: coreMetadata("山田太郎").replaceAll("dc:", "author:").replace("xmlns:dc", "xmlns:author") }
  ])("reads creator text with $name", async ({ xml }) => {
    const data = await withCoreMetadata(await exportedWord("ja", "山田太郎"), xml);
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.matter?.byline).toBe("山田太郎");
    expect(parsed.text).toBe(BODY);
  });

  it.each([
    { name: "missing", xml: null },
    { name: "blank", xml: coreMetadata(" \n ") },
    { name: "malformed", xml: coreMetadata("山田太郎").replace("</dc:creator>", "</dc:wrong>") },
    { name: "a different creator", xml: coreMetadata(PROFILE_AUTHOR) },
    { name: "a foreign namespace", xml: coreMetadata("山田太郎").replace("http://purl.org/dc/elements/1.1/", "https://example.test/other") }
  ])("keeps uncertain bylines as content when metadata is $name", async ({ xml }) => {
    const data = await withCoreMetadata(await exportedWord("ja", "山田太郎"), xml);
    const parsed = await parseManuscript({ data, format: "docx", knownAuthors: [PROFILE_AUTHOR] });
    expect(parsed.matter?.byline).toBeUndefined();
    expect(parsed.text).toContain("著者 山田太郎");
    expect(parsed.text).toContain(BODY);
    expect(bookMatterForImportedManuscript({ authorName: PROFILE_AUTHOR }, parsed.matter).authorName).toBe(PROFILE_AUTHOR);
  });

  it("retains caller hints when the document has a different creator", async () => {
    const data = await withCoreMetadata(await exportedWord("ja", "山田太郎"), coreMetadata(PROFILE_AUTHOR));
    const parsed = await parseManuscript({ data, format: "docx", knownAuthors: ["山田太郎"] });
    expect(parsed.matter?.byline).toBe("山田太郎");
    expect(parsed.text).toBe(BODY);
  });
});
