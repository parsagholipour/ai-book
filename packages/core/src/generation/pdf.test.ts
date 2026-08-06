import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it, afterEach } from "vitest";
import {
  generateBookPdf,
  insertCoverPageBreak,
  localizeImagesInMarkdown,
  prepareMarkdownForPdfDocument
} from "./pdf.js";

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

    expect(result.markdown).toMatch(/^<div class="pdf-cover-page"/);
    expect(result.markdown).toContain('<img src="proj-cover-break/cover.png"');
    expect(result.markdown).toContain('alt="Book cover"');
    expect(result.markdown).not.toContain("![Book cover]");
    expect(result.markdown).not.toContain("data:image");
    expect(result.markdown.indexOf("pdf-cover-page")).toBeLessThan(result.markdown.indexOf("# The Book"));
    expect(result.imageDataUrls.get("proj-cover-break/cover.png")).toMatch(/^data:image\/png;base64,/);
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
