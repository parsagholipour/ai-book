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
import { storySceneLength, type StorySceneLength } from "./pdfStoryPages.js";
import { allStoryPageDesigns, STORY_PAGE_DESIGN_IDS, type StoryPageDesignId } from "./storyPageDesigns.js";
import { extractPdfNamedDestinations } from "./pdfNamedDestinations.js";

afterAll(closeSharedBrowser);

function wordBounds(path: string, page: number, word: string): { x: number; y: number; height: number } {
  const xml = execFileSync("pdftotext", ["-f", String(page), "-l", String(page), "-bbox", path, "-"], { encoding: "utf8" });
  const match = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)<\/word>/g)]
    .find((entry) => entry[5] === word);
  expect(match, `Printed word ${word} on sheet ${page}`).toBeDefined();
  return { x: Number(match![1]), y: Number(match![2]), height: Number(match![4]) - Number(match![2]) };
}

it("centres text-only story sheets in picture-book type, with fifteen chapters on one Contents sheet", async () => {
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
      const end = wordBounds(outputPath, page.index + 2, `EndingScene${page.index}Token.`);
      // Picture-book type: Nunito's glyph box at the largest size is ~34pt, the
      // house serif's at 11pt ~18pt.
      expect(bounds.height).toBeGreaterThan(30);
      expect(bounds.x).toBeGreaterThan(100); // Narrower measure, with symmetric gutters.
      // A forty-word scene sits in the middle of its sheet rather than at the top
      // of an otherwise empty one: A4 is 842pt tall, and its writing area runs
      // from 57pt to 765pt.
      expect((bounds.y + end.y + end.height) / 2).toBeGreaterThan(330);
      expect((bounds.y + end.y + end.height) / 2).toBeLessThan(450);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("sizes a text-only scene by the height its paragraphs take, not by its characters", () => {
  const prose = "Mira pulled the quilt up to her chin and listened while the old house settled. ".repeat(4);
  const dialogue = Array.from({ length: 14 }, (_, i) => (i % 2 ? "“I’m here,” Mother said." : "“Mother?” Mira called.")).join("\n\n");
  expect(prose.split(/\s+/).length).toBeGreaterThan(dialogue.split(/\s+/).length);
  expect(storySceneLength(prose)).toBe("brief");
  // Fewer words, but fourteen lines that each end early and the gaps between them.
  expect(storySceneLength(dialogue)).not.toBe("brief");
  // At the last word the largest size takes, a chapter heading costs lines of
  // its own; an anchor and image markup cost none.
  const words = "Mira pulled the quilt up to her chin and listened. ".repeat(30).trim().split(" ");
  let edge = words[0]!;
  for (let count = 2; count <= words.length && storySceneLength(words.slice(0, count).join(" ")) === "brief"; count += 1) {
    edge = words.slice(0, count).join(" ");
  }
  expect(storySceneLength(`<a id="bp-1"></a>\n\n${edge}`)).toBe("brief");
  expect(storySceneLength(`![Mira](/assets/images/book/mira.png)\n\n${edge}`)).toBe("brief");
  expect(storySceneLength(`<a id="chapter-1"></a>\n\n## Chapter 1: The Long Night\n\n${edge}`)).not.toBe("brief");
});

// Every design, and no design at all: each card takes its own padding off the
// sheet and its own face sets its own line, so each is measured on its own.
for (const designId of [...STORY_PAGE_DESIGN_IDS, undefined] as const) {
  it(`keeps the longest scene each size accepts on one sheet, heading and all (${designId ?? "no design"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf-story-sizes-"));
    try {
      const category = designId ? "KIDS" : "STORY";
      const sources = {
        prose: "Mira pulled the quilt up to her chin and listened. Somewhere down the hall, a floorboard gave a long, slow creak, " +
          "the kind that sounds like a sigh. She counted to ten. Nothing else moved. Her little bear sat beside her, button eyes " +
          "shining in the moonlight, and together they waited for the house to settle into sleep.",
        dialogue: "“Mother?” Mira called softly.\n\n“I’m here,” Mother said.\n\nThe floorboard creaked again.\n\n" +
          "“Is it a monster?”\n\n“It is only the old house.”\n\nMira hugged her bear."
      };
      const title = "The Long Night in the Creaking Old House on the Hill";
      const sizes: StorySceneLength[] = ["brief", "short", "medium", "long"];
      const scenes = Object.values(sources).flatMap((source) => {
        const tokens = source.split(/( |\n\n)/);
        const sceneOf = (words: number) => {
          let text = "";
          for (let count = 0, i = 0; count < words; i += 1) {
            text += tokens[i % tokens.length]!;
            if (tokens[i % tokens.length]!.trim()) count += 1;
          }
          return text.trim();
        };
        const longest = new Map<StorySceneLength, string>();
        for (let words = 1; words <= 300; words += 1) {
          const scene = sceneOf(words);
          longest.set(storySceneLength(`## Chapter 1: ${title}\n\n${scene}`, designId), scene);
        }
        return sizes.map((size) => longest.get(size)!);
      });
      const input = createProjectSchema.parse({ prompt: "A bedtime story.", category, targetPages: scenes.length });
      const pages = scenes.map((markdown, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown }));
      const compiled = compileBookMarkdownWithPageAnchors({ plan: makeFallbackPlan(input), category: input.category,
        storyPageLayout: "separate", ...(designId ? { storyPageDesign: designId } : {}), pages, authorName: "Story Author",
        readerChapters: pages.map((page) => ({ index: page.index, title, summary: "The next scene.",
          startPageIndex: page.index, endPageIndex: page.index })) });
      expect(compiled.storyPageDesign).toBe(designId);
      const result = await generateBookPdfWithPageMap(compiled.markdown, { imageStorageDir: directory,
        publicApiUrl: "http://localhost:4001", pageMapPlan: compiled, outputPath: join(directory, "book.pdf") });
      expect(result.pageMap?.pages.map((page) => page.endPdfPage - page.startPdfPage + 1)).toEqual(scenes.map(() => 1));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
}

