import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { BOOK_PDF_OPTIONS, bookPdfBaseStylesheetPaths, buildBookPdfDocument } from "./pdfDocument.js";

/**
 * The book is typeset against md-to-pdf's bundled `markdown.css` and highlight.js'
 * `github.css`, which we now deep-import rather than let md-to-pdf inject. A
 * dependency bump that changes either one silently re-typesets every book ever
 * compiled, so it has to fail here instead.
 *
 * When one of these fires: render the fixture corpus before and after, compare
 * `pdfinfo | grep Pages` first, and only then update the digest.
 */
const MARKDOWN_CSS_SHA256 = "a7570e486a31d8b401efe9f7339d569d6dbf11e0b230c5528d57390eaf34b550";
const HIGHLIGHT_CSS_SHA256 = "4164771f545d87f697360d9b1fa176ce8759a9acf83f1c47212aa1c2d2e0d619";

async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("book PDF base stylesheets", () => {
  it("still resolves md-to-pdf's markdown.css unchanged", async () => {
    const { markdownCss } = bookPdfBaseStylesheetPaths();
    expect(markdownCss).toMatch(/md-to-pdf[/\\]markdown\.css$/);
    expect(await sha256OfFile(markdownCss)).toBe(MARKDOWN_CSS_SHA256);
  });

  it("still resolves highlight.js' github theme unchanged", async () => {
    const { highlightCss } = bookPdfBaseStylesheetPaths();
    expect(highlightCss).toMatch(/highlight\.js[/\\]styles[/\\]github\.css$/);
    expect(await sha256OfFile(highlightCss)).toBe(HIGHLIGHT_CSS_SHA256);
  });
});

