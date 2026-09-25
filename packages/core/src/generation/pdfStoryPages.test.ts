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
    const text = execFileSync("pdftotext", ["-f", String(long!.startPdfPage), "-l", String(long!.endPdfPage), outputPath, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
    expect(text).toContain("OpeningLongToken");
    expect(text).toContain("EndingLongToken");
    expect(text.match(/Rabbit brought the basket/g)).toHaveLength(110);
    expect(text).not.toContain("OpeningNextToken");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
