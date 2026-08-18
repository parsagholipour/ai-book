import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it, afterAll, afterEach } from "vitest";
import { closeSharedBrowser, withRenderPage } from "./browserPool.js";
import {
  generateBookPdf,
  generateBookPdfWithPageMap,
  insertCoverPageBreak,
  localizeImagesInMarkdown,
  markdownOpensOnCoverSheet,
  prepareMarkdownForPdfDocument,
  type BookPageMapPlan
} from "./pdf.js";
import { compileBookMarkdown, compileBookMarkdownWithPageAnchors } from "./markdown.js";
import { extractPdfNamedDestinations } from "./pdfNamedDestinations.js";
import { printedPageForPdfPage } from "./pdfPageMap.js";

afterAll(async () => {
  // Renders share one long-lived Chromium, and a live browser holds the event
  // loop open — without this vitest never exits.
  await closeSharedBrowser();
});

describe("localizeImagesInMarkdown", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("rewrites a local project image to a renderer-served asset path", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const projectId = "proj-1";
    const imageDir = join(imageStorageDir, projectId);
    await mkdir(imageDir, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    await writeFile(join(imageDir, "page-1.png"), png);

    const markdown = "![Page 1](http://localhost:4001/assets/images/proj-1/page-1.png)";
    const result = await localizeImagesInMarkdown(markdown, {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001"
    });

    expect(result).toBe("![Page 1](proj-1/page-1.png)");
    expect(result).not.toContain("localhost:4001");
    expect(result).not.toContain("data:image");
  });

  it("rewrites a local cover image to a renderer-served asset path", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-cover-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const projectId = "proj-cover";
    const imageDir = join(imageStorageDir, projectId);
    await mkdir(imageDir, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    await writeFile(join(imageDir, "cover.png"), png);

    const markdown = "![Book cover](http://localhost:4001/assets/images/proj-cover/cover.png)";
    const result = await localizeImagesInMarkdown(markdown, {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001"
    });

    expect(result).toBe("![Book cover](proj-cover/cover.png)");
    expect(result).not.toContain("localhost:4001");
    expect(result).not.toContain("data:image");
    expect(result).not.toContain("page-break");
  });

  it("wraps a leading cover image and keeps its embedded bytes for PDF rendering", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-cover-break-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const projectId = "proj-cover-break";
    const imageDir = join(imageStorageDir, projectId);
    await mkdir(imageDir, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    await writeFile(join(imageDir, "cover.png"), png);

    const markdown = "![Book cover](http://localhost:4001/assets/images/proj-cover-break/cover.png)\n# The Book\n\nFirst page.";
    const result = await prepareMarkdownForPdfDocument(markdown, {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001"
    });

    expect(result).toMatch(/^<div class="pdf-cover-page"/);
    expect(result).toContain('<img src="proj-cover-break/cover.png"');
    expect(result).toContain('alt="Book cover"');
    expect(result).not.toContain("![Book cover]");
    // The renderer opens the file off disk now; nothing is inlined into the
    // document, which is what used to make a legacy illustrated book a ~27 MB
    // CDP payload.
    expect(result).not.toContain("data:image");
    expect(result.indexOf("pdf-cover-page")).toBeLessThan(result.indexOf("# The Book"));
  });

  it("does not let $-sequences in alt text rewrite the document", async () => {
    // The rewrite used to substitute through `String.replace`'s pattern
    // syntax, where `$&` in the replacement expands to the whole match.
    const imageStorageDir = join(tmpdir(), `book-pdf-dollar-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const imageDir = join(imageStorageDir, "proj-dollar");
    await mkdir(imageDir, { recursive: true });
    await writeFile(
      join(imageDir, "page-1.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      )
    );

    const result = await localizeImagesInMarkdown(
      "![see $& and $' here](http://localhost:4001/assets/images/proj-dollar/page-1.png)",
      { imageStorageDir, publicApiUrl: "http://localhost:4001" }
    );

    expect(result).toBe("![see $& and $' here](proj-dollar/page-1.png)");
  });

  it("does not localize another project's illustration", async () => {
    // The render's own allowlist would abort the load, but the document should
    // never have named it: the same scoping refuses it here, which is the only
    // thing standing between a manuscript and another reader's artwork in the
    // EPUB, where nothing renders.
    const imageStorageDir = join(tmpdir(), `book-pdf-scope-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(join(imageStorageDir, "proj-other"), { recursive: true });
    await writeFile(
      join(imageStorageDir, "proj-other", "private.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      )
    );

    const markdown = "![Theirs](http://localhost:4001/assets/images/proj-other/private.png)";

    expect(
      await localizeImagesInMarkdown(markdown, {
        imageStorageDir,
        publicApiUrl: "http://localhost:4001",
        projectId: "proj-mine"
      })
    ).toBe(markdown);
    // …and the same compile with no project named still resolves it, which is
    // what the fixture renderer relies on.
    expect(await localizeImagesInMarkdown(markdown, { imageStorageDir, publicApiUrl: "http://localhost:4001" })).toBe(
      "![Theirs](proj-other/private.png)"
    );
  });

  it("keeps the original URL when the local file is missing", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-missing-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });

    const markdown = "![Gone](http://localhost:4001/assets/images/proj-missing/page-1.png)";

    expect(await localizeImagesInMarkdown(markdown, { imageStorageDir, publicApiUrl: "http://localhost:4001" })).toBe(
      markdown
    );
  });

  it("does not add a page break when Markdown starts with a title", () => {
    const markdown = "# The Book\n\n![Illustration](/assets/images/proj-1/page-1.png)";

    expect(insertCoverPageBreak(markdown)).toBe(markdown);
  });

  it("detects manuscripts whose first sheet is unnumbered", () => {
    expect(markdownOpensOnCoverSheet("![Cover](/assets/images/p/cover.jpg)\n\n# The Book\n")).toBe(true);
    expect(markdownOpensOnCoverSheet('<div class="pdf-cover-page"><img src="cover.jpg" /></div>\n\n# The Book\n')).toBe(
      true
    );
    expect(markdownOpensOnCoverSheet('<section class="book-title-page">\n  <h1>The Book</h1>\n</section>\n')).toBe(true);
    expect(markdownOpensOnCoverSheet("# The Book\n\n![Illustration](/assets/images/p/page-1.png)\n")).toBe(false);
  });

  it("agrees with the cover break it predicts when the manuscript opens on whitespace", () => {
    // The flag and the break used to carry a regex each, and only the flag's
    // trimmed: a manuscript opening with a blank line — or a `book.md` read
    // back with a BOM, which `trimStart` also removes — was reported as opening
    // on an unnumbered cover sheet that the render never built, so every
    // printed page number the chat and the Contents speak came out one ahead of
    // the footer.
    for (const lead of ["", "\n\n", "  \n", "\uFEFF"]) {
      const withCover = `${lead}![Cover](/assets/images/p/cover.jpg)\n\n# The Book\n`;
      expect(markdownOpensOnCoverSheet(withCover)).toBe(true);
      expect(insertCoverPageBreak(withCover)).toMatch(/^<div class="pdf-cover-page"/);
      expect(insertCoverPageBreak(withCover)).toContain("# The Book");

      const withoutCover = `${lead}# The Book\n\n![Illustration](/assets/images/p/page-1.png)\n`;
      expect(markdownOpensOnCoverSheet(withoutCover)).toBe(false);
      expect(insertCoverPageBreak(withoutCover)).toBe(withoutCover);
    }
  });

  const itIfPdfTextAvailable = hasCommand("pdftotext") ? it : it.skip;

  itIfPdfTextAvailable("adds a Page X footer to generated PDFs", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-page-number-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    await generateBookPdf("# The Book\n\nFirst page.\n\nSecond paragraph.", {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      outputPath
    });

    const text = execFileSync("pdftotext", [outputPath, "-"], { encoding: "utf8" });
    expect(text).toMatch(/\bPage\s+1\b/);
  }, 30_000);

  itIfPdfTextAvailable("numbers the sheet after the cover as Page 1", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-cover-number-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const projectId = "proj-cover-number";
    const imageDir = join(imageStorageDir, projectId);
    await mkdir(imageDir, { recursive: true });
    await writeFile(
      join(imageDir, "cover.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="2400"><rect width="1800" height="2400" fill="red"/></svg>'
    );
    const outputPath = join(imageStorageDir, "book.pdf");

    await generateBookPdf(
      "![Book cover](http://localhost:4001/assets/images/proj-cover-number/cover.svg)\n# The Book\n\nFirst page of the story.",
      {
        imageStorageDir,
        publicApiUrl: "http://localhost:4001",
        outputPath
      }
    );

    const cover = execFileSync("pdftotext", ["-f", "1", "-l", "1", outputPath, "-"], { encoding: "utf8" });
    const afterCover = execFileSync("pdftotext", ["-f", "2", "-l", "2", outputPath, "-"], { encoding: "utf8" });
    expect(cover).not.toMatch(/\bPage\s+\d+\b/);
    expect(afterCover).toMatch(/\bPage\s+1\b/);
    expect(afterCover).not.toMatch(/\bPage\s+2\b/);
  }, 30_000);

  itIfPdfTextAvailable("numbers the sheet after the title page as Page 1", async () => {
    // Coverless books with an author get a title page instead of a cover, and
    // `@page pdf-title` carries the same counter-reset. A CSS-string assertion
    // cannot see whether Chrome honours it; the cover render above cannot
    // either, because that book never names `pdf-title`.
    const imageStorageDir = join(tmpdir(), `book-pdf-title-number-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    const markdown = compileBookMarkdown({
      plan: {
        title: "The Clockmaker",
        premise: "p",
        audience: "a",
        chapters: [{ index: 1, title: "Beginnings", summary: "s", targetPages: 1 }],
        characters: [],
        questions: []
      } as never,
      pages: [{ index: 1, title: "Opening", markdown: "First page of the story." }],
      authorName: "Ada Lovelace"
    });
    expect(markdown).toContain("book-title-page");
    expect(markdown).not.toContain("pdf-cover-page");

    await generateBookPdf(markdown, {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      outputPath
    });

    const titlePage = execFileSync("pdftotext", ["-f", "1", "-l", "1", outputPath, "-"], { encoding: "utf8" });
    const afterTitle = execFileSync("pdftotext", ["-f", "2", "-l", "2", outputPath, "-"], { encoding: "utf8" });
    expect(titlePage).toContain("The Clockmaker");
    expect(titlePage).not.toMatch(/\bPage\s+\d+\b/);
    expect(afterTitle).toContain("First page of the story.");
    expect(afterTitle).toMatch(/\bPage\s+1\b/);
    expect(afterTitle).not.toMatch(/\bPage\s+2\b/);
  }, 30_000);

  itIfPdfTextAvailable("keeps an overlong title page to one unnumbered sheet", async () => {
    // `@page pdf-title` resets the page counter on every sheet it names, so a
    // title page that fragmented would leave two unnumbered sheets and print
    // page 1 on the third — while `printedPageOffset` counts exactly one.
    // Nothing caps a title's length, so the stylesheet caps its height.
    const imageStorageDir = join(tmpdir(), `book-pdf-long-title-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    const markdown = compileBookMarkdown({
      plan: {
        title: Array.from({ length: 60 }, (_, index) => `Interminable Title Clause ${index + 1}`).join(", "),
        premise: "p",
        audience: "a",
        chapters: [{ index: 1, title: "Beginnings", summary: "s", targetPages: 1 }],
        characters: [],
        questions: []
      } as never,
      pages: [{ index: 1, title: "Opening", markdown: "First page of the story." }],
      authorName: "Ada Lovelace"
    });
    expect(markdown).toContain("book-title-page");

    await generateBookPdf(markdown, {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      outputPath
    });

    const titlePage = execFileSync("pdftotext", ["-f", "1", "-l", "1", outputPath, "-"], { encoding: "utf8" });
    const afterTitle = execFileSync("pdftotext", ["-f", "2", "-l", "2", outputPath, "-"], { encoding: "utf8" });
    expect(titlePage).not.toMatch(/\bPage\s+\d+\b/);
    expect(afterTitle).toContain("First page of the story.");
    expect(afterTitle).toMatch(/\bPage\s+1\b/);
    // And it clips from the *tail*. The cap arrived as `justify-content: center`
    // plus `overflow: hidden`, which overflows a flex column at both ends: this
    // sheet printed its first visible line as "Interminable Title Clause 10" and
    // the opening nine clauses were nowhere in the PDF. A title page that keeps
    // the numbering by losing the book's name is not a title page.
    // Whitespace is normalised because a 34pt title wraps every three words.
    expect(titlePage.replace(/\s+/g, " ")).toContain("Interminable Title Clause 1,");
  }, 30_000);

  it("builds a document outline from the chapter headings", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-outline-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    await generateBookPdf(
      "# The Book\n\nIntro.\n\n## Chapter 1 — Beginnings\n\nText.\n\n## Chapter 2 — Endings\n\nMore text.",
      {
        imageStorageDir,
        publicApiUrl: "http://localhost:4001",
        outputPath
      }
    );

    // The mobile reader's table of contents navigates by PDF bookmarks, so the
    // catalog has to carry an outline tree with an entry per heading.
    const pdf = (await readFile(outputPath)).toString("latin1");
    expect(pdf).toContain("/Outlines");
    expect((pdf.match(/\/Title/g) ?? []).length).toBeGreaterThan(1);
  }, 30_000);

  const itIfPdfInfoAvailable = hasCommand("pdfinfo") ? it : it.skip;

  itIfPdfInfoAvailable("lays a known manuscript out over a recorded number of pages", async () => {
    // Page count is the cheapest signal that the typography this book is set in
    // drifted — `bookPdfCss`, md-to-pdf's `markdown.css`, or the marked output
    // those are applied to. `pdfDocument.ts` now pins all three by hand instead
    // of inheriting them, and if this number moves, every book ever compiled
    // re-paginates.
    //
    // The prose runs continuously on purpose. An earlier version of this
    // fixture ended each chapter with `<div class="page-break"></div>`, which
    // pinned the count to the chapter count and made it blind: it returned 12
    // whatever the stylesheet said. As written, a 5% change in body size, a
    // wider `@page` margin or a taller line-height all move it.
    //
    // What it cannot see is `BOOK_PDF_OPTIONS.margin`, and nothing can: that
    // option is inert while `bookPdfCss` sets `@page { margin }`, which Chrome
    // honours instead. `pdfDocument.test.ts` asserts that value directly.
    //
    // Measuring must not move that count either. The HTML `normalized()` tests
    // in `pdfPageAnchors.test.ts` only approximate layout neutrality — they
    // strip markers and compare boxes, which cannot see Chrome fragment a
    // glued span or a `display:none` nav. The same manuscript rendered with
    // and without a `pageMapPlan` is the lock that can. Contents reprint is
    // the other measuring pass; that lives on the compiled fixture below,
    // because a Contents section here would force a page break and blind the
    // typography pin the way the old per-chapter breaks did.
    const imageStorageDir = join(tmpdir(), `book-pdf-pagination-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });

    const { markdown, pageMapPlan } = paginationManuscript();
    const withoutPlanPath = join(imageStorageDir, "without-plan.pdf");
    const withPlanPath = join(imageStorageDir, "with-plan.pdf");
    const pdfOptions = {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      language: "en"
    };

    await generateBookPdf(markdown, { ...pdfOptions, outputPath: withoutPlanPath });
    const measured = await generateBookPdfWithPageMap(markdown, {
      ...pdfOptions,
      outputPath: withPlanPath,
      pageMapPlan
    });

    const withoutPlanPages = pdfPageCount(withoutPlanPath);
    expect(withoutPlanPages).toBe("9");
    expect(pdfPageCount(withPlanPath)).toBe(withoutPlanPages);
    expect(measured.pageMap?.pages).toHaveLength(pageMapPlan.pageAnchors.length);
  }, 90_000);

  const itIfPdfFontsAndTextAvailable = hasCommand("pdffonts") && hasCommand("pdftotext") ? it : it.skip;

  itIfPdfFontsAndTextAvailable("embeds an Arabic-script face for a Persian book", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-persian-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    await generateBookPdf("# \u06a9\u062a\u0627\u0628 \u0645\u0627\u0647\n\n\u0627\u06cc\u0646 \u06cc\u06a9 \u0622\u0632\u0645\u0627\u06cc\u0634 \u0627\u0633\u062a.\n", {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      outputPath,
      language: "Farsi"
    });

    // The footer counts in Persian digits and drops the English word, so page
    // one reads "۱" — and nothing English is left at the foot of the page.
    const footer = execFileSync("pdftotext", [outputPath, "-"], { encoding: "utf8" });
    expect(footer).toContain("۱");
    expect(footer).not.toMatch(/\bPage\b/);

    expect(execFileSync("pdffonts", [outputPath], { encoding: "utf8" })).toMatch(/Vazirmatn/i);
    // The assertion that actually proves the reported bug is gone: extraction
    // only succeeds when the glyphs carry a real ToUnicode map, so a tofu
    // render would come back empty even though pdffonts still named a font.
    expect(execFileSync("pdftotext", [outputPath, "-"], { encoding: "utf8" })).toContain("\u06a9\u062a\u0627\u0628");
  }, 60_000);

  itIfPdfFontsAndTextAvailable("still typesets an English book in Source Serif", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-latin-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    await generateBookPdf("# The Book\n\nFirst page.\n", {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      outputPath,
      language: "en"
    });

    expect(execFileSync("pdffonts", [outputPath], { encoding: "utf8" })).toMatch(/SourceSerif/i);
    expect(execFileSync("pdftotext", [outputPath, "-"], { encoding: "utf8" })).toContain("The Book");
  }, 60_000);

  const itIfPdfRasterAvailable = hasCommand("pdftoppm") ? it : it.skip;

  itIfPdfRasterAvailable("renders a leading cover to the first page edge", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-cover-edge-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const projectId = "proj-cover-edge";
    const imageDir = join(imageStorageDir, projectId);
    await mkdir(imageDir, { recursive: true });
    await writeFile(
      join(imageDir, "cover.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="2400"><rect width="1800" height="2400" fill="red"/></svg>'
    );
    const outputPath = join(imageStorageDir, "book.pdf");
    const ppmPrefix = join(imageStorageDir, "cover-page");
    const ppmPath = `${ppmPrefix}.ppm`;

    await generateBookPdf(
      "![Book cover](http://localhost:4001/assets/images/proj-cover-edge/cover.svg)\n# The Book\n\nFirst page.",
      {
        imageStorageDir,
        publicApiUrl: "http://localhost:4001",
        outputPath
      }
    );

    execFileSync("pdftoppm", ["-r", "20", "-f", "1", "-singlefile", outputPath, ppmPrefix]);
    const page = await readPpm(ppmPath);
    expect(readRgb(page, 0, 0)).toEqual([255, 0, 0]);
    expect(readRgb(page, 5, 5)).toEqual([255, 0, 0]);
  }, 30_000);

  const itIfPdfTextAndRasterAvailable = hasCommand("pdftotext") && hasCommand("pdftoppm") ? it : it.skip;

  itIfPdfTextAndRasterAvailable("prints the book's own illustrations and no other file on the server", async () => {
    // The reported disclosure, end to end. Printing from `file://` is what made
    // the export fast, and it handed the manuscript the renderer's file access:
    // markdown passes raw HTML through, and a manuscript is user text (imports,
    // exact-replacement edits), so an `<iframe src="file:///etc/passwd">` in
    // chapter one printed the server's password file into the book. The
    // HTTP-origin renderer this replaced refused `file://` for free.
    //
    // Rendered with the cover in place so the same run also proves the policy
    // did not simply block everything: a book whose illustrations stopped
    // loading would pass a leak assertion on its own.
    const imageStorageDir = join(tmpdir(), `book-pdf-file-access-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const projectId = "proj-file-access";
    await mkdir(join(imageStorageDir, projectId), { recursive: true });
    await mkdir(join(imageStorageDir, "proj-other"), { recursive: true });
    await writeFile(
      join(imageStorageDir, projectId, "cover.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="2400"><rect width="1800" height="2400" fill="red"/></svg>'
    );
    const secretPath = join(imageStorageDir, "secret.txt");
    await writeFile(secretPath, "SUPER-SECRET-MARKER\n");
    const otherProjectSecret = join(imageStorageDir, "proj-other", "notes.txt");
    await writeFile(otherProjectSecret, "OTHER-PROJECT-MARKER\n");
    const outputPath = join(imageStorageDir, "book.pdf");
    const ppmPrefix = join(imageStorageDir, "cover-page");

    await generateBookPdf(
      [
        `![Book cover](http://localhost:4001/assets/images/${projectId}/cover.svg)`,
        "# The Book",
        "",
        "Innocent prose.",
        "",
        `<iframe src="file://${secretPath}" width="600" height="300"></iframe>`,
        `<iframe src="file://${otherProjectSecret}" width="600" height="300"></iframe>`,
        '<object data="file:///etc/passwd" type="text/plain" width="600" height="400"></object>',
        '<embed src="file:///etc/hostname" width="600" height="200">',
        '<div style="background-image:url(file:///etc/hosts)">x</div>',
        "<script>document.title = 'ran';</script>"
      ].join("\n"),
      { imageStorageDir, publicApiUrl: "http://localhost:4001", outputPath, projectId }
    );

    const text = execFileSync("pdftotext", [outputPath, "-"], { encoding: "utf8" });
    expect(text).toContain("Innocent prose.");
    expect(text).not.toContain("SUPER-SECRET-MARKER");
    expect(text).not.toContain("OTHER-PROJECT-MARKER");
    expect(text).not.toContain("root:x:0:0");

    // The cover still fills page one, so nothing above came at the cost of the
    // book's own illustrations.
    execFileSync("pdftoppm", ["-r", "20", "-f", "1", "-singlefile", outputPath, ppmPrefix]);
    expect(readRgb(await readPpm(`${ppmPrefix}.ppm`), 5, 5)).toEqual([255, 0, 0]);
  }, 60_000);

  it("does not execute manuscript attributes or leave auxiliary pages behind", async () => {
    // Request interception is per page. Before executable attributes were
    // removed and JavaScript was disabled, a missing image's `onerror` could
    // open a new page whose first navigation was already on the wire before the
    // pool learned that target existed — a real SSRF, not merely a leaked tab.
    const imageStorageDir = join(tmpdir(), `book-pdf-popup-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    const projectId = "proj-popup";
    await mkdir(join(imageStorageDir, projectId), { recursive: true });

    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("probe");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Probe server did not expose a TCP port.");
    }

    try {
      // Asked through a render of its own, so it is the pool's own browser being
      // counted rather than one this test launched.
      const pagesInPool = () => withRenderPage(async (page) => (await page.browser().pages()).length);
      const before = await pagesInPool();

      await generateBookPdf(
        [
          "# The Book",
          "",
          "Innocent prose.",
          "",
          `<img src="${projectId}/missing.png" onerror="window.open('http://127.0.0.1:${address.port}/probe','_blank')">`
        ].join("\n"),
        { imageStorageDir, publicApiUrl: "http://localhost:4001", projectId }
      );

      // Give an accidentally opened navigation time to reach the local server;
      // the vulnerable implementation made two requests before PDF generation
      // returned, so this is deliberately generous.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(requests).toBe(0);
      expect(await pagesInPool()).toBe(before);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 60_000);

  const itIfPdfFontsAvailable = hasCommand("pdffonts") ? it : it.skip;

  itIfPdfFontsAvailable("embeds Source Serif 4 for manuscript typography", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-font-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    await generateBookPdf("# The Book\n\n_First line._\n\nSecond paragraph.", {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      outputPath
    });

    const fonts = execFileSync("pdffonts", [outputPath], { encoding: "utf8" });
    expect(fonts).toMatch(/SourceSerif/i);
  }, 30_000);
});

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pdfPageCount(path: string): string | undefined {
  const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
  return /^Pages:\s+(\d+)$/m.exec(info)?.[1];
}

/** Continuous twelve-chapter prose plus a plan that marks each chapter heading. */
function paginationManuscript(): { markdown: string; pageMapPlan: BookPageMapPlan } {
  const body =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
      18
    );
  const markdown = `# The Quiet Engine\n\nAn opening note.\n\n${Array.from(
    { length: 12 },
    (_, index) => `## Chapter ${index + 1}\n\nThis is the body of chapter ${index + 1}. ${body}`
  ).join("\n\n")}`;

  const pageAnchors: BookPageMapPlan["pageAnchors"] = [];
  let searchFrom = 0;
  for (let index = 1; index <= 12; index += 1) {
    const needle = `## Chapter ${index}\n`;
    const markdownOffset = markdown.indexOf(needle, searchFrom);
    if (markdownOffset < 0) {
      throw new Error(`Pagination fixture missing ${needle.trim()}`);
    }
    pageAnchors.push({ pageIndex: index, destName: `bp-${index}`, markdownOffset });
    searchFrom = markdownOffset + needle.length;
  }

  return { markdown, pageMapPlan: { pageAnchors, hasCoverPage: false, hasContents: false } };
}

