import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { compileBookMarkdownWithPageAnchors } from "./markdown.js";
import { buildBookPdfDocument } from "./pdfDocument.js";
import { bookPageAnchorLinkNav, injectBookPageAnchorMarkers } from "./pdfPageAnchors.js";
import { originalDevelopmentPlan } from "./testing/bookDevelopmentFixtures.js";
import { generateBookEpub } from "./epub.js";
import { generateBookDocx } from "./docx.js";

async function renderPages(pages: string[]) {
  const compiled = compileBookMarkdownWithPageAnchors({
    plan: originalDevelopmentPlan(),
    pages: pages.map((markdown, index) => ({ index: index + 1, title: "Page", markdown }))
  });
  const html = await buildBookPdfDocument({
    markdown: injectBookPageAnchorMarkers(compiled.markdown, compiled),
    pageAnchorNav: bookPageAnchorLinkNav(compiled.pageAnchors, {
      hasContents: compiled.hasContents,
      hasSources: compiled.sourcesOffset !== undefined
    }),
    profile: scriptProfileForLanguage("en"),
    css: ""
  });
  return { compiled, body: html.slice(html.indexOf("<body")) };
}

describe("exported markdown page boundaries", () => {
  it("keeps the paragraph following a page-ending table outside the table", async () => {
    const { compiled, body } = await renderPages([
      "| Operation | Private control | Public action | Protection |\n|---|---|---|---|\n| Digital signature | Signing key | Public verification | Integrity |",
      "The *Handbook of Applied Cryptography* treats these operations separately."
    ]);
    expect(body.match(/<td>/g)).toHaveLength(4);
    expect(body).toMatch(/<\/table>\s*<p><span id="bp-2">The<\/span> <em>Handbook/);
    const anchor = compiled.pageAnchors.find((value) => value.pageIndex === 2)!;
    expect(compiled.markdown.slice(anchor.markdownOffset)).toBe(
      "The *Handbook of Applied Cryptography* treats these operations separately."
    );
  });

  it.each([
    ["outer pipes", "| A | B |\n|---|---|\n| one | two |", "| three | four |"],
    ["no outer pipes", "A | B\n---|---\none | two", "three | four"]
  ])("keeps a continued table with %s intact, then closes it before prose", async (_name, first, second) => {
    const third = "| five | six |";
    const { compiled, body } = await renderPages([first, second, third, "After the table."]);
    expect(body.match(/<table>/g)).toHaveLength(1);
    expect(body.match(/<td>/g)).toHaveLength(6);
    expect(body).toMatch(/<\/table>\s*<p><span id="bp-4">After<\/span> the table\.<\/p>/);
    expect(compiled.markdown).toContain(`${first}\n${second}\n${third}\n\nAfter the table.`);
  });

  it.each([
    ["paragraph", "The sentence continues", "across pages.", "<p>"],
    ["list", "- One", "- Two", "<ul>"],
    ["quote", "> One", "> Two", "<blockquote>"],
    ["code fence", "```text\n| A | B |\n|---|---|\n| one | two |", "plain code\n```", "<pre\\b"],
    ["pipe-bearing prose", "Use A | B as an operator.", "Continue the explanation.", "<p>"]
  ])("preserves a continuing %s", async (_name, first, second, tag) => {
    const { compiled, body } = await renderPages([first, second]);
    expect(compiled.markdown).toContain(`${first}\n${second}`);
    expect(body.match(new RegExp(tag, "g"))).toHaveLength(1);
    expect(body).not.toContain("<table>");
  });

  it("does not treat an escaped pipe in following prose as a continued row", async () => {
    const { body } = await renderPages([
      "| A | B |\n|---|---|\n| one | two |", "An escaped \\| appears in prose."
    ]);
    expect(body.match(/<td>/g)).toHaveLength(2);
    expect(body).toMatch(/<\/table>\s*<p>/);
  });

  it("ends the table before an image and its caption", async () => {
    const { body } = await renderPages([
      "| A | B |\n|---|---|\n| one | two |", "![Diagram](diagram.svg)\n\nThe diagram caption."
    ]);
    expect(body.match(/<td>/g)).toHaveLength(2);
    expect(body).toMatch(/<\/table>\s*<p><img[^>]*id="bp-2"/);
    expect(body).toContain("<p>The diagram caption.</p>");
  });

  it("keeps the shared markdown boundary in EPUB and Word as well", async () => {
    const { compiled } = await renderPages(["| A | B |\n|---|---|\n| one | two |", "After the table."]);
    const options = {
      title: "Tables", language: "en", imageStorageDir: "/nonexistent", publicApiUrl: "https://example.test"
    };
    const epub = await JSZip.loadAsync(await generateBookEpub(compiled.markdown, options));
    const chapters = await Promise.all(epub.file(/chapter-\d+\.xhtml$/).map((file) => file.async("string")));
    const html = chapters.join("\n");
    expect(html.match(/<td>/g)).toHaveLength(2);
    expect(html).toMatch(/<\/table>\s*<p>After the table\.<\/p>/);
    const docx = await JSZip.loadAsync(await generateBookDocx(compiled.markdown, options));
    const xml = await docx.file("word/document.xml")!.async("string");
    expect(xml.match(/<w:tr>/g)).toHaveLength(2);
    expect(xml.slice(xml.indexOf("</w:tbl>"))).toContain("After the table.");
  });
});
