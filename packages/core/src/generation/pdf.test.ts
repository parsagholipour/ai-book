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
  insertCoverPageBreak,
  localizeImagesInMarkdown,
  prepareMarkdownForPdfDocument
} from "./pdf.js";

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
    const imageStorageDir = join(tmpdir(), `book-pdf-pagination-test-${randomUUID()}`);
    tempDirs.push(imageStorageDir);
    await mkdir(imageStorageDir, { recursive: true });
    const outputPath = join(imageStorageDir, "book.pdf");

    const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
      18
    );
    const markdown = `# The Quiet Engine\n\nAn opening note.\n\n${Array.from(
      { length: 12 },
      (_, index) => `## Chapter ${index + 1}\n\nThis is the body of chapter ${index + 1}. ${body}`
    ).join("\n\n")}`;

    await generateBookPdf(markdown, {
      imageStorageDir,
      publicApiUrl: "http://localhost:4001",
      outputPath,
      language: "en"
    });

    const info = execFileSync("pdfinfo", [outputPath], { encoding: "utf8" });
    expect(/^Pages:\s+(\d+)$/m.exec(info)?.[1]).toBe("9");
  }, 30_000);

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
