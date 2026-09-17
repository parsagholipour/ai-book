import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allBookFontSets } from "./bookFonts.js";
import { docxFontsFor, generateBookDocx } from "./docx.js";
import { externalLinkTarget, fitImage, prepareDocxSource } from "./docxAssets.js";
import { scriptProfileForLanguage } from "../prompting/script.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let imageStorageDir: string;

beforeAll(async () => {
  imageStorageDir = await mkdtemp(join(tmpdir(), "docx-test-images-"));
  await mkdir(join(imageStorageDir, "proj1"), { recursive: true });
  await writeFile(join(imageStorageDir, "proj1", "page-1.png"), PNG_1X1);
  // A 40×20 illustration, so scaling and aspect can be read back off the extent.
  await writeFile(
    join(imageStorageDir, "proj1", "wide.png"),
    await sharp({ create: { width: 40, height: 20, channels: 3, background: "#336699" } })
      .png()
      .toBuffer()
  );
  await writeFile(
    join(imageStorageDir, "proj1", "photo.webp"),
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#996633" } })
      .webp()
      .toBuffer()
  );
  // Another reader's book, in the same shared storage directory. It has to be a
  // real readable file, or "not embedded" proves nothing.
  await mkdir(join(imageStorageDir, "proj2"), { recursive: true });
  await writeFile(join(imageStorageDir, "proj2", "private.png"), PNG_1X1);
});

afterAll(async () => {
  await rm(imageStorageDir, { recursive: true, force: true });
});

const SAMPLE_MARKDOWN = [
  "![Cover for The Clockmaker](http://localhost:4001/assets/images/proj1/page-1.png)",
  "",
  "# The Clockmaker",
  "",
  "An opening note before the chapters & a stray <tag>.",
  "",
  "## Chapter One: Springs",
  "",
  "The first chapter text with **bold** and _quiet_ words.",
  "",
  "![A workshop](http://localhost:4001/assets/images/proj1/wide.png)",
  "",
  "- first point",
  "- second point",
  "  - nested point",
  "",
  "1. step one",
  "2. step two",
  "",
  "> A quoted line.",
  "",
  "```",
  "const x = 1;",
  "```",
  "",
  "| Year | Carts |",
  "| ---- | ----: |",
  "| 1500 | 120 |",
  "",
  "## Chapter Two: Gears",
  "",
  "The second chapter text.",
  "",
  "![A workshop again](http://localhost:4001/assets/images/proj1/wide.png)",
  "",
  "![Missing remote](https://example.com/external.png)"
].join("\n");

type Docx = {
  zip: JSZip;
  document: string;
  styles: string;
  media: string[];
  rels: string;
};

async function render(markdown: string, options: Partial<Extract<Parameters<typeof generateBookDocx>[1], { imageSource?: "local" }>> = {}): Promise<Docx> {
  const bytes = await generateBookDocx(markdown, {
    title: "The Clockmaker",
    author: "Test Author",
    language: "en",
    imageStorageDir,
    publicApiUrl: "http://localhost:4001",
    ...options
  });
  return open(bytes);
}

