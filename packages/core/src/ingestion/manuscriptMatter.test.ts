import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { compileBookMarkdownWithPageAnchors } from "../generation/markdown.js";
import { authorReaderChapters } from "../generation/readerChapters.js";
import { bookMatterYear, parseBookMatter, type BookMatter } from "../schemas/bookMatter.js";
import {
  analyzeManuscriptStyle,
  bookMatterForImportedManuscript,
  deriveManuscriptTitle,
  parseManuscript,
  segmentManuscript,
  synthesizeImportedBookPlan,
  type ManuscriptImportFormat
} from "./manuscriptImport.js";
import { parseByline, parseCopyrightStatement, matterHeadingKind } from "./manuscriptMatterWords.js";

/**
 * An imported manuscript's own matter, through every step a real import takes:
 * the API's parse and profile merge, the worker's re-parse with the byline the
 * API stored, segmentation, the plan, and the author compile — so each test
 * reads the book as it prints.
 */

const BIO = "Jane Doe lives in Maine with two dogs and a stubborn garden. This is her first novel.";
const DEDICATION = "For my mother, who taught me to read.";
const COPYRIGHT_LINES = [
  "Copyright © 2019 Jane Doe",
  "All rights reserved.",
  "No part of this book may be reproduced in any form without written permission from the author.",
  "This is a work of fiction. Names, characters and places are products of the author's imagination.",
  "ISBN 978-0-306-40615-7",
  "Published by Lantern Press"
];
const PROFILE: { authorName: string; bookMatter: BookMatter } = {
  authorName: "Jane Doe",
  bookMatter: { aboutAuthor: "PROFILE BIO: Jane writes thrillers.", authorWebsite: "janedoe.com", imprint: "Self Press" }
};
const CHAPTERS = ["Chapter One", "Chapter Two", "Chapter Three"];

function prose(chapter: number, index: number): string {
  return `Snow fell on the valley in chapter ${chapter}, paragraph ${index}. ${"The wind kept its own counsel and the river slept under the ice. ".repeat(10).trim()}`;
}

