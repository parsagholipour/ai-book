import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { compileBookMarkdownWithPageAnchors } from "./markdown.js";
import { generateBookDocx } from "./docx.js";
import { generateBookEpub } from "./epub.js";

it("retains thirty independent story scenes and ten matching images in Word and reflowable EPUB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "story-companions-"));
  try {
    await mkdir(join(directory, "book"));
    const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle restore the lantern path.", category: "KIDS", targetPages: 30 });
    const pages = await Promise.all(Array.from({ length: 30 }, async (_, position) => {
      const index = position + 1;
      if (index % 3 === 0) await sharp({ create: { width: 600, height: 400, channels: 3, background: "#447766" } }).png().toFile(join(directory, "book", `scene-${index}.png`));
      return { index, title: `Scene ${index}`, markdown: `OpeningScene${index}Token. Rabbit stopped beside the lantern. ` +
        "Turtle checked the path before they moved the light. The neighbors waited by the trees with their picnic baskets. " +
        `Rabbit asked where to put the lantern and listened to Turtle. EndingScene${index}Token.`,
        ...(index % 3 === 0 ? { imagePath: `/assets/images/book/scene-${index}.png` } : {}) };
    }));
    const compiled = compileBookMarkdownWithPageAnchors({ plan: makeFallbackPlan(input), category: "KIDS", pages,
      storyPageLayout: "separate", authorName: "Story Author",
      readerChapters: Array.from({ length: 15 }, (_, i) => ({ index: i + 1, title: `Story movement ${i + 1}`,
        summary: "The next scene.", startPageIndex: i * 2 + 1, endPageIndex: i * 2 + 2 })) });
    const options = { imageStorageDir: directory, publicApiUrl: "http://localhost:4001", projectId: "book",
      title: "The Lantern Path", pageMapPlan: compiled };
    const wordBytes = await generateBookDocx(compiled.markdown, options);
    const word = await JSZip.loadAsync(wordBytes);
    const xml = await word.file("word/document.xml")!.async("string");
    const sheets = new Map<number, string>();
    let sheet = 1;
    for (const paragraph of xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? []) {
      if (paragraph.includes("<w:pageBreakBefore/>") || paragraph.includes('<w:br w:type="page"/>')) sheet += 1;
      sheets.set(sheet, (sheets.get(sheet) ?? "") + paragraph);
    }
    const storySheets = [...sheets.values()].filter((content) => /OpeningScene\d+Token/.test(content));
    expect(storySheets).toHaveLength(30);
    for (const [position, content] of storySheets.entries()) {
      const index = position + 1;
      expect(content.match(/OpeningScene\d+Token/g)).toEqual([`OpeningScene${index}Token`]);
      expect(content.match(/EndingScene\d+Token/g)).toEqual([`EndingScene${index}Token`]);
      expect(content.match(/<w:drawing>/g) ?? []).toHaveLength(index % 3 === 0 ? 1 : 0);
    }
    expect(xml).not.toContain('<w:br w:type="page"/>');
    const epubBytes = await generateBookEpub(compiled.markdown, options);
    const epub = await JSZip.loadAsync(epubBytes);
    const documents = await Promise.all(Object.keys(epub.files).filter((file) => /^OEBPS\/chapter-\d+\.xhtml$/.test(file)).map(async (file) => ({ file, text: await epub.file(file)!.async("string") })));
    const scenes = documents.filter(({ text }) => /OpeningScene\d+Token/.test(text));
    expect(scenes).toHaveLength(30);
    for (const [position, scene] of scenes.entries()) {
      const index = position + 1;
      expect(scene.text.match(/OpeningScene\d+Token/g)).toEqual([`OpeningScene${index}Token`]);
      expect(scene.text.match(/EndingScene\d+Token/g)).toEqual([`EndingScene${index}Token`]);
      expect(scene.text.match(/<img\b/g) ?? []).toHaveLength(index % 3 === 0 ? 1 : 0);
    }
    const opf = await epub.file("OEBPS/content.opf")!.async("string");
    for (const scene of scenes) expect(opf).toContain(`href="${scene.file.slice(6)}"`);
    const contents = documents.find(({ text }) => text.includes('id="book-contents-title"'))!.text;
    for (let index = 1; index <= 15; index += 1) {
      const chapter = documents.find(({ text }) => text.includes(`id="chapter-${index}"`))!;
      expect(contents).toContain(`href="${chapter.file.slice(6)}#chapter-${index}"`);
    }
    if (process.env.STORY_COMPANION_REVIEW_DIR) {
      await writeFile(join(process.env.STORY_COMPANION_REVIEW_DIR, "book.docx"), wordBytes);
      await writeFile(join(process.env.STORY_COMPANION_REVIEW_DIR, "book.epub"), epubBytes);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