async function open(bytes: Buffer): Promise<Docx> {
  const zip = await JSZip.loadAsync(bytes);
  return {
    zip,
    document: await zip.file("word/document.xml")!.async("string"),
    styles: await zip.file("word/styles.xml")!.async("string"),
    media: Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !zip.files[name]!.dir),
    rels: await zip.file("word/_rels/document.xml.rels")!.async("string")
  };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("generateBookDocx", () => {
  it("produces a structurally valid Word package with the book's metadata", async () => {
    const { zip } = await render(SAMPLE_MARKDOWN);
    const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
    expect(contentTypes).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
    for (const name of ["word/document.xml", "word/styles.xml", "word/numbering.xml", "word/footer1.xml", "docProps/core.xml"]) {
      expect(zip.file(name), name).not.toBeNull();
    }
    const core = await zip.file("docProps/core.xml")!.async("string");
    expect(core).toContain("The Clockmaker");
    expect(core).toContain("Test Author");
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("PAGE");
  });

  it("makes every chapter a page-breaking Heading 1 with a bookmark, and prints the prose", async () => {
    const { document } = await render(SAMPLE_MARKDOWN);
    expect(count(document, '<w:pStyle w:val="Heading1"/>')).toBeGreaterThanOrEqual(2);
    expect(document).toContain('w:name="chapter-1"');
    expect(document).toContain('w:name="chapter-2"');
    expect(document).toContain("Chapter One: Springs");
    expect(document).toContain("Chapter Two: Gears");
    expect(document).toContain("The first chapter text with ");
    expect(document).toContain("The second chapter text.");
    expect(count(document, "<w:pageBreakBefore/>")).toBeGreaterThanOrEqual(2);
  });

  it("rebuilds the Contents as hyperlinks to the chapter bookmarks, after the front matter", async () => {
    const { document } = await render(SAMPLE_MARKDOWN);
    expect(document).toContain('w:anchor="chapter-1"');
    expect(document).toContain('w:anchor="chapter-2"');
    const contentsAt = document.indexOf('w:anchor="chapter-1"');
    expect(document.indexOf("An opening note before the chapters")).toBeLessThan(contentsAt);
    expect(document.indexOf("The first chapter text")).toBeGreaterThan(contentsAt);
    // The bare `# Title` before the chapters is the book's title, not a chapter.
    expect(document).toContain('<w:pStyle w:val="Title"/>');
    expect(document).not.toContain('w:name="chapter-3"');
  });

  it("prints no Contents for a book with a single chapter", async () => {
    const { document } = await render("# Solo\n\n## Only Chapter\n\nText.");
    expect(document).not.toContain("<w:hyperlink");
    expect(document).toContain('w:name="chapter-1"');
  });

  it("reads the compiler's title page and Contents back rather than printing their markup", async () => {
    const markdown = [
      '<section class="book-title-page">',
      '  <h1 class="book-title-page__title">Major Wars &amp; Peace</h1>',
      '  <p class="book-title-page__subtitle">A short history</p>',
      '  <p class="book-title-page__byline">by Test Author</p>',
      "</section>",
      '<section class="book-contents" aria-labelledby="book-contents-title">',
      '  <h2 id="book-contents-title">Contents</h2>',
      '  <a class="book-contents__link" href="#chapter-1">',
      '    <span class="book-contents__name">First War</span>',
      '    <span class="book-contents__leader" aria-hidden="true"></span>',
      '    <span class="book-contents__page">1</span>',
      "  </a>",
      "</section>",
      '<a id="chapter-1"></a>',
      "",
      "## Chapter 1: First War",
      "",
      "First chapter prose.",
      "",
      '<a id="chapter-2"></a>',
      "",
      "## Chapter 2: Second War",
      "",
      "Second chapter prose."
    ].join("\n");
    const { document } = await render(markdown, { title: "Major Wars & Peace" });
    for (const leak of ["book-contents", "book-title-page", "&lt;a id=", "&lt;section", 'href="#chapter-', "aria-hidden"]) {
      expect(document, leak).not.toContain(leak);
    }
    expect(document).toContain("Major Wars &amp; Peace");
    expect(document).toContain('<w:pStyle w:val="Title"/>');
    expect(document).toContain("A short history");
    expect(document).toContain("by Test Author");
    // Once in the rebuilt Contents, once as the heading itself.
    expect(count(document, "Chapter 2: Second War")).toBe(2);
    expect(document).toContain('w:anchor="chapter-2"');
  });

  it("embeds a repeated illustration once, scaled to the text block, and ships no remote reference", async () => {
    const { document, media, rels } = await render(SAMPLE_MARKDOWN);
    // The cover (1×1) and the workshop picture (40×20, used twice) — two files.
    expect(media).toHaveLength(2);
    expect(count(rels, 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"')).toBe(2);
    expect(count(document, "<a:blip ")).toBe(3);
    expect(document).not.toContain("example.com");
    // 40×20 px at 9525 EMU a pixel; the picture is smaller than the text block so it keeps its size.
    expect(document).toContain('<wp:extent cx="381000" cy="190500"/>');
  });

  it("scales a wide picture down to the text block and keeps its aspect", () => {
    expect(fitImage(2000, 1000)).toEqual({ width: 656, height: 328 });
    expect(fitImage(400, 4000)).toEqual({ width: 88, height: 880 });
    expect(fitImage(0, 0)).toEqual({ width: 1, height: 1 });
  });

  it("embeds no file from outside the image storage directory, and none from another project", async () => {
    const traversal = [
      "# The Book",
      "",
      "![a](/assets/images/proj1/../../../../../../etc/passwd)",
      "![b](/assets/images/proj1/..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd)",
      "![c](/assets/images/proj1/nested/../../../etc/hostname)"
    ].join("\n");
    expect((await render(traversal)).media).toHaveLength(0);

    const crossProject = [
      "# The Book",
      "",
      "![mine](/assets/images/proj1/page-1.png)",
      "![theirs](/assets/images/proj2/private.png)"
    ].join("\n");
    const scoped = await render(crossProject, { projectId: "proj1" });
    expect(scoped.media).toHaveLength(1);
    expect(scoped.document).not.toContain("theirs");
  });

  it("re-encodes an illustration Word cannot take as PNG", async () => {
    const { media, zip } = await render("# The Book\n\n![photo](/assets/images/proj1/photo.webp)");
    expect(media).toHaveLength(1);
    expect(media[0]).toMatch(/\.png$/);
    const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
    expect(contentTypes).toContain('Extension="png"');
  });

  it("draws a figure as a picture with its caption, and prints the stand-in for one it cannot draw", async () => {
    const fence =
      "```figure\n" +
      JSON.stringify({
        kind: "bar",
        title: "Carts by decade",
        categories: ["Q&A 1500", "1510"],
        series: [{ name: "Carts", values: [120, 140] }],
        source: "The ledger"
      }) +
      "\n```";
    const drawn = await render(`# The Book\n\n## Chapter One\n\nProse before.\n\n${fence}\n\nProse after.`);
    expect(drawn.media).toHaveLength(1);
    expect(drawn.document).toContain("Carts by decade.");
    expect(drawn.document).toContain("Source: The ledger.");
    expect(drawn.document).toContain('<w:pStyle w:val="BookCaption"/>');
    expect(drawn.document).not.toContain('"kind"');

    const broken = await render('# The Book\n\n## Chapter One\n\n```figure\n{"kind":"bar","title":"Half a chart"\n```\n\nAfter.');
    expect(broken.media).toHaveLength(0);
    expect(broken.document).toContain("[Figure: Half a chart]");
    expect(broken.document).toContain("After.");
  });

  it("sets a Persian book right-to-left in the complex-script face, with code left-to-right and emphasis bold", async () => {
    const markdown = [
      "# کتاب ساعت‌ساز",
      "",
      "## فصل اول",
      "",
      "متن _مهم_ فصل اول.",
      "",
      "```",
      "code line",
      "```"
    ].join("\n");
    const { document, styles } = await render(markdown, { title: "کتاب ساعت‌ساز", language: "Persian" });
    expect(styles).toContain('w:cs="Vazirmatn"');
    expect(styles).toMatch(/<w:lang [^>]*w:val="fa"/);
    expect(styles).toMatch(/<w:lang [^>]*w:bidi="fa"/);
    expect(document).toContain("<w:bidi/>");
    expect(document).toContain("<w:rtl/>");
    expect(document).toContain("<w:b/>");
    expect(document).not.toContain("<w:i/>");
    const codeParagraph = document.slice(document.indexOf('<w:pStyle w:val="BookCode"/>'));
    const codeRun = codeParagraph.slice(0, codeParagraph.indexOf("</w:p>"));
    expect(codeRun).not.toContain("<w:bidi/>");
    expect(codeRun).toContain("code line");
  });

  it("writes the file to outputPath and returns the same bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docx-out-"));
    try {
      const outputPath = join(dir, "book.docx");
      const bytes = await generateBookDocx("# A Book\n\nOne paragraph.", {
        title: "A Book",
        imageStorageDir,
        publicApiUrl: "http://localhost:4001",
        outputPath
      });
      expect(Buffer.compare(await readFile(outputPath), bytes)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a hyperlink only for a web or mail target and prints the rest as words", async () => {
    const { document, rels } = await render(
      "# Links\n\n[web](https://example.com/page) and [mail](mailto:a@b.c) and [bad](javascript:alert(1)) and [frag](#chapter-1)."
    );
    expect(count(rels, 'TargetMode="External"')).toBe(2);
    expect(rels).toContain('Target="https://example.com/page"');
    expect(rels).not.toContain("javascript:");
    expect(document).toContain("bad");
    expect(document).toContain("frag");
    expect(count(document, "<w:hyperlink ")).toBe(2);
  });

  it("survives empty and awkward manuscripts", async () => {
    for (const markdown of [
      "",
      "Just one paragraph.",
      "![Cover](/assets/images/proj1/page-1.png)",
      "# Deep\n\n- a\n  - b\n    - c\n      - d\n        - e",
      "# T\n\n| ستون | دوم |\n| --- | --- |\n| ۱ | ۲ |",
      "# Tasks\n\n- [x] done\n- [ ] not yet\n\n***\n\n### Third\n\n#### Fourth\n\n<div class=\"page-break\"></div>\n\nAfter."
    ]) {
      const bytes = await generateBookDocx(markdown, {
        title: "Edge",
        imageStorageDir,
        publicApiUrl: "http://localhost:4001",
        language: markdown.includes("ستون") ? "fa" : "en"
      });
      const { document } = await open(bytes);
      expect(document, markdown).toContain("<w:body>");
      expect(document, markdown).not.toContain("page-break");
    }
  });

  it("names a font set for every script the registry knows", () => {
    for (const fontSet of allBookFontSets()) {
      const profile = { ...scriptProfileForLanguage("en"), fontSet: fontSet.id };
      expect(docxFontsFor(profile).body, fontSet.id).toBeTruthy();
    }
    expect(docxFontsFor(scriptProfileForLanguage("Persian")).complexScript).toBe("Vazirmatn");
    expect(docxFontsFor(scriptProfileForLanguage("Japanese")).eastAsia).toBe("Noto Serif JP");
  });
});

describe("prepareDocxSource", () => {
  it("takes the cover off the front and cuts the manuscript around figures", () => {
    const source = prepareDocxSource(
      "![Cover](/assets/images/p/cover.jpg)\n\n# T\n\nBefore.\n\n```figure\n{\"kind\":\"bar\"}\n```\n\nAfter."
    );
    expect(source.cover).toEqual({ alt: "Cover", src: "/assets/images/p/cover.jpg" });
    expect(source.segments.map((segment) => segment.kind)).toEqual(["markdown", "figure", "markdown"]);
    expect(source.segments[0]).toMatchObject({ text: "# T\n\nBefore.\n\n" });
  });

  it("leaves a code sample about the book's own furniture alone", () => {
    const markdown = "# T\n\n```html\n<section class=\"book-contents\">\n</section>\n```\n";
    const source = prepareDocxSource(markdown);
    expect(source.segments[0]).toMatchObject({ text: markdown });
    expect(source.titlePage).toBeUndefined();
  });
});

describe("externalLinkTarget", () => {
  it("admits exactly http, https and mailto", () => {
    expect(externalLinkTarget("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(externalLinkTarget("http://example.com")).toBe("http://example.com/");
    expect(externalLinkTarget("mailto:a@b.c")).toBe("mailto:a@b.c");
    for (const href of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "#chapter-1", "chapter.md", ""]) {
      expect(externalLinkTarget(href), href).toBeNull();
    }
  });
});