async function readPpm(path: string): Promise<{ width: number; height: number; pixels: Buffer }> {
  const bytes = await readFile(path);
  let offset = 0;
  const tokens: string[] = [];

  while (tokens.length < 4) {
    while (/\s/.test(String.fromCharCode(bytes[offset] ?? 0))) {
      offset += 1;
    }
    if (bytes[offset] === 35) {
      while (offset < bytes.length && bytes[offset] !== 10) {
        offset += 1;
      }
      continue;
    }
    const start = offset;
    while (offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset] ?? 0))) {
      offset += 1;
    }
    tokens.push(bytes.subarray(start, offset).toString("ascii"));
  }

  while (/\s/.test(String.fromCharCode(bytes[offset] ?? 0))) {
    offset += 1;
  }
  if (tokens[0] !== "P6" || tokens[3] !== "255") {
    throw new Error(`Unsupported PPM header: ${tokens.join(" ")}`);
  }

  return {
    width: Number(tokens[1]),
    height: Number(tokens[2]),
    pixels: bytes.subarray(offset)
  };
}

function readRgb(page: { width: number; height: number; pixels: Buffer }, x: number, y: number): [number, number, number] {
  if (x < 0 || x >= page.width || y < 0 || y >= page.height) {
    throw new Error(`Pixel is outside the page: ${x}, ${y}`);
  }
  const offset = (y * page.width + x) * 3;
  return [page.pixels[offset] ?? 0, page.pixels[offset + 1] ?? 0, page.pixels[offset + 2] ?? 0];
}