function chapterParagraphs(chapter: number): string[] {
  return Array.from({ length: 8 }, (_, index) => prose(chapter, index));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type DocxParagraph = { text: string; style?: string } | { pageBreak: true };

async function docxBuffer(paragraphs: DocxParagraph[]): Promise<Buffer> {
  const body = paragraphs
    .map((paragraph) =>
      "pageBreak" in paragraph
        ? `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`
        : `<w:p>${paragraph.style ? `<w:pPr><w:pStyle w:val="${paragraph.style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${escapeXml(paragraph.text)}</w:t></w:r></w:p>`
    )
    .join("");
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

type EpubFile = { name: string; html: string; spine?: boolean };

async function epubBuffer(files: EpubFile[], meta: { title: string; creator: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  const manifest = files.map((file, index) => `<item id="f${index}" href="${file.name}" media-type="application/xhtml+xml"/>`).join("");
  const spine = files
    .map((file, index) => (file.spine === false ? "" : `<itemref idref="f${index}"/>`))
    .join("");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package><metadata><dc:title>${meta.title}</dc:title><dc:creator>${meta.creator}</dc:creator></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`
  );
  for (const file of files) zip.file(`OEBPS/${file.name}`, file.html);
  return zip.generateAsync({ type: "nodebuffer" });
}

function xhtml(title: string, body: string, bodyAttributes = ""): string {
  return `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body${bodyAttributes}>${body}</body></html>`;
}

const paragraphsHtml = (lines: readonly string[]) => lines.map((line) => `<p>${escapeXml(line)}</p>`).join("");

/** Every format's manuscript with a title page, a © page, a dedication, three chapters and About the Author. */
async function fullManuscript(format: ManuscriptImportFormat | "markdown"): Promise<{ data: Buffer; format: ManuscriptImportFormat; title: string }> {
  switch (format) {
    case "docx":
      return {
        format,
        title: "The Long Winter",
        data: await docxBuffer([
          { text: "The Long Winter", style: "Title" },
          { text: "by Jane Doe" },
          { pageBreak: true },
          ...COPYRIGHT_LINES.map((text) => ({ text })),
          { pageBreak: true },
          { text: DEDICATION },
          { pageBreak: true },
          ...CHAPTERS.flatMap((title, index) => [{ text: title, style: "Heading1" }, ...chapterParagraphs(index + 1).map((text) => ({ text }))]),
          { text: "About the Author", style: "Heading1" },
          { text: BIO }
        ])
      };
    case "epub":
      return {
        format,
        title: "The Long Winter",
        data: await epubBuffer(
          [
            { name: "cover.xhtml", html: xhtml("Cover", `<img src="cover.jpg" alt="Cover"/>`) },
            {
              name: "title.xhtml",
              html: xhtml("The Long Winter", `<section epub:type="titlepage"><h1>The Long Winter</h1><p class="author">Jane Doe</p></section>`)
            },
            { name: "copyright.xhtml", html: xhtml("The Long Winter", paragraphsHtml(COPYRIGHT_LINES)) },
            { name: "dedication.xhtml", html: xhtml("The Long Winter", `<p><em>${DEDICATION}</em></p>`) },
            ...CHAPTERS.map((title, index) => ({
              name: `ch${index + 1}.xhtml`,
              html: xhtml("The Long Winter", `<h1>${title}</h1>${paragraphsHtml(chapterParagraphs(index + 1))}`)
            })),
            { name: "ack.xhtml", html: xhtml("The Long Winter", `<h1>Acknowledgments</h1><p>Thanks to my editor, who read every draft.</p>`) },
            { name: "about.xhtml", html: xhtml("The Long Winter", `<h1>About the Author</h1><p>${BIO}</p>`) },
            {
              name: "nav.xhtml",
              spine: false,
              html: xhtml(
                "Contents",
                `<nav epub:type="toc"><h1>Table of Contents</h1><ol>${["Title Page", "Copyright", ...CHAPTERS, "About the Author"]
                  .map((entry) => `<li><a href="#">${entry}</a></li>`)
                  .join("")}</ol></nav>`
              )
            }
          ],
          { title: "The Long Winter", creator: "Jane Doe" }
        )
      };
    case "html":
      return {
        format,
        title: "The Long Winter",
        data: Buffer.from(
          `<html><body><h1>The Long Winter</h1><p>by Jane Doe</p><h2>Copyright</h2>${paragraphsHtml(COPYRIGHT_LINES)}<h2>Dedication</h2><p>${DEDICATION}</p>${CHAPTERS.map(
            (title, index) => `<h2>${title}</h2>${paragraphsHtml(chapterParagraphs(index + 1))}`
          ).join("")}<h2>About the Author</h2><p>${BIO}</p></body></html>`,
          "utf8"
        )
      };
    case "rtf": {
      const rtfLines = (lines: readonly string[]) => lines.map((line) => line.replace(/©/g, "\\'a9")).join("\\par ");
      return {
        format,
        title: "The Long Winter",
        data: Buffer.from(
          `{\\rtf1\\ansi The Long Winter\\par by Jane Doe\\page ${rtfLines(COPYRIGHT_LINES)}\\page ${DEDICATION}\\page ${CHAPTERS.map(
            (title, index) => `${title}\\par ${rtfLines(chapterParagraphs(index + 1))}`
          ).join("\\par ")}\\par About the Author\\par ${BIO}\\par }`,
          "utf8"
        )
      };
    }
    case "markdown":
      return {
        format: "text",
        title: "The Long Winter",
        data: Buffer.from(
          [
            "# The Long Winter",
            "*by Jane Doe*",
            "## Copyright",
            ...COPYRIGHT_LINES,
            "## Dedication",
            `*${DEDICATION}*`,
            ...CHAPTERS.flatMap((title, index) => [`## ${title}`, ...chapterParagraphs(index + 1)]),
            "## About the Author",
            BIO
          ].join("\n\n"),
          "utf8"
        )
      };
    case "text":
      // Word's "Save as plain text": one paragraph a line, a form feed where a page ended.
      return {
        format,
        title: "THE LONG WINTER",
        data: Buffer.from(
          [
            "THE LONG WINTER",
            "by Jane Doe",
            "\f",
            ...COPYRIGHT_LINES,
            "\f",
            DEDICATION,
            "\f",
            ...CHAPTERS.flatMap((title, index) => [title, ...chapterParagraphs(index + 1)]),
            "About the Author",
            BIO
          ].join("\n"),
          "utf8"
        )
      };
  }
}