it("prints each design in its own colours and faces, and a book with none on plain sheets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-story-designs-"));
  try {
    const scenes = ["Mira snuggled beneath her blanket and listened.", "The old floorboard creaked once.", "The room grew quiet again."];
    const render = async (designId: StoryPageDesignId | undefined) => {
      const category = designId ? "KIDS" : "STORY";
      const input = createProjectSchema.parse({ prompt: "A bedtime story.", category, targetPages: scenes.length });
      const compiled = compileBookMarkdownWithPageAnchors({ plan: makeFallbackPlan(input), category, storyPageLayout: "separate",
        ...(designId ? { storyPageDesign: designId } : {}), authorName: "Story Author",
        pages: scenes.map((markdown, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown })),
        // Two chapters, so the first sheet carries a chapter title in the design's heading face.
        readerChapters: [
          { index: 1, title: "The Creak", summary: "s", startPageIndex: 1, endPageIndex: 2 },
          { index: 2, title: "Morning", summary: "s", startPageIndex: 3, endPageIndex: 3 }
        ] });
      const outputPath = join(directory, `${designId ?? "none"}.pdf`);
      const result = await generateBookPdfWithPageMap(compiled.markdown, { imageStorageDir: directory,
        publicApiUrl: "http://localhost:4001", pageMapPlan: compiled, outputPath });
      // A point inside the card's padding, clear of the prose and the shapes:
      // 25mm in from the sheet's left edge, halfway down.
      const fills: string[] = [];
      for (const page of result.pageMap!.pages) {
        const raster = join(directory, `${designId ?? "none"}-${page.index}`);
        execFileSync("pdftoppm", ["-f", String(page.startPdfPage), "-l", String(page.startPdfPage), "-r", "20", "-png", "-singlefile", outputPath, raster]);
        const { data, info } = await sharp(`${raster}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const offset = (Math.round(info.height / 2) * info.width + Math.round((25 / 210) * info.width)) * 3;
        fills.push([...data.subarray(offset, offset + 3)].join(","));
      }
      return { fonts: execFileSync("pdffonts", [outputPath], { encoding: "utf8" }), fills };
    };
    for (const design of allStoryPageDesigns()) {
      const { fonts, fills } = await render(design.id);
      expect(fonts, design.id).toMatch(design.face === "rounded" ? /Nunito/ : /SourceSerif/);
      if (design.displayHeadings) expect(fonts, design.id).toMatch(/Playfair/);
      if (!design.card) {
        expect(new Set(fills), design.id).toEqual(new Set(["255,255,255"]));
        continue;
      }
      expect(fills, design.id).not.toContain("255,255,255");
      // Each sheet takes the next fill in the design's cycle.
      expect(new Set(fills).size, design.id).toBe(new Set(design.sheets.slice(0, scenes.length).map((sheet) => sheet.fill)).size);
    }
    const plain = await render(undefined);
    expect(plain.fonts).not.toMatch(/Nunito|Playfair/);
    expect(new Set(plain.fills)).toEqual(new Set(["255,255,255"]));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

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