describe("generateBookPdfWithPageMap", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  const itIfPdfText = hasCommand("pdftotext") ? it : it.skip;

  itIfPdfText("measures where every model page landed and reprints the Contents in printed pages", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-map-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    const prose = (index: number) =>
      `OpeningToken${index} starts this page. ` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
        14
      );
    const compiled = compileBookMarkdownWithPageAnchors({
      plan: {
        title: "The Measured Book",
        premise: "p",
        audience: "a",
        chapters: [
          { index: 1, title: "Beginnings", summary: "s", targetPages: 4 },
          { index: 2, title: "Endings", summary: "s", targetPages: 4 }
        ],
        characters: [],
        questions: []
      } as never,
      pages: Array.from({ length: 8 }, (_, i) => ({
        index: i + 1,
        title: `Page ${i + 1}`,
        markdown: prose(i + 1)
      })),
      readerChapters: [
        { index: 1, title: "Beginnings", summary: "s", startPageIndex: 1, endPageIndex: 4 },
        { index: 2, title: "Endings", summary: "s", startPageIndex: 5, endPageIndex: 8 }
      ]
    });
    expect(compiled.hasContents).toBe(true);

    const pdfOptions = {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      language: "en"
    };
    // Same manuscript, no plan: markers and the Contents reprint must not
    // add a page. HTML `normalized()` cannot see either pass.
    const unmarked = await generateBookPdfWithPageMap(compiled.markdown, pdfOptions);
    const result = await generateBookPdfWithPageMap(compiled.markdown, {
      ...pdfOptions,
      outputPath,
      pageMapPlan: compiled
    });

    expect(extractPdfNamedDestinations(result.pdf)?.pageCount).toBe(
      extractPdfNamedDestinations(unmarked.pdf)?.pageCount
    );

    const map = result.pageMap;
    expect(map).toBeDefined();
    if (!map) {
      return;
    }
    expect(map.pages).toHaveLength(8);
    for (let i = 1; i < map.pages.length; i += 1) {
      expect(map.pages[i]!.startPdfPage).toBeGreaterThanOrEqual(map.pages[i - 1]!.startPdfPage);
    }
    expect(map.contentsStartPdfPage).toBeDefined();
    expect(map.totalPdfPages).toBeGreaterThanOrEqual(map.pages[7]!.endPdfPage);

    // Every measured start really holds that page's opening words.
    for (const page of [map.pages[0]!, map.pages[3]!, map.pages[7]!]) {
      const text = execFileSync(
        "pdftotext",
        ["-f", String(page.startPdfPage), "-l", String(page.startPdfPage), outputPath, "-"],
        { encoding: "utf8" }
      );
      expect(text).toContain(`OpeningToken${page.index}`);
    }

    // The Contents rows print the numbers the footer counts — printed pages,
    // which skip the cover when there is one — rather than model page indexes.
    // Chapter 2 opens at model page 5, which cannot be its printed page: the
    // front matter alone displaces it.
    const chapterTwoPrinted = printedPageForPdfPage(map, map.pages[4]!.startPdfPage);
    expect(chapterTwoPrinted).toBeDefined();
    expect(chapterTwoPrinted).not.toBe(5);
    const contentsText = execFileSync(
      "pdftotext",
      ["-f", String(map.contentsStartPdfPage), "-l", String(map.contentsStartPdfPage), outputPath, "-"],
      { encoding: "utf8" }
    );
    expect(contentsText).toContain("Endings");
    expect(contentsText).toContain(String(chapterTwoPrinted));
    expect(contentsText).not.toMatch(/\b5\b/);
  }, 120_000);

  it("returns no map — and a whole book — when no plan is given", async () => {
    const imageStorageDir = join(tmpdir(), `book-pdf-no-plan-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });

    const result = await generateBookPdfWithPageMap("# A Book\n\nSome prose.", {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001"
    });
    expect(result.pageMap).toBeUndefined();
    expect(result.pdf.length).toBeGreaterThan(1000);
  }, 30_000);
});