/** One import as the API and the worker run it, then the author compile. */
async function importAndCompile(
  manuscript: { data: Buffer; format: ManuscriptImportFormat },
  profile: { authorName?: string; bookMatter?: BookMatter } = PROFILE,
  exportMatterOverrides: BookMatter = {}
) {
  const parsed = await parseManuscript({
    data: manuscript.data,
    format: manuscript.format,
    ...(profile.authorName ? { knownAuthors: [profile.authorName] } : {})
  });
  const book = bookMatterForImportedManuscript(profile, parsed.matter);
  const worker = await parseManuscript({
    data: manuscript.data,
    format: manuscript.format,
    ...(book.authorName ? { knownAuthors: [book.authorName] } : {})
  });
  // The API stores the matter; the worker writes the pages. Both must have read the same manuscript.
  expect(worker.sections).toEqual(parsed.sections);
  expect(worker.matter).toEqual(parsed.matter);
  const segmented = await segmentManuscript(worker);
  const title = deriveManuscriptTitle({ bookTitle: parsed.bookTitle, sections: parsed.sections, fileName: "draft.bin" });
  const style = await analyzeManuscriptStyle({ text: worker.text });
  const plan = synthesizeImportedBookPlan({ title, ...(book.subtitle ? { subtitle: book.subtitle } : {}), segmented, style });
  let index = 0;
  const pages = segmented.chapters.flatMap((chapter, chapterIndex) =>
    chapter.pages.map((page) => ({
      index: ++index,
      title: page.title,
      markdown: page.markdown,
      chapter: { index: chapterIndex + 1, title: chapter.title, summary: chapter.summary }
    }))
  );
  const { copyrightYear, ...matter } = parseBookMatter(book.bookMatter);
  const compiled = compileBookMarkdownWithPageAnchors({
    plan,
    pages,
    readerChapters: authorReaderChapters(pages),
    language: "en",
    ...(book.authorName ? { authorName: book.authorName } : {}),
    matter: {
      ...matter,
      ...exportMatterOverrides,
      year: bookMatterYear(copyrightYear ? { copyrightYear } : {}, new Date("2026-10-07T00:00:00Z")),
      madeWithCredit: false
    },
    authorManuscript: true
  });
  return { parsed, book, title, markdown: compiled.markdown, chapters: segmented.chapters.map((chapter) => chapter.title) };
}