describe("buildBookPdfDocument", () => {
  const latin = scriptProfileForLanguage("en");

  it("carries both base stylesheets and ours, in cascade order", async () => {
    const html = await buildBookPdfDocument({
      markdown: "# The Book\n\nFirst page.",
      css: "/* book-stylesheet-marker */",
      profile: latin
    });

    // A marker from each sheet: md-to-pdf's own, highlight.js' theme, ours.
    const markdownCssAt = html.indexOf("body > :first-child");
    const highlightCssAt = html.indexOf(".hljs");
    const bookCssAt = html.indexOf("book-stylesheet-marker");

    expect(markdownCssAt).toBeGreaterThan(-1);
    expect(highlightCssAt).toBeGreaterThan(-1);
    expect(bookCssAt).toBeGreaterThan(-1);
    // Ours is last, so it wins — `RTL_OVERRIDES` in pdfCss.ts undoes rules
    // from the first sheet and only works from there.
    expect(markdownCssAt).toBeLessThan(highlightCssAt);
    expect(highlightCssAt).toBeLessThan(bookCssAt);
    expect(bookCssAt).toBeLessThan(html.indexOf("</head>"));
  });

  it("renders markdown through md-to-pdf's own marked, with the hljs class prefix", async () => {
    const html = await buildBookPdfDocument({
      markdown: "# The Book\n\n```js\nconst a = 1;\n```",
      css: "",
      profile: latin
    });

    // marked@4 heading ids and `langPrefix: 'hljs '` are what page breaks in
    // every existing book were laid out against.
    expect(html).toContain('<h1 id="the-book">The Book</h1>');
    expect(html).toContain('class="hljs js"');
  });

  it("leaves an English document's html tag bare, as md-to-pdf did", async () => {
    const html = await buildBookPdfDocument({ markdown: "Text.", css: "", profile: latin });

    expect(html).toContain("<html>");
    expect(html).not.toContain("lang=");
  });

  it("stamps lang and dir on a Persian document", async () => {
    const html = await buildBookPdfDocument({
      markdown: "متن.",
      css: "",
      profile: scriptProfileForLanguage("Farsi")
    });

    // Chrome copies `lang` into the PDF's own /Lang, which CSS cannot reach.
    expect(html).toContain('<html lang="fa" dir="rtl">');
  });

  it("does not expand $-sequences from the book's prose or its stylesheet", async () => {
    const html = await buildBookPdfDocument({
      markdown: "A line with $& and $` in it.",
      css: "/* $& $' */",
      profile: latin
    });

    expect(html).toContain("$&amp; and $` in it.");
    expect(html).toContain("/* $& $' */");
    expect(html).not.toContain("</head></head>");
  });

  it("drops elements that would put a foreign document on the page", async () => {
    const html = await buildBookPdfDocument({
      markdown: [
        "# The Book",
        "",
        '<iframe src="file:///etc/passwd"></iframe>',
        '<object data="file:///etc/passwd"></object>',
        '<embed src="file:///etc/hostname">',
        '<link rel="stylesheet" href="file:///etc/passwd">',
        '<base href="file:///etc/">',
        '<meta http-equiv="refresh" content="0;url=file:///etc/passwd">',
        "<script>fetch('http://example.com')</script>",
        "",
        "Real prose."
      ].join("\n"),
      css: "",
      profile: latin
    });

    expect(html).not.toMatch(/<(iframe|object|embed|link|base|script)\b/i);
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("/etc/passwd");
    expect(html).toContain("Real prose.");
    // md-to-pdf's own wrapper is untouched apart from that.
    expect(html).toContain('<meta charset="utf-8">');
  });

  it("strips executable attributes while preserving ordinary manuscript markup", async () => {
    const html = await buildBookPdfDocument({
      markdown: [
        "# The Book",
        "",
        '<img class="figure" src="proj/image.png" alt="A > B" onerror="window.open(\'http://127.0.0.1/probe\')">',
        '<a class="unsafe" href="java&#x73;cript:alert(1)" onclick="alert(2)">unsafe</a>',
        '<a class="safe" href="chapter.xhtml#part" title="Keep me">safe</a>',
        '<div onload=alert(3) srcdoc="<script>alert(4)</script>">text</div>',
        '<form action="data:text/html,<script>alert(5)</script>">form</form>',
        '<p style="color: red; expression(alert(6))">styled</p>'
      ].join("\n"),
      css: "",
      profile: latin
    });

    expect(html).not.toMatch(/\son[a-z]*\s*=/i);
    expect(html).not.toMatch(/\bsrcdoc\s*=/i);
    expect(html).not.toContain("java&#x73;cript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("expression(alert");
    expect(html).not.toContain("window.open");
    expect(html).toContain('class="figure" src="proj/image.png" alt="A > B"');
    expect(html).toContain('<a class="safe" href="chapter.xhtml#part" title="Keep me">safe</a>');
    expect(html).toContain("styled");
  });

  it("keeps HTML examples that a book is quoting rather than using", async () => {
    // marked has already escaped everything inside a fence by the time the
    // strip runs, which is why a book *about* HTML still prints its examples.
    const html = await buildBookPdfDocument({
      markdown: '# HTML\n\n```html\n<iframe src="page.html"></iframe>\n```\n\nInline `<script>` too.',
      css: "",
      profile: latin
    });

    expect(html).toContain("iframe");
    expect(html).toContain("&lt;");
    expect(html).not.toMatch(/<(iframe|script)\b/i);
  });

  it("keeps a front-matter-looking first line as body text", async () => {
    // md-to-pdf ran gray-matter over the content first. `compileBookMarkdown`
    // never emits leading `---`, so that parse was dropped — but a book whose
    // first line happens to look like front matter must still print it.
    const html = await buildBookPdfDocument({
      markdown: "---\ntitle: Not Front Matter\n---\n\nBody text.",
      css: "",
      profile: latin
    });

    expect(html).toContain("Not Front Matter");
    expect(html).toContain("Body text.");
  });

  it("carries every chapter anchor onto the heading it names", async () => {
    // The anchor `compileBookMarkdown` writes on its own line before a `## `
    // heading is glued by marked to the end of whatever block came *before* it,
    // so Chrome's named destination lands at the foot of the previous page
    // whenever `page-break-after: avoid` pushes the heading onto the next one.
    // This is the only automated thing that would catch a marked bump changing
    // the shapes below — each one was measured coming out of md-to-pdf's marked.
    const html = await buildBookPdfDocument({
      markdown: [
        "# Book",
        "",
        '<section class="book-contents"><a class="book-contents__link" href="#chapter-1">One</a></section>',
        '<a id="chapter-1"></a>',
        "",
        "## Chapter 1: Opening",
        "",
        "Prose ending a paragraph.",
        '<a id="chapter-2"></a>',
        "",
        "## Chapter 2: Second",
        "",
        "- one",
        "- two",
        '<a id="chapter-3"></a>',
        "",
        "## Chapter 3: Third",
        "",
        "```js",
        "const answer = 42;",
        "```",
        "",
        '<a id="chapter-4"></a>',
        "",
        "## Chapter 4: Fourth"
      ].join("\n"),
      css: "",
      profile: latin
    });

    for (const index of [1, 2, 3, 4]) {
      expect(html).toContain(`<h2 id="chapter-${index}">Chapter ${index}:`);
    }
    // No anchor left behind to take the destination with it, and the Contents
    // link still points at the id that now sits on the heading.
    expect(html).not.toMatch(/<a\b[^>]*\sid="chapter-\d+"/);
    expect(html).toContain('href="#chapter-1"');
  });
});

describe("BOOK_PDF_OPTIONS", () => {
  it("pins the margins md-to-pdf used to supply", () => {
    // Asserted directly because no rendered output can: `bookPdfCss` sets
    // `@page { margin }`, which Chrome honours over these, so the value is
    // inert until that rule is removed. It is pinned for that day, and so the
    // configuration inherited from md-to-pdf stays auditable.
    expect(BOOK_PDF_OPTIONS.margin).toEqual({
      top: "30mm",
      right: "40mm",
      bottom: "30mm",
      left: "20mm"
    });
    expect(BOOK_PDF_OPTIONS.format).toBe("a4");
    expect(BOOK_PDF_OPTIONS.printBackground).toBe(true);
    expect(BOOK_PDF_OPTIONS.outline).toBe(true);
  });
});
