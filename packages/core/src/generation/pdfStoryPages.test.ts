import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { closeSharedBrowser } from "./browserPool.js";
import { compileBookMarkdownWithPageAnchors } from "./markdown.js";
import { generateBookPdfWithPageMap } from "./pdf.js";
import { extractPdfNamedDestinations } from "./pdfNamedDestinations.js";

afterAll(closeSharedBrowser);

function wordBounds(path: string, page: number, word: string): { x: number; y: number; height: number } {
  const xml = execFileSync("pdftotext", ["-f", String(page), "-l", String(page), "-bbox", path, "-"], { encoding: "utf8" });
  const match = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)<\/word>/g)]
    .find((entry) => entry[5] === word);
  expect(match, `Printed word ${word} on sheet ${page}`).toBeDefined();
  return { x: Number(match![1]), y: Number(match![2]), height: Number(match![4]) - Number(match![2]) };
}

it("gives text-only story sheets readable type and measure, with fifteen chapters on one Contents sheet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-text-story-"));
  try {
    const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle restore the lantern path.", category: "KIDS", targetPages: 30 });
    const pages = Array.from({ length: 30 }, (_, position) => ({ index: position + 1, title: `Scene ${position + 1}`,
      markdown: `OpeningScene${position + 1}Token. Rabbit stopped beside the lantern. ` +
        "Turtle checked the path before they moved the light. The neighbors waited by the trees with their picnic baskets. " +
        `Rabbit asked where to put the lantern and listened to Turtle. EndingScene${position + 1}Token.` }));
    const compiled = compileBookMarkdownWithPageAnchors({ plan: makeFallbackPlan(input), category: input.category,
      storyPageLayout: "separate", pages, authorName: "Story Author",
      readerChapters: Array.from({ length: 15 }, (_, i) => ({ index: i + 1, title: `Lantern station ${i + 1}`,
        summary: "The next scene.", startPageIndex: i * 2 + 1, endPageIndex: i * 2 + 2 })) });
    const outputPath = join(directory, "book.pdf");
    const result = await generateBookPdfWithPageMap(compiled.markdown, {
      imageStorageDir: directory, publicApiUrl: "http://localhost:4001", pageMapPlan: compiled, outputPath, targetPageCount: 30
    });
    expect(result.pageMap?.totalPdfPages).toBe(32);
    expect(result.pagination).toBeUndefined();
    expect(result.pageMap?.pages).toEqual(pages.map((page) => ({ index: page.index, startPdfPage: page.index + 2, endPdfPage: page.index + 2 })));
    const contents = execFileSync("pdftotext", ["-f", "2", "-l", "2", "-layout", outputPath, "-"], { encoding: "utf8" });
    const measured = extractPdfNamedDestinations(result.pdf)!;
    for (let chapter = 1; chapter <= 15; chapter += 1) {
      const printedPage = measured.destinations.get(`chapter-${chapter}`)!.pdfPage - 1;
      expect(contents).toMatch(new RegExp(`CHAPTER ${chapter}\\s+Lantern station ${chapter}\\s+${printedPage}\\b`));
    }
    for (const page of pages) {
      const text = execFileSync("pdftotext", ["-f", String(page.index + 2), "-l", String(page.index + 2), outputPath, "-"], { encoding: "utf8" });
      expect(text.match(/OpeningScene\d+Token/g)).toEqual([`OpeningScene${page.index}Token`]);
      expect(text.match(/EndingScene\d+Token/g)).toEqual([`EndingScene${page.index}Token`]);
      expect(text).toContain(`Page ${page.index + 1}`);
      const bounds = wordBounds(outputPath, page.index + 2, `OpeningScene${page.index}Token.`);
      expect(bounds.height).toBeGreaterThan(32); // Source Serif's glyph box at 20pt, versus ~18pt at 11pt.
      expect(bounds.height).toBeLessThan(35);
      expect(bounds.x).toBeGreaterThan(100); // Narrower measure, with symmetric gutters.
      expect(bounds.y).toBeGreaterThan(185); // Prose sits lower than the normal top margin.
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("prints thirty separate story sheets with ten matching scene images and truthful ranges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-story-pages-"));
  try {
    await mkdir(join(directory, "book"));
    const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle restore the lantern path.", category: "KIDS", targetPages: 30 });
    const pages = await Promise.all(Array.from({ length: 30 }, async (_, position) => {
      const index = position + 1;
      const illustrated = index % 3 === 0;
      if (illustrated) await sharp({ create: { width: 600, height: 400, channels: 3,
        background: { r: index * 7, g: 40, b: 180 } } }).png().toFile(join(directory, "book", `scene-${index}.png`));
      return { index, title: `Scene ${index}`, markdown: `OpeningScene${index}Token. Rabbit stopped beside the lantern. ` +
        "Turtle checked the path before they moved the light. The neighbors waited by the trees with their picnic baskets. " +
        `Rabbit asked where to put the lantern and listened to Turtle. EndingScene${index}Token.`,
        ...(illustrated ? { imagePath: `/assets/images/book/scene-${index}.png` } : {}) };
    }));
    const options = { plan: makeFallbackPlan(input), category: input.category, pages, authorName: "Story Author",
      readerChapters: Array.from({ length: 15 }, (_, i) => ({ index: i + 1, title: `Story movement ${i + 1}`,
        summary: "The next scene.", startPageIndex: i * 2 + 1, endPageIndex: i * 2 + 2 })) };
    const compiled = compileBookMarkdownWithPageAnchors({ ...options, storyPageLayout: "separate" });
    const flowing = compileBookMarkdownWithPageAnchors(options);
    expect(compiled.markdown).toBe(flowing.markdown);
    const outputPath = join(directory, "book.pdf");
    const result = await generateBookPdfWithPageMap(compiled.markdown, {
      imageStorageDir: directory, publicApiUrl: "http://localhost:4001", projectId: "book",
      pageMapPlan: compiled, outputPath, targetPageCount: 30
    });
    const map = result.pageMap!;
    expect(map).toBeDefined();
    expect(map.pages).toHaveLength(30);
    expect(result.pagination).toBeUndefined(); // No attempt to squeeze frontmatter into the thirty story sheets.
    expect(map.totalPdfPages).toBe(map.pages[0]!.startPdfPage - 1 + 30);
    expect(map.contentsStartPdfPage).toBe(2);
    const bounds = wordBounds(outputPath, map.pages[0]!.startPdfPage, "OpeningScene1Token.");
    expect(bounds.height).toBeLessThan(20); // Mixed books retain their existing typography on all scenes.
    expect(bounds.y).toBeLessThan(120);
    const measured = extractPdfNamedDestinations(result.pdf)!;
    for (const [position, page] of map.pages.entries()) {
      expect(page.endPdfPage).toBe(page.startPdfPage);
      if (position) expect(page.startPdfPage).toBe(map.pages[position - 1]!.endPdfPage + 1);
      const text = execFileSync("pdftotext", ["-f", String(page.startPdfPage), "-l", String(page.endPdfPage), outputPath, "-"], { encoding: "utf8" });
      expect(text.match(/OpeningScene\d+Token/g)).toEqual([`OpeningScene${page.index}Token`]);
      expect(text.match(/EndingScene\d+Token/g)).toEqual([`EndingScene${page.index}Token`]);
      expect(text).toContain(`Page ${page.startPdfPage - 1}`);
      const prefix = join(directory, `extracted-${page.index}`);
      execFileSync("pdfimages", ["-f", String(page.startPdfPage), "-l", String(page.endPdfPage), "-png", outputPath, prefix]);
      const extracted = (await readdir(directory)).filter((name) => name.startsWith(`extracted-${page.index}-`) && name.endsWith(".png"));
      expect(extracted).toHaveLength(page.index % 3 === 0 ? 1 : 0);
      if (extracted[0]) {
        const pixel = await sharp(join(directory, extracted[0])).removeAlpha().raw().toBuffer();
        expect([...pixel.subarray(0, 3)]).toEqual([page.index * 7, 40, 180]);
      }
    }
    const contents = execFileSync("pdftotext", ["-f", "2", "-l", String(map.pages[0]!.startPdfPage - 1), outputPath, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
    for (let index = 1; index <= 15; index += 1) {
      const actual = measured.destinations.get(`chapter-${index}`)!.pdfPage - 1;
      expect(contents).toContain(`CHAPTE R ${index} ${actual} Story movement ${index}`);
    }
    // Preserve the actual result for local visual inspection only when explicitly requested.
    if (process.env.STORY_PDF_REVIEW_PATH) await writeFile(process.env.STORY_PDF_REVIEW_PATH, result.pdf);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("retains overflowing prose and keeps its true end separate from the following scene and Sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-story-overflow-"));
  try {
    const input = createProjectSchema.parse({ prompt: "A story about sharing.", category: "KIDS", targetPages: 5 });
    const sentence = "Rabbit brought the basket along the woodland path while Turtle followed the lanterns.";
    const compiled = compileBookMarkdownWithPageAnchors({ plan: makeFallbackPlan(input), storyPageLayout: "separate",
      authorName: "Story Author", pages: [
        { index: 1, title: "Long scene", markdown: `OpeningLongToken. ${sentence.repeat(110)} EndingLongToken.` },
        { index: 2, title: "Next scene", markdown: "OpeningNextToken. They shared the picnic. EndingNextToken." }
      ], includeSources: true, researchSources: [{ title: "Story notes", url: "https://example.org/story", summary: "Source material." }] });
    const outputPath = join(directory, "book.pdf");
    const result = await generateBookPdfWithPageMap(compiled.markdown, {
      imageStorageDir: directory, publicApiUrl: "http://localhost:4001", pageMapPlan: compiled, outputPath
    });
    const [long, next] = result.pageMap!.pages;
    expect(long!.endPdfPage).toBeGreaterThan(long!.startPdfPage);
    expect(next!.startPdfPage).toBe(long!.endPdfPage + 1);
    expect(next!.endPdfPage).toBe(next!.startPdfPage);
    expect(result.pageMap!.backMatterStartPdfPage).toBe(next!.endPdfPage + 1);
    // A footer can split any phrase when a paragraph crosses a sheet boundary.
    const text = execFileSync("pdftotext", ["-f", String(long!.startPdfPage), "-l", String(long!.endPdfPage), outputPath, "-"], { encoding: "utf8" })
      .replace(/\bPage\s+\d+\b/g, "").replace(/\s+/g, " ");
    expect(text).toContain("OpeningLongToken");
    expect(text).toContain("EndingLongToken");
    expect(text.match(/Rabbit brought the basket/g)).toHaveLength(110);
    expect(text).not.toContain("OpeningNextToken");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