describe("an imported manuscript's own matter prints once, in every format", () => {
  it.each([
    ["Derechos de autor", "María Pérez", "todos los derechos reservados."],
    ["Droits d’auteur", "Émilie Noël", "tous droits réservés."],
    ["Droits d’auteur", "E\u0301milie Noe\u0308l", "tous droits re\u0301serve\u0301s."],
    ["Impressum", "Jürgen Weiß", "alle Rechte vorbehalten."],
    ["Direitos autorais", "João Silva", "todos os direitos reservados."],
    ["Diritti d’autore", "Giulia Rossi", "tutti i diritti sono riservati."],
    ["Авторские права", "Алексей Иванов", "все права защищены."],
    ["Telif hakkı", "Ayşe Yılmaz", "tüm hakları saklıdır."],
    ["حقوق النشر", "ليلى أحمد", "جميع الحقوق محفوظة."],
    ["حقوق نشر", "مریم احمدی", "همهٔ حقوق محفوظ است."],
    ["حقوق اشاعت", "عائشہ خان", "جملہ حقوق محفوظ ہیں."],
    ["कॉपीराइट", "किरण शर्मा", "सर्वाधिकार सुरक्षित."],
    ["版权", "李明", "版权所有。"],
    ["版權", "李明", "版權所有。"],
    ["著作権", "山田 太郎", "無断転載を禁じます。"],
    ["저작권", "김민수", "모든 권리 보유."],
    ["זכויות יוצרים", "דנה לוי", "כל הזכויות שמורות."],
    ["Copyright", "Émilie Noël", "Ａｌｌ ｒｉｇｈｔｓ ｒｅｓｅｒｖｅｄ."]
  ])("lifts the inline rights notice from %s out of its holder", async (heading, holder, notice) => {
    const data = Buffer.from(
      [`## ${heading}`, `© 2023 ${holder}, ${notice}`, "## Chapter One", ...chapterParagraphs(1)].join("\n\n"),
      "utf8"
    );
    const { parsed, book, markdown } = await importAndCompile({ data, format: "text" });
    expect(parsed.matterRemoved).toContain("copyright");
    expect(book.bookMatter).toMatchObject({ copyrightHolder: holder, copyrightYear: "2023", allRightsReserved: true });
    expect(markdown).toContain(`© 2023 ${holder}`);
    expect(count(markdown, "All rights reserved")).toBe(1);
    expect(markdown).not.toContain(notice);
    const disabled = await importAndCompile({ data, format: "text" }, PROFILE, { allRightsReserved: false });
    expect(disabled.markdown).toContain(`© 2023 ${holder}`);
    expect(disabled.markdown).not.toContain("All rights reserved");
    expect(disabled.markdown).not.toContain(notice);
  });

  it.each([
    ["© 2023 tous droits réservés Éditions du Rivage", "Éditions du Rivage"],
    ["© 2023山田太郎、無断転載禁止。", "山田太郎"],
    ["© 2023 مريم أحمدي، جميع الحقوق محفوظة.", "مريم أحمدي"]
  ])("keeps the holder's original spelling around a notice in %s", async (statement, holder) => {
    const data = Buffer.from(["## Copyright", statement, "## Chapter One", ...chapterParagraphs(1)].join("\n\n"), "utf8");
    const { book, markdown } = await importAndCompile({ data, format: "text" });
    expect(book.bookMatter).toMatchObject({ copyrightHolder: holder, copyrightYear: "2023", allRightsReserved: true });
    expect(markdown).toContain(`© 2023 ${holder}`);
    expect(count(markdown, "All rights reserved")).toBe(1);
  });

  it.each([
    ["Publisher:Lantern Press", "Lantern Press"],
    ["出版社：山田 出版", "山田 出版"],
    ["出版社：山田出版", "山田出版"],
    ["Éditeur:Éditions du Rivage", "Éditions du Rivage"],
    ["E\u0301diteur:Éditions du Rivage", "Éditions du Rivage"],
    ["Ｐｕｂｌｉｓｈｅｒ：Lantern Press", "Lantern Press"],
    ["ناشِر:انتشارات روشنا", "انتشارات روشنا"],
    ["издательство\u0301:Северный Свет", "Северный Свет"],
    ["Published\tby  Lantern Press", "Lantern Press"],
    ["Publisher : Lantern Press", "Lantern Press"]
  ])("preserves the entire publisher from %s after removing its copyright page", async (line, imprint) => {
    const data = Buffer.from(
      ["## Copyright", "© 2019 Jane Doe", line, "## Chapter One", ...chapterParagraphs(1)].join("\n\n"),
      "utf8"
    );
    const { parsed, book, markdown } = await importAndCompile({ data, format: "text" });
    expect(parsed.matterRemoved).toContain("copyright");
    expect(parsed.sections.map((section) => section.title)).toEqual(["Chapter One"]);
    expect(book.bookMatter?.imprint).toBe(imprint);
    expect(count(markdown, imprint)).toBe(1);
  });

  for (const format of ["docx", "epub", "html", "rtf", "markdown", "text"] as const) {
    it(`${format}: title page, © page, dedication and About the Author`, async () => {
      const manuscript = await fullManuscript(format);
      const { parsed, book, title, markdown, chapters } = await importAndCompile(manuscript);

      expect(parsed.matterRemoved).toEqual(
        expect.arrayContaining(["title_page", "copyright", "dedication", "about_author"])
      );
      expect(title).toBe(manuscript.title);
      expect(chapters).toEqual(format === "epub" ? [...CHAPTERS, "Acknowledgments"] : CHAPTERS);
      expect(book.authorName).toBe("Jane Doe");
      // The manuscript's words win field by field; the profile fills the rest.
      expect(book.bookMatter).toEqual({
        dedication: DEDICATION,
        aboutAuthor: BIO,
        authorWebsite: "janedoe.com",
        imprint: "Lantern Press",
        isbn: "978-0-306-40615-7",
        allRightsReserved: true,
        copyrightYear: "2019"
      });

      // The title page: the compiler's, once.
      expect(count(markdown, manuscript.title)).toBe(1);
      expect(count(markdown, "by Jane Doe")).toBe(1);
      // One © statement, with the year the manuscript printed, and its lines once.
      expect(count(markdown, "©")).toBe(1);
      expect(markdown).toContain("© 2019 Jane Doe");
      expect(count(markdown, "All rights reserved")).toBe(1);
      expect(count(markdown, "ISBN 978-0-306-40615-7")).toBe(1);
      expect(count(markdown, "Lantern Press")).toBe(1);
      expect(markdown).not.toContain("Self Press");
      // The page's boilerplate went with the page.
      expect(markdown).not.toContain("No part of this book");
      expect(markdown).not.toContain("work of fiction");
      // The dedication on the matter sheet, once.
      expect(count(markdown, "For my mother")).toBe(1);
      expect(markdown).toContain('<div class="book-matter-sheet__dedication">');
      // One About the Author: the manuscript's, in the house layout, never the profile's.
      expect(count(markdown, "About the Author")).toBe(1);
      expect(count(markdown, "Jane Doe lives in Maine with two dogs and a stubborn garden")).toBe(1);
      expect(markdown).not.toContain("PROFILE BIO");
      expect(markdown).toContain('<div class="book-about-author');
      // And the book itself is all there.
      expect(count(markdown, "Snow fell on the valley")).toBe(24);
      if (format === "epub") {
        expect(markdown).not.toContain("Table of Contents");
        expect(count(markdown, "Thanks to my editor")).toBe(1);
      }
    });
  }
});

describe("what the separation keeps", () => {
  it("keeps a © page's credits in the book and takes only the sheet's lines off it", async () => {
    const data = Buffer.from(
      [
        "# The Long Winter",
        "by Jane Doe",
        "## Copyright",
        ...COPYRIGHT_LINES,
        "Cover design by Sam Lee",
        ...CHAPTERS.flatMap((title, index) => [`## ${title}`, ...chapterParagraphs(index + 1)])
      ].join("\n\n"),
      "utf8"
    );
    const { parsed, book, markdown, chapters } = await importAndCompile({ data, format: "text" });

    expect(parsed.matterRemoved).toEqual(["title_page", "copyright"]);
    expect(chapters).toEqual(["Copyright", ...CHAPTERS]);
    expect(book.bookMatter).toMatchObject({ copyrightYear: "2019", isbn: "978-0-306-40615-7", imprint: "Lantern Press" });
    expect(count(markdown, "©")).toBe(1);
    expect(count(markdown, "Cover design by Sam Lee")).toBe(1);
    // A page that stays keeps its boilerplate: only the lines the sheet reprints came off.
    expect(count(markdown, "No part of this book")).toBe(1);
    expect(count(markdown, "ISBN")).toBe(1);
    expect(count(markdown, "All rights reserved")).toBe(1);
  });

  it.each([
    { dedication: DEDICATION, extracted: false },
    { dedication: "This book is dedicated to my mother, who taught me to read.", extracted: true }
  ])("reads no-break title and © lines, lifting only explicit dedication wording: $dedication", async ({ dedication, extracted }) => {
    const lines = ["The Long Winter", "by Jane Doe", ...COPYRIGHT_LINES, dedication];
    const docx = await docxBuffer([
      ...lines.map((text, index) => (index === 0 ? { text, style: "Title" } : { text })),
      ...CHAPTERS.flatMap((title, index) => [{ text: title, style: "Heading1" }, ...chapterParagraphs(index + 1).map((text) => ({ text }))])
    ]);
    const text = Buffer.from([...lines, ...CHAPTERS.flatMap((title, index) => [title, ...chapterParagraphs(index + 1)])].join("\n"), "utf8");

    for (const manuscript of [{ data: docx, format: "docx" as const }, { data: text, format: "text" as const }]) {
      const { parsed, markdown, chapters } = await importAndCompile(manuscript);
      expect(parsed.matterRemoved).toEqual(extracted ? ["title_page", "copyright", "dedication"] : ["title_page", "copyright"]);
      expect(parsed.matter?.dedication).toBe(extracted ? dedication : undefined);
      expect(parsed.text.includes(dedication)).toBe(!extracted);
      expect(chapters.slice(-CHAPTERS.length)).toEqual(CHAPTERS);
      expect(count(markdown, "©")).toBe(1);
      expect(count(markdown, dedication)).toBe(1);
      // Ambiguous text stays in the body, so its page's legal boilerplate stays too.
      expect(markdown.includes("No part of this book")).toBe(!extracted);
    }
  });

  it("keeps the book that follows its © lines in a section with no chapter headings", async () => {
    const data = Buffer.from(["The Long Winter", "by Jane Doe", ...COPYRIGHT_LINES, ...chapterParagraphs(1)].join("\n\n"), "utf8");
    const { parsed, markdown } = await importAndCompile({ data, format: "text" });
    expect(parsed.matterRemoved).toEqual(["title_page", "copyright"]);
    expect(count(markdown, "©")).toBe(1);
    // Not the whole page, so its boilerplate stays where the author put it.
    expect(count(markdown, "No part of this book")).toBe(1);
    expect(count(markdown, "Snow fell on the valley")).toBe(8);
  });

  it("keeps an About the Author too long for the field in the pages, and leaves the profile's bio out", async () => {
    const longBio = Array.from({ length: 20 }, (_, index) => `Jane Doe spent year ${index + 1} of her life writing in a cabin by the lake, far from any road.`).join(" ");
    const data = Buffer.from(
      [...CHAPTERS.flatMap((title, index) => [`## ${title}`, ...chapterParagraphs(index + 1)]), "## About the Author", longBio].join("\n\n"),
      "utf8"
    );
    const { parsed, book, markdown, chapters } = await importAndCompile({ data, format: "text" });

    expect(longBio.length).toBeGreaterThan(1500);
    expect(parsed.matter).toEqual({ aboutAuthorInPages: true });
    expect(chapters).toEqual([...CHAPTERS, "About the Author"]);
    expect(book.bookMatter?.aboutAuthor).toBeUndefined();
    expect(markdown).not.toContain("PROFILE BIO");
    expect(markdown).not.toContain('<div class="book-about-author');
    expect(count(markdown, "year 20 of her life")).toBe(1);
  });

  it("keeps a chapter called About the Author in the middle of a novel, and prints the profile's bio", async () => {
    const data = Buffer.from(
      ["## Chapter One", ...chapterParagraphs(1), "## About the Author", "Mara found the old notebook under the stairs.", ...chapterParagraphs(2), "## Chapter Three", ...chapterParagraphs(3)].join("\n\n"),
      "utf8"
    );
    const { parsed, book, markdown, chapters } = await importAndCompile({ data, format: "text" });

    expect(parsed.matter).toBeUndefined();
    expect(parsed.matterRemoved).toBeUndefined();
    expect(chapters).toEqual(["Chapter One", "About the Author", "Chapter Three"]);
    expect(book.bookMatter?.aboutAuthor).toBe("PROFILE BIO: Jane writes thrillers.");
    expect(count(markdown, "Mara found the old notebook")).toBe(1);
  });

  it("keeps a chapter called Dedication, or Copyright, that is the book's own", async () => {
    const data = Buffer.from(
      ["## Chapter One", ...chapterParagraphs(1), "## Dedication", "For years he gave the mill everything he had.", ...chapterParagraphs(2), "## Copyright", "Copyright law was the last thing on her mind.", ...chapterParagraphs(3)].join("\n\n"),
      "utf8"
    );
    const { parsed, chapters } = await importAndCompile({ data, format: "text" });
    expect(parsed.matterRemoved).toBeUndefined();
    expect(chapters).toEqual(["Chapter One", "Dedication", "Copyright"]);
  });

  it("never reads a novel's opening as a title page or a dedication", async () => {
    const opening = ["For three days it rained, and the river rose over the low fields until the church stood alone in the water.", ...chapterParagraphs(1)];
    const untitled = Buffer.from([...opening, "Chapter 2", ...chapterParagraphs(2)].join("\n\n"), "utf8");
    const titled = Buffer.from(["# The Storm", "It rained all night.", ...chapterParagraphs(1), "# Chapter 2", ...chapterParagraphs(2)].join("\n\n"), "utf8");
    const letters = Buffer.from(["# The Long Winter", "A story told in letters, written by the sea over many years.", "# Chapter 1", ...chapterParagraphs(1)].join("\n\n"), "utf8");

    for (const data of [untitled, titled, letters]) {
      const parsed = await parseManuscript({ data, format: "text", knownAuthors: ["Jane Doe"] });
      expect(parsed.matter).toBeUndefined();
      expect(parsed.matterRemoved).toBeUndefined();
    }
    expect((await parseManuscript({ data: titled, format: "text" })).sections[0]!.title).toBe("The Storm");
  });

  it("keeps short unheaded Word opening prose before the first styled chapter", async () => {
    const opening = "For three days it rained. The river swallowed the bridge and the village waited.";
    const data = await docxBuffer([
      { text: opening },
      { text: "Chapter One", style: "Heading1" },
      { text: "On the fourth day Alice left home." }
    ]);
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.matter).toBeUndefined();
    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.sections[0]).toEqual({ title: null, text: opening });
  });

  it("keeps the short EPUB chapters and acknowledgments the old title rule dropped", async () => {
    const data = await epubBuffer(
      [
        { name: "a.xhtml", html: xhtml("Book", `<h1>Covert</h1><p>The agent waited.</p>`) },
        { name: "b.xhtml", html: xhtml("Book", `<h1>Navigating the Storm</h1><p>The boat turned.</p>`) },
        { name: "c.xhtml", html: xhtml("Book", `<h1>Contents of the Box</h1><p>A key and a letter.</p>`) },
        { name: "d.xhtml", html: xhtml("Book", `<h1>Acknowledgments</h1><p>Thank you, Sam.</p>`) }
      ],
      { title: "Short Book", creator: "Jane Doe" }
    );
    const parsed = await parseManuscript({ data, format: "epub" });
    expect(parsed.sections.map((section) => section.title)).toEqual(["Covert", "Navigating the Storm", "Contents of the Box", "Acknowledgments"]);
    expect(parsed.bookTitle).toBe("Short Book");
    // The chapter's heading is its title, printed once as the chapter heading, never as page text.
    expect(parsed.sections[0]!.text).toBe("The agent waited.");
  });

  it("keeps a title page with a line it cannot place", async () => {
    const data = await docxBuffer([
      { text: "The Long Winter", style: "Title" },
      { text: "A story told in letters, written by the sea over many years." },
      { text: "Chapter One", style: "Heading1" },
      ...chapterParagraphs(1).map((text) => ({ text }))
    ]);
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.sections[0]!.title).toBe("The Long Winter");
  });

  it("reads a Persian manuscript's dedication and About the Author by their headings", async () => {
    const data = Buffer.from(
      [
        "# زمستان طولانی",
        "نوشته‌ی جین دو",
        "## تقدیم",
        "به مادرم که خواندن را به من آموخت",
        "## فصل اول",
        ...chapterParagraphs(1),
        "## درباره‌ی نویسنده",
        "جین دو در شیراز زندگی می‌کند."
      ].join("\n\n"),
      "utf8"
    );
    const parsed = await parseManuscript({ data, format: "text" });
    expect(parsed.bookTitle).toBe("زمستان طولانی");
    expect(parsed.matter).toEqual({
      byline: "جین دو",
      dedication: "به مادرم که خواندن را به من آموخت",
      aboutAuthor: "جین دو در شیراز زندگی می‌کند."
    });
    expect(parsed.sections.map((section) => section.title)).toEqual(["فصل اول"]);
  });

  it("keeps a manuscript that is nothing but matter whole", async () => {
    const data = Buffer.from(["## Dedication", DEDICATION, "## About the Author", BIO].join("\n\n"), "utf8");
    const parsed = await parseManuscript({ data, format: "text" });
    expect(parsed.matter).toBeUndefined();
    expect(parsed.sections.map((section) => section.title)).toEqual(["Dedication", "About the Author"]);
  });

  it("leaves no page-break mark in any page", async () => {
    const data = await docxBuffer([
      { text: "Chapter One", style: "Heading1" },
      { text: "Before the break." },
      { pageBreak: true },
      { text: "After the break." },
      { text: "Chapter Two", style: "Heading1" },
      { text: "The end." }
    ]);
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.sections).toEqual([
      { title: "Chapter One", text: "Before the break.\nAfter the break." },
      { title: "Chapter Two", text: "The end." }
    ]);
  });
});

describe("bookMatterForImportedManuscript", () => {
  it("is the profile's matter when the manuscript has none", () => {
    expect(bookMatterForImportedManuscript(PROFILE, undefined)).toEqual({ authorName: "Jane Doe", bookMatter: PROFILE.bookMatter });
    expect(bookMatterForImportedManuscript({}, undefined)).toEqual({});
  });

  it("prints the profile's website under the manuscript's bio unless the bio gives it", () => {
    const withSite = bookMatterForImportedManuscript(PROFILE, { aboutAuthor: "Jane writes. Visit https://www.janedoe.com/ for more." });
    expect(withSite.bookMatter).toEqual({ aboutAuthor: "Jane writes. Visit https://www.janedoe.com/ for more.", imprint: "Self Press" });
    const without = bookMatterForImportedManuscript(PROFILE, { aboutAuthor: "Jane writes." });
    expect(without.bookMatter).toMatchObject({ aboutAuthor: "Jane writes.", authorWebsite: "janedoe.com" });
  });

  it("leaves a © holder that is the byline to fall back to it, and keeps one that is not", () => {
    expect(bookMatterForImportedManuscript({}, { byline: "Jane Doe", copyrightHolder: "JANE DOE" }).bookMatter).toBeUndefined();
    expect(bookMatterForImportedManuscript(PROFILE, { copyrightHolder: "Lantern Press Ltd", copyrightYear: "2015–2019" }).bookMatter).toMatchObject({
      copyrightHolder: "Lantern Press Ltd",
      copyrightYear: "2015–2019"
    });
  });

  it("leaves the profile's bio out when the manuscript kept its own in the pages", () => {
    expect(bookMatterForImportedManuscript(PROFILE, { aboutAuthorInPages: true }).bookMatter).toEqual({
      authorWebsite: "janedoe.com",
      imprint: "Self Press"
    });
  });

  it("takes the manuscript's byline and subtitle over the profile's pen name", () => {
    expect(bookMatterForImportedManuscript(PROFILE, { byline: "J. Doe", subtitle: "A Novel" })).toMatchObject({
      authorName: "J. Doe",
      subtitle: "A Novel"
    });
  });
});

describe("the words matter is recognised by", () => {
  it("reads © statements as written, and nothing that only mentions copyright", () => {
    expect(parseCopyrightStatement("Copyright © 2019 by Jane Doe")).toEqual({ holder: "Jane Doe", year: "2019", scoped: false, rights: false });
    expect(parseCopyrightStatement("© Jane Doe, 2019. All rights reserved.")).toEqual({ holder: "Jane Doe", year: "2019", scoped: false, rights: true });
    expect(parseCopyrightStatement("© 2015–2019 Jane Doe")).toMatchObject({ holder: "Jane Doe", year: "2015–2019" });
    expect(parseCopyrightStatement("Illustrations © 2019 Sam Lee")).toMatchObject({ holder: "Sam Lee", scoped: true });
    expect(parseCopyrightStatement("© ۱۴۰۲ جین دو")).toMatchObject({ holder: "جین دو", year: "1402" });
    expect(parseCopyrightStatement("Copyright law protects the work of authors.")).toBeNull();
    expect(parseCopyrightStatement("Copyright")).toBeNull();
  });

  it("reads bylines, and not a subtitle that happens to say by", () => {
    expect(parseByline("by Jane Doe")).toEqual({ name: "Jane Doe" });
    expect(parseByline("Written by J. R. Ellis")).toEqual({ name: "J. R. Ellis" });
    expect(parseByline("A Novel by Jane Doe")).toEqual({ name: "Jane Doe", lead: "A Novel" });
    expect(parseByline("Author: Jane Doe")).toEqual({ name: "Jane Doe" });
    expect(parseByline("山田太郎 著")).toEqual({ name: "山田太郎" });
    expect(parseByline("Stand by Me")).toBeNull();
    expect(parseByline("by the sea")).toBeNull();
  });

  it("names matter only by a whole heading", () => {
    expect(matterHeadingKind("About the Author")).toBe("about");
    expect(matterHeadingKind("## ABOUT THE AUTHOR:")).toBe("about");
    expect(matterHeadingKind("Über die Autorin")).toBe("about");
    expect(matterHeadingKind("À propos de l’auteur")).toBe("about");
    expect(matterHeadingKind("Об авторе")).toBe("about");
    expect(matterHeadingKind("著者について")).toBe("about");
    expect(matterHeadingKind("Dédicace")).toBe("dedication");
    expect(matterHeadingKind("Table des matières")).toBe("contents");
    expect(matterHeadingKind("Also by Jane Doe")).toBe("passover");
    expect(matterHeadingKind("About the Author's Mother")).toBeNull();
    expect(matterHeadingKind("Covert")).toBeNull();
  });
});
